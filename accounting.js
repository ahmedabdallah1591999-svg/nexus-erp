'use strict';
/* accounting.js — double-entry accounting: chart of accounts, balanced
   journal entries, trial balance, accounting-equation invariants.
   The simple cash ledger (finance.js) stays as the cash view; this module
   is the accrual book. Operational flows post here automatically:
   invoice sent (AR/Revenue/VAT), invoice paid (Cash/AR),
   purchase received (Inventory/AP), payroll run (Payroll expense/Cash). */

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];

const DEFAULT_COA = [
  { code: '1000', name: 'Cash', type: 'asset' },
  { code: '1010', name: 'Bank', type: 'asset' },
  { code: '1100', name: 'Accounts Receivable', type: 'asset' },
  { code: '1200', name: 'Inventory', type: 'asset' },
  { code: '2000', name: 'Accounts Payable', type: 'liability' },
  { code: '2100', name: 'VAT Payable', type: 'liability' },
  { code: '3000', name: "Owner's Equity", type: 'equity' },
  { code: '4000', name: 'Sales Revenue', type: 'revenue' },
  { code: '4100', name: 'Other Income', type: 'revenue' },
  { code: '5000', name: 'Cost of Goods Sold', type: 'expense' },
  { code: '6000', name: 'Operating Expenses', type: 'expense' },
  { code: '6100', name: 'Payroll Expense', type: 'expense' },
  { code: '1500', name: 'Fixed Assets', type: 'asset' },
  { code: '1590', name: 'Accumulated Depreciation', type: 'asset' },
  { code: '6200', name: 'Depreciation Expense', type: 'expense' },
  { code: '6900', name: 'Loss on Disposal', type: 'expense' },
  { code: '7100', name: 'Gain on Disposal', type: 'revenue' },
];

function ensureCOA() {
  if (!store.data.accounts) store.data.accounts = [];
  if (!store.data.journal) store.data.journal = [];
  const hadAccounts = store.data.accounts.length > 0;
  /* schema addition: fill in default accounts that are missing (older
     databases predate newer accounts like COGS) — never touches existing
     entries or the journal */
  let added = false;
  for (const a of DEFAULT_COA) {
    if (!store.data.accounts.some(x => x.code === a.code)) {
      store.add('accounts', { code: a.code, name: a.name, type: a.type });
      added = true;
    }
  }
  if (!hadAccounts) {
    /* fresh setup with stock but no books activity yet: establish known
       opening values explicitly. A pre-upgrade database with any journal
       history takes the admin review path (migrateInventoryValuation) and
       never gets an automatic equity entry. */
    /* an empty journal is NOT proof of a fresh setup — real or imported
       stock can have no journal. Only the explicitly marked synthetic seed
       fixture gets automatic opening values; everything else takes the
       admin review path (migrateInventoryValuation), even with no journal. */
    if (!store.data.journal.length && store.data.settings && store.data.settings.seed_demo) {
      const pv = Math.round(store.data.products.reduce((s, p) => s + num(p.stock) * num(p.cost), 0) * 100) / 100;
      if (pv > 0) {
        postJournal({
          date: todayStr(),
          memo: t('Opening stock per the initial product list (fresh setup)'),
          ref_type: 'opening', ref_id: null,
          lines: [
            { account_id: store.data.accounts.find(a => a.code === '1200').id, debit: pv },
            { account_id: store.data.accounts.find(a => a.code === '3000').id, credit: pv },
          ],
        });
        added = true;
      }
    }
  }
  if (added) store.save();
}

function accountCode(id) {
  const a = (store.data.accounts || []).find(x => x.id === id);
  return a ? a.code : null;
}

/* depreciation posted to the books for one asset (journal is the source) */
function accumDepr(assetId) {
  const acc = accountByCode('1590');
  if (!acc) return 0;
  return (store.data.journal || []).reduce((s, j) => {
    if (j.ref_type !== 'asset-depr' || j.ref_id !== assetId) return s;
    return s + (j.lines || []).reduce((t, l) => t + (l.account_id === acc.id ? num(l.credit) : 0), 0);
  }, 0);
}

function accountByCode(code) {
  return store.data.accounts.find(a => a.code === code);
}

/* Post a balanced journal entry. Returns the entry, or null when invalid.
   Rules: at least 2 lines, every line has a positive debit XOR credit,
   total debits equal total credits to the cent. */
function postJournal({ date, memo, ref_type, ref_id, lines }) {
  const clean = (lines || [])
    .map(l => ({ account_id: Number(l.account_id), debit: Math.round(num(l.debit) * 100) / 100, credit: Math.round(num(l.credit) * 100) / 100 }))
    .filter(l => l.account_id && (l.debit > 0 || l.credit > 0));
  if (clean.length < 2) return null;
  for (const l of clean) {
    if (l.debit > 0 && l.credit > 0) return null;      // one side only
    if (!store.data.accounts.some(a => a.id === l.account_id)) return null;
  }
  const dr = clean.reduce((s, l) => s + l.debit, 0);
  const cr = clean.reduce((s, l) => s + l.credit, 0);
  if (Math.abs(dr - cr) > 0.005) return null;          // must balance
  return store.add('journal', {
    date: date || todayStr(), memo: memo || '',
    ref_type: ref_type || null, ref_id: ref_id || null,
    lines: clean,
  });
}

/* Reverse an entry: same lines, debits and credits swapped. */
function reverseJournal(entryId, memo) {
  const e = store.data.journal.find(j => j.id === entryId);
  if (!e) return null;
  return postJournal({
    date: todayStr(),
    memo: memo || `${t('Reversal of')} #${e.id} ${e.memo || ''}`.trim(),
    ref_type: e.ref_type, ref_id: e.ref_id,
    lines: e.lines.map(l => ({ account_id: l.account_id, debit: l.credit, credit: l.debit })),
  });
}

function accountBalance(accountId, upToDate) {
  let bal = 0;
  for (const j of store.data.journal) {
    if (upToDate && (j.date || '') > upToDate) continue;
    for (const l of j.lines) if (l.account_id === accountId) bal += l.debit - l.credit;
  }
  return Math.round(bal * 100) / 100;
}

/* Signed balance in the account's "natural" direction (assets/expenses
   debit-positive, liabilities/equity/revenue credit-positive). */
function naturalBalance(a, upToDate) {
  const raw = accountBalance(a.id, upToDate);
  return (a.type === 'asset' || a.type === 'expense') ? raw : -raw;
}

function trialBalance(upToDate) {
  const rows = store.data.accounts.map(a => ({ account: a, balance: naturalBalance(a, upToDate) }))
    .filter(r => Math.abs(r.balance) > 0.004 || true); // show all accounts
  const dr = rows.filter(r => (r.account.type === 'asset' || r.account.type === 'expense'))
    .reduce((s, r) => s + r.balance, 0);
  const cr = rows.filter(r => !(r.account.type === 'asset' || r.account.type === 'expense'))
    .reduce((s, r) => s + r.balance, 0);
  return { rows, debitTotal: Math.round(dr * 100) / 100, creditTotal: Math.round(cr * 100) / 100 };
}

/* Independent integrity check. Returns a list of violations; empty = books ok. */
function accountingInvariants() {
  const bad = [];
  for (const j of store.data.journal) {
    const dr = j.lines.reduce((s, l) => s + l.debit, 0);
    const cr = j.lines.reduce((s, l) => s + l.credit, 0);
    if (Math.abs(dr - cr) > 0.005) bad.push(`journal #${j.id} unbalanced (dr ${dr} / cr ${cr})`);
    for (const l of j.lines) {
      if (l.debit > 0 && l.credit > 0) bad.push(`journal #${j.id} line with both sides`);
      if (!store.data.accounts.some(a => a.id === l.account_id)) bad.push(`journal #${j.id} unknown account ${l.account_id}`);
    }
  }
  const sum = type => store.data.accounts.filter(a => a.type === type)
    .reduce((s, a) => s + naturalBalance(a), 0);
  const assets = sum('asset'), liab = sum('liability'), eq = sum('equity');
  const rev = sum('revenue'), exp = sum('expense');
  if (Math.abs(assets - (liab + eq + rev - exp)) > 0.01) {
    bad.push(`accounting equation broken: assets ${assets.toFixed(2)} != L ${liab.toFixed(2)} + E ${eq.toFixed(2)} + (R ${rev.toFixed(2)} - X ${exp.toFixed(2)})`);
  }
  /* the Inventory account must reconcile with the stock ledger at cost —
     a balanced journal alone does not prove correct financial semantics */
  if (typeof inventoryValuationViolations === 'function') bad.push(...inventoryValuationViolations());
  return bad;
}

/* ---------------- automatic postings from operational flows ---------------- */

function postInvoiceSentJournal(inv) {
  const total = Math.round(invoiceTotal(inv) * 100) / 100;
  const sub = Math.round((inv.items || []).reduce((s, it) => s + num(it.qty) * num(it.price), 0) * 100) / 100;
  const tax = Math.round((total - sub) * 100) / 100;
  const lines = [
    { account_id: accountByCode('1100').id, debit: total },
    { account_id: accountByCode('4000').id, credit: sub },
  ];
  if (tax > 0) lines.push({ account_id: accountByCode('2100').id, credit: tax });
  return postJournal({ date: inv.issue_date, memo: `${t('Invoice')} ${inv.number} ${t('sent')}`, ref_type: 'invoice', ref_id: inv.id, lines });
}

function postInvoicePaidJournal(inv) {
  const total = Math.round(invoiceTotal(inv) * 100) / 100;
  return postJournal({
    date: todayStr(), memo: `${t('Payment received for')} ${inv.number}`, ref_type: 'invoice', ref_id: inv.id,
    lines: [{ account_id: accountByCode('1000').id, debit: total }, { account_id: accountByCode('1100').id, credit: total }],
  });
}

function postPurchaseReceivedJournal(rec) {
  const total = Math.round(purchaseTotal(rec) * 100) / 100;
  return postJournal({
    date: rec.received_date || todayStr(), memo: `${rec.number} ${t('received')}`, ref_type: 'purchase', ref_id: rec.id,
    lines: [{ account_id: accountByCode('1200').id, debit: total }, { account_id: accountByCode('2000').id, credit: total }],
  });
}

function postPayrollJournal(month, total) {
  return postJournal({
    date: todayStr(), memo: `${t('Payroll')} ${month}`, ref_type: 'payroll', ref_id: null,
    lines: [{ account_id: accountByCode('6100').id, debit: total }, { account_id: accountByCode('1000').id, credit: total }],
  });
}

/* COGS when an invoice's stock leaves the warehouse: the sold units move
   from Inventory to Cost of Goods Sold at their cost. This is what makes
   the Inventory account reconcile with the stock ledger valuation. */
function invoiceCostTotal(inv) {
  return Math.round((inv.items || []).reduce((s, it) => {
    const p = it.product_id ? store.product(it.product_id) : null;
    return s + (p ? num(it.qty) * num(p.cost) : 0);
  }, 0) * 100) / 100;
}

function postInvoiceCOGSJournal(inv) {
  const cogs = invoiceCostTotal(inv);
  if (!(cogs > 0)) return null;
  return postJournal({
    date: inv.issue_date || todayStr(), memo: `${t('Cost of goods sold for')} ${inv.number}`,
    ref_type: 'invoice-cogs', ref_id: inv.id,
    lines: [{ account_id: accountByCode('5000').id, debit: cogs }, { account_id: accountByCode('1200').id, credit: cogs }],
  });
}

/* Opening stock is capital the business starts with: Dr Inventory / Cr equity. */
function postOpeningStockJournal(product, qty) {
  const val = Math.round(num(qty) * num(product.cost) * 100) / 100;
  if (!(val > 0)) return null;
  return postJournal({
    date: todayStr(), memo: `${t('Opening stock')}: ${product.name}`,
    ref_type: 'opening-stock', ref_id: product.id,
    lines: [{ account_id: accountByCode('1200').id, debit: val }, { account_id: accountByCode('3000').id, credit: val }],
  });
}

/* Stock adjustments change inventory value: losses are an expense, gains
   reduce it. Dr/Cr against Operating Expenses at cost. */
function postStockAdjustmentJournal(product, qty, memo) {
  const val = Math.round(Math.abs(num(qty)) * num(product.cost) * 100) / 100;
  if (!(val > 0)) return null;
  const inv = accountByCode('1200').id, opex = accountByCode('6000').id;
  const lines = num(qty) < 0
    ? [{ account_id: opex, debit: val }, { account_id: inv, credit: val }]
    : [{ account_id: inv, debit: val }, { account_id: opex, credit: val }];
  return postJournal({
    date: todayStr(), memo: `${t('Stock adjustment')}: ${product.name}${memo ? ' — ' + memo : ''}`,
    ref_type: 'stock-adjustment', ref_id: product.id, lines,
  });
}

/* Reconciliation proof: the Inventory GL account must equal the stock
   ledger valued at cost, and the equation must still hold. Returns a list
   of violations (empty = reconciled). */
function inventoryGap() {
  const invAcc = accountByCode('1200');
  if (!invAcc) return 0;
  const gl = accountBalance(invAcc.id);
  const val = Math.round(store.data.products.reduce((s, p) => s + num(p.stock) * num(p.cost), 0) * 100) / 100;
  return Math.round((val - gl) * 100) / 100;
}

function inventoryValuationViolations() {
  const out = [];
  const invAcc = accountByCode('1200');
  if (!invAcc) return out;
  const gl = accountBalance(invAcc.id);
  const val = Math.round(store.data.products.reduce((s, p) => s + num(p.stock) * num(p.cost), 0) * 100) / 100;
  if (Math.abs(gl - val) > 0.01) out.push(`Inventory GL ${gl} != stock valuation at cost ${val}`);
  return out;
}

/* Legacy settlement mismatches: incoming payments whose method says
   bank/transfer/card but whose journal debited the cash account (pre-fix
   postings). Surfaced for review — aligning them is an explicit admin
   decision, never automatic; refunded ones net to zero and are skipped. */
function settlementMismatches() {
  const cash = accountByCode('1000');
  if (!cash) return [];
  const refunded = new Set((store.data.payments || []).filter(o => o.direction === 'out').map(o => o.ref_type + ':' + o.ref_id));
  const out = [];
  for (const p of (store.data.payments || [])) {
    if (p.direction !== 'in' || p.reclassed || refunded.has(p.ref_type + ':' + p.ref_id)) continue;
    if (!['bank', 'transfer', 'card'].includes(p.method)) continue;
    const j = (store.data.journal || []).find(x => x.id === p.journal_id);
    if (!j) continue;
    const debitLine = (j.lines || []).find(l => num(l.debit) > 0 && l.account_id === cash.id);
    if (debitLine) out.push({ payment: p, amount: num(debitLine.debit) });
  }
  return out;
}

/* Upgrade migration for data created before inventory postings existed
   (opening stock, COGS, adjustments). We never rewrite or fabricate
   per-document history: one clearly-labelled alignment entry against
   equity brings the Inventory account in line with the stock ledger, and
   every posting from then on is exact. Idempotent — once reconciled, the
   gap is zero and nothing posts. */
function migrateInventoryValuation() {
  ensureCOA();
  if (typeof ensureStockBaseline === 'function') ensureStockBaseline();
  const gap = inventoryGap();
  if (Math.abs(gap) <= 0.01) return null;
  const invAcc = accountByCode('1200'), eq = accountByCode('3000');
  const lines = gap > 0
    ? [{ account_id: invAcc.id, debit: gap }, { account_id: eq.id, credit: gap }]
    : [{ account_id: eq.id, debit: -gap }, { account_id: invAcc.id, credit: -gap }];
  return postJournal({
    date: todayStr(),
    memo: t('Migration: align inventory valuation with the stock ledger (pre-upgrade data)'),
    ref_type: 'migration', ref_id: null, lines,
  });
}

/* ---------------- UI ---------------- */

function journalEntryFields() {
  const opts = store.data.accounts.map(a => ({ value: a.id, label: `${a.code} ${a.name}` }));
  const line = n => ([
    { key: `a${n}`, label: `${t('Account')} ${n}`, type: 'select', options: [{ value: '', label: '—' }, ...opts] },
    { key: `d${n}`, label: `${t('Debit')} ${n}`, type: 'number' },
    { key: `c${n}`, label: `${t('Credit')} ${n}`, type: 'number' },
  ]);
  return [
    { key: 'date', label: t('Date'), type: 'date', value: todayStr() },
    { key: 'memo', label: t('Memo'), value: '', full: true },
    ...line(1), ...line(2), ...line(3), ...line(4),
  ];
}

function addJournalEntry() {
  openModal(t('New journal entry'), journalEntryFields(), out => {
    const lines = [];
    for (let n = 1; n <= 4; n++) {
      if (out[`a${n}`]) lines.push({ account_id: out[`a${n}`], debit: num(out[`d${n}`]), credit: num(out[`c${n}`]) });
    }
    if (inServerMode()) { txCall('journal', { date: out.date, memo: out.memo, lines }, t('Journal entry posted')); return; }
    const e = postJournal({ date: out.date, memo: out.memo, lines });
    if (!e) { toast(t('Journal entry must have at least two lines and balance (debits = credits).')); return; }
    toast(t('Journal entry posted'));
    render();
  });
}

function renderAccounting() {
  ensureCOA();
  const violations = accountingInvariants();
  const tb = trialBalance();
  const sum = type => store.data.accounts.filter(a => a.type === type).reduce((s, a) => s + naturalBalance(a), 0);
  const assets = sum('asset'), liab = sum('liability'), eq = sum('equity'), rev = sum('revenue'), exp = sum('expense');

  /* Unresolved inventory reconciliation: surface the discrepancy and the
     proposed dated opening adjustment for review. The equity offset is an
     accounting decision — only an authorized admin can approve and post it
     (server mode enforces this again in the transaction layer). */
  const gap = typeof inventoryGap === 'function' ? inventoryGap() : 0;
  let reconCard = '';
  if (Math.abs(gap) > 0.01) {
    const inv = accountByCode('1200'), eqAcc = accountByCode('3000');
    const side = (acc, amt) => `${acc ? esc(`${acc.code} ${acc.name}`) : '?'} ${money(amt)}`;
    const proposal = gap > 0
      ? `${t('Debit')} ${side(inv, gap)} · ${t('Credit')} ${side(eqAcc, gap)}`
      : `${t('Debit')} ${side(eqAcc, -gap)} · ${t('Credit')} ${side(inv, -gap)}`;
    const isAdmin = Auth.current && Auth.current.role === 'admin';
    reconCard = `<div class="card" style="border-color:var(--red)">
      <h3>${t('Unresolved inventory reconciliation')}</h3>
      <p>${t('The Inventory account differs from the stock ledger valuation at cost by')} <strong>${money(Math.abs(gap))}</strong>.</p>
      <p>${t('Proposed dated opening adjustment')} (${todayStr()}): ${proposal}<br><span class="cell-sub">${t('Migration: align inventory valuation with the stock ledger (pre-upgrade data)')}</span></p>
      <p class="cell-sub">${t('Postings that affect the books are blocked until an authorized admin reviews and approves this adjustment. Existing data stays unchanged; a backup is kept before the adjustment is saved.')}</p>
      ${isAdmin ? `<button class="primary-btn" id="approveInvAdj">${t('Approve and post adjustment')}</button>`
                : `<p><strong>${t('Waiting for an admin to review and approve.')}</strong></p>`}
    </div>`;
  }

  const mismatches = typeof settlementMismatches === 'function' ? settlementMismatches() : [];
  const mismatchTotal = Math.round(mismatches.reduce((s, m) => s + m.amount, 0) * 100) / 100;
  const isAdmin2 = Auth.current && Auth.current.role === 'admin';
  const reclassCard = mismatches.length ? `<div class="card" style="border-color:var(--yellow, #d97706)">
    <h3>${t('Legacy settlement review')}</h3>
    <p>${mismatches.length} ${t('payment(s) recorded as bank/transfer/card were posted to the cash account before the settlement fix')} — ${t('total')} <strong>${money(mismatchTotal)}</strong>.</p>
    <p class="cell-sub">${t('Review where the money actually arrived, then approve a dated reclass to the bank account (Dr 1010 / Cr 1000). Original entries stay untouched; refunds of these sales stay blocked until the review.')}</p>
    ${isAdmin2 ? `<button class="primary-btn" id="approveReclass">${t('Approve and post reclass')}</button>`
               : `<p><strong>${t('Waiting for an admin to review and approve.')}</strong></p>`}
  </div>` : '';

  const coaRows = store.data.accounts.map(a => `
    <tr><td>${esc(a.code)}</td><td>${esc(a.name)}</td><td><span class="badge inactive">${t(a.type)}</span></td>
    <td>${money(naturalBalance(a))}</td></tr>`).join('');

  const journalRows = store.data.journal.slice().sort((a, b) => (b.id - a.id)).slice(0, 50).map(j => {
    const lines = j.lines.map(l => {
      const a = store.data.accounts.find(x => x.id === l.account_id);
      return `<tr class="journal-line">
        <td></td><td class="cell-sub">${a ? esc(`${a.code} ${a.name}`) : '?'} </td>
        <td>${l.debit ? money(l.debit) : ''}</td><td>${l.credit ? money(l.credit) : ''}</td>
        <td></td></tr>`;
    }).join('');
    return `<tr class="journal-head">
      <td>${esc(j.date || '—')}</td><td><div class="cell-main">#${j.id} ${esc(j.memo || '')}</div>
      <div class="cell-sub">${j.ref_type ? t('auto') : ''}</div></td>
      <td>${money(j.lines.reduce((s, l) => s + l.debit, 0))}</td>
      <td>${money(j.lines.reduce((s, l) => s + l.credit, 0))}</td>
      <td class="row-actions"><button class="icon-btn" data-act="rev" data-id="${j.id}" title="${t('Reverse')}">↩️</button></td>
    </tr>${lines}`;
  }).join('');

  $('#view-accounting').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Accounting')}</h2><div class="sub">${t('Double-entry books')} · ${t('every entry balanced, equation checked live')}</div></div>
      <div class="head-actions"><button class="secondary-btn" id="addJournal">+ ${t('New journal entry')}</button></div>
    </div>
    <div class="cards">
      <div class="stat-card"><div class="label">${t('Assets')}</div><div class="value">${money(assets)}</div></div>
      <div class="stat-card"><div class="label">${t('Liabilities')}</div><div class="value">${money(liab)}</div></div>
      <div class="stat-card"><div class="label">${t('Equity')}</div><div class="value">${money(eq)}</div></div>
      <div class="stat-card"><div class="label">${t('Net income')} (${t('Revenue')} − ${t('Expenses')})</div><div class="value" style="color:${rev - exp >= 0 ? 'var(--green)' : 'var(--red)'}">${money(rev - exp)}</div></div>
      <div class="stat-card"><div class="label">${t('Books check')}</div><div class="value" style="color:${violations.length ? 'var(--red)' : 'var(--green)'}">${violations.length ? '✗ ' + violations.length : '✓'}</div></div>
    </div>
    ${violations.length ? `<div class="card" style="border-color:var(--red)"><h3>${t('Integrity violations')}</h3><ul>${violations.map(v => `<li>${esc(v)}</li>`).join('')}</ul></div>` : ''}
    ${reconCard}
    ${reclassCard}
    <div class="card"><h3>${t('Chart of accounts')}</h3>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>${t('Code')}</th><th>${t('Account')}</th><th>${t('Type')}</th><th>${t('Balance')}</th></tr></thead>
        <tbody>${coaRows}</tbody></table></div></div>
    <div class="card"><h3>${t('Journal')}</h3>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>${t('Date')}</th><th>${t('Entry')}</th><th>${t('Debit')}</th><th>${t('Credit')}</th><th></th></tr></thead>
        <tbody>${journalRows || `<tr><td colspan="5" class="empty-state">${t('No journal entries yet.')}</td></tr>`}</tbody></table></div></div>`;

  $('#addJournal').onclick = addJournalEntry;
  const rcBtn = $('#approveReclass');
  if (rcBtn) rcBtn.onclick = () => {
    if (inServerMode()) { txCall('reclass-settlement', { all: true }, t('Reclass posted — settlements aligned')); return; }
    toast(t('Reclass needs the server.'));
  };
  const apBtn = $('#approveInvAdj');
  if (apBtn) apBtn.onclick = () => {
    if (inServerMode()) { txCall('migrate-inventory', {}, t('Adjustment posted — books reconciled')); return; }
    const e = migrateInventoryValuation();
    if (e) { toast(t('Adjustment posted — books reconciled')); render(); }
    else { toast(t('Adjustment failed.')); }
  };
  $('#view-accounting').querySelectorAll('button[data-act="rev"]').forEach(btn => {
    btn.onclick = () => {
      if (inServerMode()) { txCall('journal-reverse', { id: Number(btn.dataset.id) }, t('Reversal posted')); return; }
      const e = reverseJournal(Number(btn.dataset.id));
      if (e) { toast(t('Reversal posted')); render(); }
    };
  });
}

App.views.accounting = renderAccounting;
