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
    summary_3line: { type: 'string' },
    tried_to_apply: { type: 'string', enum: ['Yes', 'No'] },
  },
  required: [
    'call_id', 'phone', 'call_duration_seconds', 'call_datetime_ist',
    'call_answered', 'call_engaged', 'applied_to_job', 'applications_count',
    'jobs_shown', 'primary_topic', 'call_language', 'summary_3line', 'tried_to_apply',
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
12. summary_3line — a concise 3-line plain-English summary FROM THE USER'S POINT OF VIEW. Line 1: the user's overall response/engagement (interested, disengaged, confused, hung up, etc.). Line 2: key actions the user took (asked for jobs in X city, agreed to apply for job Y, gave their name/age, etc.). Line 3: key failures or unresolved issues from the user's perspective (couldn't find jobs they wanted, apply failed, bot didn't understand them, call dropped, etc. — or "None" if the call went smoothly). Use \\n as separator. If no conversation, return "Call not answered."
13. tried_to_apply — This column now tracks FAILED apply attempts only. Yes ONLY when BOTH are true: (i) the user explicitly consented to apply OR the bot invoked the apply_jobs tool, AND (ii) the application did NOT confirm successfully (no "अप्लाई हो गया है" / "apply ho gaya" / "application submitted" from the bot, OR the bot acknowledged an error from the tool). If applied_to_job=Yes, this MUST be No. If the user never consented and no apply tool was invoked, this is No. If jobs_shown=No this is almost always No.

Output valid JSON only.`;
}

export async function taskA_metrics(payload) {
  const body = payload?.body ?? {};
  const uuid = body.uuid;
  const phone = body.contact_phone || body.to_number || '';
  const duration = body.call_duration;
  const transcript = Array.isArray(body.call_transcript) ? body.call_transcript : [];
  // Build LLM-visible transcript: include role labels and surface tool-call names
  // (so the model can see if apply_jobs was actually invoked).
  const transcript_text = transcript
    .map((t) => {
      if (t?.role === 'tool') return ''; // strip large tool results
      if (t?.role === 'assistant' && Array.isArray(t.tool_calls) && t.tool_calls.length) {
        const names = t.tool_calls.map((tc) => tc?.function?.name || tc?.name || 'tool').join(',');
        return `assistant[tool_call:${names}]: ${t.content ?? ''}`;
      }
      return `${t?.role ?? 'unknown'}: ${t?.content ?? ''}`;
    })
    .filter(Boolean)
    .join('\n');
  const outcome = body.outcome ?? '';
  const start_time = body.call_start_time ?? '';
  const recording_url = body.call_recording_url ?? '';
  // Strip tool-call result messages (large job-listing blobs) before storing
  const cleaned_transcript = transcript
    .filter((t) => t?.role !== 'tool')
    .map((t) => t?.role === 'assistant' && t.tool_calls && !t.content
      ? { role: 'assistant', content: '[tool call]' }
      : { role: t.role, content: t.content ?? '' });
  const raw_transcript_str = JSON.stringify(cleaned_transcript);
  const raw_transcript = raw_transcript_str.length > 40000
    ? raw_transcript_str.slice(0, 40000) + '…"]'
    : raw_transcript_str;

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

  // 19-column layout matches the Sheet1 header. Cols 1-4 are reserved for
  // manual fill (campaign_day, campaign_date, campaign_type, language); the
  // webhook leaves them blank so a human/script can populate them later.
  const row = [
    '',                          //  1  campaign_day         (manual)
    '',                          //  2  campaign_date        (manual)
    '',                          //  3  campaign_type        (manual)
    '',                          //  4  language             (manual)
    m.call_id,                   //  5  call_id
    m.phone,                     //  6  phone
    m.call_duration_seconds,     //  7  call_duration_seconds
    m.call_datetime_ist,         //  8  call_datetime_ist
    outcome,                     //  9  call_outcome
    m.call_answered,             // 10  call_answered
    m.call_engaged,              // 11  call_engaged
    m.applied_to_job,            // 12  applied_to_job
    m.applications_count,        // 13  applications_count
    m.jobs_shown,                // 14  jobs_shown
    m.primary_topic,             // 15  primary_topic
    m.call_language,             // 16  call_language
    recording_url,               // 17  call_recording_url
    m.summary_3line,             // 18  final_summary
    raw_transcript,              // 19  call_transcript
    m.tried_to_apply,            // 20  tried_to_apply
  ];

  await appendCallRecord(row);
}
