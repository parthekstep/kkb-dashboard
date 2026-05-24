/**
 * One-shot backfill: read the published Sheet1 CSV and embed every
 * transcript-bearing row into Pinecone. Idempotent — skips call_ids already
 * present in the index. After all rows are processed, enforces the
 * rolling-window cap (200 vectors per namespace).
 *
 * Usage:
 *   node --env-file=.env.local scripts/bulk-embed.js
 */

import Papa from 'papaparse';
import OpenAI from 'openai';
import { pineconeUpsert, pineconeFetch } from '../utils/pinecone.js';
import { appendEmbedManifest } from '../utils/sheets.js';
import { buildEmbedText, enforceRollingWindow } from '../utils/embed.js';

const CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vS0I-yVy4ae2MvmSq44r2kFJNc-5lpcX4395tXu9hzplrgfVJ2U5CvC1FS0NAXQtM56w7I8tAnKjZIL/pub?gid=0&single=true&output=csv';

const NAMESPACE = process.env.PINECONE_NAMESPACE || 'kkb';
const EMBED_MODEL = 'text-embedding-3-small';
const SLEEP_MS = 200;
const WINDOW_LIMIT = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function transcriptToText(raw) {
  const t = (raw || '').trim();
  if (!t || t === '[]') return '';
  try {
    const parsed = JSON.parse(t);
    if (!Array.isArray(parsed)) return t;
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
      .join('\n');
  } catch {
    return t;
  }
}

async function alreadyEmbedded(call_id) {
  try {
    const res = await pineconeFetch([call_id], NAMESPACE);
    return Boolean(res?.vectors && res.vectors[call_id]);
  } catch (e) {
    // If Pinecone fetch fails, assume not embedded and let upsert handle it.
    console.warn(`fetch check failed for ${call_id} — proceeding to embed:`, e.message);
    return false;
  }
}

async function main() {
  console.log('Fetching CSV...');
  const csvRes = await fetch(CSV_URL + '&t=' + Date.now());
  if (!csvRes.ok) throw new Error(`CSV fetch failed: ${csvRes.status}`);
  const csv = await csvRes.text();

  const { data } = Papa.parse(csv, { header: true, skipEmptyLines: true });
  console.log(`  ${data.length} total rows`);

  // Only rows with a real transcript + call_id
  const targets = data.filter((r) => {
    const t = (r.call_transcript || '').trim();
    return r.call_id && t && t !== '[]';
  });
  console.log(`  ${targets.length} transcript-bearing rows`);

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  let embedded = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const r = targets[i];
    const call_id = String(r.call_id).trim();
    try {
      if (await alreadyEmbedded(call_id)) {
        skipped++;
        if (skipped % 25 === 0) console.log(`  Skipped ${skipped} already-embedded so far...`);
        continue;
      }

      const callData = {
        call_id,
        phone: r.phone ?? '',
        transcript_text: transcriptToText(r.call_transcript),
        summary_3line: r.final_summary ?? '',
        call_output_summary: '', // not present in sheet
        call_datetime_ist: r.call_datetime_ist ?? '',
        primary_topic: r.primary_topic ?? '',
        call_language: r.call_language ?? '',
        call_answered: r.call_answered ?? '',
        call_engaged: r.call_engaged ?? '',
        applied_to_job: r.applied_to_job ?? '',
        jobs_shown: r.jobs_shown ?? '',
      };

      const text = buildEmbedText(callData);
      const embRes = await openai.embeddings.create({ model: EMBED_MODEL, input: text });
      const values = embRes.data[0].embedding;

      await pineconeUpsert(
        [{
          id: call_id,
          values,
          metadata: {
            call_id,
            phone: callData.phone,
            call_datetime_ist: callData.call_datetime_ist,
            primary_topic: callData.primary_topic,
            call_language: callData.call_language,
            call_answered: callData.call_answered,
            call_engaged: callData.call_engaged,
            applied_to_job: callData.applied_to_job,
            jobs_shown: callData.jobs_shown,
            final_summary: callData.summary_3line,
            transcript_preview: callData.transcript_text.slice(0, 500),
          },
        }],
        NAMESPACE
      );

      try {
        await appendEmbedManifest(call_id, callData.call_datetime_ist, NAMESPACE);
      } catch (e) {
        console.error(`  manifest append failed for ${call_id}:`, e.message);
      }

      embedded++;
      console.log(`Embedded ${embedded + skipped}/${targets.length}: ${call_id}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ failed ${call_id}: ${e.message}`);
    }
    await sleep(SLEEP_MS);
  }

  console.log(`\nEmbed pass: ${embedded} new, ${skipped} skipped, ${failed} failed`);

  // Enforce rolling window
  console.log('\nEnforcing rolling window...');
  try {
    await enforceRollingWindow(NAMESPACE, WINDOW_LIMIT);
  } catch (e) {
    console.error('rolling window enforcement failed:', e.message);
  }

  console.log(`\nDone. ${NAMESPACE} namespace target: ${WINDOW_LIMIT} vectors.`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
