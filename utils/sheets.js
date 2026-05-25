import { google } from 'googleapis';

let cachedSheets = null;

function getSheetsClient() {
  if (cachedSheets) return cachedSheets;

  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  if (!b64) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 not set');

  const creds = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );

  cachedSheets = google.sheets({ version: 'v4', auth });
  return cachedSheets;
}

export async function appendCallRecord(row) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'Sheet1!A:U',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

/**
 * Find the 1-based sheet row index of an error matching (call_id, task, timestamp_ist).
 * Returns null if not found. `timestamp_ist` may be omitted to match the most recent
 * row for that (call_id, task).
 */
export async function findErrorRow(call_id, task, timestamp_ist) {
  const sheets = getSheetsClient();
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'Errors!A:D',
  });
  const rows = data.values ?? [];
  // rows[0] is header; iterate from end (newest) so unspecified timestamp picks latest
  for (let i = rows.length - 1; i >= 1; i--) {
    const [ts, cid, , tk] = rows[i];
    if (cid === call_id && (tk || '').toLowerCase() === task.toLowerCase()) {
      if (!timestamp_ist || ts === timestamp_ist) return i + 1; // 1-based
    }
  }
  return null;
}

/**
 * Delete a row from the Errors sheet by its 1-based row index. Uses the
 * batchUpdate/deleteDimension API since `values` API can't delete rows.
 */
export async function deleteErrorRowByIndex(rowIndex1Based) {
  const sheets = getSheetsClient();
  // Need the sheetId (gid) for the "Errors" tab.
  const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.SPREADSHEET_ID });
  const errorsSheet = meta.data.sheets.find((s) => s.properties.title === 'Errors');
  if (!errorsSheet) throw new Error('Errors tab not found');
  const sheetId = errorsSheet.properties.sheetId;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.SPREADSHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex1Based - 1, // API is 0-based
            endIndex: rowIndex1Based,
          },
        },
      }],
    },
  });
}

// ── EmbedManifest helpers ────────────────────────────────────────────────────
// Source of truth for which call_ids are currently embedded in Pinecone (free
// tier doesn't expose listing). One row per embedded call:
//   call_id | call_datetime_ist | namespace
// Tab must be created manually with that header — see README.

export async function appendEmbedManifest(call_id, call_datetime_ist, namespace) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'EmbedManifest!A:C',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[call_id, call_datetime_ist, namespace]] },
  });
}

export async function readEmbedManifest(namespace) {
  const sheets = getSheetsClient();
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'EmbedManifest!A2:C',
  });
  return (data.values ?? [])
    .map((r, i) => ({
      call_id: r[0],
      call_datetime_ist: r[1],
      namespace: r[2],
      rowIndex: i + 2, // +2 = 1-based + skip header
    }))
    .filter((r) => r.namespace === namespace && r.call_id);
}

export async function deleteEmbedManifestRows(rowIndices1Based) {
  if (!rowIndices1Based.length) return;
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.SPREADSHEET_ID });
  const tab = meta.data.sheets.find((s) => s.properties.title === 'EmbedManifest');
  if (!tab) throw new Error('EmbedManifest tab not found');
  const sheetId = tab.properties.sheetId;
  // Delete bottom-up so earlier deletes don't shift later indices.
  const sorted = [...rowIndices1Based].sort((a, b) => b - a);
  const requests = sorted.map((idx) => ({
    deleteDimension: {
      range: { sheetId, dimension: 'ROWS', startIndex: idx - 1, endIndex: idx },
    },
  }));
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.SPREADSHEET_ID,
    requestBody: { requests },
  });
}

function istTimestamp() {
  const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

export async function logError(call_id, phone, task, errorMessage, stackTrace, retryAttempted, retrySucceeded) {
  try {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'Errors!A:H',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          istTimestamp(),
          call_id ?? '',
          phone ?? '',
          task ?? '',
          errorMessage ?? '',
          stackTrace ?? '',
          retryAttempted ? 'TRUE' : 'FALSE',
          retrySucceeded ? 'TRUE' : 'FALSE',
        ]],
      },
    });
  } catch (e) {
    console.error('logError failed:', e?.message);
  }
}
