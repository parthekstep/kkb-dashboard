import { logError } from './sheets.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractIds(payload) {
  const body = payload?.body ?? {};
  return {
    call_id: body.uuid ?? '',
    phone: body.contact_phone ?? body.to_number ?? '',
  };
}

export async function runWithRetry(fn, payload, taskName) {
  const { call_id, phone } = extractIds(payload);

  try {
    await fn();
    return;
  } catch (err1) {
    console.error(`[${taskName}] first attempt failed:`, err1?.message);
    await sleep(2000);
    try {
      await fn();
      await logError(
        call_id,
        phone,
        taskName,
        `First attempt failed: ${err1?.message}`,
        err1?.stack ?? '',
        true,
        true
      );
    } catch (err2) {
      console.error(`[${taskName}] retry failed:`, err2?.message);
      await logError(
        call_id,
        phone,
        taskName,
        err2?.message ?? String(err2),
        err2?.stack ?? '',
        true,
        false
      );
    }
  }
}
