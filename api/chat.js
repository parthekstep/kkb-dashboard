/**
 * POST /api/chat
 *
 * Body: { question: string, namespace?: string }  // namespace defaults to 'kkb'
 *
 * Pipeline:
 *   1. Classify question into one of three intents:
 *        - corpus_aggregation  (default for "how many / how often / what % / what are the main")
 *        - specific_lookup     (only when user asks for examples by similarity)
 *        - dashboard_metric    (only Sheet1-column questions the dashboard already shows)
 *   2. Route:
 *        - corpus_aggregation → map-reduce across ALL 200 transcripts in namespace.
 *          8 chunks × 25 records, parallel; each map emits strict JSON with
 *          count_matching + examples; reduce sums + synthesizes a final answer.
 *        - specific_lookup → multi-lingual query expansion + Pinecone topK=100,
 *          filter score ≥ 0.25, tiered context.
 *        - dashboard_metric → small similarity-search context to add colour,
 *          but the answer points the user at the right dashboard column.
 */

import OpenAI from 'openai';
import { pineconeQuery, pineconeFetch } from '../utils/pinecone.js';
import { readEmbedManifest } from '../utils/sheets.js';

export const config = { runtime: 'nodejs', maxDuration: 90 };

const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIMENSIONS = 1024;
const CHAT_MODEL = 'gpt-4o-mini';

const MAP_CHUNK_SIZE = 25;                 // 200 ÷ 25 = 8 parallel calls
const MAP_PREVIEW_CHARS_PER_RECORD = 6000; // 25 × 6000 ≈ 150k chars ≈ 38k tokens/chunk

// Sheet1 columns the dashboard already exposes — the ONLY questions that
// should route to dashboard_metric. Listed in the classifier prompt so the
// model has a concrete allow-list.
const DASHBOARD_COLUMNS = [
  'call_answered (Yes/No)',
  'call_engaged (Yes/No)',
  'applied_to_job (Yes/No)',
  'applications_count (integer)',
  'jobs_shown (Yes/No)',
  'call_language (Hindi/Kannada/English/Unknown)',
  'call_duration_seconds',
  'primary_topic (one of 5 enum values)',
  'tried_to_apply (= failed apply attempts)',
];

// ── Classification ─────────────────────────────────────────────────────────
const classifierSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['corpus_aggregation', 'specific_lookup', 'dashboard_metric'] },
    reasoning: { type: 'string' },
  },
  required: ['type', 'reasoning'],
};

async function classify(openai, question) {
  const completion = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      {
        role: 'system',
        content:
`Classify the user's question into one of three types. Pick the SINGLE best match. Bias toward "corpus_aggregation" — most analytical questions belong there.

TYPES:

1. "corpus_aggregation" — DEFAULT for anything that requires reading across many transcripts to count, average, theme, or summarise. ALWAYS pick this for phrasings like "how many", "how often", "what % of", "what are the main", "summarise", "across all calls", "common", "typical". Examples:
   - "how often does the bot repeat itself"
   - "what % of callers mention salary"
   - "what are the main reasons calls end early"
   - "summarise the themes in recent calls"
   - "how many people complained about the bot"

2. "specific_lookup" — ONLY when the user explicitly asks to see specific examples / one or a few cases, NOT a count. Examples:
   - "show me a call where the user got angry"
   - "give me an example of a successful application"
   - "find calls about security guard jobs"

3. "dashboard_metric" — ONLY when the answer is DIRECTLY a column already shown on the dashboard. The dashboard surfaces these columns: ${DASHBOARD_COLUMNS.join(', ')}. Examples:
   - "how many calls were answered" (call_answered column)
   - "what's the application rate" (applied_to_job column)
   - "how many people spoke Kannada" (call_language column)
   Do NOT pick dashboard_metric for questions that ask about themes, complaints, sentiment, or behaviour visible only in transcript text — those are corpus_aggregation even if they sound numeric.

When in doubt → corpus_aggregation, NOT specific_lookup.

Return JSON only.`,
      },
      { role: 'user', content: question },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'Classification', strict: true, schema: classifierSchema },
    },
  });
  return JSON.parse(completion.choices[0].message.content);
}

// ── Multi-lingual query expansion (for specific_lookup + dashboard_metric) ─
const translationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    hindi: { type: 'string' },
    kannada: { type: 'string' },
  },
  required: ['hindi', 'kannada'],
};

async function translate(openai, question) {
  try {
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content:
`Translate this English analyst question into the colloquial Hindi and Kannada a job-seeker might actually say on a phone call. Use Devanagari for Hindi and Kannada script for Kannada. Don't translate technical terms like "application rate". Return JSON only.`,
        },
        { role: 'user', content: question },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'Translation', strict: true, schema: translationSchema },
      },
    });
    return JSON.parse(completion.choices[0].message.content);
  } catch (e) {
    console.warn('translation failed; falling back to English-only:', e.message);
    return { hindi: '', kannada: '' };
  }
}

async function embedOne(openai, text) {
  const r = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: text,
    dimensions: EMBED_DIMENSIONS,
  });
  return r.data[0].embedding;
}

function averageVectors(vectors) {
  const dim = vectors[0].length;
  const out = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i] += v[i];
  const n = vectors.length;
  for (let i = 0; i < dim; i++) out[i] /= n;
  let mag = 0;
  for (let i = 0; i < dim; i++) mag += out[i] * out[i];
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < dim; i++) out[i] /= mag;
  return out;
}

async function buildMultilingualQueryVector(openai, question) {
  const { hindi, kannada } = await translate(openai, question);
  const variants = [question, hindi, kannada].filter(Boolean);
  const vecs = await Promise.all(variants.map((v) => embedOne(openai, v)));
  return vecs.length === 1 ? vecs[0] : averageVectors(vecs);
}

// ── Pinecone namespace fetch (corpus_aggregation source of truth) ──────────
async function fetchAllNamespaceRecords(namespace) {
  const manifest = await readEmbedManifest(namespace);
  const ids = manifest.map((r) => String(r.call_id));
  if (!ids.length) return [];
  const BATCH = 100;
  const out = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const res = await pineconeFetch(slice, namespace);
    const vectors = res?.vectors || {};
    for (const id of slice) {
      const v = vectors[id];
      if (v) out.push({ call_id: id, metadata: v.metadata || {} });
    }
  }
  out.sort((a, b) =>
    String(b.metadata.call_datetime_ist || '').localeCompare(
      String(a.metadata.call_datetime_ist || '')
    )
  );
  return out;
}

// ── Map-reduce: corpus_aggregation ─────────────────────────────────────────
const mapSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    subset_size: { type: 'integer' },
    count_matching: { type: 'integer' },
    examples: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          call_id: { type: 'string' },
          snippet: { type: 'string' },
        },
        required: ['call_id', 'snippet'],
      },
    },
    theme_notes: { type: 'string' },
  },
  required: ['subset_size', 'count_matching', 'examples', 'theme_notes'],
};

function buildMapPromptBody(chunk, perRecordChars) {
  return chunk
    .map((r, i) => {
      const md = r.metadata || {};
      const header = `[${i + 1}] call_id=${md.call_id || r.call_id} | ${md.call_datetime_ist || '?'} | ${md.primary_topic || '?'} | ${md.call_language || '?'}`;
      const summary = md.final_summary || '(no summary)';
      const preview = String(md.transcript_preview || '').slice(0, perRecordChars);
      return `${header}\nSummary: ${summary}\nTranscript excerpt: ${preview}`;
    })
    .join('\n\n---\n\n');
}

async function runMapChunk(openai, question, chunk, totalCorpus) {
  let perRecordChars = MAP_PREVIEW_CHARS_PER_RECORD;
  for (let attempt = 0; attempt < 4; attempt++) {
    const body = buildMapPromptBody(chunk, perRecordChars);
    const system =
`You are analysing one SUBSET of a larger transcript corpus from "Kaam Ki Baat", a voice AI for Indian blue-collar job seekers (Hindi/Kannada/English calls).

You are looking at exactly ${chunk.length} calls. This is one of several subsets; the full corpus has ${totalCorpus} calls total. Count ONLY within these ${chunk.length}.

Read the user's question, then return strict JSON:
- subset_size: must equal ${chunk.length}
- count_matching: integer count of calls IN THIS SUBSET that match the user's question. If the question isn't really a count (e.g. "what are the main themes"), set this to the number of calls in this subset that contain content relevant to the theme.
- examples: up to 3 short concrete examples from THIS subset (call_id + a one-line English snippet quoting or paraphrasing the relevant content). If transcript is non-English, translate the quote to English.
- theme_notes: one sentence describing the pattern observed in this subset relevant to the question.

CALLS (${chunk.length}):
${body}`;

    try {
      const completion = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: question },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'MapResult', strict: true, schema: mapSchema },
        },
      });
      return JSON.parse(completion.choices[0].message.content);
    } catch (e) {
      const msg = String(e?.message || '');
      const ctxErr = msg.includes('maximum context length') || msg.includes('context_length_exceeded');
      if (!ctxErr || attempt === 3) {
        console.error(`map chunk failed (attempt ${attempt + 1}):`, msg);
        return { subset_size: chunk.length, count_matching: 0, examples: [], theme_notes: `(map failed: ${msg.slice(0, 100)})` };
      }
      perRecordChars = Math.floor(perRecordChars / 2);
      console.warn(`map chunk shrunk to ${perRecordChars} chars/record, retrying`);
    }
  }
}

const FORMAT_RULES = `
FORMATTING RULES (strict):
- Plain text only. No Markdown. No **bold**, no *italics*, no ### headings, no - bullet lists, no backticks.
- If you need a list, write it as numbered lines: "1. foo\\n2. bar".
- Use blank lines for paragraph breaks.
- Never wrap quotes in asterisks; use plain quotation marks.
`;

async function runReduce(openai, question, mapResults, totalCorpus) {
  const totalMatching = mapResults.reduce((s, r) => s + (r.count_matching || 0), 0);
  const allExamples = mapResults.flatMap((r) => r.examples || []);
  const themeBullets = mapResults
    .map((r, i) => `Subset ${i + 1} (${r.subset_size} calls, ${r.count_matching} matching): ${r.theme_notes}`)
    .join('\n');
  const examplesBlock = allExamples
    .slice(0, 25) // give the reducer plenty to pick from
    .map((e, i) => `${i + 1}. [${e.call_id}] ${e.snippet}`)
    .join('\n');

  const system =
`You are an analyst for "Kaam Ki Baat", a voice AI that helps Indian blue-collar workers find jobs in Hindi and Kannada.

The corpus was split into ${mapResults.length} subsets totalling ${totalCorpus} calls. Each subset was analysed separately. You now aggregate.

INSTRUCTIONS:
- If the question implies a count or rate, give the aggregate as "X of the ${totalCorpus} calls (~Y%)" using the pre-computed total of ${totalMatching} matching calls. Do NOT re-count from the examples — trust the subset counts.
- Quote 2–4 of the strongest concrete examples (the example list is your evidence).
- Synthesize the subset theme_notes into 1–2 coherent paragraphs describing the pattern, common variations, and any notable outliers.
- Keep the full answer under 300 words.
- Include a one-line scope caveat ONLY IF scope materially affects the answer (e.g. the question asks about a time period that goes beyond the analysis window). Most answers do NOT need a caveat.
- NEVER say "I can't provide exact numbers" or "check the dashboard for exact figures".
${FORMAT_RULES}

AGGREGATE COUNT: ${totalMatching} of ${totalCorpus} calls matched (~${totalCorpus ? Math.round((totalMatching / totalCorpus) * 100) : 0}%)

SUBSET THEME NOTES:
${themeBullets}

EXAMPLES (call_id and English snippet):
${examplesBlock || '(no examples surfaced)'}`;

  const completion = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: question },
    ],
  });
  return {
    answer: completion.choices[0].message.content ?? '',
    aggregate_count: totalMatching,
    examples: allExamples,
  };
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Specific-lookup helpers ────────────────────────────────────────────────
function formatTieredContext(matches, { deepCount, deepPreviewChars }) {
  const lines = [];
  matches.forEach((m, i) => {
    const md = m.metadata || {};
    const header = `[${i + 1}] (${md.call_datetime_ist || '?'} · ${md.primary_topic || '?'} · ${md.call_language || '?'} · phone ${md.phone || '?'})`;
    const summary = md.final_summary || '(no summary)';
    if (i < deepCount) {
      const preview = String(md.transcript_preview || '').slice(0, deepPreviewChars);
      lines.push(`${header}\nSummary: ${summary}\nTranscript excerpt: ${preview}`);
    } else {
      lines.push(`${header}\nSummary: ${summary}`);
    }
  });
  return lines.join('\n\n');
}

const SPECIFIC_PROMPT = (count, ctx) =>
`You are an analyst for "Kaam Ki Baat", a voice AI that helps Indian blue-collar workers find jobs in Hindi and Kannada.

The user is asking to see specific examples. Below are ${count} relevant calls (top matches by similarity). The strongest matches include a transcript excerpt; weaker matches include just a summary. Answer based only on what is present — quote real caller statements (translated to English when needed).

Keep the answer under 300 words.
${FORMAT_RULES}
TRANSCRIPT CONTEXT:
${ctx}`;

const DASHBOARD_PROMPT = (ctx) =>
`You are an analyst for "Kaam Ki Baat", a voice AI that helps Indian blue-collar workers find jobs.

This question maps directly to a column already exposed in the dashboard. In ONE short paragraph:
1. State which dashboard widget/column gives the exact number.
2. Add 1–2 sentences of qualitative colour using the transcript excerpts below.

Do NOT try to recompute the count yourself — the dashboard has the full, current data.
${FORMAT_RULES}
TRANSCRIPT CONTEXT:
${ctx}`;

// ── Handler ────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid body' });

  const question = String(body.question ?? '').trim();
  if (!question) return res.status(400).json({ error: 'question required' });
  const namespace = body.namespace || process.env.PINECONE_NAMESPACE || 'kkb';

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // 1. Classify
    const cls = await classify(openai, question);
    const type = cls.type;

    let answer = '';
    let topMatches = [];
    let sourcesUsed = 0;

    if (type === 'corpus_aggregation') {
      // MAP-REDUCE over all 200 records.
      const records = await fetchAllNamespaceRecords(namespace);
      sourcesUsed = records.length;

      if (!records.length) {
        answer = 'No transcripts are currently in the analysis window. Once new calls come in, ask again.';
      } else {
        const chunks = chunkArray(records, MAP_CHUNK_SIZE);
        const mapResults = await Promise.all(
          chunks.map((c) => runMapChunk(openai, question, c, records.length))
        );
        const reduced = await runReduce(openai, question, mapResults, records.length);
        answer = reduced.answer;

        // Surface the examples the reducer was given so the UI can chip them.
        const exampleIds = (reduced.examples || []).slice(0, 5).map((e) => e.call_id);
        const idToRecord = new Map(records.map((r) => [String(r.call_id), r]));
        topMatches = exampleIds
          .map((id) => idToRecord.get(String(id)))
          .filter(Boolean)
          .map((r) => ({
            call_id: r.call_id,
            phone: r.metadata.phone ?? '',
            call_datetime_ist: r.metadata.call_datetime_ist ?? '',
            primary_topic: r.metadata.primary_topic ?? '',
            score: null,
            transcript_preview: r.metadata.transcript_preview ?? '',
          }));
        // Fallback: if reducer didn't supply any, show the most recent calls.
        if (!topMatches.length) {
          topMatches = records.slice(0, 5).map((r) => ({
            call_id: r.call_id,
            phone: r.metadata.phone ?? '',
            call_datetime_ist: r.metadata.call_datetime_ist ?? '',
            primary_topic: r.metadata.primary_topic ?? '',
            score: null,
            transcript_preview: r.metadata.transcript_preview ?? '',
          }));
        }
      }
    } else {
      // specific_lookup OR dashboard_metric → multi-lingual similarity search.
      const qVector = await buildMultilingualQueryVector(openai, question);

      const queryRes = await pineconeQuery({
        vector: qVector,
        topK: 100,
        namespace,
        includeMetadata: true,
      });
      const all = queryRes.matches ?? [];

      const isDashboard = type === 'dashboard_metric';
      const SCORE_THRESHOLD = 0.25;
      const MAX_FOR_LLM = isDashboard ? 10 : 50;
      const ctxMatches = all
        .filter((m) => (m.score ?? 0) >= SCORE_THRESHOLD)
        .slice(0, MAX_FOR_LLM);
      sourcesUsed = ctxMatches.length;

      const deepCount = isDashboard ? 4 : 12;
      const deepPreviewChars = isDashboard ? 4000 : 8000;
      const ctx = ctxMatches.length
        ? formatTieredContext(ctxMatches, { deepCount, deepPreviewChars })
        : '(no sufficiently relevant transcripts found)';

      const systemPrompt = isDashboard
        ? DASHBOARD_PROMPT(ctx)
        : SPECIFIC_PROMPT(ctxMatches.length, ctx);

      const completion = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: question },
        ],
      });
      answer = completion.choices?.[0]?.message?.content ?? '';

      topMatches = ctxMatches.slice(0, 5).map((m) => ({
        call_id: m.metadata?.call_id ?? m.id,
        phone: m.metadata?.phone ?? '',
        call_datetime_ist: m.metadata?.call_datetime_ist ?? '',
        primary_topic: m.metadata?.primary_topic ?? '',
        score: m.score,
        transcript_preview: m.metadata?.transcript_preview ?? '',
      }));
    }

    return res.status(200).json({
      answer,
      question_type: type,
      sources_used: sourcesUsed,
      top_matches: topMatches,
    });
  } catch (err) {
    console.error('chat handler error:', err?.message);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
}
