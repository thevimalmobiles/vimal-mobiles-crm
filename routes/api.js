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
const { sheetToObjects, upsertRow, deleteRowById, getLastRow, CATEGORIES, today, branchNames, invoicePrefixFor, logActivity } = require('../sheets');
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
    const { MASTER_SHEET_ID } = require('../sheets');
    await logActivity(MASTER_SHEET_ID(), req.user.username, req.user.role, 'Password Changed', 'for user: ' + username);
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

    const [invRows, custRows, repairRows, expRows, salesRows, financeRows] = await Promise.all([
      sheetToObjects('Inventory', spreadsheetId),
      sheetToObjects('Customers', spreadsheetId),
      sheetToObjects('Repairs', spreadsheetId),
      sheetToObjects('Expenses', spreadsheetId),
      sheetToObjects('Sales', spreadsheetId),
      sheetToObjects('Finance', spreadsheetId),
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
      mobile:      str(r['Customer Mobile'] || ''),
      type:        r['Type (Product/Repair)'],
      revenue:     parseFloat(r['Revenue']) || 0,
      cost:        parseFloat(r['Cost']) || 0,
      profit:      parseFloat(r['Profit']) || 0,
      paymentMode: r['Payment Mode'] || '',
      cashAmount:  parseFloat(r['Cash Amount']) || 0,
      upiAmount:   parseFloat(r['UPI Amount']) || 0,
      invoiceNo:   r['Invoice No'] || '',
      status:      r['Status'] || 'Completed',
    }));

    const Finance = financeRows.map(r => ({
      id:          str(r['Loan ID']),
      date:        fmtDate(r['Date']),
      invoiceNo:   str(r['Invoice No']),
      customer:    r['Customer Name'],
      mobile:      str(r['Customer Mobile'] || ''),
      partner:     r['Partner'],
      appNo:       str(r['App ID']),
      downpayment: parseFloat(r['Down Payment']) || 0,
      loanAmount:  parseFloat(r['Loan Amount']) || 0,
      status:      r['Status'] || 'Pending',
    }));

    // Staff accounts don't see expense data, even via the API directly
    return { branch: req.branch, Inventory, Customers, Repairs, Sales, Finance, Expenses: req.user.role === 'admin' ? Expenses : [] };
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/finance/settle  →  mark a loan as Disbursed
// ══════════════════════════════════════════════════════════════════════
router.post('/finance/settle', (req, res) => {
  wrap(res, async () => {
    const { resolveBranchSheetId } = require('../sheets');
    const spreadsheetId = resolveBranchSheetId(req.branch);
    const { loanId } = req.body;
    if (!loanId) throw new Error('loanId is required');

    const rows = await sheetToObjects('Finance', spreadsheetId);
    const loan = rows.find(r => str(r['Loan ID']) === str(loanId));
    if (!loan) throw new Error('Loan not found: ' + loanId);

    await upsertRow('Finance', loanId, {
      'Loan ID':        loan['Loan ID'],
      'Date':           loan['Date'],
      'Invoice No':     loan['Invoice No'],
      'Customer Name':  loan['Customer Name'],
      'Customer Mobile':loan['Customer Mobile'],
      'Partner':        loan['Partner'],
      'App ID':         loan['App ID'],
      'Down Payment':   loan['Down Payment'],
      'Loan Amount':    loan['Loan Amount'],
      'Status':         'Disbursed',
    }, spreadsheetId);

    await logActivity(spreadsheetId, req.user.username, req.user.role, 'Loan Settled', loanId);
    return { success: true };
  });
});

// ══════════════════════════════════════════════════════════════════════
// GET /api/activity  →  recent activity log entries (admin only)
// ══════════════════════════════════════════════════════════════════════
router.get('/activity', requireAdmin, (req, res) => {
  wrap(res, async () => {
    const { resolveBranchSheetId, MASTER_SHEET_ID } = require('../sheets');
    const spreadsheetId = resolveBranchSheetId(req.branch);
    const masterId = MASTER_SHEET_ID();
    const [branchRows, masterRows] = await Promise.all([
      sheetToObjects('ActivityLog', spreadsheetId),
      spreadsheetId !== masterId ? sheetToObjects('ActivityLog', masterId) : Promise.resolve([]),
    ]);
    const mapRow = r => ({ id: str(r['Log ID']), timestamp: r['Timestamp'], username: r['Username'], role: r['Role'], action: r['Action'], details: r['Details'] });
    return branchRows.map(mapRow).concat(masterRows.map(mapRow))
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
      .slice(0, 200); // most recent 200 — plenty for a quick review, keeps the response light
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
    await logActivity(spreadsheetId, req.user.username, req.user.role, 'Inventory Saved', id + ' — ' + p.name);
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
    await logActivity(spreadsheetId, req.user.username, req.user.role, 'Inventory Deleted', id);
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
    await logActivity(spreadsheetId, req.user.username, req.user.role, 'Customer Saved', id + ' — ' + c.name);
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
    await logActivity(spreadsheetId, req.user.username, req.user.role, 'Repair Saved', jobCard + ' — ' + r.customerName);
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
    await logActivity(spreadsheetId, req.user.username, req.user.role, 'Expense Added', id + ' — ₹' + e.amount + ' (' + e.category + ')');
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

    // For each item, compute cost, decrement stock, and log a line-item
    // record (SaleItems) so a future refund can restock exactly what was sold.
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
      await upsertRow('SaleItems', payload.invoiceNo + '-' + item.productId, {
        'Row ID':      payload.invoiceNo + '-' + item.productId,
        'Sale ID':     payload.invoiceNo,
        'Product ID':  str(item.productId),
        'Product Name':prod ? prod['Product Name'] : '',
        'Qty':         item.qty,
        'Price':       item.sellingPrice,
        'Amount':      item.qty * item.sellingPrice,
      }, spreadsheetId);
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

    // Sequential, GST-friendly invoice number (e.g. "STK-000042") — separate
    // from the internal Sale ID used above for idempotency. Counted from
    // existing rows in this branch's own Sales sheet, so numbering never
    // has gaps and never collides with the other branch's numbering.
    const invoiceNo = invoicePrefixFor(req.branch) + '-' + String(existingSales.length + 1).padStart(6, '0');

    // Log the sale
    await upsertRow('Sales', payload.invoiceNo, {
      'Sale ID':              payload.invoiceNo,
      'Date':                 today(),
      'Item/Customer Name':   payload.customerName,
      'Customer Mobile':      str(payload.mobile || ''),
      'Type (Product/Repair)':'Product',
      'Revenue':              revenue,
      'Cost':                 totalCost,
      'Profit':               revenue - totalCost,
      'Payment Mode':         paymentMode,
      'Cash Amount':          cashAmount,
      'UPI Amount':           upiAmount,
      'Invoice No':           invoiceNo,
      'Status':               'Completed',
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

    // Finance-mode sales also create a Loan Tracker entry
    if (paymentMode === 'Finance' && payload.financePartner) {
      const downPayment = parseFloat(payload.downPayment) || 0;
      const loanId = 'FIN-' + payload.invoiceNo;
      await upsertRow('Finance', loanId, {
        'Loan ID':        loanId,
        'Date':           today(),
        'Invoice No':     invoiceNo,
        'Customer Name':  payload.customerName,
        'Customer Mobile':str(payload.mobile || ''),
        'Partner':        payload.financePartner,
        'App ID':         payload.financeAppId || '',
        'Down Payment':   downPayment,
        'Loan Amount':    Math.max(0, revenue - downPayment),
        'Status':         'Pending',
      }, spreadsheetId);
    }

    await logActivity(spreadsheetId, req.user.username, req.user.role, 'Sale Recorded', invoiceNo + ' — ₹' + revenue.toFixed(2) + ' to ' + payload.customerName);

    return { success: true, invoiceNo };
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/sales/refund  →  reverse a completed sale
// Marks the Sales row as Refunded, restocks every item from that sale's
// SaleItems log, and subtracts the amount back off the customer's
// Purchase History. Admin only — refunds affect money and stock, so this
// shouldn't be a one-tap action for staff.
// ══════════════════════════════════════════════════════════════════════
router.post('/sales/refund', requireAdmin, (req, res) => {
  wrap(res, async () => {
    const { resolveBranchSheetId } = require('../sheets');
    const spreadsheetId = resolveBranchSheetId(req.branch);
    const { saleId } = req.body;
    if (!saleId) throw new Error('saleId is required');

    const salesRows = await sheetToObjects('Sales', spreadsheetId);
    const sale = salesRows.find(s => str(s['Sale ID']) === str(saleId));
    if (!sale) throw new Error('Sale not found: ' + saleId);
    if (sale['Status'] === 'Refunded') throw new Error('This sale was already refunded');

    // Restock every item that was part of this sale, using the SaleItems log
    // written at the time of sale — this is why that log exists.
    const [itemRows, invRows] = await Promise.all([
      sheetToObjects('SaleItems', spreadsheetId),
      sheetToObjects('Inventory', spreadsheetId),
    ]);
    const soldItems = itemRows.filter(i => str(i['Sale ID']) === str(saleId));
    for (const item of soldItems) {
      const prod = invRows.find(r => str(r['Product ID']) === str(item['Product ID']));
      if (prod) {
        const currentStock = parseFloat(prod['Stock']) || 0;
        const qty = parseFloat(item['Qty']) || 0;
        await upsertRow('Inventory', str(prod['Product ID']), {
          'Product ID':    str(prod['Product ID']),
          'Product Name':  prod['Product Name'],
          'Category':      prod['Category'],
          'Cost Price':    prod['Cost Price'],
          'Selling Price': prod['Selling Price'],
          'Stock':         currentStock + qty,
        }, spreadsheetId);
      }
    }

    // Mark the sale itself as refunded (kept in the sheet for audit trail,
    // just excluded from active revenue/profit totals by its Status).
    await upsertRow('Sales', saleId, {
      'Sale ID':              sale['Sale ID'],
      'Date':                 sale['Date'],
      'Item/Customer Name':   sale['Item/Customer Name'],
      'Customer Mobile':      sale['Customer Mobile'],
      'Type (Product/Repair)':sale['Type (Product/Repair)'],
      'Revenue':              sale['Revenue'],
      'Cost':                 sale['Cost'],
      'Profit':               sale['Profit'],
      'Payment Mode':         sale['Payment Mode'],
      'Cash Amount':          sale['Cash Amount'],
      'UPI Amount':           sale['UPI Amount'],
      'Invoice No':           sale['Invoice No'],
      'Status':               'Refunded',
    }, spreadsheetId);

    // Subtract the refunded amount back off the customer's running total.
    const mobile = sale['Customer Mobile'];
    if (mobile) {
      const custRows = await sheetToObjects('Customers', spreadsheetId);
      const cust = custRows.find(c => str(c['Mobile Number']) === str(mobile));
      if (cust) {
        const prevHistory = parseFloat(cust['Purchase History']) || 0;
        const revenue = parseFloat(sale['Revenue']) || 0;
        await upsertRow('Customers', str(mobile), {
          'Customer ID':    cust['Customer ID'],
          'Customer Name':  cust['Customer Name'],
          'Mobile Number':  cust['Mobile Number'],
          'WhatsApp Number':cust['WhatsApp Number'],
          'Purchase History': Math.max(0, prevHistory - revenue),
        }, spreadsheetId);
      }
    }

    await logActivity(spreadsheetId, req.user.username, req.user.role, 'Sale Refunded', saleId);
    return { success: true, restockedItems: soldItems.length };
  });
});

module.exports = router;
