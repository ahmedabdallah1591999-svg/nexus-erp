'use strict';
/* pos.js — till view: product grid, cart, one explicit charge. The server
   owns catalog prices, stock, the invoice, the payment and the journal in a
   single transaction; the UI sends only product ids, quantities and an
   idempotency reference so a retried tap can never double-sell.
   Shifts: one open shift per cashier; closing counts the cash and records
   the variance as a review figure only — it never posts a journal. */

let posCart = [];   // [{product_id, qty}]
let posRef = null;  // idempotency reference for the current cart

function posMyShift() {
  const u = (Auth.current && Auth.current.username) || '';
  return (store.data.pos_shifts || []).find(s => s.status === 'open' && s.cashier === u) || null;
}

function posOpenShift() {
  openModal(t('Open shift'), [
    { key: 'opening_float', label: t('Opening float'), type: 'number', required: true, value: 0 },
  ], out => {
    if (inServerMode()) { txCall('pos-shift-open', { opening_float: num(out.opening_float) }, t('Shift opened')); return; }
    alert(t('This change needs the server.'));
  });
}

function posExpectedCash(sh) {
  return Math.round((num(sh.opening_float) + num(sh.sales_cash) - num(sh.refund_cash)) * 100) / 100;
}

function posCloseShift(sh) {
  const expected = posExpectedCash(sh);
  openModal(t('Close shift'), [
    { key: 'counted_cash', label: `${t('Counted cash')} (${t('Expected cash')}: ${money(expected)})`, type: 'number', required: true, value: expected },
  ], out => {
    if (inServerMode()) { txCall('pos-shift-close', { id: sh.id, counted_cash: num(out.counted_cash) }, t('Shift closed')); return; }
    alert(t('This change needs the server.'));
  });
}

function posAdd(pid) {
  const p = store.data.products.find(x => x.id === pid);
  if (!p || num(p.stock) <= 0) return;
  const line = posCart.find(l => l.product_id === pid);
  const inCart = line ? line.qty : 0;
  if (inCart + 1 > num(p.stock)) { toast(t('Insufficient stock')); return; }
  if (line) line.qty += 1; else posCart.push({ product_id: pid, qty: 1 });
  render();
}

function posBump(pid, d) {
  const line = posCart.find(l => l.product_id === pid);
  if (!line) return;
  const p = store.data.products.find(x => x.id === pid);
  line.qty += d;
  if (d > 0 && p && line.qty > num(p.stock)) { line.qty -= d; toast(t('Insufficient stock')); return; }
  if (line.qty <= 0) posCart = posCart.filter(l => l !== line);
  render();
}

function posTotal() {
  return Math.round(posCart.reduce((s, l) => {
    const p = store.data.products.find(x => x.id === l.product_id);
    return s + (p ? num(p.price) * l.qty : 0);
  }, 0) * 100) / 100;
}

function posCharge(shift) {
  if (!posCart.length) { toast(t('Cart is empty.')); return; }
  const total = posTotal();
  openModal(t('Charge'), [
    { key: 'method', label: t('Payment method'), type: 'select',
      options: [{ value: 'cash', label: t('cash') }, { value: 'bank', label: t('bank') }, { value: 'transfer', label: t('transfer') }, { value: 'card', label: t('card') }],
      value: 'cash' },
  ], out => {
    /* explicit confirm with the amount before anything posts */
    if (!window.confirm(`${t('Charge')} ${money(total)} (${t(out.method)})?`)) return;
    if (!inServerMode()) { alert(t('This change needs the server.')); return; }
    if (!posRef) posRef = (crypto.randomUUID ? crypto.randomUUID() : `pos-${Date.now()}-${Math.random()}`);
    const items = posCart.map(l => ({ product_id: l.product_id, qty: l.qty }));
    txCall('pos-sale', { client_ref: posRef, shift_id: shift ? shift.id : null, method: out.method, items }, t('Sale completed'));
    posCart = [];
    posRef = null;
  });
}

function renderPos() {
  const shift = posMyShift();
  const products = (store.data.products || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const grid = products.map(p => `
    <button class="pos-tile" data-pos="${p.id}" ${num(p.stock) <= 0 ? 'disabled' : ''}>
      <strong>${esc(p.name)}</strong>
      <span>${money(p.price)}</span>
      <span class="cell-sub">${t('Stock')}: ${num(p.stock)}</span>
    </button>`).join('');
  const cartRows = posCart.map(l => {
    const p = store.data.products.find(x => x.id === l.product_id) || { name: '?', price: 0 };
    return `<tr>
      <td>${esc(p.name)}</td>
      <td class="row-actions"><button class="icon-btn" data-bump="${p.id}|-1">−</button> ${l.qty} <button class="icon-btn" data-bump="${p.id}|1">+</button></td>
      <td>${money(Math.round(num(p.price) * l.qty * 100) / 100)}</td>
    </tr>`;
  }).join('');
  const recent = (store.data.invoices || []).filter(i => i.pos_ref).sort((a, b) => b.id - a.id).slice(0, 10).map(i => `
    <tr><td>${esc(i.number)}</td><td>${money(invoiceTotal(i))}</td><td><span class="badge ${i.status === 'refunded' ? 'lost' : 'won'}">${t(i.status)}</span>${i.status === 'paid' ? ` <button class="icon-btn" data-refund="${i.id}" title="${t('Refund')}">↩</button>` : ''}</td></tr>`).join('');

  $('#view-pos').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Point of sale')}</h2><div class="sub">${t('Tap products, charge once — invoice, payment, stock and books post together.')}</div></div>
      <div class="head-actions">
        ${shift
          ? `<span class="badge won">${t('Open shift')} · ${t('Expected cash')}: ${money(posExpectedCash(shift))}</span>
             <span class="cell-sub">${t('cash')}: ${money(num(shift.sales_cash))} · ${t('bank')}: ${money(num(shift.sales_bank))} · ${t('transfer')}: ${money(num(shift.sales_transfer))} · ${t('card')}: ${money(num(shift.sales_card))} · ${t('Refunds')}: ${money(num(shift.refund_cash) + num(shift.refund_bank) + num(shift.refund_transfer) + num(shift.refund_card))}</span>
             <button class="secondary-btn" id="posClose">${t('Close shift')}</button>`
          : `<button class="secondary-btn" id="posOpen">${t('Open shift')}</button>`}
      </div>
    </div>
    <div class="pos-layout">
      <div class="pos-grid">${grid || `<div class="empty-state">${t('No products yet.')}</div>`}</div>
      <div class="pos-side">
        <div class="table-wrap"><table class="data">
          <thead><tr><th>${t('Product')}</th><th>${t('Qty')}</th><th>${t('Amount')}</th></tr></thead>
          <tbody>${cartRows || `<tr><td colspan="3" class="empty-state">${t('Cart is empty.')}</td></tr>`}</tbody>
        </table></div>
        <div class="pos-total"><strong>${t('Total')}: ${money(posTotal())}</strong>
          <button class="primary-btn" id="posCharge">${t('Charge')}</button>
        </div>
        <h3>${t('Recent till sales')}</h3>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>${t('Invoice')}</th><th>${t('Total')}</th><th>${t('Status')}</th></tr></thead>
          <tbody>${recent || `<tr><td colspan="3" class="empty-state">${t('No sales yet.')}</td></tr>`}</tbody>
        </table></div>
      </div>
    </div>`;

  /* onclick assignment, not addEventListener: the section node persists
     across renders and listeners would stack, multiplying every tap */
  $('#view-pos').onclick = e => {
    const tile = e.target.closest('button[data-pos]');
    if (tile) return posAdd(Number(tile.dataset.pos));
    const bump = e.target.closest('button[data-bump]');
    if (bump) { const [pid, d] = bump.dataset.bump.split('|'); return posBump(Number(pid), Number(d)); }
    const rf = e.target.closest('button[data-refund]');
    if (rf) {
      const inv = (store.data.invoices || []).find(i => i.id === Number(rf.dataset.refund));
      if (inv && window.confirm(`${t('Refund')} ${esc(inv.number)} — ${money(invoiceTotal(inv))}?`)) {
        txCall('pos-refund', { id: inv.id }, t('Refund posted'));
      }
    }
  };
  const openBtn = $('#posOpen'); if (openBtn) openBtn.onclick = posOpenShift;
  const closeBtn = $('#posClose'); if (closeBtn) closeBtn.onclick = () => posCloseShift(shift);
  $('#posCharge').onclick = () => posCharge(shift);
}

App.views.pos = renderPos;
