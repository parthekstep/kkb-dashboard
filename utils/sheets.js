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
    range: 'Sheet1!A:P',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
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
