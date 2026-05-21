import { waitUntil } from '@vercel/functions';
import { taskA_metrics } from '../utils/extractMetrics.js';
import { taskB_profile } from '../utils/extractProfile.js';
import { runWithRetry } from '../utils/retry.js';

export const config = { runtime: 'nodejs' };

async function processCall(payload) {
  await Promise.allSettled([
    runWithRetry(() => taskA_metrics(payload), payload, 'metrics'),
    runWithRetry(() => taskB_profile(payload), payload, 'profile'),
  ]);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Spec: required fields are body.uuid and body.call_transcript.
  // Bolna/Raya send the call envelope at the top level, so the "payload" we pass
  // downstream wraps it as { body: <incoming JSON> }.
  const inner = body.body ?? body;
  if (!inner.uuid || !inner.call_transcript) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  res.status(200).json({ status: 'received', call_id: inner.uuid });

  const payload = { body: inner };
  waitUntil(processCall(payload));
}
