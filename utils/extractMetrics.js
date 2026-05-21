import OpenAI from 'openai';
import { appendCallRecord } from './sheets.js';

const metricsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    call_id: { type: 'string' },
    phone: { type: 'string' },
    call_duration_seconds: { type: 'number' },
    call_datetime_ist: { type: 'string' },
    call_answered: { type: 'string', enum: ['Yes', 'No'] },
    call_engaged: { type: 'string', enum: ['Yes', 'No'] },
    applied_to_job: { type: 'string', enum: ['Yes', 'No'] },
    applications_count: { type: 'number' },
    jobs_shown: { type: 'string', enum: ['Yes', 'No'] },
    primary_topic: {
      type: 'string',
      enum: ['Job search', 'Application follow-up', 'Profile update', 'Salary inquiry', 'No engagement'],
    },
    call_language: {
      type: 'string',
      enum: ['Hindi', 'Kannada', 'English', 'Unknown'],
    },
  },
  required: [
    'call_id', 'phone', 'call_duration_seconds', 'call_datetime_ist',
    'call_answered', 'call_engaged', 'applied_to_job', 'applications_count',
    'jobs_shown', 'primary_topic', 'call_language',
  ],
};

function buildPrompt({ uuid, phone, duration, transcript_text, outcome, start_time }) {
  return `You are analyzing a call transcript from "Kaam Ki Baat", a voice AI helping Indian workers find jobs. The conversation may be in Hindi or Kannada.

Extract these fields from the input data. Extract only what is explicitly present. Do not infer or assume.

INPUT:
- Call UUID: ${uuid}
- Phone: ${phone}
- Duration: ${duration} seconds
- Transcript: ${transcript_text}
- Outcome: ${outcome}
- Start Time: ${start_time}

RULES:
1. call_id — copy UUID exactly
2. phone — copy phone exactly
3. call_duration_seconds — copy duration as number
4. call_datetime_ist — convert start_time to IST, format YYYY-MM-DD HH:MM:SS
5. call_answered — Yes if duration > 0 and transcript has content, No otherwise
6. call_engaged — Yes only if call_answered is Yes AND duration > 10 seconds
7. applied_to_job — Yes if bot said "अप्लाई हो गया है" or "apply ho gaya" or "application submitted" or equivalent
8. applications_count — count of successful applications, default 0
9. jobs_shown — Yes if bot presented a list of jobs
10. primary_topic — one of the 5 allowed values
11. call_language — one of the 4 allowed values

Output valid JSON only.`;
}

export async function taskA_metrics(payload) {
  const body = payload?.body ?? {};
  const uuid = body.uuid;
  const phone = body.contact_phone || body.to_number || '';
  const duration = body.call_duration;
  const transcript = Array.isArray(body.call_transcript) ? body.call_transcript : [];
  const transcript_text = transcript.map((t) => t?.content ?? '').join(' ');
  const outcome = body.outcome ?? '';
  const start_time = body.call_start_time ?? '';
  const recording_url = body.call_recording_url ?? '';
  const summary = body.call_output?.summary ?? '';
  const raw_transcript = JSON.stringify(transcript);

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: buildPrompt({ uuid, phone, duration, transcript_text, outcome, start_time }) },
      { role: 'user', content: 'Extract the fields now.' },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'CallMetrics', strict: true, schema: metricsSchema },
    },
  });

  const content = completion.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned empty content for metrics');
  const m = JSON.parse(content);

  const campaign_date = typeof start_time === 'string' && start_time.includes('T')
    ? start_time.split('T')[0]
    : '';

  const row = [
    m.call_id,
    m.phone,
    m.call_duration_seconds,
    m.call_datetime_ist,
    outcome,                  // call_outcome
    m.call_answered,
    m.call_engaged,
    m.applied_to_job,
    m.applications_count,
    m.jobs_shown,
    m.primary_topic,
    m.call_language,
    recording_url,
    summary,
    raw_transcript,
    campaign_date,
  ];

  await appendCallRecord(row);
}
