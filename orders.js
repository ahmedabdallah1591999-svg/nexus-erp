'use strict';
/* orders.js — sales orders, fulfillment and returns.
   Workflow: quote -> sales order (draft -> confirmed) -> fulfillment, which
   creates the invoice (stock + journals post through the invoice's own
   rules) -> payment. Cancellation is only possible before fulfillment;
   after fulfillment a return reverses stock, revenue, VAT and COGS.
   In server mode every action goes through Sync.tx and the server owns
   the whole transaction. */

const ORDER_STATUSES = ['draft', 'confirmed', 'fulfilled', 'cancelled'];

function nextOrderNumber() {
  const n = `SO-${String(store.data.meta.orderSeq || 1).padStart(4, '0')}`;
  store.data.meta.orderSeq = (store.data.meta.orderSeq || 1) + 1;
  return n;
}
function nextReturnNumber() {
  const n = `RN-${String(store.data.meta.returnSeq || 1).padStart(4, '0')}`;
  store.data.meta.returnSeq = (store.data.meta.returnSeq || 1) + 1;
  return n;
}

function orderTotal(o) { return invoiceTotal(o); } // same shape: items + tax_rate

/* Quantity of a product already returned against an order. */
function returnedQty(orderId, productId) {
  return (store.data.returns || [])
    .filter(r => r.order_id === orderId)
    .reduce((s, r) => s + (r.items || []).filter(it => it.product_id === productId)
      .reduce((x, it) => x + num(it.qty), 0), 0);
}

/* ---------------- order creation / editing ---------------- */

function editOrder(ord) {
  const isNew = !ord;
  const row = ord || {
    number: nextOrderNumberPreview(), status: 'draft', order_date: todayStr(),
    contact_id: '', quote_id: null, tax_rate: 14, items: [], notes: '',
  };
  const statusOpt = (v, l) => `<option value="${v}"${row.status === v ? ' selected' : ''}>${l}</option>`;
  const html = `
    <div class="form-grid">
      <div class="field"><label>${t('Order #')}</label><input value="${esc(row.number)}" disabled></div>
      <div class="field"><label>${t('Status')}</label>
        <select name="status"${isNew || row.status === 'draft' ? '' : ' disabled'}>${statusOpt('draft', t('draft'))}${statusOpt('confirmed', t('confirmed'))}</select></div>
      <div class="field"><label>${t('Customer (CRM contact)')} *</label>
        <select name="contact_id" required>
          <option value="">${t('— choose —')}</option>
          ${store.data.contacts.map(c => `<option value="${c.id}"${row.contact_id === c.id ? ' selected' : ''}>${esc(contactName(c))}</option>`).join('')}
        </select></div>
      <div class="field"><label>${t('Order date')}</label><input name="order_date" type="date" value="${esc(row.order_date || todayStr())}"></div>
      <div class="field"><label>${t('Tax rate %')}</label><input name="tax_rate" type="number" min="0" step="any" value="${num(row.tax_rate)}"></div>
      <div class="field"><label>${t('Notes')}</label><input name="notes" value="${esc(row.notes || '')}"></div>
    </div>
    <div class="lines-head"><h4>${t('Line items')}</h4><button type="button" class="secondary-btn add-line">+ ${t('Add line')}</button></div>
    <table class="lines"><thead><tr><th style="width:32%">${t('Product')}</th><th>${t('Description')}</th><th style="width:80px">${t('Qty')}</th><th style="width:110px">${t('Unit price')}</th><th style="width:80px">${t('Total')}</th><th></th></tr></thead>
      <tbody class="lines-body">${(row.items.length ? row.items : [{ qty: 1, price: 0 }]).map(it => lineRowHtml(it, 'price')).join('')}</tbody>
    </table>
    <div class="doc-totals">
      <div>${t('Subtotal')}: <strong class="doc-sub">0.00</strong></div>
      <div>${t('Tax')}: <strong class="doc-tax">0.00</strong></div>
      <div class="doc-grand">${t('Total')}: <strong class="doc-total">0.00</strong></div>
    </div>`;

  openDocumentModal(isNew ? t('New order') : `${t('Edit')} ${row.number}`, html);
  const form = $('#modalForm');
  wireLineItems(form, 'price', sub => {
    const tax = sub * num(form.querySelector('[name=tax_rate]').value) / 100;
    form.querySelector('.doc-sub').textContent = sub.toFixed(2);
    form.querySelector('.doc-tax').textContent = tax.toFixed(2);
    form.querySelector('.doc-total').textContent = (sub + tax).toFixed(2);
  });
  form.querySelector('[name=tax_rate]').addEventListener('input', () => form.querySelector('.lines-body').dispatchEvent(new Event('input')));
  modalSubmit = () => {
    const contact_id = idsOrNull(form.querySelector('[name=contact_id]').value);
    if (!contact_id) { alert(t('Choose a customer contact first.')); return; }
    const items = collectLines(form);
    if (!items.length) { alert(t('Add at least one line item.')); return; }
    const out = {
      status: form.querySelector('[name=status]').value,
      contact_id,
      order_date: form.querySelector('[name=order_date]').value,
      tax_rate: num(form.querySelector('[name=tax_rate]').value),
      notes: form.querySelector('[name=notes]').value.trim(),
      items,
    };
    saveOrder(ord, out);
    closeModal();
    render();
  };
}
function nextOrderNumberPreview() { return `SO-${String(store.data.meta.orderSeq || 1).padStart(4, '0')}`; }

function saveOrder(existing, out) {
  if (inServerMode()) {
    txCall('order-save', { id: existing && existing.id, out },
      existing ? `${t('Order')} ${existing.number} ${t('updated')}` : `${t('Order')} ${t('created')}`);
    return;
  }
  if (existing) {
    store.update('sales_orders', existing.id, out);
    toast(`${t('Order')} ${existing.number} ${t('updated')}`);
  } else {
    out.number = nextOrderNumber();
    out.invoice_id = null;
    out.quote_id = out.quote_id || null;
    store.add('sales_orders', out);
    toast(`${t('Order')} ${out.number} ${t('created')}`);
  }
}

/* Quote -> order (the order keeps the link; the quote records the order). */
function convertQuoteToOrder(q) {
  if (q.order_id) { alert(t('This quote was already converted to an order.')); return; }
  if (inServerMode()) { txCall('quote-to-order', { id: q.id }, `${t('Quote')} ${q.number} → ${t('Order')}`); return; }
  const out = {
    status: 'draft', contact_id: q.contact_id, order_date: todayStr(),
    tax_rate: num(q.tax_rate), notes: `${t('From quote')} ${q.number}${q.notes ? ' — ' + q.notes : ''}`,
    items: (q.items || []).map(it => ({ product_id: it.product_id || null, description: it.description || '', qty: num(it.qty), price: num(it.price) })),
    quote_id: q.id, invoice_id: null,
  };
  saveOrder(null, out);
  const created = store.data.sales_orders[store.data.sales_orders.length - 1];
  store.update('quotes', q.id, { order_id: created ? created.id : null });
  render();
}

/* ---------------- workflow actions ---------------- */

function confirmOrder(o) {
  if (inServerMode()) { txCall('order-confirm', { id: o.id }, `${o.number} ${t('confirmed')}`); return; }
  store.update('sales_orders', o.id, { status: 'confirmed' });
  toast(`${o.number} ${t('confirmed')}`);
}

/* Fulfillment creates the invoice; stock, COGS and revenue journals all
   post through the invoice's own rules. Idempotent via order.invoice_id. */
function fulfillOrder(o) {
  if (o.invoice_id) { alert(t('This order is already fulfilled.')); return; }
  for (const it of o.items) {
    const p = it.product_id ? store.product(it.product_id) : null;
    if (p && num(p.stock) < num(it.qty)) { alert(`${t('Insufficient stock for')} ${p.name}`); return; }
  }
  if (inServerMode()) { txCall('order-fulfill', { id: o.id }, `${o.number} ${t('fulfilled')}`); return; }
  const inv = {
    status: 'sent', contact_id: o.contact_id,
    issue_date: todayStr(), due_date: todayStr(),
    tax_rate: num(o.tax_rate),
    notes: `${t('From order')} ${o.number}${o.notes ? ' — ' + o.notes : ''}`,
    items: (o.items || []).map(it => ({ product_id: it.product_id || null, description: it.description || '', qty: num(it.qty), price: num(it.price) })),
    order_id: o.id,
  };
  saveInvoice(null, inv);
  const created = store.data.invoices[store.data.invoices.length - 1];
  store.update('sales_orders', o.id, { status: 'fulfilled', invoice_id: created ? created.id : null, fulfilled_date: todayStr() });
  toast(`${o.number} ${t('fulfilled')} → ${created ? created.number : ''}`);
  render();
}

function cancelOrder(o) {
  if (o.status === 'fulfilled') { alert(t('Fulfilled orders cannot be cancelled — post a return instead.')); return; }
  if (inServerMode()) { txCall('order-cancel', { id: o.id }, `${o.number} ${t('cancelled')}`); return; }
  store.update('sales_orders', o.id, { status: 'cancelled' });
  toast(`${o.number} ${t('cancelled')}`);
}

/* ---------------- returns ---------------- */

function returnModal(o) {
  const lines = (o.items || []).map((it, i) => {
    const p = it.product_id ? store.product(it.product_id) : null;
    const ret = returnedQty(o.id, it.product_id);
    const max = num(it.qty) - ret;
    return `<div class="field"><label>${esc(p ? p.name : it.description || '')} (${t('sold')} ${num(it.qty)}, ${t('returned')} ${ret})</label>
      <input type="number" class="ret-qty" data-i="${i}" min="0" max="${max}" step="any" value="0"></div>`;
  }).join('');
  openModal(`${t('Create return')} — ${o.number}`, [{ key: '_info', label: t('Quantities to return'), type: 'info' }], () => {});
  const refundHtml = inServerMode() ? `<div class="field"><label>${t('Money already paid back to the customer? (needed only if they already paid)')}</label>
      <select id="retConfirm"><option value="no">${t('No, nothing moved')}</option><option value="yes">${t('Yes, it was paid back')}</option></select></div>
    <div class="field"><label>${t('Refund method')}</label><select id="retMethod"><option value="">—</option>${PAYMENT_METHODS.map(m => `<option value="${m}">${m}</option>`).join('')}</select></div>
    <div class="field"><label>${t('Refund reference (transfer / receipt no.)')}</label><input id="retRef"></div>` : '';
  $('#modalForm').innerHTML = `<div class="form-grid">${lines}${refundHtml}</div>
    <div class="modal-actions"><button type="button" class="secondary-btn" id="modalCancel">${t('Cancel')}</button>
    <button type="submit" class="primary-btn">${t('Create return')}</button></div>`;
  $('#modalCancel').onclick = closeModal;
  modalSubmit = () => {
    const items = [];
    $('#modalForm').querySelectorAll('.ret-qty').forEach(inp => {
      const q = num(inp.value);
      if (q > 0) {
        const src = o.items[Number(inp.dataset.i)];
        items.push({ product_id: src.product_id || null, description: src.description || '', qty: q, price: num(src.price) });
      }
    });
    if (!items.length) { alert(t('Nothing to return')); return; }
    const refund = (inServerMode() && $('#retConfirm') && $('#retConfirm').value === 'yes')
      ? { refund_confirmed: true, refund_method: $('#retMethod').value || undefined, refund_reference: $('#retRef').value } : {};
    createReturn(o, items, refund);
    closeModal();
    render();
  };
}

/* The return transaction: stock back in, revenue + VAT reversed, COGS
   reversed, and the money side credited to AR (unpaid) or cash (paid). */
function createReturn(o, items, refund) {
  if (inServerMode()) { txCall('return-create', { id: o.id, items, ...(refund || {}) }, `${t('Return posted for')} ${o.number}`); return; }
  /* single-user browser mode: a refund of money the customer already paid
     is only posted once the user confirms it was really paid back */
  const sp = returnSplit(o, items);
  if (sp.toCash > 0.005 && !window.confirm(`${t('Money already paid back to the customer? (needed only if they already paid)')} ${money(sp.toCash)}`)) return;
  applyReturnEffects(o, items);
  toast(`${t('Return posted for')} ${o.number}`);
}

/* Shared by the local path and (inside the sandbox) the server path. */
/* Review flags for a stored return. Nothing is changed or corrected: the
   original row and its postings stay as evidence. A flag only says "a person
   must look at this" (old returns were priced from the browser request and
   paid out cash without a recorded confirmation). Derived, never stored. */
function returnReviewFlags(r) {
  const flags = [];
  const o = (store.data.sales_orders || []).find(x => x.id === r.order_id);
  if (o) {
    for (const it of (r.items || [])) {
      const lines = (o.items || []).filter(x => (x.product_id || null) === (it.product_id || null));
      if (lines.length && !lines.some(x => Math.abs(num(x.price) - num(it.price)) < 0.005)) { flags.push('price differs from the order line'); break; }
    }
    const sold = {};
    (o.items || []).forEach(x => { const k = x.product_id || 'n'; sold[k] = (sold[k] || 0) + num(x.qty); });
    const back = {};
    (store.data.returns || []).filter(x => x.order_id === o.id).forEach(x => (x.items || []).forEach(it => { const k = it.product_id || 'n'; back[k] = (back[k] || 0) + num(it.qty); }));
    if (Object.keys(back).some(k => back[k] > (sold[k] || 0) + 0.0005)) flags.push('returned more than sold');
  }
  const j = (store.data.journal || []).find(x => x.ref_type === 'return' && x.ref_id === r.id);
  if (j && r.invoice_id) {
    const ar = accountByCode('1100');
    const arCr = (j.lines || []).filter(l => ar && l.account_id === ar.id).reduce((s, l) => s + num(l.credit), 0);
    if (num(r.amount) - arCr > 0.005 && !r.refund_confirmed_by) flags.push('money paid back without a recorded confirmation');
  }
  return flags;
}

/* How a return splits: the part that reduces what the customer still owes
   (toAR) and the part that is MORE than they owe, i.e. money they already
   paid (toCash). toCash is only a refund once someone confirms it was paid. */
function returnSplit(o, items) {
  const sub = Math.round(items.reduce((s, it) => s + num(it.qty) * num(it.price), 0) * 100) / 100;
  const tax = Math.round(sub * num(o.tax_rate) / 100 * 100) / 100;
  const total = Math.round((sub + tax) * 100) / 100;
  const inv = o.invoice_id ? store.invoice(o.invoice_id) : null;
  const open = inv ? invoiceOpenAmount(inv) : 0;
  const toAR = Math.round(Math.min(total, open) * 100) / 100;
  return { sub, tax, total, toAR, toCash: Math.round((total - toAR) * 100) / 100 };
}

function applyReturnEffects(o, items, opts) {
  const split = returnSplit(o, items);   // computed before the new return row exists
  const ret = {
    number: nextReturnNumber(), order_id: o.id, invoice_id: o.invoice_id || null,
    date: todayStr(), items,
  };
  applyStock(items, +1, { reason: 'return', ref_type: 'return', ref_id: null });
  const { sub, tax, total, toAR, toCash } = split;
  ret.amount = total;
  if (toCash > 0.005 && opts && opts.method) { ret.refund_method = opts.method; ret.refund_reference = opts.reference || ''; ret.refund_confirmed_by = opts.by || null; }
  const row = store.add('returns', ret);
  // fix stock-move refs now that the return has an id
  store.data.stock_moves.filter(m => m.reason === 'return' && m.ref_id == null).forEach(m => { m.ref_id = row.id; });
  ensureCOA();
  const lines = [{ account_id: accountByCode('4000').id, debit: sub }];
  if (tax > 0) lines.push({ account_id: accountByCode('2100').id, debit: tax });
  if (toAR > 0) lines.push({ account_id: accountByCode('1100').id, credit: Math.round(toAR * 100) / 100 });
  if (toCash > 0) lines.push({ account_id: (opts && opts.method) ? settlementAccountId(opts.method) : accountByCode('1000').id, credit: toCash });
  postJournal({ date: ret.date, memo: `${t('Return')} ${ret.number} (${o.number})`, ref_type: 'return', ref_id: row.id, lines });
  const cogs = Math.round(items.reduce((s, it) => {
    const p = it.product_id ? store.product(it.product_id) : null;
    return s + (p ? num(it.qty) * num(p.cost) : 0);
  }, 0) * 100) / 100;
  if (cogs > 0) postJournal({
    date: ret.date, memo: `${t('COGS reversal for')} ${ret.number}`, ref_type: 'return-cogs', ref_id: row.id,
    lines: [{ account_id: accountByCode('1200').id, debit: cogs }, { account_id: accountByCode('5000').id, credit: cogs }],
  });
  if (toCash > 0) store.add('ledger', {
    date: ret.date, type: 'expense', category: 'Sales return', amount: toCash,
    ref_type: 'return', ref_id: row.id, memo: `${t('Refund for')} ${ret.number}`,
  });
  return row;
}

/* ---------------- view ---------------- */

function orderStatusBadge(s) {
  const cls = { draft: 'status-draft', confirmed: 'status-sent', fulfilled: 'status-paid', cancelled: 'status-cancelled' }[s] || 'status-draft';
  return `<span class="status-badge ${cls}">${t(s)}</span>`;
}

function renderOrders() {
  const rows = (store.data.sales_orders || []).slice().sort((a, b) => b.id - a.id);
  const body = rows.map(o => {
    const c = store.contact(o.contact_id);
    const inv = o.invoice_id ? store.invoice(o.invoice_id) : null;
    const acts = [];
    if (o.status === 'draft') acts.push(`<button class="mini-btn" data-act="edit" data-id="${o.id}">${t('Edit')}</button>`);
    if (o.status === 'draft') acts.push(`<button class="mini-btn" data-act="confirm" data-id="${o.id}">${t('Confirm')}</button>`);
    if (o.status === 'confirmed') acts.push(`<button class="mini-btn primary" data-act="fulfill" data-id="${o.id}">${t('Fulfill')}</button>`);
    if (o.status === 'draft' || o.status === 'confirmed') acts.push(`<button class="mini-btn" data-act="cancel" data-id="${o.id}">${t('Cancel order')}</button>`);
    if (o.status === 'fulfilled') acts.push(`<button class="mini-btn" data-act="return" data-id="${o.id}">${t('Create return')}</button>`);
    if (o.status === 'draft') acts.push(`<button class="mini-btn danger" data-act="del" data-id="${o.id}">${t('Delete')}</button>`);
    return `<tr>
      <td><div class="cell-main">${esc(o.number)}</div><div class="cell-sub">${esc(o.order_date || '')}</div></td>
      <td>${esc(c ? contactName(c) : '')}</td>
      <td>${orderStatusBadge(o.status)}</td>
      <td class="num">${money(orderTotal(o))}</td>
      <td>${inv ? esc(inv.number) : '—'}</td>
      <td class="actions">${acts.join('')}</td></tr>`;
  }).join('');
  const rets = (store.data.returns || []).slice().sort((a, b) => b.id - a.id);
  const retBody = rets.map(r => `<tr>
    <td><div class="cell-main">${esc(r.number)}</div><div class="cell-sub">${esc(r.date || '')}</div></td>
    <td>${esc((store.data.sales_orders.find(o => o.id === r.order_id) || {}).number || '')}</td>
    <td>${(r.items || []).map(it => { const p = it.product_id ? store.product(it.product_id) : null; return `${esc(p ? p.name : it.description || '')} × ${num(it.qty)}`; }).join(', ')}</td>
    <td class="num">${money(r.amount || 0)}${returnReviewFlags(r).length ? `<div class="cell-sub" style="color:#b45309">⚠ ${t('Needs review')}: ${returnReviewFlags(r).map(f => t(f)).join('; ')}</div>` : ''}${r.refund_reference ? `<div class="cell-sub">${t('Refund reference (transfer / receipt no.)')}: ${esc(r.refund_reference)}</div>` : ''}</td></tr>`).join('');

  $('#view-orders').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Sales orders')}</h2><div class="sub">${t('Confirm, fulfill to invoice, cancel or return')}</div></div>
      <div class="head-actions"><button class="primary-btn" id="addOrder">+ ${t('New order')}</button></div>
    </div>
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr><th>${t('Order')}</th><th>${t('Customer')}</th><th>${t('Status')}</th><th>${t('Total')}</th><th>${t('Invoice')}</th><th></th></tr></thead>
      <tbody>${body || `<tr><td colspan="6" class="empty-state">${t('No orders yet.')}</td></tr>`}</tbody></table></div></div>
    <div class="card"><h3>${t('Returns')}</h3><div class="table-wrap"><table class="data">
      <thead><tr><th>${t('Return')}</th><th>${t('Order')}</th><th>${t('Items')}</th><th>${t('Amount')}</th></tr></thead>
      <tbody>${retBody || `<tr><td colspan="4" class="empty-state">${t('No returns yet.')}</td></tr>`}</tbody></table></div></div>`;

  $('#addOrder').onclick = () => editOrder(null);
  $('#view-orders').querySelectorAll('button[data-act]').forEach(btn => {
    btn.onclick = () => {
      const id = Number(btn.dataset.id);
      const o = (store.data.sales_orders || []).find(x => x.id === id);
      if (!o) return;
      if (btn.dataset.act === 'edit') editOrder(o);
      if (btn.dataset.act === 'confirm') { confirmOrder(o); if (!inServerMode()) render(); }
      if (btn.dataset.act === 'fulfill') { fulfillOrder(o); }
      if (btn.dataset.act === 'cancel') { cancelOrder(o); if (!inServerMode()) render(); }
      if (btn.dataset.act === 'return') returnModal(o);
      if (btn.dataset.act === 'del') confirmDelete(`${t('Order')} ${o.number}`, () => {
        if (inServerMode()) { txCall('order-delete', { id }, t('Order deleted')); return; }
        store.remove('sales_orders', id);
        toast(t('Order deleted'));
      });
    };
  });
}

App.views.orders = renderOrders;
