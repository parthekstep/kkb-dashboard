/**
 * POST /api/chat
 *
 * Body: { question: string, namespace?: string }  // namespace defaults to 'kkb'
 *
 * Pipeline:
 *   1. Classify question (quantitative vs qualitative) — gpt-4o-mini strict JSON.
 *   2. Embed question — text-embedding-3-small.
 *   3. Query Pinecone (topK=20, includeMetadata=true).
 *   4. Build context from top 15 (qual) or 10 (quant) matches.
 *   5. Answer with gpt-4o-mini.
 *
 * Response:
 *   {
 *     answer, question_type, sources_used,
 *     top_matches: [{ call_id, call_datetime_ist, primary_topic, score, transcript_preview }] // top 3
 *   }
 */

import OpenAI from 'openai';
import { pineconeQuery } from '../utils/pinecone.js';

export const config = { runtime: 'nodejs' };

const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIMENSIONS = 1024; // Match the Pinecone index dimension.
const CHAT_MODEL = 'gpt-4o-mini';

const classifierSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['quantitative', 'qualitative'] },
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
`Classify this question into one of two types:
- "quantitative": asks for counts, rates, percentages, or numbers derivable from structured data (e.g. "how many calls were answered", "what is the application rate")
- "qualitative": asks about reasons, themes, patterns, sentiment, or specific things people said (e.g. "why are people not applying", "what objections come up")

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

function formatContext(matches) {
  return matches
    .map((m, i) => {
      const md = m.metadata || {};
      return `[${i + 1}] (${md.call_datetime_ist || '?'} · ${md.primary_topic || '?'} · ${md.call_language || '?'})
Summary: ${md.final_summary || '(none)'}
Excerpt: ${md.transcript_preview || '(none)'}`;
    })
    .join('\n\n');
}

const FORMAT_RULES = `
FORMATTING RULES (strict):
- Plain text only. No Markdown. No **bold**, no *italics*, no ### headings, no - bullet lists, no backticks.
- If you need a list, write it as numbered lines: "1. foo\\n2. bar".
- Use blank lines for paragraph breaks.
- Never wrap quotes in asterisks; use plain quotation marks.
`;

const QUAL_PROMPT = (count, ctx) =>
`You are an analyst for "Kaam Ki Baat", a voice AI that helps Indian blue-collar workers find jobs in Hindi and Kannada.

You have access to summaries and excerpts from the ${count} most relevant recent call transcripts. Answer based only on what is present in these transcripts. If the transcripts don't contain enough information, say so clearly. Do not invent patterns.

Be specific — reference what callers actually said or did when relevant. Keep the answer under 250 words but make it insightful.
${FORMAT_RULES}
TRANSCRIPT CONTEXT:
${ctx}`;

const QUANT_PROMPT = (ctx) =>
`You are an analyst for "Kaam Ki Baat", a voice AI that helps Indian blue-collar workers find jobs.

This is a counting or metrics question. For exact numbers, direct the user to use the dashboard filters which have complete data. Use the transcript context below to add qualitative colour to the numbers.
${FORMAT_RULES}
TRANSCRIPT CONTEXT:
${ctx}`;

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
    const isQuant = cls.type === 'quantitative';

    // 2. Embed question
    const embedRes = await openai.embeddings.create({
      model: EMBED_MODEL,
      input: question,
      dimensions: EMBED_DIMENSIONS,
    });
    const qVector = embedRes.data[0].embedding;

    // 3. Query Pinecone — pull the full namespace's worth of candidates so we
    //    don't artificially cap what the LLM can reason over. We then filter
    //    by score (drops obvious irrelevants) and cap by token budget.
    const queryRes = await pineconeQuery({
      vector: qVector,
      topK: 100,
      namespace,
      includeMetadata: true,
    });
    const allMatches = queryRes.matches ?? [];

    // 4. Filter by relevance score, then cap by count. gpt-4o-mini has a 128k
    //    context; each preview is ~4k chars (~1k tokens) + ~200 chars of
    //    summary, so 50 matches ≈ 60k tokens of context. Plenty of headroom.
    const SCORE_THRESHOLD = 0.25;        // anything below is barely related
    const MAX_FOR_LLM = isQuant ? 30 : 50;
    const ctxMatches = allMatches
      .filter((m) => (m.score ?? 0) >= SCORE_THRESHOLD)
      .slice(0, MAX_FOR_LLM);
    const ctx = ctxMatches.length ? formatContext(ctxMatches) : '(no relevant transcripts found)';

    // 5. Answer
    const systemPrompt = isQuant ? QUANT_PROMPT(ctx) : QUAL_PROMPT(ctxMatches.length, ctx);
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question },
      ],
    });
    const answer = completion.choices?.[0]?.message?.content ?? '';

    return res.status(200).json({
      answer,
      question_type: cls.type,
      sources_used: ctxMatches.length,
      top_matches: ctxMatches.slice(0, 5).map((m) => ({
        call_id: m.metadata?.call_id ?? m.id,
        phone: m.metadata?.phone ?? '',
        call_datetime_ist: m.metadata?.call_datetime_ist ?? '',
        primary_topic: m.metadata?.primary_topic ?? '',
        score: m.score,
        transcript_preview: m.metadata?.transcript_preview ?? '',
      })),
    });
  } catch (err) {
    console.error('chat handler error:', err?.message);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
}
