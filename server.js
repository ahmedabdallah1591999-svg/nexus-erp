'use strict';
/* server.js — Nexus ERP local server (أحمد عبدالله بيزنس ديفيلوبمنت).
 *
 * Runs on ONE machine in the office (the one that stays on). Employees open
 * http://<that-machine>:8080 in any browser on the same network. No cloud
 * account, no subscription, no payment method — Node.js only.
 *
 * What it adds over the browser-only version:
 *   - Real accounts: passwords are scrypt-hashed on the server; the password
 *     list is not readable from any employee's browser.
 *   - Shared data: everyone works on the same database (data/store.json here).
 *   - Real permissions: the server only sends each user the sections their
 *     role allows, and only accepts writes to those sections. Export on each
 *     device therefore contains only what that user is allowed to see.
 *   - Contact-us messages reach the admin's inbox on any device.
 *
 * Requires Node.js 18+ (https://nodejs.org — free). No npm packages needed.
 * Run:  node server.js   (then open http://localhost:8080)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runTx, SERVER_OWNED } = require('./tx');

/* One queue serializes every mutation (tx ops and whole-data PUTs), so a
   business transaction never interleaves with another write: concurrent
   conversions, double payments and lost updates are impossible. */
let writeQueue = Promise.resolve();
function enqueueWrite(fn) {
  const p = writeQueue.then(fn);
  writeQueue = p.catch(() => {});
  return p;
}

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

/* Collection -> permission view. A user may read/write a collection only if
   their role grants its view (admins: everything). */
const COLLECTION_VIEW = {
  contacts: 'contacts', companies: 'companies', deals: 'deals', tasks: 'tasks', quotes: 'quotes',
  activities: 'contacts', products: 'products', suppliers: 'suppliers',
  invoices: 'invoices', purchases: 'purchases', ledger: 'finance',
  employees: 'employees', notes: 'notes', accounts: 'accounting', journal: 'accounting', payments: 'payments',
  warehouses: 'stock', stock_moves: 'stock',
};
const ADMIN_ONLY = ['settings']; // app-wide settings stay with the admin

/* ---------------- persistence ---------------- */

function emptyDb() {
  return {
    users: [],           // {id, username, salt, hash, role, modules[], mustChange, created_at}
    data: {
      meta: { nextId: 1, invoiceSeq: 1, purchaseSeq: 1, quoteSeq: 1 },
      companies: [], contacts: [], deals: [], tasks: [], activities: [], quotes: [],
      products: [], suppliers: [], invoices: [], purchases: [],
      ledger: [], employees: [], notes: [], messages: [], accounts: [], journal: [], payments: [],
      warehouses: [], stock_moves: [], settings: {},
    },
  };
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}

function saveJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file); // atomic on POSIX and Windows
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
let db = loadJson(DB_FILE, null);
if (db && db.data) {
  /* migrate older data files forward: any collection added later starts empty */
  const fresh = emptyDb().data;
  for (const k of Object.keys(fresh)) if (db.data[k] === undefined) db.data[k] = fresh[k];
  for (const k of Object.keys(fresh.meta || {})) if (db.data.meta[k] === undefined) db.data.meta[k] = fresh.meta[k];
}
if (!db || !db.data || !db.users) { db = emptyDb(); saveJson(DB_FILE, db); }
let sessions = loadJson(SESSIONS_FILE, {}); // token -> username
const loginFails = new Map(); // ip -> {count, first} — simple brute-force brake

/* ---------------- password hashing (scrypt) ---------------- */

function hashPassword(salt, password) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

function checkPassword(user, password) {
  const h = hashPassword(user.salt, password);
  const a = Buffer.from(h, 'hex'), b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------- helpers ---------------- */

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, modules: u.modules || [], mustChange: !!u.mustChange };
}

function canView(user, view) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return (user.modules || []).includes(view);
}

/* Filter the shared data down to what this user may see. Because the client
   only ever holds permitted sections, its Excel export is scoped by design. */
function dataFor(user) {
  const d = db.data;
  const out = { meta: d.meta };
  for (const [coll, view] of Object.entries(COLLECTION_VIEW)) {
    if (canView(user, view)) out[coll] = d[coll];
  }
  if (user.role === 'admin') {
    out.messages = d.messages;
    out.settings = d.settings;
  }
  return out;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((res, rej) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 5e6) req.destroy(); });
    req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); } });
    req.on('error', rej);
  });
}

function authUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const username = token && sessions[token];
  return username ? db.users.find(u => u.username === username) || null : null;
}

/* ---------------- API ---------------- */

const api = {
  'GET /api/ping': (req, res) => json(res, 200, { ok: true, server: true, needsSetup: db.users.length === 0 }),

  'POST /api/setup': async (req, res) => {
    if (db.users.length || api._setupBusy) return json(res, 409, { error: 'already set up' });
    api._setupBusy = true;
    try {
      const b = await readBody(req);
      /* Re-check AFTER the async body read: two simultaneous setup attempts
         must not both pass — only the first creates the admin. */
      if (db.users.length) return json(res, 409, { error: 'already set up' });
      const username = String(b.username || '').trim();
      const password = String(b.password || '');
      if (!username || password.length < 4) return json(res, 400, { error: 'invalid' });
      const salt = crypto.randomBytes(16).toString('hex');
    const u = { id: 1, username, salt, hash: hashPassword(salt, password), role: 'admin',
      modules: ['dashboard','contacts','companies','deals','tasks','notes','quotes','invoices','products','stock','purchases','suppliers','finance','accounting','payments','employees','reports','contact'],
      mustChange: false, created_at: new Date().toISOString() };
      db.users.push(u);
      saveJson(DB_FILE, db);
      const token = crypto.randomBytes(24).toString('hex');
      sessions[token] = u.username; saveJson(SESSIONS_FILE, sessions);
      json(res, 200, { token, user: publicUser(u) });
    } finally { api._setupBusy = false; }
  },

  'POST /api/login': async (req, res) => {
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
    const now = Date.now();
    const rec = loginFails.get(ip) || { count: 0, first: now };
    if (now - rec.first > 5 * 60 * 1000) { rec.count = 0; rec.first = now; }
    if (rec.count >= 10) return json(res, 429, { error: 'too many attempts, wait a few minutes' });
    const b = await readBody(req);
    const u = db.users.find(x => x.username.toLowerCase() === String(b.username || '').toLowerCase());
    if (!u || !checkPassword(u, String(b.password || ''))) {
      rec.count++; loginFails.set(ip, rec);
      return json(res, 401, { error: 'bad credentials' });
    }
    loginFails.delete(ip);
    const token = crypto.randomBytes(24).toString('hex');
    sessions[token] = u.username; saveJson(SESSIONS_FILE, sessions);
    json(res, 200, { token, user: publicUser(u) });
  },

  'POST /api/logout': (req, res) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    delete sessions[token]; saveJson(SESSIONS_FILE, sessions);
    json(res, 200, { ok: true });
  },

  'GET /api/me': (req, res, user) => json(res, 200, { user: publicUser(user) }),

  'GET /api/data': (req, res, user) => json(res, 200, { data: dataFor(user) }),

  /* Whole-data save with per-section enforcement. For each collection the
     client sends, the server replaces its copy ONLY when the user may write
     that section. Collections the user cannot see are left untouched. */
  'PUT /api/data': async (req, res, user) => {
    const b = await readBody(req);
    const incoming = b.data || {};
    return enqueueWrite(async () => {
    for (const [coll, view] of Object.entries(COLLECTION_VIEW)) {
      /* Server-owned collections (journal, stock moves, payments, invoices,
         purchases, quotes, products, ledger, warehouses, accounts) are only
         ever written by validated transactions — never from a client copy. */
      if (SERVER_OWNED.has(coll)) continue;
      if (Array.isArray(incoming[coll]) && canView(user, view)) db.data[coll] = incoming[coll];
    }
    if (user.role === 'admin') {
      if (Array.isArray(incoming.messages)) db.data.messages = incoming.messages;
      if (incoming.settings && typeof incoming.settings === 'object') db.data.settings = incoming.settings;
    }
    if (incoming.meta && typeof incoming.meta === 'object') {
      const m = incoming.meta;
      for (const k of ['nextId', 'invoiceSeq', 'purchaseSeq', 'quoteSeq']) {
        if (Number.isFinite(m[k])) db.data.meta[k] = Math.max(db.data.meta[k] || 1, m[k]);
      }
    }
    saveJson(DB_FILE, db);
    json(res, 200, { ok: true });
    });
  },

  /* Business transactions: the server validates the actor's permission for
     the operation, applies the business logic itself (same modules the
     browser ships, in a sandbox), checks the accounting and stock
     invariants, and commits atomically. */
  'POST /api/tx': async (req, res, user) => {
    const b = await readBody(req);
    const r = await enqueueWrite(async () => runTx(db, user, String(b.op || ''), b, canView));
    if (!r.ok) return json(res, r.status || 400, { error: r.error, violations: r.violations });
    json(res, 200, { ok: true, ...r.result });
  },

  /* Contact-us: any signed-in user (or the setup-less public form is not a
     thing — contact form requires login like the rest of the app) can send;
     only the admin reads. */
  'POST /api/messages': async (req, res, user) => {
    const b = await readBody(req);
    const body = String(b.body || '').trim();
    if (!body) return json(res, 400, { error: 'empty' });
    const msg = {
      id: db.data.meta.nextId++, from: user.username, name: String(b.name || user.username),
      body, read: false, created_at: new Date().toISOString(),
    };
    db.data.messages.push(msg);
    saveJson(DB_FILE, db);
    json(res, 200, { ok: true, id: msg.id });
  },

  'GET /api/users': (req, res, user) => {
    if (user.role !== 'admin') return json(res, 403, { error: 'admin only' });
    json(res, 200, { users: db.users.map(publicUser) });
  },

  'POST /api/users': async (req, res, user) => {
    if (user.role !== 'admin') return json(res, 403, { error: 'admin only' });
    const b = await readBody(req);
    const username = String(b.username || '').trim();
    const password = String(b.password || '');
    if (!username || password.length < 4) return json(res, 400, { error: 'invalid' });
    if (db.users.some(x => x.username.toLowerCase() === username.toLowerCase())) return json(res, 409, { error: 'exists' });
    const salt = crypto.randomBytes(16).toString('hex');
    const u = { id: db.users.reduce((m, x) => Math.max(m, x.id), 0) + 1, username,
      salt, hash: hashPassword(salt, password), role: b.role === 'admin' ? 'admin' : 'employee',
      modules: Array.isArray(b.modules) ? b.modules.filter(m => typeof m === 'string') : [],
      mustChange: true, created_at: new Date().toISOString() };
    db.users.push(u); saveJson(DB_FILE, db);
    json(res, 200, { user: publicUser(u) });
  },

  'PATCH /api/users': async (req, res, user) => {
    const b = await readBody(req);
    const target = db.users.find(x => x.id === b.id);
    if (!target) return json(res, 404, { error: 'not found' });
    const isSelf = target.username === user.username;
    if (user.role !== 'admin' && !isSelf) return json(res, 403, { error: 'admin only' });
    if (b.newPassword) {
      if (String(b.newPassword).length < 4) return json(res, 400, { error: 'short' });
      target.salt = crypto.randomBytes(16).toString('hex');
      target.hash = hashPassword(target.salt, String(b.newPassword));
      target.mustChange = false;
    }
    if (user.role === 'admin') {
      if (Array.isArray(b.modules)) target.modules = b.modules.filter(m => typeof m === 'string');
      if (b.role && isSelf === false) target.role = b.role === 'admin' ? 'admin' : 'employee';
    }
    saveJson(DB_FILE, db);
    json(res, 200, { user: publicUser(target) });
  },

  'DELETE /api/users': async (req, res, user) => {
    if (user.role !== 'admin') return json(res, 403, { error: 'admin only' });
    const b = await readBody(req);
    const target = db.users.find(x => x.id === b.id);
    if (!target) return json(res, 404, { error: 'not found' });
    if (target.username === user.username) return json(res, 400, { error: 'cannot delete self' });
    db.users = db.users.filter(x => x.id !== b.id);
    saveJson(DB_FILE, db);
    json(res, 200, { ok: true });
  },
};

const NEEDS_AUTH = new Set(['GET /api/me', 'GET /api/data', 'PUT /api/data', 'POST /api/messages', 'POST /api/tx',
  'GET /api/users', 'POST /api/users', 'PATCH /api/users', 'DELETE /api/users', 'POST /api/logout']);

/* ---------------- static files ---------------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function serveStatic(req, res) {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT) || file.startsWith(DATA_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const route = req.method + ' ' + (req.url || '').split('?')[0];
  const handler = api[route];
  if (!handler) return serveStatic(req, res);
  try {
    if (NEEDS_AUTH.has(route)) {
      const user = authUser(req);
      if (!user) return json(res, 401, { error: 'sign in required' });
      return await handler(req, res, user);
    }
    return await handler(req, res);
  } catch (e) {
    console.error(route, e);
    json(res, 500, { error: 'server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Nexus ERP local server — أحمد عبدالله بيزنس ديفيلوبمنت`);
  console.log(`Running on http://localhost:${PORT} — share http://<this-machine-IP>:${PORT} with the team.`);
  console.log(db.users.length ? `${db.users.length} user account(s) on file.` : 'First run: open the app and create the admin account.');
});
