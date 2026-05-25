/**
 * Re-runs the metrics LLM extraction over existing Sheet1 rows to refresh
 * `final_summary` (col R), `tried_to_apply` (col T), and `drop_reason` (col U)
 * using the updated prompts.
 *
 * Skips rows where call_transcript is empty/[]. Writes back in batches.
 *
 * Usage: node --env-file=.env.local scripts/re-extract.js
 *        node --env-file=.env.local scripts/re-extract.js --limit 20   # dry sample
 */

import OpenAI from 'openai';
import { google } from 'googleapis';

const SHEET_RANGE = 'Sheet1!A2:U';      // skip header
const COL_TRANSCRIPT_IDX = 18;          // 0-based: 19th col
const COL_SUMMARY_IDX    = 17;          // 0-based: 18th col (R)
const COL_TRIED_IDX      = 19;          // 0-based: 20th col (T)
const COL_DROP_IDX       = 20;          // 0-based: 21st col (U)
const CONCURRENCY = 8;
const WRITE_CHUNK = 100;

const args = process.argv.slice(2);
const limitFlag = args.indexOf('--limit');
const LIMIT = limitFlag >= 0 ? parseInt(args[limitFlag + 1], 10) : Infinity;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function getSheets() {
  const creds = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, 'base64').toString());
  const auth = new google.auth.JWT(creds.client_email, null, creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']);
  return google.sheets({ version: 'v4', auth });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary_3line:  { type: 'string' },
    tried_to_apply: { type: 'string', enum: ['Yes', 'No'] },
    drop_reason: {
      type: ['string', 'null'],
      enum: [
        null,
        'silent_user',
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
  required: ['summary_3line', 'tried_to_apply', 'drop_reason'],
};

function buildPrompt(transcript_text, duration, jobs_shown, applied_to_job, call_answered) {
  return `You are re-analyzing a call transcript from "Kaam Ki Baat", a voice AI helping Indian workers find jobs. Hindi/Kannada/English.

INPUT:
- Duration: ${duration}s
- call_answered (already determined): ${call_answered}
- jobs_shown (already determined): ${jobs_shown}
- applied_to_job (already determined): ${applied_to_job}
- Transcript (role: content; "assistant[tool_call:NAME]" marks tool invocations):
${transcript_text}

Extract three fields:

1. summary_3line — 3-line summary FROM THE USER'S POINT OF VIEW. Use \\n as separator.
   Line 1: the user's overall response/engagement (interested, disengaged, confused, hung up, gave short replies, etc.).
   Line 2: key actions the user took (asked for jobs in X city, agreed to apply for job Y, gave name/age, asked for more details, etc.).
   Line 3: key failures or unresolved issues from the user's perspective (couldn't find jobs they wanted, apply failed with an error, bot didn't understand them, call dropped mid-flow, etc. — or "None" if smooth).

2. tried_to_apply — FAILED apply attempts only. Yes ONLY when BOTH are true:
   (i) user explicitly consented to apply ("apply", "haan apply karo", "yes", "ಅಪ್ಲೈ ಮಾಡಿ") OR the bot invoked an apply tool (assistant[tool_call:apply...]), AND
   (ii) the application did NOT confirm successfully — no "apply ho gaya" / "application submitted" from the bot, or the bot acknowledged a tool error.
   If applied_to_job=Yes, this MUST be No. If the user never consented and no apply tool was invoked, this is No.

3. drop_reason — the DOMINANT reason this answered call did NOT produce an application. MUST be null if call_answered=No OR applied_to_job=Yes. Otherwise pick ONE bucket:
   - "silent_user" — user said ≤5 words total, basically just greeting then disengaged. No real conversation.
   - "bot_didnt_understand" — bot repeatedly asked the user to repeat / "I didn't catch that" / responded with non-sequiturs because it couldn't parse the user's Hindi/Kannada speech.
   - "profile_collection_loop" — bot got stuck asking for name/age/location/qualification; user disengaged before any job was discussed.
   - "no_matching_jobs" — bot DID show jobs (jobs_shown=Yes is a strong hint) but none fit the user's stated preference (wrong location, salary too low, wrong skill / job type). User rejected the shown jobs.
   - "apply_failed" — same population as tried_to_apply=Yes (consented or tool fired but no success confirmation).
   - "user_declined" — user engaged but explicitly refused ("not looking", "no", "abhi nahi", "ಬೇಡ"). Said no — distinct from silent_user.
   - "language_mismatch" — user wanted a language different from the bot, or spoke a language the bot couldn't handle (Telugu, Marathi, English-only).
   - "other" — none of the above. Use sparingly.
   Pick the DOMINANT reason when multiple apply.

Output valid JSON only.`;
}

function transcriptToText(raw) {
  const t = (raw || '').trim();
  if (!t || t === '[]') return '';
  try {
    const parsed = JSON.parse(t);
    if (!Array.isArray(parsed)) return t.slice(0, 6000);
    return parsed
      .map((m) => {
        if (m?.role === 'tool') return '';
        if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          const names = m.tool_calls.map((tc) => tc?.function?.name || tc?.name || 'tool').join(',');
          return `assistant[tool_call:${names}]: ${m.content ?? ''}`;
        }
        if (typeof m?.content === 'string') return `${m.role}: ${m.content}`;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .slice(0, 6000);
  } catch {
    return t.slice(0, 6000);
  }
}

async function extract(text, duration, jobs_shown, applied_to_job, call_answered) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: buildPrompt(text, duration, jobs_shown, applied_to_job, call_answered) },
      { role: 'user', content: 'Extract.' },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'ReExtract', strict: true, schema },
    },
  });
  return JSON.parse(completion.choices[0].message.content);
}

async function runBatch(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      try { results[i] = await tasks[i](); }
      catch (e) { results[i] = { error: e.message }; }
      done++;
      if (done % 25 === 0 || done === tasks.length) {
        process.stdout.write(`\r  OpenAI: ${done}/${tasks.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log();
  return results;
}

async function main() {
  const sheets = getSheets();
  console.log('Reading Sheet1...');
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: SHEET_RANGE,
  });
  const rows = data.values ?? [];
  console.log(`  ${rows.length} data rows`);

  // Identify rows needing re-extraction
  const targets = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const transcript = r[COL_TRANSCRIPT_IDX] || '';
    const t = transcript.trim();
    if (!t || t === '[]') continue;
    targets.push({
      sheetRow: i + 2,            // +2 for 1-based + header
      transcript,
      duration: parseInt(r[6] || '0', 10),
      call_answered: r[9] || 'No',
      jobs_shown: r[13] || 'No',
      applied_to_job: r[11] || 'No',
    });
    if (targets.length >= LIMIT) break;
  }
  console.log(`  ${targets.length} rows with transcripts to re-extract`);

  let failCount = 0;
  const tasks = targets.map((t) => async () => {
    const text = transcriptToText(t.transcript);
    if (!text) return { ...t, summary_3line: 'No transcript content.', tried_to_apply: 'No', drop_reason: null };
    try {
      const ex = await extract(text, t.duration, t.jobs_shown, t.applied_to_job, t.call_answered);
      return { ...t, ...ex };
    } catch (e) {
      failCount++;
      return { ...t, summary_3line: `Re-extract failed: ${e.message.slice(0, 80)}`, tried_to_apply: 'No', drop_reason: null };
    }
  });

  console.log('Calling OpenAI...');
  const results = await runBatch(tasks, CONCURRENCY);
  if (failCount) console.log(`  ⚠ ${failCount} extraction failures`);

  // Build batchUpdate requests: 3 cells per row (R = summary, T = tried_to_apply, U = drop_reason)
  console.log(`Writing ${results.length * 3} cells back to Sheet1...`);
  const updates = [];
  for (const r of results) {
    updates.push({ range: `Sheet1!R${r.sheetRow}`, values: [[r.summary_3line]] });
    updates.push({ range: `Sheet1!T${r.sheetRow}`, values: [[r.tried_to_apply]] });
    updates.push({ range: `Sheet1!U${r.sheetRow}`, values: [[r.drop_reason ?? '']] });
  }

  for (let i = 0; i < updates.length; i += WRITE_CHUNK) {
    const slice = updates.slice(i, i + WRITE_CHUNK);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: process.env.SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: slice },
    });
    process.stdout.write(`\r  wrote ${Math.min(i + WRITE_CHUNK, updates.length)}/${updates.length}`);
    if (i + WRITE_CHUNK < updates.length) await sleep(1200);
  }
  console.log('\nDone.');
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
