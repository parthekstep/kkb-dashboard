/**
 * Thin REST wrappers around the Pinecone Data Plane API.
 * Free-tier safe: never relies on metadata-filtered listing.
 *
 * Env:
 *   PINECONE_API_KEY     — required
 *   PINECONE_INDEX_HOST  — full https://...pinecone.io host for the index
 */

function host() {
  const h = process.env.PINECONE_INDEX_HOST;
  if (!h) throw new Error('PINECONE_INDEX_HOST not set');
  return h.replace(/\/$/, '');
}

function headers() {
  const k = process.env.PINECONE_API_KEY;
  if (!k) throw new Error('PINECONE_API_KEY not set');
  return { 'Api-Key': k, 'Content-Type': 'application/json' };
}

async function call(method, path, body) {
  const res = await fetch(`${host()}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Pinecone ${method} ${path} → ${res.status}: ${txt.slice(0, 400)}`);
  }
  // Some endpoints (delete) return empty body
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

export async function pineconeUpsert(vectors, namespace) {
  return call('POST', '/vectors/upsert', { vectors, namespace });
}

export async function pineconeQuery({ vector, topK = 10, namespace, includeMetadata = true }) {
  return call('POST', '/query', { vector, topK, namespace, includeMetadata });
}

export async function pineconeFetch(ids, namespace) {
  const qs = new URLSearchParams();
  for (const id of ids) qs.append('ids', id);
  if (namespace) qs.set('namespace', namespace);
  return call('GET', `/vectors/fetch?${qs.toString()}`);
}

export async function pineconeDelete(ids, namespace) {
  return call('POST', '/vectors/delete', { ids, namespace });
}
