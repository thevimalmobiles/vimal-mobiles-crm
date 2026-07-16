'use strict';
/**
 * server.js – Vimal Mobiles CRM (localhost edition)
 * ──────────────────────────────────────────────────
 * Replaces the Google Apps Script web app.
 * Serves the HTML frontend and exposes a REST API that reads/writes
 * the same Google Sheet that the Apps Script version used.
 *
 * Setup:
 *   1. Copy .env.example → .env and fill in SHEET_ID + key path.
 *   2. Download a Service Account JSON key from Google Cloud Console.
 *   3. Share the Google Sheet with the service account email (Editor).
 *   4. npm install && npm start
 *   5. Open http://localhost:3000
 */

require('dotenv').config();
console.log("=================================");
console.log("ENV SHEET_ID:", process.env.SHEET_ID);
console.log("ENV KEY:", process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH);
console.log("Current Directory:", process.cwd());
console.log("=================================");

const express    = require('express');
const bodyParser = require('body-parser');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');

const apiRouter  = require('./routes/api');
const { ensureDefaultUsers } = require('./auth');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// ── API routes ────────────────────────────────────────────────────────
app.use('/api', apiRouter);

// If a request under /api/* didn't match any route above, respond with JSON
// (not the HTML catch-all below) so the frontend's res.json() never chokes
// on an HTML page.
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: `No API route: ${req.method} ${req.originalUrl}` });
});

// ── Serve the frontend ────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Catch-all: serve index.html for any non-API route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Global error handler ────────────────────────────────────────────────
// Catches anything thrown/rejected outside an individual route's own
// try/catch (e.g. a bad JSON body, a middleware crash) and guarantees a
// JSON response for API calls instead of Express's default HTML error page —
// which is what produces "Unexpected token '<' ... is not valid JSON" in
// the browser.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (req.path.startsWith('/api')) {
    res.status(err.status || 500).json({ ok: false, error: err.message || 'Internal server error' });
  } else {
    res.status(err.status || 500).send('Internal server error');
  }
});

// ── Startup validation ────────────────────────────────────────────────
function validateConfig() {
  const errors = [];

  function logSheetIdDiagnostic(label, value) {
    if (!value) { console.log(`   ${label}: (not set)`); return; }
    const masked = value.length > 10 ? value.slice(0, 5) + '...' + value.slice(-5) : value;
    console.log(`   ${label}: "${masked}" (length ${value.length})`);
  }

  console.log('🔎 Sheet ID diagnostic (compare against your actual Google Sheet URLs):');
  logSheetIdDiagnostic('SHEET_ID', process.env.SHEET_ID);
  logSheetIdDiagnostic('SHEET_ID_SITHALAPAKKAM', process.env.SHEET_ID_SITHALAPAKKAM);
  logSheetIdDiagnostic('SHEET_ID_ARASANKAZHANI', process.env.SHEET_ID_ARASANKAZHANI);

  if (!process.env.SHEET_ID) {
    errors.push('SHEET_ID (master sheet, holds the shared Users/login tab) is not set in .env');
  }
  if (!process.env.SHEET_ID_SITHALAPAKKAM) {
    errors.push('SHEET_ID_SITHALAPAKKAM is not set — the Sithalapakkam branch has no sheet configured');
  }
  if (!process.env.SHEET_ID_ARASANKAZHANI) {
    errors.push('SHEET_ID_ARASANKAZHANI is not set — the Arasankazhani branch has no sheet configured');
  }

  const hasKeyEnv  = !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const keyPath    = path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './service-account-key.json');
  const hasKeyFile = fs.existsSync(keyPath);
  if (!hasKeyEnv && !hasKeyFile) {
    errors.push(
      `No Google credentials found (checked GOOGLE_SERVICE_ACCOUNT_KEY env var and ${keyPath})\n` +
      '  → Local dev: download a key from Google Cloud Console → IAM → Service Accounts → Keys\n' +
      '  → Vercel: paste the key JSON into the GOOGLE_SERVICE_ACCOUNT_KEY environment variable\n' +
      '  → Either way, share ALL your Google Sheets (master + every branch) with the service account email (Editor access)'
    );
  }

  if (errors.length) {
    console.error('\n⚠️  Configuration problems detected:');
    errors.forEach(e => console.error('   • ' + e));
    console.error('\n  See .env.example for instructions.\n');
    // Don't exit — the server still starts so you can see the UI;
    // API calls will fail with a helpful error message.
  }
}

validateConfig();
ensureDefaultUsers().catch(err => {
  console.error('⚠️  Could not seed default users (check Sheet ID / key):', err.message);
});

// Running locally (`npm start`) → start a normal listening server.
// Running on Vercel → Vercel calls the exported app as a serverless
// function per-request, so app.listen() must NOT be called there.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n✅  Vimal Mobiles CRM running at http://localhost:${PORT}`);
    console.log('   Press Ctrl+C to stop.\n');
  });
}

module.exports = app;
