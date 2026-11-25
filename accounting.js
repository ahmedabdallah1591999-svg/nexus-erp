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
];

function ensureCOA() {
  if (!store.data.accounts) store.data.accounts = [];
  if (!store.data.journal) store.data.journal = [];
  if (!store.data.accounts.length) {
    for (const a of DEFAULT_COA) store.add('accounts', { code: a.code, name: a.name, type: a.type });
    store.save();
  }
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
    <div class="card"><h3>${t('Chart of accounts')}</h3>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>${t('Code')}</th><th>${t('Account')}</th><th>${t('Type')}</th><th>${t('Balance')}</th></tr></thead>
        <tbody>${coaRows}</tbody></table></div></div>
    <div class="card"><h3>${t('Journal')}</h3>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>${t('Date')}</th><th>${t('Entry')}</th><th>${t('Debit')}</th><th>${t('Credit')}</th><th></th></tr></thead>
        <tbody>${journalRows || `<tr><td colspan="5" class="empty-state">${t('No journal entries yet.')}</td></tr>`}</tbody></table></div></div>`;

  $('#addJournal').onclick = addJournalEntry;
  $('#view-accounting').querySelectorAll('button[data-act="rev"]').forEach(btn => {
    btn.onclick = () => {
      const e = reverseJournal(Number(btn.dataset.id));
      if (e) { toast(t('Reversal posted')); render(); }
    };
  });
}

App.views.accounting = renderAccounting;
