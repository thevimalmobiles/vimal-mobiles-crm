'use strict';
/**
 * auth.js – login, JWT sessions, and password management.
 *
 * Users live in the "Users" tab of the MASTER sheet (shared across both
 * branches — one login list, not duplicated per branch):
 *   Username | Password Hash | Role | Display Name | Branch
 *
 * Branch rules:
 *   - role "admin"  → Branch column is ignored; admins can access either
 *     branch and pick one via the branch switcher in the UI.
 *   - role "staff"  → Branch column pins that account to exactly one
 *     branch (e.g. "Sithalapakkam"); the UI never shows them a switcher
 *     and the server rejects any request for a different branch.
 *
 * On first run (empty Users tab) three default accounts are seeded:
 *   admin / admin123                    (role: admin, all branches)
 *   staff_sithalapakkam / staff123      (role: staff, Sithalapakkam)
 *   staff_arasankazhani / staff123      (role: staff, Arasankazhani)
 * Change all passwords from the app's Settings page before going live.
 */

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { sheetToObjects, upsertRow, MASTER_SHEET_ID, branchNames } = require('./sheets');

const JWT_SECRET  = process.env.JWT_SECRET || 'change-this-secret-before-deploying';
const TOKEN_TTL   = '12h';

// ── Seed default accounts if the Users tab is empty ───────────────────
async function ensureDefaultUsers() {
  const users = await sheetToObjects('Users', MASTER_SHEET_ID());
  if (users.length > 0) return;

  const adminHash = await bcrypt.hash('admin123', 10);
  const staffHash = await bcrypt.hash('staff123', 10);

  await upsertRow('Users', 'admin', {
    'Username': 'admin', 'Password Hash': adminHash, 'Role': 'admin', 'Display Name': 'Admin', 'Branch': 'ALL',
  }, MASTER_SHEET_ID());

  const [branchA, branchB] = branchNames();
  if (branchA) {
    await upsertRow('Users', 'staff_' + branchA.toLowerCase(), {
      'Username': 'staff_' + branchA.toLowerCase(), 'Password Hash': staffHash, 'Role': 'staff', 'Display Name': 'Staff (' + branchA + ')', 'Branch': branchA,
    }, MASTER_SHEET_ID());
  }
  if (branchB) {
    await upsertRow('Users', 'staff_' + branchB.toLowerCase(), {
      'Username': 'staff_' + branchB.toLowerCase(), 'Password Hash': staffHash, 'Role': 'staff', 'Display Name': 'Staff (' + branchB + ')', 'Branch': branchB,
    }, MASTER_SHEET_ID());
  }

  console.log('ℹ️  Seeded default users (password "admin123"/"staff123") — change these from Settings before going live.');
}

// ── Verify username + password, return a signed JWT on success ───────
async function login(username, password) {
  const users = await sheetToObjects('Users', MASTER_SHEET_ID());
  const user = users.find(u => String(u['Username']).toLowerCase() === String(username).toLowerCase());
  if (!user) return null;

  const match = await bcrypt.compare(password, user['Password Hash'] || '');
  if (!match) return null;

  const role   = user['Role'];
  const branch = role === 'admin' ? 'ALL' : (user['Branch'] || '');
  if (role !== 'admin' && !branch) {
    throw new Error(`User "${username}" has no Branch assigned — set one in the Users sheet before they can log in`);
  }

  const token = jwt.sign(
    { username: user['Username'], role, name: user['Display Name'] || user['Username'], branch },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );

  return { token, role, name: user['Display Name'] || user['Username'], branch };
}

// ── Change a user's password (admin only — enforced in the route) ────
async function changePassword(username, newPassword) {
  const users = await sheetToObjects('Users', MASTER_SHEET_ID());
  const user = users.find(u => String(u['Username']).toLowerCase() === String(username).toLowerCase());
  if (!user) throw new Error('User not found: ' + username);

  const hash = await bcrypt.hash(newPassword, 10);
  await upsertRow('Users', user['Username'], {
    'Username': user['Username'], 'Password Hash': hash, 'Role': user['Role'], 'Display Name': user['Display Name'], 'Branch': user['Branch'] || '',
  }, MASTER_SHEET_ID());
}

// ── Express middleware: require a valid token on protected routes ────
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: 'Not logged in' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: 'Session expired, please log in again' });
  }
}

// ── Express middleware: require the "admin" role ──────────────────────
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Admin access only' });
  }
  next();
}

// ── Express middleware: resolve which branch this request targets ────
// Staff accounts are pinned to their own Branch from the JWT — any attempt
// to request a different branch is rejected outright. Admin accounts pick
// a branch per-request via the X-Branch header (or ?branch= query param),
// since they're allowed to switch between branches in the UI.
function requireBranch(req, res, next) {
  const requested = req.headers['x-branch'] || req.query.branch;

  if (req.user.role === 'admin') {
    if (!requested) {
      return res.status(400).json({ ok: false, error: 'Missing branch — admin requests must include an X-Branch header' });
    }
    if (!branchNames().includes(requested)) {
      return res.status(400).json({ ok: false, error: `Unknown branch "${requested}". Known branches: ${branchNames().join(', ')}` });
    }
    req.branch = requested;
  } else {
    // Staff: always use their own assigned branch, regardless of what (if
    // anything) the client sent — this is what "locked to one branch" means.
    if (!req.user.branch) {
      return res.status(403).json({ ok: false, error: 'Your account has no branch assigned — contact your admin' });
    }
    req.branch = req.user.branch;
  }
  next();
}

module.exports = { ensureDefaultUsers, login, changePassword, requireAuth, requireAdmin, requireBranch };
