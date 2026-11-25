'use strict';
/* ============================================================
   Nexus ERP — core: data layer, helpers, modal, search, router.
   Runs entirely in the browser; data persists in localStorage
   and can be exported/imported as JSON. No dependencies.
   UI language: English / Arabic (RTL) / German (see i18n.js).
   ============================================================ */

const DB_KEY = 'nexus-erp-v1';
const STAGES = ['Lead', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost'];
const OPEN_STAGES = STAGES.filter(s => s !== 'Won' && s !== 'Lost');
const STAGE_COLORS = {
  Lead: '#60a5fa', Qualified: '#818cf8', Proposal: '#f59e0b',
  Negotiation: '#a855f7', Won: '#22c55e', Lost: '#94a3b8',
};

/* Global registry: modules register their views, quick-add actions
   and editors here so core can route, search and cross-link. */
const App = { views: {}, quickAdd: {}, editors: {} };

/* Display labels per view (used for access-control checkboxes). */
const VIEW_LABELS = {
  dashboard: 'Dashboard', contacts: 'Contacts', companies: 'Companies', deals: 'Deals',
  quotes: 'Quotes', orders: 'Sales orders', accounting: 'Accounting', payments: 'Payments', stock: 'Stock ledger',
  tasks: 'Tasks', notes: 'Notes', invoices: 'Invoices', products: 'Inventory', projects: 'Projects',
  purchases: 'Purchases', suppliers: 'Suppliers', finance: 'Finance', expenses: 'Expense requests', employees: 'Employees',
  reports: 'Reports', contact: 'Contact us', helpdesk: 'Helpdesk', 'hr-self': 'My HR', assets: 'Assets', pos: 'Point of sale', quality: 'Quality & documents',
};

/* ---------------- Data layer ---------------- */

function emptyData() {
  return {
    meta: { nextId: 1, invoiceSeq: 1, purchaseSeq: 1, quoteSeq: 1, orderSeq: 1, returnSeq: 1, ticketSeq: 1, qcSeq: 1, docSeq: 1, cnSeq: 1, prSeq: 1 },
    companies: [], contacts: [], deals: [], tasks: [], activities: [], quotes: [], projects: [], timesheets: [], tickets: [], ticket_replies: [],
    leave_requests: [], attendance: [], assets: [], quality_checks: [], documents: [], credit_notes: [], customer_credits: [], supplier_credits: [], purchase_returns: [], pos_shifts: [],
    products: [], suppliers: [], invoices: [], purchases: [], sales_orders: [], returns: [], recurring: [],
    ledger: [], expenses: [], employees: [], notes: [], messages: [],
    accounts: [], journal: [], payments: [], warehouses: [], stock_moves: [],
    settings: {},
  };
}

const store = {
  data: null,
  load() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      this.data = raw ? JSON.parse(raw) : seedData();
    } catch (e) {
      console.error('Failed to load saved data, reseeding.', e);
      this.data = seedData();
    }
    if (!this.data || !this.data.meta) this.data = seedData();
    // tolerate exports missing newer collections
    for (const key of Object.keys(emptyData())) if (!this.data[key]) this.data[key] = emptyData()[key];
    this.save();
  },
  save() {
    try {
      localStorage.setItem(DB_KEY, JSON.stringify(this.data));
    } catch (e) {
      console.error('Save failed:', e);
      if (typeof toast === 'function') toast(t('Could not save data. Browser storage is full.'));
    }
    if (window.Sync && Sync.mode === 'server') Sync.push();
  },
  // Adopt an imported data object: normalize missing collections, then persist.
  adopt(data) {
    this.data = data;
    if (!this.data || !this.data.meta) this.data = seedData();
    for (const key of Object.keys(emptyData())) if (!this.data[key]) this.data[key] = emptyData()[key];
    this.save();
  },
  add(coll, row) {
    row.id = this.data.meta.nextId++;
    row.created_at = row.created_at || new Date().toISOString();
    this.data[coll].push(row);
    this.save();
    return row;
  },
  update(coll, id, patch) {
    const row = this.data[coll].find(r => r.id === id);
    if (!row) return null;
    Object.assign(row, patch);
    if (coll === 'deals') row.updated_at = new Date().toISOString();
    this.save();
    return row;
  },
  remove(coll, id) {
    const i = this.data[coll].findIndex(r => r.id === id);
    if (i >= 0) { this.data[coll].splice(i, 1); this.save(); }
  },
  find(coll, id) { return this.data[coll].find(r => r.id === id) || null; },
  company(id) { return this.find('companies', id); },
  contact(id) { return this.find('contacts', id); },
  deal(id) { return this.find('deals', id); },
  product(id) { return this.find('products', id); },
  supplier(id) { return this.find('suppliers', id); },
  invoice(id) { return this.find('invoices', id); },
  employee(id) { return this.find('employees', id); },
};

/* ---------------- Helpers ---------------- */

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = v => new Intl.NumberFormat(localeTag(), { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(v) || 0);
const money0 = v => new Intl.NumberFormat(localeTag(), { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(v) || 0);
const contactName = c => c ? (`${c.first_name || ''} ${c.last_name || ''}`.trim() || c.name || '') : '';
const companyOf = row => row && row.company_id ? store.company(row.company_id) : null;
const todayStr = () => new Date().toISOString().slice(0, 10);
const monthStr = () => todayStr().slice(0, 7);
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const idsOrNull = v => (v === '' || v == null ? null : Number(v));

function dueLabel(due) {
  if (!due) return t('No date');
  const td = todayStr();
  if (due < td) return `${t('Overdue')} · ${due}`;
  if (due === td) return t('Due today');
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  if (due === tomorrow.toISOString().slice(0, 10)) return t('Due tomorrow');
  return `${t('Due')} ${due}`;
}

function relTime(isoStr) {
  const then = new Date(isoStr); const now = new Date();
  const mins = Math.round((now - then) / 60000);
  if (mins < 1) return t('just now');
  if (mins < 60) return `${mins}${t('m ago')}`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}${t('h ago')}`;
  const days = Math.round(hrs / 24);
  return days === 1 ? t('yesterday') : `${days}${t('d ago')}`;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2200);
}

/* ---------------- Modal form ---------------- */

let modalSubmit = null;

function openModal(title, fields, onSubmit) {
  $('#modalTitle').textContent = title;
  const form = $('#modalForm');
  form.innerHTML = '<div class="form-grid">' + fields.map(f => {
    const full = (f.full || f.type === 'textarea') ? ' full' : '';
    const req = f.required ? ' required' : '';
    let control;
    const val = f.value ?? '';
    if (f.type === 'select') {
      control = `<select name="${f.key}"${req}>` +
        (f.allowEmpty ? `<option value="">${esc(f.allowEmpty)}</option>` : '') +
        f.options.map(o => {
          const ov = typeof o === 'object' ? o.value : o;
          const ol = typeof o === 'object' ? o.label : o;
          return `<option value="${esc(ov)}"${String(ov) === String(val) ? ' selected' : ''}>${esc(ol)}</option>`;
        }).join('') + '</select>';
    } else if (f.type === 'textarea') {
      control = `<textarea name="${f.key}" placeholder="${esc(f.placeholder || '')}">${esc(val)}</textarea>`;
    } else if (f.type === 'modules') {
      const selected = Array.isArray(val) ? val : [];
      control = '<div class="check-grid">' + GRANTABLE_VIEWS.map(v =>
        `<label class="check-item"><input type="checkbox" name="${f.key}" value="${v}"${selected.includes(v) ? ' checked' : ''}> ${esc(t(VIEW_LABELS[v] || v))}</label>`).join('') + '</div>';
    } else {
      control = `<input name="${f.key}" type="${f.type || 'text'}" value="${esc(val)}" placeholder="${esc(f.placeholder || '')}"${req}${f.type === 'number' ? ' step="any"' : ''}>`;
    }
    return `<div class="field${full}"><label>${esc(f.label)}${f.required ? ' *' : ''}</label>${control}</div>`;
  }).join('') + `</div>
  <div class="modal-actions">
    <button type="button" class="secondary-btn" id="modalCancel">${t('Cancel')}</button>
    <button type="submit" class="primary-btn">${t('Save')}</button>
  </div>`;
  modalSubmit = onSubmit;
  $('#modalBackdrop').classList.remove('hidden');
  $('#modalCancel').onclick = closeModal;
  const first = form.querySelector('input, select, textarea');
  if (first) first.focus();
}

function closeModal() {
  $('#modalBackdrop').classList.add('hidden');
  modalSubmit = null;
}

function bindModal() {
  $('#modalClose').onclick = closeModal;
  $('#modalBackdrop').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modalBackdrop').classList.contains('hidden')) closeModal(); });
  $('#modalForm').addEventListener('submit', e => {
    e.preventDefault();
    if (!e.target.reportValidity()) return;
    const fd = new FormData(e.target);
    const out = {};
    for (const k of new Set(fd.keys())) {
      const all = fd.getAll(k);
      out[k] = all.length > 1 ? all : (typeof all[0] === 'string' ? all[0].trim() : all[0]);
    }
    // unchecked checkbox groups never appear in FormData — restore them as empty lists
    e.target.querySelectorAll('.check-grid').forEach(grid => {
      const name = grid.querySelector('input')?.name;
      if (name && out[name] === undefined) out[name] = [];
      else if (name && !Array.isArray(out[name])) out[name] = [out[name]];
    });
    const fn = modalSubmit;
    closeModal();
    if (fn) fn(out);
  });
}

function confirmDelete(label, fn) {
  if (window.confirm(t('Delete {item}? This cannot be undone.').replace('{item}', label))) { fn(); render(); }
}

/* Server-authoritative transaction wrapper (server mode only): the server
   validates the operation, writes the derived accounting/stock records
   itself and commits atomically. The client never edits those collections
   directly when a server is in charge. */
function txCall(op, payload, okMsg) {
  Sync.tx(op, payload).then(r => {
    if (r.ok) { if (okMsg) toast(okMsg); }
    else toast(t('The server rejected the change.') + (r.data && r.data.error ? ` (${r.data.error})` : ''));
    render();
  }).catch(() => { toast(t('Could not reach the server. Your change was not saved.')); render(); });
}
function inServerMode() { return typeof Sync !== 'undefined' && Sync.authoritative && Sync.authoritative(); }

/* Advance an ISO date (yyyy-mm-dd) by a recurring interval, UTC-safe.
   Monthly and longer intervals keep the template's anchor day-of-month,
   clamped to the target month's length: Jan 31 -> Feb 28/29 -> Mar 31,
   never drifting to the 28th forever. */
function advanceDate(iso, interval, anchorDay) {
  const [y, m, dd] = String(iso).split('-').map(Number);
  if (interval === 'weekly') {
    const d = new Date(Date.UTC(y, m - 1, dd));
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  }
  const months = interval === 'monthly' ? 1 : interval === 'quarterly' ? 3 : 12;
  const anchor = Math.max(1, Math.min(31, Number(anchorDay) || dd));
  const total = (m - 1) + months;
  const ty = y + Math.floor(total / 12);
  const tm = total % 12;
  const dim = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ty, tm, Math.min(anchor, dim))).toISOString().slice(0, 10);
}

/* ---------------- Search ---------------- */

function runSearch(q) {
  const allowed = m => (typeof Auth === 'undefined' || !Auth.current) ? true : Auth.can(m);
  const needle = q.toLowerCase();
  const hits = [];
  if (allowed('contacts')) store.data.contacts.forEach(c => {
    if (`${contactName(c)} ${c.email} ${c.phone} ${c.position} ${c.tags}`.toLowerCase().includes(needle))
      hits.push({ kind: t('Contact'), label: contactName(c), sub: c.email || c.phone || '', go: () => App.editors.contact(c) });
  });
  if (allowed('companies')) store.data.companies.forEach(c => {
    if (`${c.name} ${c.industry} ${c.email}`.toLowerCase().includes(needle))
      hits.push({ kind: t('Company'), label: c.name, sub: c.industry || '', go: () => App.editors.company(c) });
  });
  if (allowed('deals')) store.data.deals.forEach(x => {
    if (`${x.title} ${x.stage} ${x.notes}`.toLowerCase().includes(needle))
      hits.push({ kind: t('Deal'), label: x.title, sub: `${t(x.stage)} · ${money0(x.value)}`, go: () => App.editors.deal(x) });
  });
  if (allowed('products')) store.data.products.forEach(p => {
    if (`${p.name} ${p.sku} ${p.category}`.toLowerCase().includes(needle))
      hits.push({ kind: t('Product'), label: p.name, sub: `${p.sku} · ${t('stock')} ${p.stock}`, go: () => App.editors.product(p) });
  });
  if (allowed('invoices')) store.data.invoices.forEach(inv => {
    const c = inv.contact_id ? store.contact(inv.contact_id) : null;
    if (`${inv.number} ${inv.status} ${c ? contactName(c) : ''}`.toLowerCase().includes(needle))
      hits.push({ kind: t('Invoice'), label: inv.number, sub: `${t(inv.status)} · ${money(invoiceTotal(inv))}`, go: () => App.editors.invoice(inv) });
  });
  if (allowed('suppliers')) store.data.suppliers.forEach(s => {
    if (`${s.name} ${s.contact_person} ${s.email}`.toLowerCase().includes(needle))
      hits.push({ kind: t('Supplier'), label: s.name, sub: s.contact_person || '', go: () => App.editors.supplier(s) });
  });
  return hits.slice(0, 8);
}

function bindSearch() {
  const input = $('#globalSearch');
  const box = $('#searchResults');
  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    const hits = runSearch(q);
    box.innerHTML = hits.length
      ? hits.map((h, i) => `<button class="search-hit" data-i="${i}"><span class="kind">${esc(h.kind)}</span><span class="grow">${esc(h.label)}</span><span class="cell-sub">${esc(h.sub)}</span></button>`).join('')
      : `<div class="search-empty">${t('No matches.')}</div>`;
    box.classList.remove('hidden');
    box.querySelectorAll('.search-hit').forEach(b => {
      b.onclick = () => { box.classList.add('hidden'); input.value = ''; hits[Number(b.dataset.i)].go(); };
    });
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.search-wrap')) box.classList.add('hidden');
  });
}

/* ---------------- Quick add ---------------- */

function bindQuickAdd() {
  $('#quickAddBtn').onclick = () => {
    const fn = App.quickAdd[currentView] || App.quickAdd.contacts;
    if (fn) fn();
  };
}

/* ---------------- Export / import ---------------- */

function bindExportImport() {
  $('#exportBtn').onclick = () => {
    if (typeof Auth !== 'undefined' && Auth.current && !Auth.isAdmin()) { alert(t('Only the admin can export data.')); return; }
    const blob = new Blob([JSON.stringify(store.data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `nexus-erp-export-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(t('Data exported'));
  };
  $('#importInput').addEventListener('change', e => {
    if (typeof Auth !== 'undefined' && Auth.current && !Auth.isAdmin()) { alert(t('Only the admin can import data.')); return; e.target.value=''; }
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || !data.meta || !Array.isArray(data.contacts) || !Array.isArray(data.companies)
          || !Array.isArray(data.deals) || !Array.isArray(data.tasks))
          throw new Error('bad shape');
        store.adopt(data); // normalize missing collections, then persist (never re-read storage here)
        toast(t('Data imported'));
        render();
      } catch (err) {
        alert(t('That file is not a valid Nexus ERP export.'));
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  });
}

/* ---------------- Router ---------------- */

let currentView = 'dashboard';

function render() {
  if (App.views[currentView]) App.views[currentView]();
}

function switchView(name) {
  if (typeof Auth !== 'undefined' && Auth.current && !Auth.can(name)) name = Auth.firstAllowed();
  currentView = name;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  const section = $(`#view-${name}`);
  if (section) section.classList.remove('hidden');
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  render();
}

function bindNav() {
  document.querySelectorAll('.nav-item').forEach(b => { b.onclick = () => switchView(b.dataset.view); });
  window.addEventListener('hashchange', () => {
    const v = location.hash.slice(1);
    if (App.views[v] && v !== currentView) switchView(v);
  });
}
