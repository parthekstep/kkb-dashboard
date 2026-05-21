/**
 * Retries only the rows whose final_summary still says "Re-extract failed: ...".
 * Lower concurrency to dodge rate limits.
 *
 * Usage: node --env-file=.env.local scripts/re-extract-retry-fails.js
 */

import OpenAI from 'openai';
import { google } from 'googleapis';

const CONCURRENCY = 4;
const WRITE_CHUNK = 100;

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
  },
  required: ['summary_3line', 'tried_to_apply'],
};

function buildPrompt(transcript_text, duration, jobs_shown) {
  return `You are re-analyzing a call transcript from "Kaam Ki Baat", a voice AI helping Indian workers find jobs. Hindi/Kannada/English.

INPUT:
- Duration: ${duration}s
- jobs_shown (already determined): ${jobs_shown}
- Transcript (role: content; "assistant[tool_call:NAME]" marks tool invocations):
${transcript_text}

Extract two fields:

1. summary_3line — 3-line summary FROM THE USER'S POINT OF VIEW. Use \\n as separator.
   Line 1: the user's overall response/engagement (interested, disengaged, confused, hung up, gave short replies, etc.).
   Line 2: key actions the user took (asked for jobs in X city, agreed to apply for job Y, gave name/age, asked for more details, etc.).
   Line 3: key failures or unresolved issues from the user's perspective (couldn't find jobs they wanted, apply failed with an error, bot didn't understand them, call dropped mid-flow, etc. — or "None" if smooth).

2. tried_to_apply — Yes ONLY if at least one is true:
   (a) the user EXPLICITLY said "apply", "haan apply karo", "yes" (in response to "should I apply?"), "ಅಪ್ಲೈ ಮಾಡಿ", or equivalent affirmative consent to apply for a SPECIFIC job, OR
   (b) the bot actually invoked an apply tool (look for "assistant[tool_call:apply...]" markers).
   User merely asking about jobs, hearing listings, or saying "tell me more" / "kya hai" does NOT count.
   If jobs_shown=No this should almost always be No.

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

async function extract(text, duration, jobs_shown, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: buildPrompt(text, duration, jobs_shown) },
          { role: 'user', content: 'Extract.' },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'ReExtract', strict: true, schema },
        },
      });
      return JSON.parse(completion.choices[0].message.content);
    } catch (e) {
      if (i === attempts - 1) throw e;
      const wait = 3000 * (i + 1);
      await sleep(wait);
    }
  }
}

async function runBatch(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0, done = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      try { results[i] = await tasks[i](); }
      catch (e) { results[i] = { error: e.message }; }
      done++;
      process.stdout.write(`\r  OpenAI: ${done}/${tasks.length}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log();
  return results;
}

async function main() {
  const sheets = getSheets();
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'Sheet1!A2:T',
  });
  const rows = data.values ?? [];

  const targets = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const summary = r[17] || '';
    if (!summary.startsWith('Re-extract failed:')) continue;
    targets.push({
      sheetRow: i + 2,
      transcript: r[18] || '',
      duration: parseInt(r[6] || '0', 10),
      jobs_shown: r[13] || 'No',
    });
  }
  console.log(`Retrying ${targets.length} failed rows at concurrency ${CONCURRENCY}`);

  let failCount = 0;
  const tasks = targets.map((t) => async () => {
    const text = transcriptToText(t.transcript);
    if (!text) return { ...t, summary_3line: 'No transcript content.', tried_to_apply: 'No' };
    try {
      const ex = await extract(text, t.duration, t.jobs_shown);
      return { ...t, ...ex };
    } catch (e) {
      failCount++;
      return { ...t, summary_3line: `Re-extract failed: ${e.message.slice(0, 80)}`, tried_to_apply: 'No' };
    }
  });

  const results = await runBatch(tasks, CONCURRENCY);
  if (failCount) console.log(`  ⚠ ${failCount} still failing`);

  const updates = [];
  for (const r of results) {
    updates.push({ range: `Sheet1!R${r.sheetRow}`, values: [[r.summary_3line]] });
    updates.push({ range: `Sheet1!T${r.sheetRow}`, values: [[r.tried_to_apply]] });
  }

  console.log(`Writing ${updates.length} cells...`);
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
