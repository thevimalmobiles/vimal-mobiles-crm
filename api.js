'use strict';
/**
 * routes/api.js
 * Express router that exposes one POST endpoint per Apps Script function.
 * Each handler is the direct equivalent of the corresponding function in Code.gs.
 *
 * Endpoints
 * ─────────
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
const { sheetToObjects, upsertRow, deleteRowById, getLastRow, today } = require('../sheets');

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
      res.status(500).json({ ok: false, error: err.message });
    });
}

// ══════════════════════════════════════════════════════════════════════
// GET /api/crm-data  →  getCRMData()
// ══════════════════════════════════════════════════════════════════════
router.get('/crm-data', (req, res) => {
  wrap(res, async () => {
    const [invRows, custRows, repairRows, expRows] = await Promise.all([
      sheetToObjects('Inventory'),
      sheetToObjects('Customers'),
      sheetToObjects('Repairs'),
      sheetToObjects('Expenses'),
    ]);

    const Inventory = invRows.map(r => ({
      id:          str(r['Product ID']),
      name:        r['Product Name'],
      category:    r['Category'],
      brand:       'Generic',
      cost:        r['Cost Price'],
      selling:     r['Selling Price'],
      stock:       r['Stock'],
      supplier:    r['Supplier Name'],
      invoiceNo:   str(r['Invoice No']),
      invoiceDate: fmtDate(r['Invoice Date']),
    }));

    const Customers = custRows.map(r => ({
      id:       str(r['Customer ID']),
      name:     r['Customer Name'],
      mobile:   str(r['Mobile Number']),
      whatsapp: str(r['WhatsApp Number']),
      history:  r['Purchase History'],
      pending:  0,
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

    return { Inventory, Customers, Repairs, Expenses };
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/inventory/save  →  saveInventoryItem()
// ══════════════════════════════════════════════════════════════════════
router.post('/inventory/save', (req, res) => {
  wrap(res, async () => {
    const p = req.body;
    const id = p.id || ('P' + String(Date.now()).slice(-6));
    await upsertRow('Inventory', id, {
      'Product ID':    id,
      'Product Name':  p.name,
      'Category':      p.category,
      'Cost Price':    p.cost,
      'Selling Price': p.selling,
      'Stock':         p.stock,
    });
    return { id };
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/inventory/delete  →  deleteInventoryItem()
// ══════════════════════════════════════════════════════════════════════
router.post('/inventory/delete', (req, res) => {
  wrap(res, async () => {
    const { id } = req.body;
    await deleteRowById('Inventory', id);
    return { deleted: id };
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/customers/save  →  saveCustomer()
// ══════════════════════════════════════════════════════════════════════
router.post('/customers/save', (req, res) => {
  wrap(res, async () => {
    const c = req.body;
    const id = c.mobile; // mobile number doubles as Customer ID
    await upsertRow('Customers', id, {
      'Customer ID':    id,
      'Customer Name':  c.name,
      'Mobile Number':  c.mobile,
      'WhatsApp Number': c.whatsapp || c.mobile,
      'Purchase History': 0,
    });
    return { id };
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/repairs/save  →  saveRepair()
// ══════════════════════════════════════════════════════════════════════
router.post('/repairs/save', (req, res) => {
  wrap(res, async () => {
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
      const nextNum = await getLastRow('Repairs'); // header = row 1
      jobCard = 'JOB' + String(nextNum).padStart(3, '0');
      fields['Repair ID'] = jobCard;
      fields['Date']      = today();
    }

    await upsertRow('Repairs', jobCard, fields);
    return { id: jobCard };
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/expenses/add  →  addExpense()
// ══════════════════════════════════════════════════════════════════════
router.post('/expenses/add', (req, res) => {
  wrap(res, async () => {
    const e = req.body;
    const id = 'E' + String(Date.now()).slice(-6);
    await upsertRow('Expenses', id, {
      'Expense ID': id,
      'Date':       today(),
      'Category':   e.category,
      'Amount':     e.amount,
      'Notes':      e.notes,
    });
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
    const payload = req.body;
    // { invoiceNo, customerName, mobile, total, items:[{productId,qty,sellingPrice}] }

    // Read current inventory
    const invRows = await sheetToObjects('Inventory');
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
        });
      }
    }

    const revenue = payload.total;

    // Log the sale
    await upsertRow('Sales', payload.invoiceNo, {
      'Sale ID':              payload.invoiceNo,
      'Date':                 today(),
      'Item/Customer Name':   payload.customerName,
      'Type (Product/Repair)':'Product',
      'Revenue':              revenue,
      'Cost':                 totalCost,
      'Profit':               revenue - totalCost,
    });

    // Update or create customer row
    const custRows = await sheetToObjects('Customers');
    const existing = custRows.find(c => str(c['Mobile Number']) === str(payload.mobile));
    const prevHistory = existing ? (parseFloat(existing['Purchase History']) || 0) : 0;

    await upsertRow('Customers', str(payload.mobile), {
      'Customer ID':      str(payload.mobile),
      'Customer Name':    payload.customerName,
      'Mobile Number':    str(payload.mobile),
      'WhatsApp Number':  str(payload.mobile),
      'Purchase History': prevHistory + revenue,
    });

    return { success: true };
  });
});

module.exports = router;
