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

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// ── API routes ────────────────────────────────────────────────────────
app.use('/api', apiRouter);

// ── Serve the frontend ────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Catch-all: serve index.html for any non-API route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Startup validation ────────────────────────────────────────────────
function validateConfig() {
  const errors = [];

  if (!process.env.SHEET_ID) {
    errors.push('SHEET_ID is not set in .env');
  }

  const keyPath = path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './service-account-key.json');
  if (!fs.existsSync(keyPath)) {
    errors.push(
      `Service account key not found at: ${keyPath}\n` +
      '  → Download it from Google Cloud Console → IAM → Service Accounts → Keys\n' +
      '  → Then share your Google Sheet with the service account email (Editor access)'
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

app.listen(PORT, () => {
  console.log(`\n✅  Vimal Mobiles CRM running at http://localhost:${PORT}`);
  console.log('   Press Ctrl+C to stop.\n');
  validateConfig();
});
