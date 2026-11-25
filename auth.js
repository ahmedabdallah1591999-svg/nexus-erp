'use strict';
/* auth.js — sign-in screen, user accounts and per-module access control.
   Honest scope: this is an in-app access gate. Data still lives in the
   browser, so it keeps casual users out of modules they should not see,
   but it is not server-side security. Passwords are stored salted+hashed
   (SHA-256), never in plain text. */

const AUTH_KEY = 'nexus-erp-auth-v1';
const SESSION_KEY = 'nexus-erp-session-v1';

/* Views an admin can grant to an employee. users/inbox stay admin-only. */
const GRANTABLE_VIEWS = ['dashboard', 'contacts', 'companies', 'deals', 'tasks', 'notes',
  'invoices', 'products', 'purchases', 'suppliers', 'finance', 'employees', 'reports', 'contact'];

const Auth = {
  users: [],
  current: null,

  load() {
    try { this.users = JSON.parse(localStorage.getItem(AUTH_KEY)) || []; }
    catch (e) { this.users = []; }
    if (!this.users.length) {
      this.users = [];
      const salt = Auth.makeSalt();
      Auth.hash(salt, 'admin123').then(h => {
        this.users.push({ id: 1, username: 'admin', salt, hash: h, role: 'admin', modules: GRANTABLE_VIEWS.slice(), mustChange: true, created_at: new Date().toISOString() });
        this.persist();
      });
    }
  },

  persist() { localStorage.setItem(AUTH_KEY, JSON.stringify(this.users)); },

  makeSalt() { return Math.random().toString(36).slice(2) + Date.now().toString(36); },

  async hash(salt, password) {
    const msg = salt + ':' + password;
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57; // non-crypto fallback (obfuscation only)
    for (let i = 0; i < msg.length; i++) {
      const ch = msg.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
  },

  find(username) { return this.users.find(u => u.username.toLowerCase() === String(username).toLowerCase()) || null; },

  sessionUser() {
    const name = sessionStorage.getItem(SESSION_KEY);
    return name ? this.find(name) : null;
  },

  isLoggedIn() { return !!this.current; },
  isAdmin() { return !!(this.current && this.current.role === 'admin'); },

  can(view) {
    if (!this.current) return false;
    if (view === 'users' || view === 'inbox') return this.current.role === 'admin';
    if (this.current.role === 'admin') return true;
    return (this.current.modules || []).includes(view);
  },

  firstAllowed() {
    if (this.isAdmin()) return 'dashboard';
    const m = this.current.modules || [];
    return m[0] || 'contact';
  },

  async login(username, password) {
    const u = this.find(username);
    if (!u) return false;
    const h = await this.hash(u.salt, password);
    if (h !== u.hash) return false;
    this.current = u;
    sessionStorage.setItem(SESSION_KEY, u.username);
    return true;
  },

  logout() {
    this.current = null;
    sessionStorage.removeItem(SESSION_KEY);
    location.hash = '';
    location.reload();
  },

  async setPassword(user, newPassword) {
    user.salt = this.makeSalt();
    user.hash = await this.hash(user.salt, newPassword);
    user.mustChange = false;
    this.persist();
  },

  /* ---------------- Login screen ---------------- */

  init(onReady) {
    this.load();
    const screen = $('#loginScreen');
    const form = $('#loginForm');
    const err = $('#loginError');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      err.classList.add('hidden');
      const ok = await this.login($('#loginUser').value.trim(), $('#loginPass').value);
      if (!ok) { err.classList.remove('hidden'); return; }
      screen.classList.add('hidden');
      document.querySelector('.app').classList.remove('app-locked');
      this.applyUI();
      onReady();
      if (this.current.mustChange) this.forcePasswordChange();
    });
    const existing = this.sessionUser();
    if (existing) {
      this.current = existing;
      screen.classList.add('hidden');
      document.querySelector('.app').classList.remove('app-locked');
      this.applyUI();
      onReady();
      if (this.current.mustChange) this.forcePasswordChange();
    }
  },

  applyUI() {
    const u = this.current;
    if (!u) return;
    document.querySelectorAll('.nav-item').forEach(b => {
      b.style.display = this.can(b.dataset.view) ? '' : 'none';
    });
    document.querySelectorAll('.nav-section').forEach(sec => {
      let el = sec.nextElementSibling, any = false;
      while (el && !el.classList.contains('nav-section')) {
        if (el.classList.contains('nav-item') && el.style.display !== 'none') any = true;
        el = el.nextElementSibling;
      }
      sec.style.display = any ? '' : 'none';
    });
    document.querySelectorAll('.admin-only').forEach(el => {
      el.style.display = this.isAdmin() ? '' : 'none';
    });
    const chip = $('#userChip');
    if (chip) {
      chip.style.display = '';
      $('#userChipName').textContent = u.username;
      $('#userChipRole').textContent = u.role === 'admin' ? t('Admin') : t('Employee');
    }
    const lo = $('#logoutBtn');
    if (lo) lo.onclick = () => this.logout();
    const cp = $('#changePassBtn');
    if (cp) cp.onclick = () => this.changePasswordDialog();
    updateInboxBadge();
  },

  forcePasswordChange() {
    openModal(t('Choose a new password'), [
      { key: 'p1', label: t('New password'), type: 'password', required: true },
      { key: 'p2', label: t('Confirm password'), type: 'password', required: true },
    ], async out => {
      if (!out.p1 || out.p1.length < 4) { alert(t('Password is too short.')); return this.forcePasswordChange(); }
      if (out.p1 !== out.p2) { alert(t('Passwords do not match.')); return this.forcePasswordChange(); }
      await this.setPassword(this.current, out.p1);
      toast(t('Password updated'));
    });
  },

  changePasswordDialog() {
    openModal(t('Change password'), [
      { key: 'old', label: t('Current password'), type: 'password', required: true },
      { key: 'p1', label: t('New password'), type: 'password', required: true },
      { key: 'p2', label: t('Confirm password'), type: 'password', required: true },
    ], async out => {
      const h = await this.hash(this.current.salt, out.old);
      if (h !== this.current.hash) { alert(t('Current password is wrong.')); return; }
      if (!out.p1 || out.p1.length < 4) { alert(t('Password is too short.')); return; }
      if (out.p1 !== out.p2) { alert(t('Passwords do not match.')); return; }
      await this.setPassword(this.current, out.p1);
      toast(t('Password updated'));
    });
  },
};

/* ---------------- Users admin view ---------------- */

function userFields(row) {
  return [
    { key: 'username', label: t('Username'), required: true, value: row?.username },
    {
      key: 'role', label: t('Role'), type: 'select',
      options: [{ value: 'admin', label: t('Admin') }, { value: 'employee', label: t('Employee') }],
      value: row?.role || 'employee',
    },
    { key: 'password', label: row ? t('New password (leave empty to keep)') : t('Password'), type: 'password', required: !row },
    { key: 'modules', label: t('Allowed sections'), type: 'modules', value: row?.modules || ['dashboard', 'contact'] },
  ];
}

function editUser(row) {
  openModal(row ? t('Edit user') : t('New user'), userFields(row), async out => {
    const username = (out.username || '').trim();
    if (!username) return;
    const dup = Auth.find(username);
    if (dup && (!row || dup.id !== row.id)) { alert(t('Username already exists.')); return; }
    const modules = Array.isArray(out.modules) ? out.modules : (out.modules ? [out.modules] : []);
    if (row) {
      const patch = { username, role: out.role, modules };
      if (out.password) { await Auth.setPassword(row, out.password); }
      Object.assign(row, patch);
      Auth.persist();
      toast(t('User updated'));
    } else {
      if (!out.password || out.password.length < 4) { alert(t('Password is too short.')); return; }
      const u = { id: Math.max(0, ...Auth.users.map(x => x.id)) + 1, username, role: out.role, modules, mustChange: false, created_at: new Date().toISOString() };
      await Auth.setPassword(u, out.password);
      Auth.users.push(u);
      Auth.persist();
      toast(t('User added'));
    }
    render();
  });
}

function renderUsers() {
  const rows = Auth.users.map(u => `
    <tr>
      <td><strong>${esc(u.username)}</strong></td>
      <td><span class="badge ${u.role === 'admin' ? 'won' : ''}">${u.role === 'admin' ? t('Admin') : t('Employee')}</span></td>
      <td class="cell-sub">${u.role === 'admin' ? t('All sections') : (u.modules || []).map(m => t(VIEW_LABELS[m] || m)).join(' · ') || '—'}</td>
      <td class="row-actions">
        <button class="icon-btn" data-act="edit" data-id="${u.id}" title="${t('Edit')}">✏️</button>
        <button class="danger-btn" data-act="del" data-id="${u.id}" title="${t('Delete')}">🗑</button>
      </td>
    </tr>`).join('');

  $('#view-users').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Users')}</h2><div class="sub">${t('Accounts and section access')}</div></div>
      <div class="head-actions"><button id="addUser" class="primary-btn">+ ${t('New user')}</button></div>
    </div>
    <div class="panel">
      <table class="table">
        <thead><tr><th>${t('Username')}</th><th>${t('Role')}</th><th>${t('Allowed sections')}</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="panel"><div class="cell-sub">${t('Access is controlled inside the app on this device. For real multi-user security the system needs a server database.')}</div></div>
  `;

  $('#addUser').onclick = () => editUser(null);
  $('#view-users').querySelector('tbody').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const row = Auth.users.find(x => x.id === id);
    if (btn.dataset.act === 'edit') editUser(row);
    if (btn.dataset.act === 'del') {
      if (Auth.current && Auth.current.id === id) { alert(t('You cannot delete your own account.')); return; }
      if (row.role === 'admin' && Auth.users.filter(x => x.role === 'admin').length === 1) { alert(t('At least one admin must remain.')); return; }
      confirmDelete(`${t('user')} "${row.username}"`, () => {
        Auth.users = Auth.users.filter(x => x.id !== id);
        Auth.persist();
        toast(t('User deleted'));
      });
    }
  });
}

App.views.users = renderUsers;
