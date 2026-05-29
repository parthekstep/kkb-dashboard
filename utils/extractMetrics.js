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
    // drop_reason is populated ONLY when call_answered=Yes AND applied_to_job=No.
    // For successful applications or unanswered calls, the model emits null
    // (strict mode requires the field present even when null).
    drop_reason: {
      type: ['string', 'null'],
      enum: [
        null,
        'silent_user',
        'early_hangup',
        'bot_didnt_understand',
        'profile_collection_loop',
        'no_matching_jobs',
        'apply_failed',
        'user_declined',
        'language_mismatch',
        'other',
      ],
    },
  },
  required: [
    'call_id', 'phone', 'call_duration_seconds', 'call_datetime_ist',
    'call_answered', 'call_engaged', 'applied_to_job', 'applications_count',
    'jobs_shown', 'primary_topic', 'call_language', 'summary_3line', 'tried_to_apply',
    'drop_reason',
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
13. tried_to_apply — FAILED apply attempts only. IMPORTANT CONTEXT: the bot only ever calls the apply_jobs tool AFTER the user says yes to "should I apply?", so an apply_jobs tool call in the transcript (e.g. assistant[tool_call:apply...]) is itself proof the user consented to apply. Yes when BOTH are true: (i) the user consented to apply — evidenced EITHER by an apply_jobs tool call appearing in the transcript, OR by the user explicitly saying to apply ("haan apply karo", "yes", "ಅಪ್ಲೈ ಮಾಡಿ"). AND (ii) the application did NOT succeed — there is no "अप्लाई हो गया है" / "apply ho gaya" / "application submitted" confirmation, or the bot acknowledged an error from the tool. If the application succeeded (applied_to_job=Yes), this MUST be No. If there is no apply tool call AND the user never said to apply, this is No.
14. drop_reason — categorise the DOMINANT reason this answered call did NOT produce an application. MUST be null if call_answered=No OR applied_to_job=Yes. Otherwise pick the ONE bucket that best describes the dropoff:
    - "silent_user" — user said almost nothing (≤3 words); essentially just answered the phone. No engagement signal.
    - "early_hangup" — user engaged briefly (said "yes", "haan kaam chahiye", asked about jobs, even heard a job listing) but the call ended WITHOUT a clear outcome — they didn't apply, didn't explicitly decline, didn't reject specific jobs, and the bot didn't fail. Just hung up / call ended. This is the catch-all for "user was interested-ish but call ended inconclusively". Usually short calls (<60s) but can be longer if the conversation was meandering. USE THIS WHENEVER no other specific bucket clearly applies and the user wasn't fully silent.
    - "bot_didnt_understand" — bot repeatedly asked the user to repeat / "I didn't catch that" / responded with non-sequiturs because it couldn't parse the user's Hindi/Kannada speech.
    - "profile_collection_loop" — bot got stuck asking for the user's name, age, location, qualification, etc.; user disengaged before any job was actually discussed.
    - "no_matching_jobs" — user EXPLICITLY rejected the shown jobs (wrong location, salary too low, wrong skill / job type). Must have explicit rejection signal — "just heard them and hung up" is early_hangup, NOT this.
    - "apply_failed" — same population as tried_to_apply=Yes: user consented to apply OR bot invoked the apply tool, but the application did not confirm successfully. Also includes cases where the bot failed to initiate the application process.
    - "user_declined" — user explicitly refused ("not looking for work", "no", "abhi nahi", "ಬೇಡ"), or said "will think about it later" / "after my exams" / "currently employed, maybe later". Must be explicit refusal or deferral.
    - "language_mismatch" — user wanted a language different from what the bot was speaking, or spoke a language (Telugu, Marathi, English-only) the bot couldn't handle.
    - "other" — TRULY none of the above. Should be RARE (<5% of drops). If you're unsure between early_hangup and other, pick early_hangup.
    Pick the dominant reason when multiple apply (e.g. a call that started with profile collection but ended on no_matching_jobs gets "no_matching_jobs").

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

  // Deterministic guard: a successful application is never a failed apply
  // attempt and never has a drop_reason. Enforce regardless of LLM output.
  if (String(m.applied_to_job).toLowerCase() === 'yes') {
    m.tried_to_apply = 'No';
    m.drop_reason = null;
  }

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
    m.drop_reason ?? '',         // 21  drop_reason (empty when null)
  ];

  await appendCallRecord(row);

  // Embed into Pinecone for the dashboard chatbot. Non-fatal — a failure here
  // must never break the webhook pipeline (Sheet1 row is already saved above).
  try {
    const { embedTranscript } = await import('./embed.js');
    await embedTranscript({
      call_id: m.call_id,
      phone: m.phone,
      transcript_text,
      summary_3line: m.summary_3line,
      call_output_summary: body?.call_output?.summary ?? '',
      call_datetime_ist: m.call_datetime_ist,
      primary_topic: m.primary_topic,
      call_language: m.call_language,
      call_answered: m.call_answered,
      call_engaged: m.call_engaged,
      applied_to_job: m.applied_to_job,
      jobs_shown: m.jobs_shown,
    });
  } catch (e) {
    console.error('embedTranscript failed (non-fatal):', e?.message);
  }
}
