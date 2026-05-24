/**
 * POST /api/chat
 *
 * Body: { question: string, namespace?: string }  // namespace defaults to 'kkb'
 *
 * Pipeline:
 *   1. Classify question into one of three types:
 *        - quantitative — counts/rates → point to dashboard, light context
 *        - specific     — about a topic/theme/sub-population → similarity search
 *        - overview     — corpus-wide summary → fetch ALL namespace metadata
 *   2. For specific/quantitative: multi-lingual query expansion. Translate the
 *      question into Hindi + Kannada via gpt-4o-mini, embed all three, average
 *      the vectors. This roughly doubles the chance of matching native-language
 *      transcripts where the structured English summary fields don't carry
 *      enough signal.
 *   3. Query Pinecone (topK=100), filter by relevance score, then build a
 *      TIERED context: the top N matches get their full transcript_preview,
 *      the next tier gets just their summary — so the LLM gets deep detail
 *      on the strongest matches and broad coverage from the rest.
 *   4. For overview: skip similarity search entirely. Fetch the metadata for
 *      every call_id in the EmbedManifest (small enough — only summaries,
 *      not previews) and let the LLM identify themes across the whole corpus.
 *   5. Answer with gpt-4o-mini.
 */

import OpenAI from 'openai';
import { pineconeQuery, pineconeFetch } from '../utils/pinecone.js';
import { readEmbedManifest } from '../utils/sheets.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIMENSIONS = 1024;
const CHAT_MODEL = 'gpt-4o-mini';

// ── Classification ─────────────────────────────────────────────────────────
const classifierSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['quantitative', 'specific', 'overview'] },
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
`Classify this question into one of three types:
- "quantitative": asks for counts, rates, percentages, or numbers derivable from structured data (e.g. "how many calls were answered", "what is the application rate", "how many people speak Kannada").
- "overview": asks about themes, patterns, summaries across the whole corpus, or general "what's going on" sentiment (e.g. "what are the main themes", "give me a summary of last week", "what do callers generally say about salary", "any common complaints?").
- "specific": asks about reasons, sub-populations, or a specific phenomenon (e.g. "why are people not applying", "what objections come up for security guard roles", "what do callers say when the bot doesn't understand them"). Default to this when ambiguous between overview and specific.

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

// ── Multi-lingual query expansion ──────────────────────────────────────────
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
`Translate the following English analyst question into the colloquial Hindi and Kannada a job-seeker might actually say on a phone call. Keep it natural — use Devanagari for Hindi and Kannada script for Kannada. Don't translate technical terms like "application rate". Return JSON only.`,
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
  // Normalise to unit length so cosine sim stays meaningful.
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

// ── Context construction ──────────────────────────────────────────────────
// Tiered: the strongest matches get their full transcript preview; the rest
// get a one-line summary. This gives the LLM deep evidence on the best hits
// plus broad coverage across the corpus, all within the token budget.
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

function formatOverviewContext(records) {
  // Each record = { call_id, metadata }. We want one short line per call.
  return records
    .map((r, i) => {
      const md = r.metadata || {};
      return `[${i + 1}] (${md.call_datetime_ist || '?'} · ${md.primary_topic || '?'} · ${md.call_language || '?'}) ${md.final_summary || '(no summary)'}`;
    })
    .join('\n');
}

// ── Prompts ────────────────────────────────────────────────────────────────
const FORMAT_RULES = `
FORMATTING RULES (strict):
- Plain text only. No Markdown. No **bold**, no *italics*, no ### headings, no - bullet lists, no backticks.
- If you need a list, write it as numbered lines: "1. foo\\n2. bar".
- Use blank lines for paragraph breaks.
- Never wrap quotes in asterisks; use plain quotation marks.
`;

const SPECIFIC_PROMPT = (count, ctx) =>
`You are an analyst for "Kaam Ki Baat", a voice AI that helps Indian blue-collar workers find jobs in Hindi and Kannada.

You have access to ${count} relevant call transcripts. The strongest matches include a transcript excerpt; weaker matches include just a summary. Answer based only on what is present in these transcripts. If the transcripts don't contain enough information, say so clearly. Do not invent patterns.

Be specific — reference what callers actually said or did, and quote short snippets (translated to English) when useful. Keep the answer under 300 words but make it insightful.
${FORMAT_RULES}
TRANSCRIPT CONTEXT:
${ctx}`;

const QUANT_PROMPT = (ctx) =>
`You are an analyst for "Kaam Ki Baat", a voice AI that helps Indian blue-collar workers find jobs.

This is a counting or metrics question. For exact numbers, direct the user to use the dashboard filters which have complete data. Use the transcript context below to add qualitative colour to the numbers.
${FORMAT_RULES}
TRANSCRIPT CONTEXT:
${ctx}`;

const OVERVIEW_PROMPT = (count, ctx) =>
`You are an analyst for "Kaam Ki Baat", a voice AI that helps Indian blue-collar workers find jobs in Hindi and Kannada.

The user is asking a corpus-wide question. Below are short summaries for ALL ${count} recent calls currently in the analysis window (not a similarity-filtered subset). Identify the main themes, patterns, and notable outliers across the whole corpus.

Be specific — quote concrete examples and give rough counts where they're obvious from the data ("around half mentioned X", "a handful complained about Y"). Keep the answer under 350 words.
${FORMAT_RULES}
CALL SUMMARIES (${count} total):
${ctx}`;

// ── Pinecone fetch in batches (overview path) ──────────────────────────────
async function fetchAllNamespaceRecords(namespace) {
  const manifest = await readEmbedManifest(namespace);
  const ids = manifest.map((r) => String(r.call_id));
  if (!ids.length) return [];
  const BATCH = 100; // Pinecone /vectors/fetch sweet spot
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
  // Sort newest-first for narrative coherence in the LLM's view.
  out.sort((a, b) =>
    String(b.metadata.call_datetime_ist || '').localeCompare(
      String(a.metadata.call_datetime_ist || '')
    )
  );
  return out;
}

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
    const type = cls.type; // 'quantitative' | 'specific' | 'overview'

    let answer = '';
    let topMatches = [];
    let sourcesUsed = 0;

    if (type === 'overview') {
      // OVERVIEW PATH — skip similarity search, look at the whole corpus.
      const records = await fetchAllNamespaceRecords(namespace);
      sourcesUsed = records.length;
      const ctx = records.length
        ? formatOverviewContext(records)
        : '(no transcripts in the analysis window)';

      const completion = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: OVERVIEW_PROMPT(records.length, ctx) },
          { role: 'user', content: question },
        ],
      });
      answer = completion.choices?.[0]?.message?.content ?? '';

      // Return the 5 most recent calls as illustrative sources.
      topMatches = records.slice(0, 5).map((r) => ({
        call_id: r.call_id,
        phone: r.metadata.phone ?? '',
        call_datetime_ist: r.metadata.call_datetime_ist ?? '',
        primary_topic: r.metadata.primary_topic ?? '',
        score: null,
        transcript_preview: r.metadata.transcript_preview ?? '',
      }));
    } else {
      // SPECIFIC or QUANTITATIVE — multi-lingual similarity search.
      const qVector = await buildMultilingualQueryVector(openai, question);

      const queryRes = await pineconeQuery({
        vector: qVector,
        topK: 100,
        namespace,
        includeMetadata: true,
      });
      const all = queryRes.matches ?? [];

      const isQuant = type === 'quantitative';
      const SCORE_THRESHOLD = 0.25;
      const MAX_FOR_LLM = isQuant ? 30 : 50;
      const ctxMatches = all
        .filter((m) => (m.score ?? 0) >= SCORE_THRESHOLD)
        .slice(0, MAX_FOR_LLM);
      sourcesUsed = ctxMatches.length;

      // Tiered: more deep matches for specific, fewer for quant (more breadth).
      const deepCount = isQuant ? 6 : 12;
      const deepPreviewChars = isQuant ? 6000 : 8000;
      const ctx = ctxMatches.length
        ? formatTieredContext(ctxMatches, { deepCount, deepPreviewChars })
        : '(no sufficiently relevant transcripts found)';

      const systemPrompt = isQuant
        ? QUANT_PROMPT(ctx)
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
