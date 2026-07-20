'use strict';
/**
 * sheets.js – Google Sheets abstraction layer
 * Replaces the Apps Script sheet helpers (getSheet_, sheetToObjects_,
 * upsertRow_, deleteRowById_, etc.) with equivalent logic via the
 * googleapis Node.js client.
 *
 * MULTI-BRANCH: this shop runs two physical branches, each backed by its
 * own Google Sheet (own Inventory/Customers/Sales/Repairs/Expenses tabs).
 * Every operational function below takes an explicit `spreadsheetId` so
 * the caller (routes/api.js) decides which branch's sheet to read/write —
 * this module has no built-in notion of "the" sheet anymore, except for
 * the one MASTER sheet that holds the shared Users/login tab.
 *
 * All functions are async and return plain JS objects/arrays.
 */

const { google } = require('googleapis');
const path = require('path');

// ── Auth ──────────────────────────────────────────────────────────────
function getAuth() {
  // On Vercel (and anywhere a file can't be committed/uploaded), the key is
  // pasted directly as JSON text into the GOOGLE_SERVICE_ACCOUNT_KEY env var.
  // Locally, GOOGLE_SERVICE_ACCOUNT_KEY_PATH points at a downloaded key file.
  const inlineKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (inlineKey) {
    let credentials;
    try {
      credentials = JSON.parse(inlineKey);
    } catch (err) {
      throw new Error(
        'GOOGLE_SERVICE_ACCOUNT_KEY is set but is not valid JSON. ' +
        'Paste the ENTIRE contents of the downloaded service-account-key.json file ' +
        '(including the { } braces) as the value of this environment variable.'
      );
    }
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }

  const keyPath = path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './service-account-key.json');
  return new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

// ── Branches ──────────────────────────────────────────────────────────
// Clean up a Sheet ID env var: trims whitespace/newlines and strips
// accidental wrapping quotes — both are common copy-paste mistakes when
// pasting into a hosting provider's environment variable UI, and Google's
// API returns a generic "Requested entity was not found" for a mangled ID
// rather than a clear "invalid format" error, so this is worth guarding.
function cleanId(raw) {
  if (!raw) return raw;
  let id = String(raw).trim();
  if ((id.startsWith('"') && id.endsWith('"')) || (id.startsWith("'") && id.endsWith("'"))) {
    id = id.slice(1, -1).trim();
  }
  return id;
}

// MASTER_SHEET_ID: the original single sheet — now used ONLY for the
// shared Users/login tab (one login list for both branches' staff+admin).
const MASTER_SHEET_ID = () => cleanId(process.env.SHEET_ID);

// Each branch has its own fully separate spreadsheet (own Inventory,
// Customers, Sales, Repairs, Expenses tabs). Add more entries here if a
// third branch opens later — no other code changes needed.
const BRANCHES = {
  Sithalapakkam: () => cleanId(process.env.SHEET_ID_SITHALAPAKKAM),
  Arasankazhani: () => cleanId(process.env.SHEET_ID_ARASANKAZHANI),
};

function branchNames() {
  return Object.keys(BRANCHES);
}

// Short prefix used in sequential invoice numbers (e.g. "STK-000042"), so
// invoices are readable and each branch's numbering never collides with
// the other's even though they're generated from two separate sheets.
const BRANCH_INVOICE_PREFIX = {
  Sithalapakkam: 'STK',
  Arasankazhani: 'ARK',
};
function invoicePrefixFor(branch) {
  return BRANCH_INVOICE_PREFIX[branch] || String(branch || 'BR').slice(0, 3).toUpperCase();
}

// Resolve a branch name to its spreadsheet ID, with a clear error if the
// branch is unknown or its env var isn't configured yet.
function resolveBranchSheetId(branch) {
  if (!branch) throw new Error('No branch specified');
  const getter = BRANCHES[branch];
  if (!getter) throw new Error(`Unknown branch "${branch}". Known branches: ${branchNames().join(', ')}`);
  const id = getter();
  if (!id) throw new Error(`Branch "${branch}" has no Sheet ID configured (set SHEET_ID_${branch.toUpperCase()} in your environment variables)`);
  return id;
}

// ── Tab definitions (mirrors Code.gs TABS) ───────────────────────────
const TABS = {
  Inventory: ['Product ID','Product Name','Category','Subcategory','Brand','Model','HSN Code','IMEI','Batch No','Cost Price','Selling Price','Stock','Supplier Name','Invoice No','Invoice Date'],
  Customers: ['Customer ID','Customer Name','Mobile Number','WhatsApp Number','Purchase History','Pending Amount','Description'],
  Sales:     ['Sale ID','Date','Item/Customer Name','Customer Mobile','Type (Product/Repair)','Revenue','Cost','Profit','Payment Mode','Cash Amount','UPI Amount','Invoice No','Status'],
  SaleItems: ['Row ID','Sale ID','Product ID','Product Name','Qty','Price','Amount'],
  Repairs:   ['Repair ID','Date','Customer Name','Phone','Brand','Model','Issue','Part Used (Product ID)','Repair Charge','Technician Cost','Status'],
  Expenses:  ['Expense ID','Date','Category','Amount','Notes'],
  Finance:   ['Loan ID','Date','Invoice No','Customer Name','Customer Mobile','Partner','App ID','Down Payment','Loan Amount','Status'],
  ActivityLog: ['Log ID','Timestamp','Username','Role','Action','Details'],
  Users:     ['Username','Password Hash','Role','Display Name','Branch'],
};

// Category → allowed subcategories (frontend also has this list; kept here
// too so server-side validation / AI ingestion can use it)
const CATEGORIES = {
  Mobiles: [],
  Accessories: [
    'Tempered Glass','Back Cover','Charger','Cable','OTG',
    'Speaker','Airpods/TWS','Neckband','Computer Accessory','Other Accessory',
  ],
  Spares: [],
};

// ── Ensure tab exists with correct header ────────────────────────────
async function ensureTab(sheets, tabName, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.map(s => s.properties.title);

  if (!existing.includes(tabName)) {
    // Create the sheet tab
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
    // Write header row
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [TABS[tabName]] },
    });
  } else {
    // Make sure header row exists, and matches the current expected TABS shape.
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tabName}!A1:1`,
    });
    const existingHeader = (res.data.values || [])[0] || [];
    if (existingHeader.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tabName}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [TABS[tabName]] },
      });
    } else {
      // Auto-migrate: append any columns defined in TABS that are missing
      // from the sheet's current header (e.g. after a code update adds a
      // new field). Existing columns and their data are left untouched.
      const missing = TABS[tabName].filter(col => !existingHeader.includes(col));
      if (missing.length > 0) {
        const newHeader = [...existingHeader, ...missing];
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${tabName}!A1`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [newHeader] },
        });
      }
    }
  }
}

// ── Read all rows from a tab as an array of objects ──────────────────
async function sheetToObjects(tabName, spreadsheetId) {
  if (!spreadsheetId) throw new Error(`sheetToObjects("${tabName}") called without a spreadsheetId`);
  const sheets = getSheetsClient();
  await ensureTab(sheets, tabName, spreadsheetId);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A:${colLetter(TABS[tabName].length - 1)}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
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
async function findRowById(sheets, tabName, idValue, spreadsheetId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A:A`,
  });
  const col = res.data.values || [];
  for (let i = 1; i < col.length; i++) {
    if (String(col[i][0]) === String(idValue)) return i + 1; // 1-based
  }
  return -1;
}

// ── Upsert a row (insert or update by column-A id) ───────────────────
async function upsertRow(tabName, idValue, fieldsObj, spreadsheetId) {
  if (!spreadsheetId) throw new Error(`upsertRow("${tabName}") called without a spreadsheetId`);
  const sheets = getSheetsClient();
  await ensureTab(sheets, tabName, spreadsheetId);
  const headers = TABS[tabName];
  const lastCol = colLetter(headers.length - 1);

  // Fetch existing row if present
  const rowNum = await findRowById(sheets, tabName, idValue, spreadsheetId);
  let existingRow = [];
  if (rowNum > 0) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tabName}!A${rowNum}:${lastCol}${rowNum}`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    existingRow = (res.data.values || [[]])[0];
  }

  const finalRow = headers.map((h, i) => {
    if (Object.prototype.hasOwnProperty.call(fieldsObj, h)) return fieldsObj[h];
    return existingRow[i] !== undefined ? existingRow[i] : '';
  });

  if (rowNum > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabName}!A${rowNum}:${lastCol}${rowNum}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [finalRow] },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [finalRow] },
    });
  }

  return finalRow;
}

// ── Delete a row by its column-A id value ────────────────────────────
async function deleteRowById(tabName, idValue, spreadsheetId) {
  if (!spreadsheetId) throw new Error(`deleteRowById("${tabName}") called without a spreadsheetId`);
  const sheets = getSheetsClient();
  await ensureTab(sheets, tabName, spreadsheetId);

  const rowNum = await findRowById(sheets, tabName, idValue, spreadsheetId);
  if (rowNum < 0) return;

  // Get the numeric sheetId for the named tab
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const tabMeta = meta.data.sheets.find(s => s.properties.title === tabName);
  if (!tabMeta) return;
  const sheetId = tabMeta.properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
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
async function getLastRow(tabName, spreadsheetId) {
  if (!spreadsheetId) throw new Error(`getLastRow("${tabName}") called without a spreadsheetId`);
  const sheets = getSheetsClient();
  await ensureTab(sheets, tabName, spreadsheetId);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
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

// ── Activity log ──────────────────────────────────────────────────────
// Best-effort audit trail: who did what, when. Logging failures are
// swallowed (logged to console, not thrown) so a hiccup writing the log
// never blocks or breaks the actual operation being logged.
async function logActivity(spreadsheetId, username, role, action, details) {
  try {
    const id = 'L' + Date.now() + Math.floor(Math.random() * 1000);
    await upsertRow('ActivityLog', id, {
      'Log ID':     id,
      'Timestamp':  new Date().toISOString(),
      'Username':   username || '',
      'Role':       role || '',
      'Action':     action || '',
      'Details':    details || '',
    }, spreadsheetId);
  } catch (err) {
    console.error('logActivity failed (non-fatal):', err.message);
  }
}

module.exports = {
  sheetToObjects, upsertRow, deleteRowById, getLastRow, TABS, CATEGORIES, today,
  MASTER_SHEET_ID, resolveBranchSheetId, branchNames, invoicePrefixFor, logActivity,
};
