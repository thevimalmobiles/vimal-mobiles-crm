# Vimal Mobiles CRM — Localhost Edition

A complete mobile shop CRM & billing system running on `localhost:3000`  
with **Google Sheets as the sole database** (no SQLite, MySQL, or Firebase).

---

## Prerequisites

- Node.js 18+ (https://nodejs.org)
- A Google Cloud project with the **Google Sheets API** enabled
- The same Google Sheet you used with the Apps Script version  
  (Sheet ID: `1lNC-ovjjsjmikQ1fUX-UNYmtznGf0oi5VE4jKyYRs9I`)

---

## One-Time Google Cloud Setup

### 1 — Enable the Sheets API

1. Go to https://console.cloud.google.com
2. Select (or create) a project
3. **APIs & Services → Enable APIs → search "Google Sheets API" → Enable**

### 2 — Create a Service Account

1. **IAM & Admin → Service Accounts → + Create Service Account**
2. Give it any name (e.g. `vimal-crm`), click **Done**
3. Click the service account → **Keys tab → Add Key → JSON**
4. A `.json` file downloads — this is your `service-account-key.json`
5. Copy it into this project folder (next to `server.js`)

### 3 — Share the Google Sheet

1. Open your Google Sheet
2. Click **Share**
3. Paste the service account email (looks like `vimal-crm@your-project.iam.gserviceaccount.com`)
4. Set role to **Editor** → **Send**

---

## Running the App

```bash
# 1. Install dependencies
npm install

# 2. Create your environment file
cp .env.example .env
# Edit .env if your Sheet ID or key file path differs from the defaults

# 3. Start the server
npm start

# 4. Open in browser
# http://localhost:3000
```

Login: `admin` / `admin123` or `staff` / `staff123`

---

## Project Structure

```
vimal-mobiles-crm/
├── server.js                  # Express app entry point
├── sheets.js                  # Google Sheets read/write helpers
├── routes/
│   └── api.js                 # REST API (replaces google.script.run)
├── public/
│   └── index.html             # Full CRM frontend (unchanged UI)
├── package.json
├── .env.example               # Environment variable template
├── .env                       # Your config (git-ignored)
└── service-account-key.json   # Your Google key (git-ignored)
```

## API Endpoints

| Method | Path | Apps Script equivalent |
|--------|------|------------------------|
| GET | `/api/crm-data` | `getCRMData()` |
| POST | `/api/inventory/save` | `saveInventoryItem()` |
| POST | `/api/inventory/delete` | `deleteInventoryItem()` |
| POST | `/api/customers/save` | `saveCustomer()` |
| POST | `/api/repairs/save` | `saveRepair()` |
| POST | `/api/expenses/add` | `addExpense()` |
| POST | `/api/sales/record` | `recordSale()` |

---

## Features Preserved

- ✅ POS Billing with cart, GST, discount, finance mode
- ✅ Inventory management with stock tracking
- ✅ Repair job cards with WhatsApp status notifications
- ✅ Customer directory
- ✅ Expense tracker (admin only)
- ✅ Finance loan tracker
- ✅ AI Invoice Ingestion (in-browser OCR via Tesseract.js)
- ✅ Google Charts dashboard
- ✅ Print invoice
- ✅ WhatsApp integration
- ✅ Role-based access (Admin / Staff)

---

## Development

```bash
npm run dev   # auto-restarts on file changes (uses nodemon)
```
