/**
 * One-shot bulk import for a single campaign day.
 * Usage: node --env-file=.env.local scripts/bulk-import.js
 *
 * Reads both Kannada and Hindi campaign CSVs, extracts metrics via
 * gpt-4o-mini for answered calls, and appends all rows to Sheet1.
 */

import fs from 'fs';
import Papa from 'papaparse';
import OpenAI from 'openai';
import { google } from 'googleapis';

// ── Config ──────────────────────────────────────────────────────────────────
const FILES = [
  {
    path: '/Users/parthbansal/Downloads/batch-contacts-export-2026-05-21 (1).csv',
    campaignType: 'KKB_Kannada_Day3',
    language: 'Kannada',
  },
  {
    path: '/Users/parthbansal/Downloads/batch-contacts-export-2026-05-21.csv',
    campaignType: 'KKB_Hindi_Day3',
    language: 'Hindi',
  },
];
const CAMPAIGN_DAY = '3';
const CAMPAIGN_DATE = '2026-05-20';
const CONCURRENCY = 15;
const SHEET_CHUNK = 200;

// ── Helpers ──────────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function getSheetsClient() {
  const creds = JSON.parse(
    Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, 'base64').toString()
  );
  const auth = new google.auth.JWT(
    creds.client_email, null, creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runBatch(tasks, concurrency) {
  const results = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const slice = tasks.slice(i, i + concurrency);
    const settled = await Promise.allSettled(slice.map((t) => t()));
    for (const s of settled) {
      results.push(s.status === 'fulfilled' ? s.value : null);
    }
    const done = Math.min(i + concurrency, tasks.length);
    process.stdout.write(`\r  OpenAI: ${done}/${tasks.length}`);
  }
  console.log();
  return results;
}

// ── OpenAI extraction ────────────────────────────────────────────────────────
const extractionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    call_answered:      { type: 'string', enum: ['Yes', 'No'] },
    call_engaged:       { type: 'string', enum: ['Yes', 'No'] },
    applied_to_job:     { type: 'string', enum: ['Yes', 'No'] },
    applications_count: { type: 'number' },
    jobs_shown:         { type: 'string', enum: ['Yes', 'No'] },
    primary_topic: {
      type: 'string',
      enum: ['Job search', 'Application follow-up', 'Profile update', 'Salary inquiry', 'No engagement'],
    },
    call_language: { type: 'string', enum: ['Hindi', 'Kannada', 'English', 'Unknown'] },
    summary_3line: { type: 'string' },
    tried_to_apply: { type: 'string', enum: ['Yes', 'No'] },
  },
  required: [
    'call_answered', 'call_engaged', 'applied_to_job', 'applications_count',
    'jobs_shown', 'primary_topic', 'call_language', 'summary_3line', 'tried_to_apply',
  ],
};

function buildPrompt({ duration, transcript_text, campaignLanguage }) {
  return `You are analyzing a call transcript from "Kaam Ki Baat", a voice AI helping Indian workers find jobs. The conversation may be in ${campaignLanguage}.

Extract these fields. Extract only what is explicitly present. Do not infer.

INPUT:
- Duration: ${duration} seconds
- Transcript: ${transcript_text}

RULES:
1. call_answered — Yes if duration > 0 and transcript has meaningful content, else No
2. call_engaged — Yes only if call_answered=Yes AND duration > 10 seconds
3. applied_to_job — Yes if application was CONFIRMED submitted (bot said "apply ho gaya", "application submitted" or equivalent)
4. tried_to_apply — FAILED apply attempts only. Yes ONLY when BOTH: (i) user consented OR bot invoked apply tool, AND (ii) the application did NOT confirm successfully. If applied_to_job=Yes, this MUST be No. If user never consented and no apply tool was invoked, this is No.
5. applications_count — count of confirmed successful applications, default 0
6. jobs_shown — Yes if bot presented a list of jobs to the user
7. primary_topic — one of the 5 allowed values
8. call_language — detected language of the conversation
9. summary_3line — 3-line plain English summary FROM THE USER'S POINT OF VIEW. Line 1: the user's overall response/engagement (interested, disengaged, confused, hung up, etc.). Line 2: key actions the user took (asked for jobs in X city, agreed to apply for job Y, gave their name/age, etc.). Line 3: key failures or unresolved issues from the user's perspective (couldn't find jobs they wanted, apply failed, bot didn't understand them, call dropped, etc. — or "None"). Use \\n as separator. If no real conversation, write "Call not answered" or "No meaningful conversation."

Output valid JSON only.`;
}

async function extractFromTranscript(row, campaignLanguage) {
  const transcript = row.call_transcript?.trim();
  const duration = parseInt(row.call_duration || '0', 10);

  // No real transcript — fill defaults without calling OpenAI
  if (!transcript || transcript === '[]') {
    const answered = duration > 0 ? 'Yes' : 'No';
    const engaged = duration > 10 ? 'Yes' : 'No';
    return {
      call_answered: answered,
      call_engaged: answered === 'Yes' ? engaged : 'No',
      applied_to_job: 'No',
      applications_count: 0,
      jobs_shown: 'No',
      primary_topic: 'No engagement',
      call_language: campaignLanguage,
      summary_3line: answered === 'Yes' ? 'Call answered but no transcript available.\n—\n—' : 'Call not answered.',
      tried_to_apply: 'No',
    };
  }

  // Parse transcript to plain text
  let transcript_text = transcript;
  try {
    const parsed = JSON.parse(transcript);
    if (Array.isArray(parsed)) {
      transcript_text = parsed
        .map((t) => {
          if (t?.role === 'tool') return '';
          if (t?.role === 'assistant' && Array.isArray(t.tool_calls) && t.tool_calls.length) {
            const names = t.tool_calls.map((tc) => tc?.function?.name || tc?.name || 'tool').join(',');
            return `assistant[tool_call:${names}]: ${t.content ?? ''}`;
          }
          if (typeof t?.content === 'string') return `${t.role}: ${t.content}`;
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
  } catch { /* leave as raw string */ }

  // Trim to ~6000 chars to stay within token budget
  if (transcript_text.length > 6000) transcript_text = transcript_text.slice(0, 6000) + '…';

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: buildPrompt({ duration, transcript_text, campaignLanguage }) },
      { role: 'user', content: 'Extract the fields now.' },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'CallExtraction', strict: true, schema: extractionSchema },
    },
  });

  const content = completion.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty OpenAI response');
  return JSON.parse(content);
}

// ── Build a sheet row ────────────────────────────────────────────────────────
const MAX_CELL = 40000;

function cleanTranscript(raw) {
  const t = (raw || '').trim();
  if (!t || t === '[]') return '[]';
  try {
    const parsed = JSON.parse(t);
    if (Array.isArray(parsed)) {
      // Strip tool-call result messages (huge job-listing JSON blobs)
      const cleaned = parsed
        .filter((m) => m?.role !== 'tool')
        .map((m) => {
          if (m?.role === 'assistant' && m.tool_calls && !m.content) {
            return { role: 'assistant', content: '[tool call]' };
          }
          return { role: m.role, content: m.content ?? '' };
        });
      const s = JSON.stringify(cleaned);
      return s.length > MAX_CELL ? s.slice(0, MAX_CELL) + '…"]' : s;
    }
  } catch { /* leave as-is */ }
  return t.length > MAX_CELL ? t.slice(0, MAX_CELL) : t;
}

function buildRow(raw, extracted, campaignType, language) {
  const phone = (raw.contact_phone || '').trim().replace(/^\+?91/, '91');
  const datetime_ist = (raw.call_start_time_ist || '').replace(' IST', '').trim();
  const raw_transcript = cleanTranscript(raw.call_transcript);

  return [
    CAMPAIGN_DAY,                         //  1 campaign_day
    CAMPAIGN_DATE,                        //  2 campaign_date
    campaignType,                         //  3 campaign_type
    language,                             //  4 language
    String(raw.call_id || ''),            //  5 call_id
    phone,                                //  6 phone
    parseInt(raw.call_duration || '0'),   //  7 call_duration_seconds
    datetime_ist,                         //  8 call_datetime_ist
    raw.contact_status || '',             //  9 call_outcome
    extracted.call_answered,              // 10
    extracted.call_engaged,               // 11
    extracted.applied_to_job,             // 12
    extracted.applications_count,         // 13
    extracted.jobs_shown,                 // 14
    extracted.primary_topic,              // 15
    extracted.call_language,              // 16
    raw.call_recording_url || '',         // 17
    extracted.summary_3line,              // 18 final_summary
    raw_transcript,                       // 19 call_transcript
    extracted.tried_to_apply,            // 20 tried_to_apply
  ];
}

// ── Append rows to sheet ─────────────────────────────────────────────────────
async function appendToSheet(sheets, rows) {
  const sid = process.env.SPREADSHEET_ID;
  for (let i = 0; i < rows.length; i += SHEET_CHUNK) {
    const chunk = rows.slice(i, i + SHEET_CHUNK);
    await sheets.spreadsheets.values.append({
      spreadsheetId: sid,
      range: 'Sheet1!A:T',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: chunk },
    });
    process.stdout.write(`\r  Sheets: appended ${Math.min(i + SHEET_CHUNK, rows.length)}/${rows.length} rows`);
    if (i + SHEET_CHUNK < rows.length) await sleep(1200); // stay under rate limit
  }
  console.log();
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const sheets = getSheetsClient();
  let grandTotal = 0;

  for (const { path: filePath, campaignType, language } of FILES) {
    console.log(`\n── ${campaignType} ──`);
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { data } = Papa.parse(raw, { header: true, skipEmptyLines: true });
    console.log(`  Loaded ${data.length} rows`);

    // Separate rows that need OpenAI from those that don't
    const noAI = [];
    const needsAI = [];
    for (const row of data) {
      const transcript = (row.call_transcript || '').trim();
      if (!transcript || transcript === '[]') {
        noAI.push(row);
      } else {
        needsAI.push(row);
      }
    }
    console.log(`  No-AI rows: ${noAI.length} | OpenAI rows: ${needsAI.length}`);

    // Rows that don't need OpenAI
    const noAIRows = noAI.map((row) => {
      const duration = parseInt(row.call_duration || '0', 10);
      const answered = duration > 0 ? 'Yes' : 'No';
      const extracted = {
        call_answered: answered,
        call_engaged: duration > 10 ? 'Yes' : 'No',
        applied_to_job: 'No',
        applications_count: 0,
        jobs_shown: 'No',
        primary_topic: 'No engagement',
        call_language: language,
        summary_3line: answered === 'Yes' ? 'Call answered but no transcript available.\n—\n—' : 'Call not answered.',
        tried_to_apply: 'No',
      };
      return buildRow(row, extracted, campaignType, language);
    });

    // Rows that need OpenAI — run in parallel batches
    console.log(`  Calling OpenAI...`);
    let failCount = 0;
    const aiTasks = needsAI.map((row) => async () => {
      try {
        const extracted = await extractFromTranscript(row, language);
        return buildRow(row, extracted, campaignType, language);
      } catch (e) {
        failCount++;
        // Fallback: fill conservatively without AI
        const duration = parseInt(row.call_duration || '0', 10);
        const extracted = {
          call_answered: duration > 0 ? 'Yes' : 'No',
          call_engaged: duration > 10 ? 'Yes' : 'No',
          applied_to_job: 'No',
          applications_count: 0,
          jobs_shown: 'No',
          primary_topic: 'No engagement',
          call_language: language,
          summary_3line: `Extraction failed: ${e.message.slice(0, 60)}`,
          tried_to_apply: 'No',
        };
        return buildRow(row, extracted, campaignType, language);
      }
    });

    const aiRows = await runBatch(aiTasks, CONCURRENCY);
    if (failCount > 0) console.log(`  ⚠ ${failCount} rows fell back to defaults due to OpenAI errors`);

    const allRows = [...noAIRows, ...aiRows.filter(Boolean)];
    console.log(`  Appending ${allRows.length} rows to Sheet1...`);
    await appendToSheet(sheets, allRows);
    grandTotal += allRows.length;
    console.log(`  Done. ✓`);
  }

  console.log(`\nComplete. ${grandTotal} rows written to Sheet1.`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
