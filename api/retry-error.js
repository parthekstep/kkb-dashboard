/**
 * POST /api/retry-error
 * Body: { call_id, task, timestamp_ist?, batch_ids?: string[] }
 *
 * Fetches the call from Raya, optionally resolves contact_id via batch lookup,
 * re-runs the specified task synchronously, and on success removes the matching
 * row from the Errors sheet. Returns { ok, status, message }.
 */

import { taskA_metrics } from '../utils/extractMetrics.js';
import { taskB_profile } from '../utils/extractProfile.js';
import { getCall, findContactForCall, buildPayloadFromRaya } from '../utils/raya.js';
import { findErrorRow, deleteErrorRowByIndex, logError } from '../utils/sheets.js';

export const config = { runtime: 'nodejs' };

const TASKS = {
  metrics: taskA_metrics,
  profile: taskB_profile,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, message: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, message: 'Invalid body' });
  }

  const { call_id, task, timestamp_ist, batch_ids } = body;
  if (!call_id || !task) {
    return res.status(400).json({ ok: false, message: 'call_id and task required' });
  }
  const taskFn = TASKS[String(task).toLowerCase()];
  if (!taskFn) {
    return res.status(400).json({ ok: false, message: `Unknown task: ${task}` });
  }

  try {
    // 1. Fetch the call from Raya.
    const call = await getCall(call_id);

    // 2. Resolve contact via batch lookup if batch_ids provided (needed for profile task).
    let contact = null;
    if (Array.isArray(batch_ids) && batch_ids.length) {
      contact = await findContactForCall(call_id, batch_ids);
    }

    if (task === 'profile' && !contact?.contact_id) {
      return res.status(400).json({
        ok: false,
        message: 'Profile retry requires batch_ids that contain this call (need contact_id).',
      });
    }

    // 3. Build the webhook-shape payload and run the task.
    const payload = buildPayloadFromRaya(call, contact);
    if (!payload.body.call_transcript || payload.body.call_transcript.length === 0) {
      return res.status(400).json({
        ok: false,
        message: 'Raya returned no transcript for this call; nothing to re-process.',
      });
    }

    await taskFn(payload);

    // 4. Success — delete the matching error row.
    let deletedRow = null;
    const rowIdx = await findErrorRow(call_id, task, timestamp_ist);
    if (rowIdx) {
      await deleteErrorRowByIndex(rowIdx);
      deletedRow = rowIdx;
    }

    return res.status(200).json({
      ok: true,
      message: `Retry succeeded for ${task}/${call_id}`,
      deletedErrorRow: deletedRow,
    });
  } catch (err) {
    // Log as a fresh error row so the failed retry is tracked.
    await logError(
      call_id,
      '',
      `${task}-retry`,
      err?.message ?? String(err),
      err?.stack ?? '',
      true,
      false
    );
    return res.status(500).json({
      ok: false,
      message: err?.message ?? String(err),
    });
  }
}
