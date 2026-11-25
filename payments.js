'use strict';
/* payments.js — payments against invoices and purchases (partial allowed),
   plus AR/AP aging. Payments are THE cash-settlement path: each payment
   posts its own journal entry (in: Dr Cash / Cr AR; out: Dr AP / Cr Cash)
   and updates the invoice/purchase paid_amount. Marking an invoice paid
   records a payment for the remaining balance, so partial and full
   settlements share one code path and never double-post. */

const PAYMENT_METHODS = ['cash', 'bank', 'transfer', 'card'];

function invoicePaidAmount(inv) {
  if (inv.paid_amount != null) return num(inv.paid_amount);
  return inv.status === 'paid' ? invoiceTotal(inv) : 0;   // pre-payments rows
}
/* everything credited back against an invoice: credit notes (credited_amount)
   plus sales-order returns recorded against it. Derived from the returns
   already stored, so old data needs no migration and no history is rewritten. */
function invoiceCreditedTotal(inv) {
  const rets = (store.data.returns || []).filter(r => r.invoice_id === inv.id && r.status !== 'void').reduce((s, r) => s + num(r.amount), 0);
  return Math.round((num(inv.credited_amount) + rets) * 100) / 100;
}
function invoiceNetTotal(inv) {
  return Math.max(0, Math.round((invoiceTotal(inv) - invoiceCreditedTotal(inv)) * 100) / 100);
}
function invoiceOpenAmount(inv) {
  return Math.max(0, Math.round((invoiceTotal(inv) - invoiceCreditedTotal(inv) - invoicePaidAmount(inv)) * 100) / 100);
}
function purchasePaidAmount(po) {
  return num(po.paid_amount || 0);
}
function purchaseOpenAmount(po) {
  return Math.max(0, Math.round((purchaseTotal(po) - num(po.returned_amount) - purchasePaidAmount(po)) * 100) / 100);
}

/* Record a payment. Returns the row or null on invalid input.
   direction 'in': money from a customer against an invoice.
   direction 'out': money to a supplier against a purchase. */
function settlementAccountId(method) {
  if (method === 'store_credit') return accountByCode('2150').id;   // only reachable through credit-apply
  /* cash settles into the till (1000); bank, transfer and card settle into
     the bank account (1010) — mixing them would break cash reconciliation.
     Anything missing or unknown keeps the historical cash account: legacy
     rows predate methods and must not silently move to a new account. */
  return accountByCode(['bank', 'transfer', 'card'].includes(method) ? '1010' : '1000').id;
}

function recordPayment({ direction, contact_id, supplier_id, ref_type, ref_id, amount, method, date, memo }, internal) {
  /* an explicit method must be a known one — a typo must not quietly pick
     a settlement account; a missing method is legacy data and stays cash */
  if (method != null && method !== '' && !PAYMENT_METHODS.includes(method) && !(internal === 'credit-apply' && method === 'store_credit')) return null;
  method = method || 'cash';
  amount = Math.round(num(amount) * 100) / 100;
  if (!(amount > 0)) return null;
  ensureCOA();
  let journal = null;
  if (direction === 'in' && ref_type === 'invoice') {
    const inv = store.data.invoices.find(i => i.id === Number(ref_id));
    if (!inv || inv.status === 'draft') return null;
    const open = invoiceOpenAmount(inv);
    if (amount > open + 0.005) return null;               // no overpayment
    journal = postJournal({
      date, memo: memo || `${t('Payment received for')} ${inv.number}`, ref_type: 'payment', ref_id: null,
      lines: [{ account_id: settlementAccountId(method), debit: amount }, { account_id: accountByCode('1100').id, credit: amount }],
    });
    if (!journal) return null;
    inv.paid_amount = Math.round((invoicePaidAmount(inv) + amount) * 100) / 100;
    if (invoiceOpenAmount(inv) <= 0.005) {
      inv.status = 'paid';
      if (!inv.ledger_posted) {
        store.add('ledger', {
          date: todayStr(), type: 'income', category: 'Sales',
          amount: Math.round(invoiceTotal(inv) * 100) / 100,
          ref_type: 'invoice', ref_id: inv.id,
          memo: `Payment received for ${inv.number}`,
        });
        inv.ledger_posted = true;
      }
    }
    contact_id = contact_id || inv.contact_id;
    journal.ref_id = null; journal.memo = memo || `${t('Payment received for')} ${inv.number}`;
  } else if (direction === 'out' && ref_type === 'purchase') {
    const po = store.data.purchases.find(p => p.id === Number(ref_id));
    if (!po || po.status !== 'received') return null;
    const open = purchaseOpenAmount(po);
    if (amount > open + 0.005) return null;
    journal = postJournal({
      date, memo: memo || `${t('Payment to supplier for')} ${po.number}`, ref_type: 'payment', ref_id: null,
      lines: [{ account_id: accountByCode('2000').id, debit: amount }, { account_id: settlementAccountId(method), credit: amount }],
    });
    if (!journal) return null;
    po.paid_amount = Math.round((purchasePaidAmount(po) + amount) * 100) / 100;
    if (purchaseOpenAmount(po) <= 0.005) po.paid = true;
    supplier_id = supplier_id || po.supplier_id;
  } else {
    return null;
  }
  const row = store.add('payments', {
    date: date || todayStr(), direction, contact_id: contact_id || null, supplier_id: supplier_id || null,
    amount, method, ref_type, ref_id: Number(ref_id), memo: memo || '', journal_id: journal.id,
  });
  store.save();
  return row;
}

/* ---------------- aging ---------------- */

const AGING_BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'];

function ageBucket(daysOverdue) {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return '1-30';
  if (daysOverdue <= 60) return '31-60';
  if (daysOverdue <= 90) return '61-90';
  return '90+';
}

function daysBetween(dateStr, refStr) {
  const a = new Date(dateStr + 'T00:00:00'), b = new Date(refStr + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

/* Per-customer open receivables bucketed by days past due date. */
function arAging() {
  const byContact = {};
  for (const inv of store.data.invoices) {
    if (inv.status === 'draft' || inv.status === 'paid') continue;
    const open = invoiceOpenAmount(inv);
    if (open <= 0.005) continue;
    const key = inv.contact_id || 0;
    if (!byContact[key]) byContact[key] = { contact_id: inv.contact_id, buckets: Object.fromEntries(AGING_BUCKETS.map(b => [b, 0])), total: 0 };
    const bucket = ageBucket(daysBetween(inv.due_date || inv.issue_date || todayStr(), todayStr()));
    byContact[key].buckets[bucket] = Math.round((byContact[key].buckets[bucket] + open) * 100) / 100;
    byContact[key].total = Math.round((byContact[key].total + open) * 100) / 100;
  }
  return Object.values(byContact).sort((a, b) => b.total - a.total);
}

/* Per-supplier open payables from received purchases, bucketed likewise. */
function apAging() {
  const bySupplier = {};
  for (const po of store.data.purchases) {
    if (po.status !== 'received') continue;
    const open = purchaseOpenAmount(po);
    if (open <= 0.005) continue;
    const key = po.supplier_id || 0;
    if (!bySupplier[key]) bySupplier[key] = { supplier_id: po.supplier_id, buckets: Object.fromEntries(AGING_BUCKETS.map(b => [b, 0])), total: 0 };
    const bucket = ageBucket(daysBetween(po.received_date || po.date || todayStr(), todayStr()));
    bySupplier[key].buckets[bucket] = Math.round((bySupplier[key].buckets[bucket] + open) * 100) / 100;
    bySupplier[key].total = Math.round((bySupplier[key].total + open) * 100) / 100;
  }
  return Object.values(bySupplier).sort((a, b) => b.total - a.total);
}

/* ---------------- UI ---------------- */

function openInvoices() {
  return store.data.invoices.filter(i => i.status !== 'draft' && i.status !== 'paid' && invoiceOpenAmount(i) > 0.005);
}
function openPurchases() {
  return store.data.purchases.filter(p => p.status === 'received' && purchaseOpenAmount(p) > 0.005);
}

function paymentFields(direction) {
  if (direction === 'in') {
    const options = openInvoices().map(i => ({
      value: i.id,
      label: `${i.number} — ${contactName(store.contact(i.contact_id)) || ''} (${t('open')}: ${money(invoiceOpenAmount(i))})`,
    }));
    return [
      { key: 'ref_id', label: t('Invoice'), type: 'select', options, required: true },
      { key: 'amount', label: t('Amount (USD)'), type: 'number', required: true },
      { key: 'method', label: t('Method'), type: 'select', options: PAYMENT_METHODS.map(m => ({ value: m, label: t(m) })) },
      { key: 'date', label: t('Date'), type: 'date', value: todayStr() },
      { key: 'memo', label: t('Memo'), value: '', full: true },
    ];
  }
  const options = openPurchases().map(p => ({
    value: p.id,
    label: `${p.number} — ${(store.data.suppliers.find(s => s.id === p.supplier_id) || {}).name || ''} (${t('open')}: ${money(purchaseOpenAmount(p))})`,
  }));
  return [
    { key: 'ref_id', label: t('Purchase order'), type: 'select', options, required: true },
    { key: 'amount', label: t('Amount (USD)'), type: 'number', required: true },
    { key: 'method', label: t('Method'), type: 'select', options: PAYMENT_METHODS.map(m => ({ value: m, label: t(m) })) },
    { key: 'date', label: t('Date'), type: 'date', value: todayStr() },
    { key: 'memo', label: t('Memo'), value: '', full: true },
  ];
}

function addPayment(direction) {
  const fields = paymentFields(direction);
  if (!fields[0].options.length) { toast(direction === 'in' ? t('No open invoices.') : t('No open purchases.')); return; }
  openModal(direction === 'in' ? t('Record incoming payment') : t('Record outgoing payment'), fields, out => {
    if (inServerMode()) { txCall('payment', { direction, ref_type: direction === 'in' ? 'invoice' : 'purchase', ref_id: out.ref_id, amount: num(out.amount), method: out.method, date: out.date, memo: out.memo }, t('Payment recorded')); return; }
    const row = recordPayment({
      direction, ref_type: direction === 'in' ? 'invoice' : 'purchase', ref_id: out.ref_id,
      amount: out.amount, method: out.method, date: out.date, memo: out.memo,
    });
    if (!row) { toast(t('Payment not recorded — check the amount does not exceed the open balance.')); return; }
    toast(t('Payment recorded'));
    render();
  });
}

function agingTable(rows, nameFn) {
  if (!rows.length) return `<div class="empty-state">${t('Nothing open.')}</div>`;
  const body = rows.map(r => `<tr>
    <td>${esc(nameFn(r) || '—')}</td>
    ${AGING_BUCKETS.map(b => `<td>${r.buckets[b] ? money(r.buckets[b]) : ''}</td>`).join('')}
    <td><strong>${money(r.total)}</strong></td></tr>`).join('');
  return `<div class="table-wrap"><table class="data">
    <thead><tr><th>${t('Name')}</th>${AGING_BUCKETS.map(b => `<th>${t(b === 'current' ? 'current (not due)' : b + ' ' + t('days overdue'))}</th>`).join('')}<th>${t('Total')}</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

function renderPayments() {
  const rows = store.data.payments.slice().sort((a, b) => b.id - a.id).slice(0, 60);
  const ar = arAging(), ap = apAging();
  const arTotal = ar.reduce((s, r) => s + r.total, 0);
  const apTotal = ap.reduce((s, r) => s + r.total, 0);
  const body = rows.map(p => {
    const party = p.direction === 'in'
      ? contactName(store.contact(p.contact_id)) || '—'
      : ((store.data.suppliers.find(s => s.id === p.supplier_id) || {}).name || '—');
    const ref = p.ref_type === 'invoice'
      ? ((store.data.invoices.find(i => i.id === p.ref_id) || {}).number || '—')
      : ((store.data.purchases.find(x => x.id === p.ref_id) || {}).number || '—');
    return `<tr>
      <td>${esc(p.date || '—')}</td>
      <td><span class="badge ${p.direction === 'in' ? 'won' : 'lost'}">${t(p.direction === 'in' ? 'incoming' : 'outgoing')}</span></td>
      <td>${esc(party)}</td><td>${esc(ref)}</td>
      <td class="${p.direction === 'in' ? '' : 'overdue-text'}">${p.direction === 'in' ? '+' : '−'}${money(p.amount)}</td>
      <td>${t(p.method || 'cash')}</td><td>${esc(p.memo || '')}</td></tr>`;
  }).join('');

  $('#view-payments').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Payments')}</h2><div class="sub">${t('Settlements against invoices and purchases, partial allowed')}</div></div>
      <div class="head-actions">
        <button class="secondary-btn" id="payIn">+ ${t('Incoming')}</button>
        <button class="secondary-btn" id="payOut">+ ${t('Outgoing')}</button>
      </div>
    </div>
    <div class="cards">
      <div class="stat-card"><div class="label">${t('Receivable (AR)')}</div><div class="value">${money(arTotal)}</div></div>
      <div class="stat-card"><div class="label">${t('Payable (AP)')}</div><div class="value">${money(apTotal)}</div></div>
      <div class="stat-card"><div class="label">${t('Net position')}</div><div class="value" style="color:${arTotal - apTotal >= 0 ? 'var(--green)' : 'var(--red)'}">${money(arTotal - apTotal)}</div></div>
    </div>
    <div class="card"><h3>${t('AR aging')} (${t('by customer')})</h3>${agingTable(ar, r => contactName(store.contact(r.contact_id)))}</div>
    <div class="card"><h3>${t('AP aging')} (${t('by supplier')})</h3>${agingTable(ap, r => (store.data.suppliers.find(s => s.id === r.supplier_id) || {}).name)}</div>
    <div class="card"><h3>${t('Recent payments')}</h3>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>${t('Date')}</th><th>${t('Direction')}</th><th>${t('Party')}</th><th>${t('Reference')}</th><th>${t('Amount')}</th><th>${t('Method')}</th><th>${t('Memo')}</th></tr></thead>
        <tbody>${body || `<tr><td colspan="7" class="empty-state">${t('No payments yet.')}</td></tr>`}</tbody></table></div></div>`;

  $('#payIn').onclick = () => addPayment('in');
  $('#payOut').onclick = () => addPayment('out');
}

App.views.payments = renderPayments;
