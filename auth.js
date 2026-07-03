'use strict';
/**
 * auth.js – login, JWT sessions, and password management.
 *
 * Users are stored in the "Users" tab of the same Google Sheet
 * (Username | Password Hash | Role | Display Name).
 * On first run (empty Users tab) two default accounts are seeded:
 *   admin / admin123   (role: admin)
 *   staff / staff123   (role: staff)
 * Change both passwords from the app's Settings page before going live.
 */

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { sheetToObjects, upsertRow } = require('./sheets');

const JWT_SECRET  = process.env.JWT_SECRET || 'change-this-secret-before-deploying';
const TOKEN_TTL   = '12h';

// ── Seed default accounts if the Users tab is empty ───────────────────
async function ensureDefaultUsers() {
  const users = await sheetToObjects('Users');
  if (users.length > 0) return;

  const adminHash = await bcrypt.hash('admin123', 10);
  const staffHash = await bcrypt.hash('staff123', 10);

  await upsertRow('Users', 'admin', {
    'Username': 'admin', 'Password Hash': adminHash, 'Role': 'admin', 'Display Name': 'Admin',
  });
  await upsertRow('Users', 'staff', {
    'Username': 'staff', 'Password Hash': staffHash, 'Role': 'staff', 'Display Name': 'Staff',
  });

  console.log('ℹ️  Seeded default users: admin/admin123 and staff/staff123 — change these from Settings before going live.');
}

// ── Verify username + password, return a signed JWT on success ───────
async function login(username, password) {
  const users = await sheetToObjects('Users');
  const user = users.find(u => String(u['Username']).toLowerCase() === String(username).toLowerCase());
  if (!user) return null;

  const match = await bcrypt.compare(password, user['Password Hash'] || '');
  if (!match) return null;

  const token = jwt.sign(
    { username: user['Username'], role: user['Role'], name: user['Display Name'] || user['Username'] },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );

  return { token, role: user['Role'], name: user['Display Name'] || user['Username'] };
}

// ── Change a user's password (admin only — enforced in the route) ────
async function changePassword(username, newPassword) {
  const users = await sheetToObjects('Users');
  const user = users.find(u => String(u['Username']).toLowerCase() === String(username).toLowerCase());
  if (!user) throw new Error('User not found: ' + username);

  const hash = await bcrypt.hash(newPassword, 10);
  await upsertRow('Users', user['Username'], {
    'Username': user['Username'], 'Password Hash': hash, 'Role': user['Role'], 'Display Name': user['Display Name'],
  });
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

module.exports = { ensureDefaultUsers, login, changePassword, requireAuth, requireAdmin };
