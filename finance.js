'use strict';
/* finance.js — finance ledger (income/expenses), HR (employees + payroll),
   and reports. Integrated: paid invoices and received purchases post here
   automatically; payroll posts an expense per active employee. */

/* ---------------- Finance ---------------- */

const EXPENSE_CATS = ['Purchases', 'Payroll', 'Rent', 'Utilities', 'Marketing', 'Operations', 'Other'];
const INCOME_CATS = ['Sales', 'Services', 'Other income'];

const ledgerFields = type => [
  { key: 'date', label: t('Date'), type: 'date', value: todayStr() },
  {
    key: 'category', label: t('Category'), type: 'select',
    options: (type === 'income' ? INCOME_CATS : EXPENSE_CATS).map(c => ({ value: c, label: t(c) })),
  },
  { key: 'amount', label: t('Amount (USD)'), type: 'number', required: true },
  { key: 'memo', label: t('Memo'), value: '', full: true },
];

function addLedgerEntry(type) {
  openModal(type === 'income' ? t('Record income') : t('Record expense'), ledgerFields(type), out => {
    out.type = type;
    out.amount = num(out.amount);
    out.ref_type = null;
    out.ref_id = null;
    if (!out.date) out.date = todayStr();
    if (inServerMode()) { txCall('ledger-entry', out, type === 'income' ? t('Income recorded') : t('Expense recorded')); return; }
    store.add('ledger', out);
    toast(type === 'income' ? t('Income recorded') : t('Expense recorded'));
    render();
  });
}

/* ---------------- Expense approvals ----------------
   A submitted expense posts NOTHING: the ledger entry and its journal exist
   only after an authorized approval. An employee cannot review their own
   request; the admin can. */

function editExpenseRequest(row) {
  const isNew = !row;
  openModal(isNew ? t('Request expense') : t('Edit expense request'), ledgerFields('expense').map(f => ({ ...f, value: row ? (row[f.key] ?? f.value) : f.value })), out => {
    out.amount = num(out.amount);
    if (!out.date) out.date = todayStr();
    if (inServerMode()) { txCall('expense-save', { id: row && row.id, out }, t('Expense submitted for approval')); return; }
    if (row) { Object.assign(row, out); }
    else store.add('expenses', { ...out, status: 'submitted', submitted_by: (Auth.current && Auth.current.username) || 'local', reviewed_by: null, reviewed_at: null, ledger_id: null });
    store.save(); render();
    toast(t('Expense submitted for approval'));
  });
}

function reviewExpense(id, act) {
  let reason = '';
  if (act === 'reject') { reason = window.prompt(t('Reject reason')) || ''; }
  if (inServerMode()) { txCall(act === 'approve' ? 'expense-approve' : 'expense-reject', { id, reason }, act === 'approve' ? t('Approved — posted to the ledger') : t('Expense rejected')); return; }
  const x = (store.data.expenses || []).find(e => e.id === id);
  if (!x || x.status !== 'submitted') return;
  const me = (Auth.current && Auth.current.username) || 'local';
  if (me !== 'local' && x.submitted_by === me && (Auth.current || {}).role !== 'admin') { toast(t('You cannot review your own expense.')); return; }
  x.status = act === 'approve' ? 'approved' : 'rejected';
  x.reviewed_by = me; x.reviewed_at = todayStr();
  if (act === 'approve') {
    const entry = store.add('ledger', { date: x.date, type: 'expense', category: x.category, amount: x.amount, ref_type: 'expense', ref_id: x.id, memo: x.memo || x.category });
    x.ledger_id = entry.id;
    toast(t('Approved — posted to the ledger'));
  } else { x.reject_reason = reason; toast(t('Expense rejected')); }
  store.save(); render();
}

function deleteExpense(id) {
  if (inServerMode()) { txCall('expense-delete', { id }, t('Expense deleted')); return; }
  const x = (store.data.expenses || []).find(e => e.id === id);
  if (!x || x.status !== 'submitted') return;
  store.remove('expenses', id); toast(t('Expense deleted'));
}

function monthTotals(month) {
  const rows = store.data.ledger.filter(l => (l.date || '').startsWith(month));
  const income = rows.filter(l => l.type === 'income').reduce((s, l) => s + num(l.amount), 0);
  const expense = rows.filter(l => l.type === 'expense').reduce((s, l) => s + num(l.amount), 0);
  return { income, expense, net: income - expense };
}

function renderFinance() {
  const m = monthStr();
  const totals = monthTotals(m);
  const rows = store.data.ledger.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  const body = rows.map(l => `
    <tr>
      <td>${esc(l.date || '—')}</td>
      <td><span class="badge ${l.type === 'income' ? 'won' : 'lost'}">${t(l.type)}</span></td>
      <td>${t(l.category || 'Other')}</td>
      <td class="${l.type === 'income' ? '' : 'overdue-text'}">${l.type === 'income' ? '+' : '−'}${money(l.amount)}</td>
      <td>${esc(l.memo || '')}</td>
      <td class="row-actions">
        ${l.ref_type ? `<span class="cell-sub" title="${t('Posted automatically')}">${t('auto')}</span>` : `<button class="danger-btn" data-act="del" data-id="${l.id}" title="${t('Delete')}">🗑</button>`}
      </td>
    </tr>`).join('');

  const exps = (store.data.expenses || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  const me = (typeof Auth !== 'undefined' && Auth.current) || null;
  const expRows = exps.map(x => `
    <tr>
      <td>${esc(x.date || '—')}</td>
      <td>${t(x.category || 'Other')}</td>
      <td class="overdue-text">−${money(x.amount)}</td>
      <td>${esc(x.memo || '')}</td>
      <td>${esc(x.submitted_by || '')}</td>
      <td><span class="badge ${x.status === 'approved' ? 'won' : x.status === 'rejected' ? 'lost' : 'lead'}"${x.status === 'rejected' && x.reject_reason ? ` title="${esc(x.reject_reason)}"` : ''}>${t(x.status)}</span></td>
      <td class="row-actions">
        ${x.status === 'submitted' && me && (me.role === 'admin' || x.submitted_by !== me.username) ? `<button class="icon-btn" data-xact="approve" data-id="${x.id}" title="${t('Approve')}">✅</button><button class="icon-btn" data-xact="reject" data-id="${x.id}" title="${t('Reject')}">⛔</button>` : ''}
        ${x.status === 'submitted' && me && (me.role === 'admin' || x.submitted_by === me.username) ? `<button class="icon-btn" data-xact="edit" data-id="${x.id}" title="${t('Edit')}">✏️</button><button class="danger-btn" data-xact="del" data-id="${x.id}" title="${t('Delete')}">🗑</button>` : ''}
      </td>
    </tr>`).join('');

  $('#view-finance').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Finance')}</h2><div class="sub">${t('Income and expenses')} · ${m}</div></div>
      <div class="head-actions">
        <button class="secondary-btn" id="addIncome">+ ${t('Income')}</button>
        <button class="secondary-btn" id="addExpense">+ ${t('Expense')}</button>
        <button class="secondary-btn" id="reqExpense">+ ${t('Request expense')}</button>
      </div>
    </div>
    <div class="cards">
      <div class="stat-card"><div class="label">${t('Income this month')}</div><div class="value">${money(totals.income)}</div></div>
      <div class="stat-card"><div class="label">${t('Expenses this month')}</div><div class="value">${money(totals.expense)}</div></div>
      <div class="stat-card"><div class="label">${t('Net this month')}</div><div class="value" style="color:${totals.net >= 0 ? 'var(--green)' : 'var(--red)'}">${money(totals.net)}</div></div>
    </div>
    <h3 style="margin:18px 0 8px">${t('Expense approvals')}</h3>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>${t('Date')}</th><th>${t('Category')}</th><th>${t('Amount')}</th><th>${t('Memo')}</th><th>${t('by')}</th><th>${t('Status')}</th><th></th></tr></thead>
      <tbody id="expBody">${expRows || `<tr><td colspan="7" class="empty-state">${t('No expense requests yet.')}</td></tr>`}</tbody>
    </table></div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>${t('Date')}</th><th>${t('Type')}</th><th>${t('Category')}</th><th>${t('Amount')}</th><th>${t('Memo')}</th><th></th></tr></thead>
      <tbody>${body || `<tr><td colspan="6" class="empty-state">${t('No ledger entries yet.')}</td></tr>`}</tbody>
    </table></div>`;

  $('#addIncome').onclick = () => addLedgerEntry('income');
  $('#addExpense').onclick = () => addLedgerEntry('expense');
  $('#reqExpense').onclick = () => editExpenseRequest(null);
  const expBody = $('#view-finance').querySelector('#expBody');
  if (expBody) expBody.addEventListener('click', e => {
    const btn = e.target.closest('button[data-xact]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const act = btn.dataset.xact;
    if (act === 'approve' || act === 'reject') reviewExpense(id, act);
    else if (act === 'edit') editExpenseRequest((store.data.expenses || []).find(x => x.id === id));
    else if (act === 'del') confirmDelete(t('this expense request'), () => deleteExpense(id));
  });
  $('#view-finance').querySelector('tbody').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act="del"]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    confirmDelete(t('this ledger entry'), () => { store.remove('ledger', id); toast(t('Entry deleted')); });
  });
}

/* ---------------- Expense requests (submitter scope) ----------------
   The server row-scopes this collection for users without the finance
   module, so this view only ever holds the current user's own requests;
   the local fallback applies the same filter. Review happens in Finance. */

function renderExpenses() {
  const me = (typeof Auth !== 'undefined' && Auth.current) || null;
  const mine = (store.data.expenses || []).slice()
    .filter(x => (me && me.role === 'admin') || !me || inServerMode() || x.submitted_by === me.username)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const rows = mine.map(x => `
    <tr>
      <td>${esc(x.date || '—')}</td>
      <td>${t(x.category || 'Other')}</td>
      <td class="overdue-text">−${money(x.amount)}</td>
      <td>${esc(x.memo || '')}</td>
      <td><span class="badge ${x.status === 'approved' ? 'won' : x.status === 'rejected' ? 'lost' : 'lead'}"${x.status === 'rejected' && x.reject_reason ? ` title="${esc(x.reject_reason)}"` : ''}>${t(x.status)}</span></td>
      <td class="row-actions">
        ${x.status === 'submitted' ? `<button class="icon-btn" data-xact="edit" data-id="${x.id}" title="${t('Edit')}">✏️</button><button class="danger-btn" data-xact="del" data-id="${x.id}" title="${t('Delete')}">🗑</button>` : ''}
      </td>
    </tr>`).join('');
  $('#view-expenses').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Expense requests')}</h2><div class="sub">${t('Submit expenses for approval — only approved expenses reach the books.')}</div></div>
      <div class="head-actions"><button class="secondary-btn" id="reqExpense2">+ ${t('Request expense')}</button></div>
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>${t('Date')}</th><th>${t('Category')}</th><th>${t('Amount')}</th><th>${t('Memo')}</th><th>${t('Status')}</th><th></th></tr></thead>
      <tbody id="expBody2">${rows || `<tr><td colspan="6" class="empty-state">${t('No expense requests yet.')}</td></tr>`}</tbody>
    </table></div>`;
  $('#reqExpense2').onclick = () => editExpenseRequest(null);
  $('#expBody2').addEventListener('click', e => {
    const btn = e.target.closest('button[data-xact]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.xact === 'edit') editExpenseRequest((store.data.expenses || []).find(x => x.id === id));
    else if (btn.dataset.xact === 'del') confirmDelete(t('this expense request'), () => deleteExpense(id));
  });
}
App.views.expenses = renderExpenses;

/* ---------------- HR / Employees ---------------- */

const employeeFields = row => [
  { key: 'name', label: t('Full name'), required: true, value: row?.name },
  { key: 'position', label: t('Position'), value: row?.position },
  { key: 'department', label: t('Department'), value: row?.department },
  {
    key: 'status', label: t('Status'), type: 'select',
    options: [{ value: 'active', label: t('active') }, { value: 'inactive', label: t('inactive') }],
    value: row?.status || 'active',
  },
  { key: 'email', label: t('Email'), type: 'email', value: row?.email },
  { key: 'phone', label: t('Phone'), value: row?.phone },
  { key: 'salary', label: t('Monthly salary (USD)'), type: 'number', value: row?.salary ?? 0 },
  { key: 'hire_date', label: t('Hire date'), type: 'date', value: row?.hire_date },
];

function editEmployee(row) {
  openModal(row ? t('Edit employee') : t('New employee'), employeeFields(row), out => {
    out.salary = num(out.salary);
    if (row) { store.update('employees', row.id, out); toast(t('Employee updated')); }
    else { store.add('employees', out); toast(t('Employee added')); }
    render();
  });
}

function runPayroll() {
  const m = monthStr();
  const already = store.data.ledger.some(l => l.type === 'expense' && l.category === 'Payroll' && (l.date || '').startsWith(m));
  if (already) { alert(t('Payroll for this month is already posted.')); return; }
  const active = store.data.employees.filter(e => e.status === 'active');
  if (!active.length) { alert(t('No active employees.')); return; }
  const total = active.reduce((s, e) => s + num(e.salary), 0);
  if (inServerMode()) {
    if (window.confirm(t('Post payroll for {month}?').replace('{month}', m) + `\n\n${active.length} ${t('active employees')}, ${t('total')} ${money(total)}.`))
      txCall('payroll', { month: m }, t('Payroll posted'));
    return;
  }
  if (!window.confirm(t('Post payroll for {month}?').replace('{month}', m) + `\n\n${active.length} ${t('active employees')}, ${t('total')} ${money(total)}.\n${t('This adds one expense entry per employee to the ledger.')}`)) return;
  active.forEach(e => {
    store.add('ledger', {
      date: todayStr(), type: 'expense', category: 'Payroll',
      amount: num(e.salary), ref_type: 'payroll', ref_id: e.id,
      memo: `Salary ${m} - ${e.name}`,
    });
  });
  if (typeof ensureCOA === 'function') { ensureCOA(); postPayrollJournal(m, total); }
  toast(t('Payroll posted'));
  render();
}

function renderEmployees() {
  const rows = store.data.employees.slice().sort((a, b) => a.name.localeCompare(b.name));
  const active = rows.filter(e => e.status === 'active');
  const payroll = active.reduce((s, e) => s + num(e.salary), 0);
  const body = rows.map(e => `
    <tr>
      <td><div class="cell-main">${esc(e.name)}</div><div class="cell-sub">${esc(e.position || '')}</div></td>
      <td>${esc(e.department || '—')}</td>
      <td><div>${esc(e.email || '—')}</div><div class="cell-sub">${esc(e.phone || '')}</div></td>
      <td>${money(e.salary)}</td>
      <td>${esc(e.hire_date || '—')}</td>
      <td><span class="badge ${esc(e.status)}">${t(e.status)}</span></td>
      <td class="row-actions">
        <button class="icon-btn" data-act="edit" data-id="${e.id}" title="${t('Edit')}">✏️</button>
        <button class="danger-btn" data-act="del" data-id="${e.id}" title="${t('Delete')}">🗑</button>
      </td>
    </tr>`).join('');

  $('#view-employees').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Employees')}</h2><div class="sub">${active.length} ${t('active')} · ${t('monthly payroll')} ${money(payroll)}</div></div>
      <div class="head-actions">
        <button class="secondary-btn" id="payrollBtn">${t('Run payroll')}</button>
        <button class="primary-btn" id="addEmployee">+ ${t('New employee')}</button>
      </div>
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>${t('Employee')}</th><th>${t('Department')}</th><th>${t('Contact')}</th><th>${t('Salary')}</th><th>${t('Hired')}</th><th>${t('Status')}</th><th></th></tr></thead>
      <tbody>${body || `<tr><td colspan="7" class="empty-state">${t('No employees yet.')}</td></tr>`}</tbody>
    </table></div>
    <div id="hrSections"></div>`;

  $('#addEmployee').onclick = () => editEmployee(null);
  $('#payrollBtn').onclick = runPayroll;
  if (typeof renderHrSections === 'function') renderHrSections();
  $('#view-employees').querySelector('tbody').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const row = store.employee(id);
    if (btn.dataset.act === 'edit') editEmployee(row);
    if (btn.dataset.act === 'del') confirmDelete(`${t('employee')} "${row.name}"`, () => { store.remove('employees', id); toast(t('Employee deleted')); });
  });
}

/* ---------------- Reports ---------------- */

function bar(value, max, color) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return `<div class="funnel-track"><div class="funnel-fill" style="width:${pct}%;background:${color}"></div></div>`;
}

function renderReports() {
  const d = store.data;

  // Sales by month (paid invoices)
  const byMonth = {};
  d.invoices.filter(i => i.status === 'paid').forEach(i => {
    const m = (i.issue_date || '').slice(0, 7) || 'unknown';
    byMonth[m] = (byMonth[m] || 0) + invoiceNetTotal(i);
  });
  const months = Object.keys(byMonth).sort();
  const maxMonth = Math.max(1, ...months.map(m => byMonth[m]));
  const salesHtml = months.length ? months.map(m => `
    <div class="funnel-row"><span class="stage-name">${esc(m)}</span>${bar(byMonth[m], maxMonth, '#4f46e5')}<span class="stage-stats">${money(byMonth[m])}</span></div>`).join('')
    : `<div class="empty-state">${t('No paid invoices yet.')}</div>`;

  // Top products by qty sold (non-draft invoices)
  const qty = {};
  d.invoices.filter(i => i.status !== 'draft').forEach(i => (i.items || []).forEach(it => {
    const name = it.product_id && store.product(it.product_id) ? store.product(it.product_id).name : (it.description || t('Custom line'));
    qty[name] = (qty[name] || 0) + num(it.qty);
  }));
  const tops = Object.entries(qty).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxQty = Math.max(1, ...tops.map(x => x[1]));
  const topHtml = tops.length ? tops.map(([name, q]) => `
    <div class="funnel-row"><span class="stage-name">${esc(name)}</span>${bar(q, maxQty, '#0891b2')}<span class="stage-stats">${q} ${t('sold')}</span></div>`).join('')
    : `<div class="empty-state">${t('No sales yet.')}</div>`;

  // Expenses by category
  const exp = {};
  d.ledger.filter(l => l.type === 'expense').forEach(l => { exp[l.category || 'Other'] = (exp[l.category || 'Other'] || 0) + num(l.amount); });
  const cats = Object.entries(exp).sort((a, b) => b[1] - a[1]);
  const maxCat = Math.max(1, ...cats.map(c => c[1]));
  const expHtml = cats.length ? cats.map(([c, v]) => `
    <div class="funnel-row"><span class="stage-name">${t(c)}</span>${bar(v, maxCat, '#dc2626')}<span class="stage-stats">${money(v)}</span></div>`).join('')
    : `<div class="empty-state">${t('No expenses yet.')}</div>`;

  // Pipeline summary
  const stageVals = STAGES.map(s => d.deals.filter(x => x.stage === s).reduce((a, x) => a + num(x.value), 0));
  const maxStage = Math.max(1, ...stageVals);
  const pipeHtml = STAGES.map((s, i) => {
    const rows = d.deals.filter(x => x.stage === s);
    return `<div class="funnel-row"><span class="stage-name">${t(s)}</span>${bar(stageVals[i], maxStage, STAGE_COLORS[s])}<span class="stage-stats">${rows.length} · ${money0(stageVals[i])}</span></div>`;
  }).join('');

  const won = d.deals.filter(x => x.stage === 'Won').length;
  const lost = d.deals.filter(x => x.stage === 'Lost').length;
  const winRate = (won + lost) ? Math.round((won / (won + lost)) * 100) : 0;

  $('#view-reports').innerHTML = `
    <div class="view-head"><div><h2>${t('Reports')}</h2><div class="sub">${t('Across sales, pipeline, products and spending')}</div></div></div>
    <div class="cards">
      <div class="stat-card"><div class="label">${t('Win rate')}</div><div class="value">${winRate}%</div><div class="hint">${won} ${t('won')} · ${lost} ${t('lost')}</div></div>
      <div class="stat-card"><div class="label">${t('Revenue (paid invoices)')}</div><div class="value">${money0(d.invoices.filter(i => i.status === 'paid').reduce((s, i) => s + invoiceNetTotal(i), 0))}</div></div>
      <div class="stat-card"><div class="label">${t('Stock value (at cost)')}</div><div class="value">${money0(d.products.reduce((s, p) => s + num(p.cost) * num(p.stock), 0))}</div></div>
      <div class="stat-card"><div class="label">${t('Monthly payroll')}</div><div class="value">${money0(d.employees.filter(e => e.status === 'active').reduce((s, e) => s + num(e.salary), 0))}</div></div>
    </div>
    <div class="dash-grid">
      <div class="panel"><h3>${t('Sales by month (paid invoices)')}</h3>${salesHtml}</div>
      <div class="panel"><h3>${t('Deal pipeline')}</h3>${pipeHtml}</div>
      <div class="panel"><h3>${t('Top products by units sold')}</h3>${topHtml}</div>
      <div class="panel"><h3>${t('Expenses by category')}</h3>${expHtml}</div>
    </div>
    ${cashAccrualCard()}`;
  const caF = $('#caFrom'), caT = $('#caTo');
  if (caF) caF.onchange = () => render();
  if (caT) caT.onchange = () => render();
}

/* Cash movement classification, computed read-only from the journal.
   Every journal entry that moves cash/bank (accounts 1000/1010) in the
   period lands in exactly one bucket by its ref_type; unknown shapes fall
   into unclassified, never into a made-up category. The bucket total must
   equal the actual cash+bank change to the cent BY CONSTRUCTION — if it
   does not, the card says so. No entry is modified; there is no plug. */
function cashDeltaOf(entry, cashIds) {
  let s = 0;
  for (const l of (entry.lines || [])) if (cashIds.includes(l.account_id)) s += num(l.debit) - num(l.credit);
  return Math.round(s * 100) / 100;
}

function cashMovementReport(from, to) {
  const cashIds = (store.data.accounts || []).filter(a => ['1000', '1010'].includes(a.code)).map(a => a.id);
  const inPeriod = j => (j.date || '') >= from && (j.date || '') <= to;
  const accNet = (codes, sign) => {
    const ids = (store.data.accounts || []).filter(a => codes.includes(a.code)).map(a => a.id);
    let s = 0;
    for (const j of (store.data.journal || [])) {
      if (!inPeriod(j)) continue;
      for (const l of (j.lines || [])) if (ids.includes(l.account_id)) s += num(l.debit) - num(l.credit);
    }
    return Math.round(sign * s * 100) / 100;
  };
  const revenue = accNet(['4000', '4100', '7100'], -1);
  const expenses = accNet(['5000', '5200', '6000', '6100', '6200', '6900'], 1);
  const ni = Math.round((revenue - expenses) * 100) / 100;

  const bucketDefs = [
    { key: 'collections', match: (j, d) => j.ref_type === 'payment' && d > 0 },
    { key: 'payouts', match: (j, d) => (j.ref_type === 'payment' || j.ref_type === 'pos-refund') && d < 0 },
    { key: 'expenses_paid', match: (j, d) => j.ref_type === 'expense' && d < 0 },
    { key: 'payroll_paid', match: (j, d) => j.ref_type === 'payroll' && d < 0 },
    { key: 'asset_investing', match: (j, d) => (j.ref_type === 'asset' || j.ref_type === 'asset-dispose') && d !== 0 },
    { key: 'internal_transfer', match: (j, d) => j.ref_type === 'reclass' },
  ];
  const buckets = bucketDefs.map(b => ({ key: b.key, count: 0, sum: 0 }));
  const uncl = { key: 'unclassified', count: 0, sum: 0 };
  let actual = 0;
  for (const j of (store.data.journal || [])) {
    if (!inPeriod(j)) continue;
    const d = cashDeltaOf(j, cashIds);
    if (!d) continue;
    actual = Math.round((actual + d) * 100) / 100;
    const i = bucketDefs.findIndex(b => b.match(j, d));
    const tgt = i >= 0 ? buckets[i] : uncl;
    tgt.count++;
    tgt.sum = Math.round((tgt.sum + d) * 100) / 100;
  }
  buckets.push(uncl);
  const total = Math.round(buckets.reduce((s, b) => s + b.sum, 0) * 100) / 100;
  return { from, to, revenue, expenses, ni, buckets, total, actual, check: Math.abs(total - actual) <= 0.005 };
}

function cashAccrualCard() {
  const today = todayStr();
  const from = ($('#caFrom') && $('#caFrom').value) || today.slice(0, 8) + '01';
  const to = ($('#caTo') && $('#caTo').value) || today;
  const r = cashMovementReport(from, to);
  const row = (label, val, bold) => `<tr>${bold ? '<td><strong>' + label + '</strong></td><td><strong>' + money(val) + '</strong></td>' : '<td>' + label + '</td><td>' + money(val) + '</td>'}</tr>`;
  const bucketLabel = { collections: t('Collections from customers'), payouts: t('Payments out (suppliers and refunds)'), expenses_paid: t('Expenses paid'), payroll_paid: t('Payroll paid'), asset_investing: t('Fixed assets bought / sold (cash)'), internal_transfer: t('Internal cash-bank transfers (reclass, net zero)'), unclassified: t('Unclassified / unreconciled cash movement') };
  const bucketRows = r.buckets.filter(b => b.count).map(b => `<tr><td>${bucketLabel[b.key]} <span class="cell-sub">× ${b.count}</span></td><td>${money(b.sum)}</td></tr>`).join('');
  return `<div class="card"><h3>${t('Cash vs accrual reconciliation')}</h3>
    <p class="cell-sub">${t('Accrual results next to classified cash movement for the period, computed live from the journal. Every entry that moves cash or bank is classified by its posting type; anything unrecognized stays unclassified. Entries that never touch cash (credit invoices and purchases, production and variance postings, depreciation, opening and migration equity entries) are excluded from cash by construction. Original entries are never modified.')}</p>
    <div class="form-grid">
      <label>${t('From')}<input type="date" id="caFrom" value="${from}"></label>
      <label>${t('To')}<input type="date" id="caTo" value="${to}"></label>
    </div>
    <div class="table-wrap"><table class="data"><tbody>
      ${row(t('Revenue (accrual, earned in period)'), r.revenue)}
      ${row(t('Expenses (accrual, incurred in period)'), r.expenses)}
      ${row(t('Net income (accrual)'), r.ni, true)}
      ${bucketRows}
      ${row(t('Total classified cash movement'), r.total, true)}
      ${row(t('Actual change in cash + bank'), r.actual, true)}
      <tr><td>${t('Classification check')}</td><td style="color:${r.check ? 'var(--green)' : 'var(--red)'}">${r.check ? '✓' : '✗ ' + money(r.total - r.actual)}</td></tr>
    </tbody></table></div></div>`;
}

/* ---------------- Registration ---------------- */

App.views.finance = renderFinance;
App.views.employees = renderEmployees;
App.views.reports = renderReports;
App.quickAdd.finance = () => addLedgerEntry('expense');
App.quickAdd.employees = () => editEmployee(null);
App.editors.employee = editEmployee;
