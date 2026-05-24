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

const QUAL_PROMPT = (count, ctx) =>
`You are an analyst for "Kaam Ki Baat", a voice AI that helps Indian blue-collar workers find jobs in Hindi and Kannada.

You have access to summaries and excerpts from the ${count} most relevant recent call transcripts. Answer based only on what is present in these transcripts. If the transcripts don't contain enough information, say so clearly. Do not invent patterns.

Be specific — reference what callers actually said or did when relevant. Keep the answer under 200 words but make it insightful.

TRANSCRIPT CONTEXT:
${ctx}`;

const QUANT_PROMPT = (ctx) =>
`You are an analyst for "Kaam Ki Baat", a voice AI that helps Indian blue-collar workers find jobs.

This is a counting or metrics question. For exact numbers, direct the user to use the dashboard filters which have complete data. Use the transcript context below to add qualitative colour to the numbers.

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
    const embedRes = await openai.embeddings.create({ model: EMBED_MODEL, input: question });
    const qVector = embedRes.data[0].embedding;

    // 3. Query Pinecone
    const queryRes = await pineconeQuery({
      vector: qVector,
      topK: 20,
      namespace,
      includeMetadata: true,
    });
    const matches = queryRes.matches ?? [];

    // 4. Slice context window
    const N = isQuant ? 10 : 15;
    const ctxMatches = matches.slice(0, N);
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
      top_matches: ctxMatches.slice(0, 3).map((m) => ({
        call_id: m.metadata?.call_id ?? m.id,
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
