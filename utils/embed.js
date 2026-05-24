/**
 * Embeds a single call's structured summary into Pinecone, tracks it in the
 * EmbedManifest sheet, and enforces a rolling-window cap (FIFO eviction).
 *
 * Designed to be called from extractMetrics.js AFTER the row has been appended
 * to Sheet1. Caller wraps in try/catch — embed failures are NEVER fatal to the
 * webhook pipeline.
 *
 * Also exports `buildEmbedText` so scripts/bulk-embed.js stays in sync.
 */

import OpenAI from 'openai';
import { pineconeUpsert, pineconeDelete } from './pinecone.js';
import {
  appendEmbedManifest,
  readEmbedManifest,
  deleteEmbedManifestRows,
} from './sheets.js';

const EMBED_MODEL = 'text-embedding-3-small';
// The Pinecone index is 1024-dim, so we use OpenAI's `dimensions` param to
// truncate text-embedding-3-small's native 1536-dim output. Truncation is
// supported by text-embedding-3-* models and preserves most of the signal.
const EMBED_DIMENSIONS = 1024;

// Caps:
//   TRANSCRIPT_EMBED_CAP — what we feed into the embedding model. The model
//     handles up to ~8192 tokens (~24-32k chars); 24k leaves comfortable
//     headroom while embedding the vast majority of calls in full.
//   TRANSCRIPT_PREVIEW_CAP — what we store in Pinecone metadata for chat-time
//     quoting. Pinecone metadata caps at 40 KB per vector across all fields;
//     4 KB keeps us well under that with room for everything else.
// Baseline cap. text-embedding-3-small max is 8192 tokens. Devanagari/Kannada
// occasionally densify to ~1.5 chars/token in worst-case dialogues, so 10k chars
// + ~500 chars of structured header ≈ 7k tokens safely. embedTextWithShrink()
// below also retries shorter on context-length errors as a safety net.
const TRANSCRIPT_EMBED_CAP = 10000;
// Bigger preview = more transcript text the chat LLM can quote for matched
// calls. Pinecone metadata caps at 40 KB per vector across ALL fields; our
// other fields total ~500 chars, so 16k chars of preview is comfortably safe.
const TRANSCRIPT_PREVIEW_CAP = 16000;

// Minimum total user-spoken characters to consider a call worth embedding.
// Anything below this is essentially a "hello → bot greeting → user dropped"
// pattern with no signal worth retrieving on later.
const MIN_USER_CHARS = 30;

/**
 * Returns true iff this call has enough user-spoken content to be worth
 * embedding. Used to skip unanswered/dropped/empty calls so we don't pollute
 * the Pinecone index with vectors that all look like generic bot greetings.
 *
 * Accepts either a parsed transcript array OR a raw JSON string.
 */
export function hasMeaningfulConversation(callAnswered, transcript) {
  if (String(callAnswered ?? '').toLowerCase() !== 'yes') return false;
  let arr = transcript;
  if (typeof transcript === 'string') {
    try { arr = JSON.parse(transcript); } catch { return false; }
  }
  if (!Array.isArray(arr)) return false;
  const userChars = arr
    .filter((m) => m?.role === 'user')
    .map((m) => String(m.content || ''))
    .join('')
    .trim()
    .length;
  return userChars >= MIN_USER_CHARS;
}

export function buildEmbedText(c) {
  const transcript = String(c.transcript_text || '').slice(0, TRANSCRIPT_EMBED_CAP);
  return [
    `Call ID: ${c.call_id}`,
    `Date: ${c.call_datetime_ist}`,
    `Language: ${c.call_language}`,
    `Topic: ${c.primary_topic}`,
    `Answered: ${c.call_answered}  Engaged: ${c.call_engaged}`,
    `Jobs Shown: ${c.jobs_shown}   Applied: ${c.applied_to_job}`,
    `Summary (3-line): ${c.summary_3line ?? ''}`,
    `Bolna summary: ${c.call_output_summary || '(none)'}`,
    `Transcript: ${transcript}`,
  ].join('\n');
}

function buildMetadata(c) {
  return {
    call_id: String(c.call_id ?? ''),
    phone: String(c.phone ?? ''),
    call_datetime_ist: String(c.call_datetime_ist ?? ''),
    primary_topic: String(c.primary_topic ?? ''),
    call_language: String(c.call_language ?? ''),
    call_answered: String(c.call_answered ?? ''),
    call_engaged: String(c.call_engaged ?? ''),
    applied_to_job: String(c.applied_to_job ?? ''),
    jobs_shown: String(c.jobs_shown ?? ''),
    final_summary: String(c.summary_3line ?? ''),
    transcript_preview: String(c.transcript_text || '').slice(0, TRANSCRIPT_PREVIEW_CAP),
  };
}

/**
 * Embed text, automatically shrinking + retrying if OpenAI complains about
 * context length. Each retry halves the body (keeps the structured header
 * intact) up to MAX_SHRINK attempts. Exported for bulk-embed.js to reuse.
 */
export async function embedTextWithShrink(openai, text) {
  const MAX_SHRINK = 4;
  let attempt = 0;
  let input = text;
  while (true) {
    try {
      const res = await openai.embeddings.create({
        model: EMBED_MODEL,
        input,
        dimensions: EMBED_DIMENSIONS,
      });
      return res.data[0].embedding;
    } catch (e) {
      const msg = String(e?.message || '');
      const isCtxErr = msg.includes('maximum context length') || msg.includes('context_length_exceeded');
      if (!isCtxErr || attempt >= MAX_SHRINK) throw e;
      // Keep the first ~600 chars (structured English header) intact, halve the rest.
      const headerEnd = input.indexOf('Transcript: ');
      const headerLen = headerEnd > 0 ? headerEnd + 'Transcript: '.length : 600;
      const head = input.slice(0, headerLen);
      const tail = input.slice(headerLen);
      input = head + tail.slice(0, Math.floor(tail.length / 2));
      attempt++;
      console.warn(`embedTextWithShrink: retry ${attempt} at ${input.length} chars`);
    }
  }
}

async function embedText(openai, text) {
  return embedTextWithShrink(openai, text);
}

export async function embedTranscript(callData) {
  if (!callData?.call_id) throw new Error('embedTranscript: call_id required');

  // Skip calls with no meaningful user content (unanswered, dropped, or just
  // a greeting). These would all embed to similar generic vectors and pollute
  // retrieval. callData.transcript_text is already the role-prefixed string
  // built by extractMetrics.js, so we check user-char count on it directly.
  const userChars = String(callData.transcript_text || '')
    .split('\n')
    .filter((line) => line.startsWith('user:'))
    .map((line) => line.slice(5).trim())
    .join(' ')
    .length;
  if (
    String(callData.call_answered ?? '').toLowerCase() !== 'yes' ||
    userChars < MIN_USER_CHARS
  ) {
    console.log(`Skipping embed for ${callData.call_id} — no meaningful user content`);
    return;
  }

  const namespace = process.env.PINECONE_NAMESPACE || 'kkb';

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const text = buildEmbedText(callData);
  const values = await embedText(openai, text);

  await pineconeUpsert(
    [{ id: String(callData.call_id), values, metadata: buildMetadata(callData) }],
    namespace
  );

  // Manifest append + rolling-window are best-effort: a failure here MUST NOT
  // undo the upsert. We log and continue; the next embed will retry eviction.
  try {
    await appendEmbedManifest(callData.call_id, callData.call_datetime_ist, namespace);
  } catch (e) {
    console.error('appendEmbedManifest failed (non-fatal):', e?.message);
  }
  try {
    await enforceRollingWindow(namespace, 200);
  } catch (e) {
    console.error('enforceRollingWindow failed (non-fatal):', e?.message);
  }
}

export async function enforceRollingWindow(namespace, limit) {
  const rows = await readEmbedManifest(namespace);
  if (rows.length <= limit) return;

  // Sort ascending by call_datetime_ist; oldest first.
  // Manifest stores strings like "YYYY-MM-DD HH:MM:SS" so lexicographic sort
  // matches chronological order. Rows with blank/invalid dates sort to the top
  // (treated as oldest) and get evicted first — desired behaviour.
  rows.sort((a, b) => (a.call_datetime_ist || '').localeCompare(b.call_datetime_ist || ''));

  const overage = rows.length - limit;
  const victims = rows.slice(0, overage);
  const ids = victims.map((r) => String(r.call_id));
  const rowIndices = victims.map((r) => r.rowIndex);

  await pineconeDelete(ids, namespace);
  await deleteEmbedManifestRows(rowIndices);

  console.log(
    `Rolling window: deleted ${overage} oldest vectors. ${namespace} namespace now has ${limit}.`
  );
}
