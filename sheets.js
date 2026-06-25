'use strict';
/**
 * sheets.js – Google Sheets abstraction layer
 * Replaces the Apps Script sheet helpers (getSheet_, sheetToObjects_,
 * upsertRow_, deleteRowById_, etc.) with equivalent logic via the
 * googleapis Node.js client.
 *
 * All functions are async and return plain JS objects/arrays.
 */

const { google } = require('googleapis');
const path = require('path');

// ── Auth ──────────────────────────────────────────────────────────────
function getAuth() {
  const keyPath = path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './service-account-key.json');
  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth;
}

function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

const SHEET_ID = () => process.env.SHEET_ID;

// ── Tab definitions (mirrors Code.gs TABS) ───────────────────────────
const TABS = {
  Inventory: ['Product ID','Product Name','Category','Cost Price','Selling Price','Stock','Supplier Name','Invoice No','Invoice Date'],
  Customers: ['Customer ID','Customer Name','Mobile Number','WhatsApp Number','Purchase History'],
  Sales:     ['Sale ID','Date','Item/Customer Name','Type (Product/Repair)','Revenue','Cost','Profit'],
  Repairs:   ['Repair ID','Date','Customer Name','Phone','Brand','Model','Issue','Part Used (Product ID)','Repair Charge','Technician Cost','Status'],
  Expenses:  ['Expense ID','Date','Category','Amount','Notes'],
};

// ── Ensure tab exists with correct header ────────────────────────────
async function ensureTab(sheets, tabName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID() });
  const existing = meta.data.sheets.map(s => s.properties.title);

  if (!existing.includes(tabName)) {
    // Create the sheet tab
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID(),
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
    // Write header row
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID(),
      range: `${tabName}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [TABS[tabName]] },
    });
  } else {
    // Make sure header row exists
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID(),
      range: `${tabName}!A1:1`,
    });
    if (!res.data.values || res.data.values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID(),
        range: `${tabName}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [TABS[tabName]] },
      });
    }
  }
}

// ── Read all rows from a tab as an array of objects ──────────────────
async function sheetToObjects(tabName) {
  const sheets = getSheetsClient();
  await ensureTab(sheets, tabName);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: `${tabName}!A:${colLetter(TABS[tabName].length - 1)}`,
  });

  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const headers = rows[0];
  return rows.slice(1)
    .filter(r => r[0] !== '' && r[0] !== undefined && r[0] !== null)
    .map(r => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = r[i] !== undefined ? r[i] : ''; });
      return obj;
    });
}

// ── Find the 1-based row number for a given id value in column A ─────
async function findRowById(sheets, tabName, idValue) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: `${tabName}!A:A`,
  });
  const col = res.data.values || [];
  for (let i = 1; i < col.length; i++) {
    if (String(col[i][0]) === String(idValue)) return i + 1; // 1-based
  }
  return -1;
}

// ── Upsert a row (insert or update by column-A id) ───────────────────
async function upsertRow(tabName, idValue, fieldsObj) {
  const sheets = getSheetsClient();
  await ensureTab(sheets, tabName);
  const headers = TABS[tabName];
  const lastCol = colLetter(headers.length - 1);

  // Fetch existing row if present
  const rowNum = await findRowById(sheets, tabName, idValue);
  let existingRow = [];
  if (rowNum > 0) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID(),
      range: `${tabName}!A${rowNum}:${lastCol}${rowNum}`,
    });
    existingRow = (res.data.values || [[]])[0];
  }

  const finalRow = headers.map((h, i) => {
    if (Object.prototype.hasOwnProperty.call(fieldsObj, h)) return fieldsObj[h];
    return existingRow[i] !== undefined ? existingRow[i] : '';
  });

  if (rowNum > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(),
      range: `${tabName}!A${rowNum}:${lastCol}${rowNum}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [finalRow] },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID(),
      range: `${tabName}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [finalRow] },
    });
  }

  return finalRow;
}

// ── Delete a row by its column-A id value ────────────────────────────
async function deleteRowById(tabName, idValue) {
  const sheets = getSheetsClient();
  await ensureTab(sheets, tabName);

  const rowNum = await findRowById(sheets, tabName, idValue);
  if (rowNum < 0) return;

  // Get the numeric sheetId for the named tab
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID() });
  const tabMeta = meta.data.sheets.find(s => s.properties.title === tabName);
  if (!tabMeta) return;
  const sheetId = tabMeta.properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID(),
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: rowNum - 1, endIndex: rowNum },
        },
      }],
    },
  });
}

// ── Get last row count for a tab (used to generate sequential IDs) ───
async function getLastRow(tabName) {
  const sheets = getSheetsClient();
  await ensureTab(sheets, tabName);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: `${tabName}!A:A`,
  });
  return (res.data.values || []).length;
}

// ── Column index → letter (A, B, … Z, AA, …) ────────────────────────
function colLetter(zeroIdx) {
  let n = zeroIdx + 1, s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ── Today's date as yyyy-MM-dd ────────────────────────────────────────
function today() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = { sheetToObjects, upsertRow, deleteRowById, getLastRow, TABS, today };
