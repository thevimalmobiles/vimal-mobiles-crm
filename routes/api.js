'use strict';
/**
 * routes/api.js
 * Express router that exposes one POST endpoint per Apps Script function.
 * Each handler is the direct equivalent of the corresponding function in Code.gs.
 *
 * MULTI-BRANCH: every data route below runs behind requireBranch, which
 * resolves req.branch (the staff member's fixed branch, or the branch an
 * admin picked via the X-Branch header) and every sheets.js call is scoped
 * to that branch's own spreadsheet. The Users/login tab is the one
 * exception — it lives on the shared MASTER sheet, not per-branch.
 *
 * Endpoints
 * ─────────
 * GET  /api/branches            → list of known branch names
 * GET  /api/crm-data            → getCRMData()
 * POST /api/inventory/save      → saveInventoryItem()
 * POST /api/inventory/delete    → deleteInventoryItem()
 * POST /api/customers/save      → saveCustomer()
 * POST /api/repairs/save        → saveRepair()
 * POST /api/expenses/add        → addExpense()
 * POST /api/sales/record        → recordSale()
 */

const express = require('express');
const router  = express.Router();
const { sheetToObjects, upsertRow, deleteRowById, getLastRow, CATEGORIES, today, branchNames } = require('../sheets');
const { login, changePassword, requireAuth, requireAdmin, requireBranch } = require('../auth');

// ── Helpers ───────────────────────────────────────────────────────────
function str(v) {
  return (v === null || v === undefined) ? '' : String(v);
}

function fmtDate(v) {
  if (!v) return '';
  // Sheets sometimes returns serial date numbers – handle them
  if (typeof v === 'number') {
    // Google Sheets date serial: days since Dec 30 1899
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return String(v).slice(0, 10);
}

function wrap(res, fn) {
  fn()
    .then(data => res.json({ ok: true, data }))
    .catch(err => {
      console.error(err);
      res.status(err.status || 500).json({ ok: false, error: err.message });
    });
}

// ══════════════════════════════════════════════════════════════════════
// AUTH — these two routes are the only ones NOT behind requireAuth
// ══════════════════════════════════════════════════════════════════════
router.post('/auth/login', (req, res) => {
  wrap(res, async () => {
    const { username, password } = req.body;
    if (!username || !password) throw new Error('Username and password are required');
    const result = await login(username, password);
    if (!result) {
      const err = new Error('Invalid username or password');
      err.status = 401;
      throw err;
    }
    return result; // { token, role, name, branch }
  });
});

// Everything below this line requires a valid logged-in session
router.use(requireAuth);

// GET /api/branches — list of known branch names, for the admin branch switcher
router.get('/branches', (req, res) => {
  res.json({ ok: true, data: branchNames() });
});

// POST /api/auth/change-password  (admin only, can change ANY user's password)
router.post('/auth/change-password', requireAdmin, (req, res) => {
  wrap(res, async () => {
    const { username, newPassword } = req.body;
    if (!username || !newPassword) throw new Error('Username and newPassword are required');
    if (newPassword.length < 4) throw new Error('Password must be at least 4 characters');
    await changePassword(username, newPassword);
    return { updated: username };
  });
});

// GET /api/auth/users  (admin only — list accounts so passwords can be changed)
router.get('/auth/users', requireAdmin, (req, res) => {
  wrap(res, async () => {
    const { MASTER_SHEET_ID } = require('../sheets');
    const users = await sheetToObjects('Users', MASTER_SHEET_ID());
    return users.map(u => ({ username: u['Username'], role: u['Role'], name: u['Display Name'], branch: u['Branch'] || '' }));
  });
});

// GET /api/auth/whoami  (used by the frontend to restore a session on refresh)
router.get('/auth/whoami', (req, res) => {
  res.json({ ok: true, data: { username: req.user.username, role: req.user.role, name: req.user.name, branch: req.user.branch } });
});

// Every route below deals with branch-scoped operational data, so resolve
// req.branch (staff: fixed; admin: from X-Branch header) before any of them run.
router.use(requireBranch);

// ══════════════════════════════════════════════════════════════════════
// GET /api/crm-data  →  getCRMData()
// ══════════════════════════════════════════════════════════════════════
router.get('/crm-data', (req, res) => {
  wrap(res, async () => {
    const sheetId = req.branch; // resolved to an actual ID just below
    const { resolveBranchSheetId } = require('../sheets');
    const spreadsheetId = resolveBranchSheetId(req.branch);

    const [invRows, custRows, repairRows, expRows, salesRows] = await Promise.all([
      sheetToObjects('Inventory', spreadsheetId),
      sheetToObjects('Customers', spreadsheetId),
      sheetToObjects('Repairs', spreadsheetId),
      sheetToObjects('Expenses', spreadsheetId),
      sheetToObjects('Sales', spreadsheetId),
    ]);

    const Inventory = invRows.map(r => ({
      id:          str(r['Product ID']),
      name:        r['Product Name'],
      category:    r['Category'],
      subcategory: r['Subcategory'] || '',
      brand:       r['Brand'] || 'Generic',
      model:       r['Model'] || '',
      hsn:         str(r['HSN Code'] || ''),
      imei:        str(r['IMEI'] || ''),
      batch:       str(r['Batch No'] || ''),
      cost:        r['Cost Price'],
      selling:     r['Selling Price'],
      stock:       r['Stock'],
      supplier:    r['Supplier Name'],
      invoiceNo:   str(r['Invoice No']),
      invoiceDate: fmtDate(r['Invoice Date']),
    }));

    const Customers = custRows.map(r => ({
      id:          str(r['Customer ID']),
      name:        r['Customer Name'],
      mobile:      str(r['Mobile Number']),
      whatsapp:    str(r['WhatsApp Number']),
      history:     r['Purchase History'],
      pending:     r['Pending Amount'] || 0,
      description: r['Description'] || '',
    }));

    const Repairs = repairRows.map(r => ({
      id:            str(r['Repair ID']),
      date:          fmtDate(r['Date']),
      customerName:  r['Customer Name'],
      phone:         str(r['Phone']),
      brand:         r['Brand'],
      model:         r['Model'],
      issue:         r['Issue'],
      partId:        str(r['Part Used (Product ID)']),
      charge:        r['Repair Charge'],
      technicianCost:r['Technician Cost'],
      status:        r['Status'],
    }));

    const Expenses = expRows.map(r => ({
      id:       str(r['Expense ID']),
      date:     fmtDate(r['Date']),
      category: r['Category'],
      amount:   r['Amount'],
      notes:    r['Notes'],
    }));

    const Sales = salesRows.map(r => ({
      id:          str(r['Sale ID']),
      date:        fmtDate(r['Date']),
      name:        r['Item/Customer Name'],
      type:        r['Type (Product/Repair)'],
      revenue:     parseFloat(r['Revenue']) || 0,
      cost:        parseFloat(r['Cost']) || 0,
      profit:      parseFloat(r['Profit']) || 0,
      paymentMode: r['Payment Mode'] || '',
      cashAmount:  parseFloat(r['Cash Amount']) || 0,
      upiAmount:   parseFloat(r['UPI Amount']) || 0,
    }));

    // Staff accounts don't see expense data, even via the API directly
    return { branch: req.branch, Inventory, Customers, Repairs, Sales, Expenses: req.user.role === 'admin' ? Expenses : [] };
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/inventory/save  →  saveInventoryItem()
// ══════════════════════════════════════════════════════════════════════
router.post('/inventory/save', (req, res) => {
  wrap(res, async () => {
    const { resolveBranchSheetId } = require('../sheets');
    const spreadsheetId = resolveBranchSheetId(req.branch);
    const p = req.body;

    // Mobiles: each physical phone is its own row, ID'd by its unique IMEI
    // (stock is always 1/0, since one row = one device). Accessories/Spares
    // use a generated Product ID and a real stock count instead.
    let id = p.id;
    if (!id) {
      if (p.category === 'Mobiles') {
        if (!p.imei) throw new Error('IMEI is required for Mobiles');
        id = p.imei.trim();
      } else {
        id = 'P' + String(Date.now()).slice(-6) + Math.floor(Math.random() * 90 + 10);
      }
    }

    const stock = p.category === 'Mobiles' ? 1 : (p.stock || 0);

    await upsertRow('Inventory', id, {
      'Product ID':    id,
      'Product Name':  p.name,
      'Category':      p.category,
      'Subcategory':   p.category === 'Accessories' ? (p.subcategory || '') : '',
      'Brand':         p.brand || 'Generic',
      'Model':         p.model || '',
      'HSN Code':      p.hsn || '',
      'IMEI':          p.category === 'Mobiles' ? id : '',
      'Batch No':      p.batch || '',
      'Cost Price':    p.cost,
      'Selling Price': p.selling,
      'Stock':         stock,
      'Supplier Name': p.supplier || '',
      'Invoice No':    p.invoiceNo || '',
      'Invoice Date':  p.invoiceDate || '',
    }, spreadsheetId);
    return { id };
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/inventory/delete  →  deleteInventoryItem()
// ══════════════════════════════════════════════════════════════════════
router.post('/inventory/delete', (req, res) => {
  wrap(res, async () => {
    const { resolveBranchSheetId } = require('../sheets');
    const spreadsheetId = resolveBranchSheetId(req.branch);
    const { id } = req.body;
    await deleteRowById('Inventory', id, spreadsheetId);
    return { deleted: id };
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/customers/save  →  saveCustomer()
// ══════════════════════════════════════════════════════════════════════
router.post('/customers/save', (req, res) => {
  wrap(res, async () => {
    const { resolveBranchSheetId } = require('../sheets');
    const spreadsheetId = resolveBranchSheetId(req.branch);
    const c = req.body;
    const id = c.mobile; // mobile number doubles as Customer ID

    // Preserve existing Purchase History / Pending Amount when editing;
    // only overwrite them if the caller explicitly supplied a value.
    const existing = (await sheetToObjects('Customers', spreadsheetId)).find(r => str(r['Mobile Number']) === str(id));

    const fields = {
      'Customer ID':       id,
      'Customer Name':     c.name,
      'Mobile Number':     c.mobile,
      'WhatsApp Number':   c.whatsapp || c.mobile,
      'Description':       c.description !== undefined ? c.description : (existing ? existing['Description'] : ''),
    };
    fields['Purchase History'] = c.history !== undefined ? c.history : (existing ? (existing['Purchase History'] || 0) : 0);
    fields['Pending Amount']   = c.pending !== undefined ? c.pending : (existing ? (existing['Pending Amount'] || 0) : 0);

    await upsertRow('Customers', id, fields, spreadsheetId);
    return { id };
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/repairs/save  →  saveRepair()
// ══════════════════════════════════════════════════════════════════════
router.post('/repairs/save', (req, res) => {
  wrap(res, async () => {
    const { resolveBranchSheetId } = require('../sheets');
    const spreadsheetId = resolveBranchSheetId(req.branch);
    const r = req.body;
    let jobCard = r.id; // present when editing existing job card

    const fields = {
      'Customer Name':       r.customerName,
      'Phone':               r.phone,
      'Brand':               r.brand,
      'Model':               r.model,
      'Issue':               r.issue,
      'Part Used (Product ID)': r.partId || 'None',
      'Repair Charge':       r.charge,
      'Technician Cost':     r.technicianCost,
      'Status':              r.status,
    };

    if (!jobCard) {
      const nextNum = await getLastRow('Repairs', spreadsheetId); // header = row 1
      jobCard = 'JOB' + String(nextNum).padStart(3, '0');
      fields['Repair ID'] = jobCard;
      fields['Date']      = today();
    }

    await upsertRow('Repairs', jobCard, fields, spreadsheetId);
    return { id: jobCard };
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/expenses/add  →  addExpense()
// ══════════════════════════════════════════════════════════════════════
router.post('/expenses/add', requireAdmin, (req, res) => {
  wrap(res, async () => {
    const { resolveBranchSheetId } = require('../sheets');
    const spreadsheetId = resolveBranchSheetId(req.branch);
    const e = req.body;
    const id = 'E' + String(Date.now()).slice(-6);
    await upsertRow('Expenses', id, {
      'Expense ID': id,
      'Date':       today(),
      'Category':   e.category,
      'Amount':     e.amount,
      'Notes':      e.notes,
    }, spreadsheetId);
    return { id };
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/sales/record  →  recordSale()
// Reduces stock on each sold product, logs a Sales row, and updates
// (or creates) the customer's cumulative purchase total.
// ══════════════════════════════════════════════════════════════════════
router.post('/sales/record', (req, res) => {
  wrap(res, async () => {
    const { resolveBranchSheetId } = require('../sheets');
    const spreadsheetId = resolveBranchSheetId(req.branch);
    const payload = req.body;
    // { invoiceNo, customerName, mobile, total, items:[{productId,qty,sellingPrice}] }
    if (!payload.invoiceNo) throw new Error('invoiceNo is required');

    // Idempotency guard: if this exact Sale ID was already recorded (e.g. a
    // duplicate/retried request, or a double-tap on "Complete Sale"), don't
    // decrement stock or log the sale again — just report success.
    const existingSales = await sheetToObjects('Sales', spreadsheetId);
    if (existingSales.some(s => str(s['Sale ID']) === str(payload.invoiceNo))) {
      return { success: true, duplicate: true };
    }

    // Read current inventory
    const invRows = await sheetToObjects('Inventory', spreadsheetId);
    let totalCost = 0;

    // For each item, compute cost and decrement stock
    for (const item of payload.items) {
      const prod = invRows.find(r => str(r['Product ID']) === str(item.productId));
      if (prod) {
        const costPrice    = parseFloat(prod['Cost Price'])  || 0;
        const currentStock = parseFloat(prod['Stock'])       || 0;
        totalCost += costPrice * item.qty;
        await upsertRow('Inventory', str(prod['Product ID']), {
          'Product ID':    str(prod['Product ID']),
          'Product Name':  prod['Product Name'],
          'Category':      prod['Category'],
          'Cost Price':    prod['Cost Price'],
          'Selling Price': prod['Selling Price'],
          'Stock':         currentStock - item.qty,
        }, spreadsheetId);
      }
    }

    const revenue = payload.total;
    const paymentMode = payload.paymentMode || 'Cash';
    // For a straight (non-split) payment, attribute the full amount to that
    // mode's column so sheet formulas/pivots can sum Cash Amount / UPI Amount
    // consistently whether or not the sale was split.
    const cashAmount = paymentMode === 'Cash + UPI'
      ? (parseFloat(payload.cashAmount) || 0)
      : (paymentMode === 'Cash' ? revenue : 0);
    const upiAmount = paymentMode === 'Cash + UPI'
      ? (parseFloat(payload.upiAmount) || 0)
      : (paymentMode === 'UPI / GPay' ? revenue : 0);

    // Log the sale
    await upsertRow('Sales', payload.invoiceNo, {
      'Sale ID':              payload.invoiceNo,
      'Date':                 today(),
      'Item/Customer Name':   payload.customerName,
      'Type (Product/Repair)':'Product',
      'Revenue':              revenue,
      'Cost':                 totalCost,
      'Profit':               revenue - totalCost,
      'Payment Mode':         paymentMode,
      'Cash Amount':          cashAmount,
      'UPI Amount':           upiAmount,
    }, spreadsheetId);

    // Update or create customer row
    const custRows = await sheetToObjects('Customers', spreadsheetId);
    const existing = custRows.find(c => str(c['Mobile Number']) === str(payload.mobile));
    const prevHistory = existing ? (parseFloat(existing['Purchase History']) || 0) : 0;

    await upsertRow('Customers', str(payload.mobile), {
      'Customer ID':      str(payload.mobile),
      'Customer Name':    payload.customerName,
      'Mobile Number':    str(payload.mobile),
      'WhatsApp Number':  str(payload.mobile),
      'Purchase History': prevHistory + revenue,
    }, spreadsheetId);

    return { success: true };
  });
});

module.exports = router;
