/**
 * Thin wrappers around the Raya (Bolna) API used for error retries.
 *  - getCall(uuid)               → call detail (transcript, duration, etc.)
 *  - getBatchContacts(batch_id)  → array of {contact_id, phone, calls:[{uuid,...}]}
 *
 * Auth: header `X-API-Key: <RAYA_API_KEY>`.
 */

const BASE = process.env.RAYA_API_BASE || 'https://v1.getraya.app/api';

function authHeaders() {
  const key = process.env.RAYA_API_KEY;
  if (!key) throw new Error('RAYA_API_KEY not set');
  return { 'X-API-Key': key };
}

export async function getCall(uuid) {
  const res = await fetch(`${BASE}/call/${encodeURIComponent(uuid)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Raya getCall ${uuid} → ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json();
}

export async function getBatchContacts(batch_id) {
  // Paginate in case >100 contacts; the API caps `limit` at 100.
  const all = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const url = `${BASE}/batch/${encodeURIComponent(batch_id)}/contacts?limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Raya getBatchContacts ${batch_id} → ${res.status}: ${t.slice(0, 300)}`);
    }
    const data = await res.json();
    const contacts = data.contacts ?? [];
    all.push(...contacts);
    if (contacts.length < limit) break;
    offset += limit;
    if (offset >= (data.total ?? Infinity)) break;
  }
  return all;
}

/**
 * Given an array of batch IDs and a call UUID, search the batches and return
 * { contact_id, phone, contact_name } for the contact owning that call, or null.
 */
export async function findContactForCall(uuid, batch_ids) {
  for (const bid of batch_ids) {
    let contacts;
    try { contacts = await getBatchContacts(bid); }
    catch (e) { console.warn(`Batch ${bid} fetch failed:`, e.message); continue; }
    for (const c of contacts) {
      if (Array.isArray(c.calls) && c.calls.some((k) => k?.uuid === uuid)) {
        return { contact_id: c.contact_id, phone: c.phone, contact_name: c.name };
      }
    }
  }
  return null;
}

/**
 * Build the `{body:...}` payload our existing taskA_metrics / taskB_profile expect,
 * from a Raya call detail object + optional contact info from a batch lookup.
 */
export function buildPayloadFromRaya(call, contact) {
  const phone =
    contact?.phone ??
    call?.agent_args?.contact_phone ??
    call?.to_number ??
    '';
  return {
    body: {
      uuid: call.uuid,
      call_transcript: Array.isArray(call.call_transcript) ? call.call_transcript : [],
      contact_phone: String(phone || '').replace(/^\+/, ''),
      to_number: call.to_number ?? '',
      contact_id: contact?.contact_id ?? null,
      call_duration: call.call_duration ?? 0,
      call_start_time: call.call_start_time ?? '',
      outcome: call.outcome ?? '',
      call_recording_url: call.call_recording_url ?? '',
    },
  };
}
