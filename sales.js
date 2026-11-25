'use strict';
/* sales.js — inventory (products), suppliers, sales invoices, purchase orders.
   Integrated: invoices draw on CRM contacts and decrement product stock;
   payments post to the finance ledger; received purchases restock. */

function invoiceSubtotal(inv) {
  return (inv.items || []).reduce((s, it) => s + num(it.qty) * num(it.price), 0);
}
function invoiceTotal(inv) {
  return invoiceSubtotal(inv) * (1 + num(inv.tax_rate) / 100);
}
function purchaseTotal(po) {
  return (po.items || []).reduce((s, it) => s + num(it.qty) * num(it.cost), 0);
}
function invoiceDisplayStatus(inv) {
  if (inv.status === 'paid') return 'paid';
  if (inv.status === 'sent' && inv.due_date && inv.due_date < todayStr()) return 'overdue';
  if (inv.status !== 'draft' && typeof invoicePaidAmount === 'function' && invoicePaidAmount(inv) > 0.005) return 'partial';
  return inv.status;
}

/* ---------------- Products ---------------- */

const productFields = row => [
  { key: 'name', label: t('Product name'), required: true, value: row?.name },
  { key: 'sku', label: t('SKU'), value: row?.sku },
  { key: 'category', label: t('Category'), value: row?.category },
  { key: 'reorder_level', label: t('Reorder level'), type: 'number', value: row?.reorder_level ?? 0 },
  { key: 'price', label: t('Sale price (USD)'), type: 'number', value: row?.price ?? 0 },
  { key: 'cost', label: t('Cost (USD)'), type: 'number', value: row?.cost ?? 0 },
  { key: 'stock', label: t('Stock on hand'), type: 'number', value: row?.stock ?? 0 },
];

function editProduct(row) {
  openModal(row ? t('Edit product') : t('New product'), productFields(row), out => {
    out.price = num(out.price); out.cost = num(out.cost);
    out.stock = num(out.stock); out.reorder_level = num(out.reorder_level);
    if (inServerMode()) { txCall('product-save', { id: row && row.id, out }, row ? t('Product updated') : t('Product added')); closeModal(); render(); return; }
    if (row) { store.update('products', row.id, out); toast(t('Product updated')); }
    else {
      const p = store.add('products', out);
      if (num(out.stock) > 0 && typeof postOpeningStockJournal === 'function') { ensureCOA(); postOpeningStockJournal(p, num(out.stock)); }
      toast(t('Product added'));
    }
    render();
  });
}

function renderProducts() {
  const rows = store.data.products.slice().sort((a, b) => a.name.localeCompare(b.name));
  const low = rows.filter(p => num(p.reorder_level) > 0 && num(p.stock) <= num(p.reorder_level));
  const body = rows.map(p => {
    const isLow = num(p.reorder_level) > 0 && num(p.stock) <= num(p.reorder_level);
    return `<tr>
      <td><div class="cell-main">${esc(p.name)}</div><div class="cell-sub">${esc(p.category || '')}</div></td>
      <td>${esc(p.sku || '—')}</td>
      <td>${money(p.price)}</td>
      <td>${money(p.cost)}</td>
      <td>${isLow ? `<span class="badge high">${num(p.stock)} · ${t('low')}</span>` : num(p.stock)}</td>
      <td class="row-actions">
        <button class="icon-btn" data-act="edit" data-id="${p.id}" title="${t('Edit')}">✏️</button>
        <button class="danger-btn" data-act="del" data-id="${p.id}" title="${t('Delete')}">🗑</button>
      </td>
    </tr>`;
  }).join('');

  $('#view-products').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Products & Inventory')}</h2><div class="sub">${rows.length} ${t('products')}${low.length ? ` · <span class="overdue-text">${low.length} ${t('low on stock')}</span>` : ''}</div></div>
      <button class="primary-btn" id="addProduct">+ ${t('New product')}</button>
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>${t('Product')}</th><th>${t('SKU')}</th><th>${t('Price')}</th><th>${t('Cost')}</th><th>${t('Stock')}</th><th></th></tr></thead>
      <tbody>${body || `<tr><td colspan="6" class="empty-state">${t('No products yet.')}</td></tr>`}</tbody>
    </table></div>`;

  $('#addProduct').onclick = () => editProduct(null);
  $('#view-products').querySelector('tbody').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const row = store.product(id);
    if (btn.dataset.act === 'edit') editProduct(row);
    if (btn.dataset.act === 'del') confirmDelete(`${t('product')} "${row.name}"`, () => {
      if (inServerMode()) { txCall('product-delete', { id }, t('Product deleted')); return; }
      store.remove('products', id); toast(t('Product deleted'));
    });
  });
}

/* ---------------- Suppliers ---------------- */

const supplierFields = row => [
  { key: 'name', label: t('Supplier name'), required: true, value: row?.name },
  { key: 'contact_person', label: t('Contact person'), value: row?.contact_person },
  { key: 'email', label: t('Email'), type: 'email', value: row?.email },
  { key: 'phone', label: t('Phone'), value: row?.phone },
  { key: 'address', label: t('Address'), value: row?.address, full: true },
  { key: 'notes', label: t('Notes'), type: 'textarea', value: row?.notes },
];

function editSupplier(row) {
  openModal(row ? t('Edit supplier') : t('New supplier'), supplierFields(row), out => {
    if (row) { store.update('suppliers', row.id, out); toast(t('Supplier updated')); }
    else { store.add('suppliers', out); toast(t('Supplier added')); }
    render();
  });
}

function renderSuppliers() {
  const rows = store.data.suppliers.slice().sort((a, b) => a.name.localeCompare(b.name));
  const body = rows.map(s => {
    const open = store.data.purchases.filter(p => p.supplier_id === s.id && p.status === 'ordered').length;
    return `<tr>
      <td><div class="cell-main">${esc(s.name)}</div><div class="cell-sub">${esc(s.contact_person || '')}</div></td>
      <td><div>${esc(s.email || '—')}</div><div class="cell-sub">${esc(s.phone || '')}</div></td>
      <td>${esc(s.address || '—')}</td>
      <td>${open || '—'}</td>
      <td class="row-actions">
        <button class="icon-btn" data-act="edit" data-id="${s.id}" title="${t('Edit')}">✏️</button>
        <button class="danger-btn" data-act="del" data-id="${s.id}" title="${t('Delete')}">🗑</button>
      </td>
    </tr>`;
  }).join('');

  $('#view-suppliers').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Suppliers')}</h2><div class="sub">${rows.length} ${t('suppliers')}</div></div>
      <button class="primary-btn" id="addSupplier">+ ${t('New supplier')}</button>
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>${t('Supplier')}</th><th>${t('Contact info')}</th><th>${t('Address')}</th><th>${t('Open POs')}</th><th></th></tr></thead>
      <tbody>${body || `<tr><td colspan="5" class="empty-state">${t('No suppliers yet.')}</td></tr>`}</tbody>
    </table></div>`;

  $('#addSupplier').onclick = () => editSupplier(null);
  $('#view-suppliers').querySelector('tbody').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const row = store.supplier(id);
    if (btn.dataset.act === 'edit') editSupplier(row);
    if (btn.dataset.act === 'del') confirmDelete(`${t('supplier')} "${row.name}"`, () => { store.remove('suppliers', id); toast(t('Supplier deleted')); });
  });
}

/* ---------------- Line-item document modal (invoices & POs) ---------------- */

function productOptions(selectedId) {
  return `<option value="">${t('— custom line —')}</option>` + store.data.products.map(p =>
    `<option value="${p.id}" data-price="${num(p.price)}" data-cost="${num(p.cost)}"${Number(selectedId) === p.id ? ' selected' : ''}>${esc(p.name)} (${esc(p.sku || 'no SKU')})</option>`).join('');
}

function lineRowHtml(it, priceKey) {
  return `<tr class="line-row">
    <td><select class="line-product">${productOptions(it?.product_id)}</select></td>
    <td><input class="line-desc" type="text" value="${esc(it?.description || '')}" placeholder="${t('Description')}"></td>
    <td><input class="line-qty" type="number" min="0" step="any" value="${num(it?.qty ?? 1)}"></td>
    <td><input class="line-price" type="number" min="0" step="any" value="${num(it?.[priceKey] ?? 0)}"></td>
    <td class="line-total cell-sub">0.00</td>
    <td><button type="button" class="danger-btn line-del" title="${t('Remove line')}">✕</button></td>
  </tr>`;
}

function openDocumentModal(title, html) {
  $('#modalTitle').textContent = title;
  const form = $('#modalForm');
  form.innerHTML = html + `
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="modalCancel">${t('Cancel')}</button>
      <button type="submit" class="primary-btn">${t('Save')}</button>
    </div>`;
  $('#modalBackdrop').classList.remove('hidden');
  $('#modalCancel').onclick = closeModal;
}

function wireLineItems(form, priceKey, totalsFn) {
  const tbody = form.querySelector('.lines-body');
  const recalc = () => {
    let sub = 0;
    tbody.querySelectorAll('.line-row').forEach(r => {
      const lt = num(r.querySelector('.line-qty').value) * num(r.querySelector('.line-price').value);
      r.querySelector('.line-total').textContent = lt.toFixed(2);
      sub += lt;
    });
    totalsFn(sub);
  };
  tbody.addEventListener('input', recalc);
  tbody.addEventListener('change', e => {
    if (e.target.classList.contains('line-product')) {
      const opt = e.target.selectedOptions[0];
      const row = e.target.closest('.line-row');
      if (opt && opt.value) {
        if (!row.querySelector('.line-desc').value) row.querySelector('.line-desc').value = opt.textContent.replace(/\s*\([^)]*\)$/, '');
        row.querySelector('.line-price').value = num(opt.dataset[priceKey]);
      }
      recalc();
    }
  });
  tbody.addEventListener('click', e => {
    if (e.target.classList.contains('line-del')) { e.target.closest('.line-row').remove(); recalc(); }
  });
  form.querySelector('.add-line').onclick = () => {
    tbody.insertAdjacentHTML('beforeend', lineRowHtml(null, priceKey));
    recalc();
  };
  recalc();
}

function collectLines(form) {
  const lines = [];
  form.querySelectorAll('.line-row').forEach(r => {
    const qty = num(r.querySelector('.line-qty').value);
    const price = num(r.querySelector('.line-price').value);
    const pid = idsOrNull(r.querySelector('.line-product').value);
    const desc = r.querySelector('.line-desc').value.trim();
    if (qty <= 0) return;
    if (!pid && !desc) return;
    lines.push({ product_id: pid, description: desc, qty, price });
  });
  return lines;
}

/* ---------------- Invoices ---------------- */

function editInvoice(inv) {
  const isNew = !inv;
  const row = inv || {
    number: `INV-${String(store.data.meta.invoiceSeq).padStart(4, '0')}`,
    status: 'draft', issue_date: todayStr(), due_date: todayStr(), tax_rate: 14,
    contact_id: '', deal_id: '', items: [], notes: '',
  };
  const statusOpt = (v, l) => `<option value="${v}"${row.status === v ? ' selected' : ''}>${l}</option>`;
  const html = `
    <div class="form-grid">
      <div class="field"><label>${t('Invoice #')}</label><input value="${esc(row.number)}" disabled></div>
      <div class="field"><label>${t('Status')}</label>
        <select name="status">${statusOpt('draft', t('draft'))}${statusOpt('sent', t('sent'))}${statusOpt('paid', t('paid'))}</select></div>
      <div class="field"><label>${t('Customer (CRM contact)')} *</label>
        <select name="contact_id" required>
          <option value="">${t('— choose —')}</option>
          ${store.data.contacts.map(c => `<option value="${c.id}"${row.contact_id === c.id ? ' selected' : ''}>${esc(contactName(c))}</option>`).join('')}
        </select></div>
      <div class="field"><label>${t('Related deal')}</label>
        <select name="deal_id">
          <option value="">${t('— none —')}</option>
          ${store.data.deals.map(x => `<option value="${x.id}"${row.deal_id === x.id ? ' selected' : ''}>${esc(x.title)}</option>`).join('')}
        </select></div>
      <div class="field"><label>${t('Issue date')}</label><input name="issue_date" type="date" value="${esc(row.issue_date)}"></div>
      <div class="field"><label>${t('Due date')}</label><input name="due_date" type="date" value="${esc(row.due_date)}"></div>
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

  openDocumentModal(isNew ? t('New invoice') : `${t('Edit')} ${row.number}`, html);
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
      deal_id: idsOrNull(form.querySelector('[name=deal_id]').value),
      issue_date: form.querySelector('[name=issue_date]').value,
      due_date: form.querySelector('[name=due_date]').value,
      tax_rate: num(form.querySelector('[name=tax_rate]').value),
      notes: form.querySelector('[name=notes]').value.trim(),
      items,
    };
    saveInvoice(isNew ? null : inv, out);
    closeModal();
    render();
  };
}

function applyStock(items, direction, ctx) {
  items.forEach(it => {
    if (!it.product_id) return;
    if (typeof recordStockMove === 'function') {
      recordStockMove({ product_id: it.product_id, qty: direction * num(it.qty), ...(ctx || {}) });
    } else {
      const p = store.product(it.product_id);
      if (p) p.stock = num(p.stock) + direction * num(it.qty);
    }
  });
}

function saveInvoice(existing, out) {
  /* Server mode: the server computes and commits the whole transaction
     (stock, journals, ledger, number) authoritatively. */
  if (inServerMode()) {
    /* a status-only change (Mark paid) still sends the full record: the
       server validates the whole invoice and locks posted lines */
    if (existing && !out.items) {
      out = { contact_id: existing.contact_id, deal_id: existing.deal_id, issue_date: existing.issue_date, due_date: existing.due_date,
        tax_rate: existing.tax_rate, notes: existing.notes || '', items: existing.items, ...out };
    }
    txCall('invoice-save', { id: existing && existing.id, out },
      existing ? `${t('Invoice')} ${existing.number} ${t('updated')}` : `${t('Invoice')} ${t('created')}`);
    return;
  }
  let inv;
  if (existing) {
    inv = store.update('invoices', existing.id, out);
  } else {
    out.number = `INV-${String(store.data.meta.invoiceSeq).padStart(4, '0')}`;
    store.data.meta.invoiceSeq++;
    out.stock_applied = false;
    out.ledger_posted = false;
    inv = store.add('invoices', out);
    toast(`${t('Invoice')} ${inv.number} ${t('created')}`);
  }
  // stock: applied once when the invoice leaves draft, returned if it goes back
  if (inv.status !== 'draft' && !inv.stock_applied) {
    applyStock(inv.items, -1, { reason: 'invoice', ref_type: 'invoice', ref_id: inv.id });
    inv.stock_applied = true;
  } else if (inv.status === 'draft' && inv.stock_applied) {
    applyStock(inv.items, +1, { reason: 'invoice-cancel', ref_type: 'invoice', ref_id: inv.id });
    inv.stock_applied = false;
  }
  // COGS: inventory becomes cost of goods sold when stock leaves; the
  // entry reverses if the invoice goes back to draft
  if (typeof postInvoiceCOGSJournal === 'function') {
    ensureCOA();
    if (inv.stock_applied && !inv.journal_cogs) {
      if (postInvoiceCOGSJournal(inv)) inv.journal_cogs = true;
    } else if (!inv.stock_applied && inv.journal_cogs) {
      const cogsEntry = store.data.journal.find(j => j.ref_type === 'invoice-cogs' && j.ref_id === inv.id);
      if (cogsEntry) reverseJournal(cogsEntry.id, `${t('Reversal of')} COGS ${inv.number}`);
      inv.journal_cogs = false;
    }
  }
  // accrual book: AR/revenue when the invoice leaves draft, cash when paid
  if (typeof ensureCOA === 'function') {
    ensureCOA();
    if (inv.status !== 'draft' && !inv.journal_sent) {
      if (postInvoiceSentJournal(inv)) inv.journal_sent = true;
    }
    if (inv.status === 'paid' && !inv.journal_paid) {
      inv.journal_paid = true;
      /* settlement posts through recordPayment (per-payment journal),
         never as one full-total entry, so partial payments never double-post */
      if (typeof recordPayment === 'function' && invoiceOpenAmount(inv) > 0.005) {
        recordPayment({ direction: 'in', ref_type: 'invoice', ref_id: inv.id, amount: invoiceOpenAmount(inv), method: 'cash', date: todayStr() });
      }
    }
  }
  // paid invoices post income to the ledger once
  if (inv.status === 'paid' && !inv.ledger_posted) {
    store.add('ledger', {
      date: todayStr(), type: 'income', category: 'Sales',
      amount: Math.round(invoiceTotal(inv) * 100) / 100,
      ref_type: 'invoice', ref_id: inv.id,
      memo: `Payment received for ${inv.number}`,
    });
    inv.ledger_posted = true;
  }
  store.save();
  if (existing) toast(`${t('Invoice')} ${inv.number} ${t('updated')}`);
}

/* ---------------- Recurring invoices ---------------- */

/* Generate due invoices from active templates. Idempotent: next_date
   advances one period per generated invoice, so a re-run is a no-op. */
function recurringDueCount(r) {
  if (r.status !== 'active' || !r.next_date) return 0;
  const today = todayStr();
  let n = 0, d = r.next_date;
  while (d <= today && n < 24 && (!r.end_date || d <= r.end_date)) {
    n++; d = advanceDate(d, r.interval, r.anchor_day);
  }
  return n;
}

/* Explicit per-template run. Nothing generates on view open: the user clicks
   Run, sees how many periods are due and the consequence (drafts by default;
   sent invoices only when the template opted into auto_post), then confirms. */
async function runRecurringTemplate(id) {
  const r = (store.data.recurring || []).find(x => x.id === id);
  if (!r) return;
  const n = recurringDueCount(r);
  if (!n) { toast(t('Nothing due for this template yet.')); return; }
  const how = r.auto_post ? t('sent invoice(s) — stock and accounting post immediately') : t('draft invoice(s) for review');
  if (!window.confirm(`${t('Generate now?')} ${n} ${t('periods due')} → ${how}`)) return;
  if (inServerMode()) {
    try {
      const res = await Sync.tx('recurring-run', { id });
      if (res.ok && res.data) {
        const made = res.data.created || [], blocked = res.data.blocked || [];
        if (made.length) { toast(`${t('Recurring invoices generated')}: ${made.join(', ')}`); render(); }
        if (blocked.length) toast(`${t('Insufficient stock for recurring run')}: ${blocked.join(', ')}`);
        if (!made.length && !blocked.length) toast(t('Nothing due for this template yet.'));
      } else if (!res.ok) toast(t('The server rejected the change.'));
    } catch (e) { toast(t('Could not reach the server. Your change was not saved.')); }
    return;
  }
  const today = todayStr();
  const made = [], blocked = [];
  let guard = 0;
  while (r.status === 'active' && r.next_date && r.next_date <= today && guard++ < 24) {
    if (r.end_date && r.next_date > r.end_date) { r.status = 'completed'; break; }
    if (r.auto_post) {
      const lacking = (r.items || []).map(it => {
        if (it.product_id == null) return null;
        const prod = store.product(it.product_id);
        return prod && num(prod.stock) < num(it.qty) ? prod : null;
      }).find(x => x);
      if (lacking) { blocked.push(`${lacking.name} (${r.next_date})`); break; }
    }
    const before = store.data.invoices.length;
    saveInvoice(null, {
      status: r.auto_post ? 'sent' : 'draft', contact_id: r.contact_id, deal_id: null,
      issue_date: r.next_date, due_date: r.next_date,
      tax_rate: r.tax_rate || 0, notes: r.notes || '',
      items: r.items.map(it => ({ ...it })),
      recurring_id: r.id,
    });
    const inv = store.data.invoices[store.data.invoices.length - 1];
    r.last_invoice_id = inv.id;
    made.push(inv.number);
    r.next_date = advanceDate(r.next_date, r.interval, r.anchor_day);
    if (r.end_date && r.next_date > r.end_date) r.status = 'completed';
    if (store.data.invoices.length === before) break;
  }
  if (made.length || blocked.length || r.status === 'completed') store.save();
  if (made.length) { toast(`${t('Recurring invoices generated')}: ${made.join(', ')}`); render(); }
  if (blocked.length) toast(`${t('Insufficient stock for recurring run')}: ${blocked.join(', ')}`);
}

function editRecurring(rec) {
  const isNew = !rec;
  const row = rec || {
    contact_id: '', interval: 'monthly', next_date: todayStr(), end_date: '',
    tax_rate: 14, notes: '', items: [],
  };
  const intOpt = (v) => `<option value="${v}"${row.interval === v ? ' selected' : ''}>${t(v)}</option>`;
  const html = `
    <div class="form-grid">
      <div class="field"><label>${t('Customer (CRM contact)')} *</label>
        <select name="contact_id" required>
          <option value="">${t('— choose —')}</option>
          ${store.data.contacts.map(c => `<option value="${c.id}"${row.contact_id === c.id ? ' selected' : ''}>${esc(contactName(c))}</option>`).join('')}
        </select></div>
      <div class="field"><label>${t('Interval')}</label>
        <select name="interval">${intOpt('weekly')}${intOpt('monthly')}${intOpt('quarterly')}${intOpt('yearly')}</select></div>
      <div class="field"><label>${t('Next run')}</label><input name="next_date" type="date" value="${esc(row.next_date)}" required></div>
      <div class="field"><label>${t('End date (optional)')}</label><input name="end_date" type="date" value="${esc(row.end_date || '')}"></div>
      <div class="field"><label>${t('Tax rate %')}</label><input name="tax_rate" type="number" min="0" step="any" value="${num(row.tax_rate)}"></div>
      <div class="field"><label>${t('Notes')}</label><input name="notes" value="${esc(row.notes || '')}"></div>
      <div class="field full"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="auto_post"${row.auto_post ? ' checked' : ''} style="width:auto"> ${t('Create as sent (post stock and accounting immediately — otherwise drafts for review)')}</label></div>
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

  openDocumentModal(isNew ? t('New recurring invoice') : `${t('Edit')} ${t('Recurring invoice')}`, html);
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
      contact_id,
      interval: form.querySelector('[name=interval]').value,
      next_date: form.querySelector('[name=next_date]').value,
      end_date: form.querySelector('[name=end_date]').value || '',
      tax_rate: num(form.querySelector('[name=tax_rate]').value),
      notes: form.querySelector('[name=notes]').value.trim(),
      items,
    };
    out.auto_post = !!(form.querySelector('[name=auto_post]') && form.querySelector('[name=auto_post]').checked);
    out.anchor_day = parseInt((out.next_date || '').slice(8, 10), 10) || null;
    if (inServerMode()) {
      txCall('recurring-save', { id: rec && rec.id, out }, t('Recurring template saved'));
      closeModal();
      return;
    }
    if (rec) { Object.assign(rec, out); }
    else { store.add('recurring', { ...out, status: 'active', last_invoice_id: null }); }
    store.save();
    closeModal();
    toast(t('Recurring template saved'));
    render();
  };
}

function renderInvoices() {
  const rows = store.data.invoices.slice().sort((a, b) => b.created_at < a.created_at ? -1 : 1);
  const body = rows.map(inv => {
    const c = inv.contact_id ? store.contact(inv.contact_id) : null;
    const st = invoiceDisplayStatus(inv);
    const n = (inv.items || []).length;
    return `<tr>
      <td><div class="cell-main">${esc(inv.number)}</div><div class="cell-sub">${n} ${t('items')}</div></td>
      <td>${c ? esc(contactName(c)) : '—'}</td>
      <td><div>${esc(inv.issue_date || '—')}</div><div class="cell-sub">${t('due')} ${esc(inv.due_date || '—')}</div></td>
      <td>${money(invoiceTotal(inv))}</td>
      <td><span class="badge ${st === 'paid' ? 'won' : st === 'overdue' ? 'high' : st === 'sent' ? 'lead' : 'inactive'}">${t(st)}</span></td>
      <td class="row-actions">
        ${st !== 'paid' ? `<button class="icon-btn" data-act="paid" data-id="${inv.id}" title="${t('Mark paid')}">💰</button>` : ''}
        <button class="icon-btn" data-act="edit" data-id="${inv.id}" title="${t('Edit')}">✏️</button>
        <button class="danger-btn" data-act="del" data-id="${inv.id}" title="${t('Delete')}">🗑</button>
      </td>
    </tr>`;
  }).join('');

  const open = rows.filter(i => i.status !== 'paid');
  const receivable = open.reduce((s, i) => s + invoiceTotal(i), 0);

  const recRows = store.data.recurring.slice().sort((a, b) => String(a.next_date).localeCompare(String(b.next_date))).map(r => {
    const c = r.contact_id ? store.contact(r.contact_id) : null;
    const sub = (r.items || []).reduce((s2, it) => s2 + num(it.qty) * num(it.price), 0);
    const total = sub * (1 + num(r.tax_rate) / 100);
    return `<tr>
      <td><div class="cell-main">${c ? esc(contactName(c)) : '—'}</div><div class="cell-sub">${(r.items || []).length} ${t('items')}</div></td>
      <td>${t(r.interval)}</td>
      <td><div>${esc(r.next_date || '—')}${recurringDueCount(r) ? ` <span class="badge inactive">${recurringDueCount(r)} ${t('due')}</span>` : ''}</div><div class="cell-sub">${r.end_date ? `${t('until')} ${esc(r.end_date)}` : ''}</div></td>
      <td>${money(total)}</td>
      <td><span class="badge ${r.status === 'active' ? 'won' : r.status === 'completed' ? 'lead' : 'inactive'}">${t(r.status)}</span></td>
      <td class="row-actions">
        ${r.status === 'active' ? `<button class="icon-btn" data-ract="run" data-id="${r.id}" title="${t('Run now')}">🚀</button>` : ''}
        ${r.status !== 'completed' ? `<button class="icon-btn" data-ract="${r.status === 'active' ? 'pause' : 'resume'}" data-id="${r.id}" title="${r.status === 'active' ? t('Pause') : t('Resume')}">${r.status === 'active' ? '⏸' : '▶️'}</button>` : ''}
        <button class="icon-btn" data-ract="edit" data-id="${r.id}" title="${t('Edit')}">✏️</button>
        <button class="danger-btn" data-ract="del" data-id="${r.id}" title="${t('Delete')}">🗑</button>
      </td>
    </tr>`;
  }).join('');

  $('#view-invoices').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Sales Invoices')}</h2><div class="sub">${money(receivable)} ${t('outstanding across')} ${open.length} ${t('unpaid invoices')}</div></div>
      <button class="primary-btn" id="addInvoice">+ ${t('New invoice')}</button>
    </div>
    <div class="card"><div class="lines-head" style="margin-bottom:8px"><h3>${t('Recurring invoices')}</h3><button class="secondary-btn" id="addRecurring">+ ${t('New recurring invoice')}</button></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>${t('Customer')}</th><th>${t('Interval')}</th><th>${t('Next run')}</th><th>${t('Total')}</th><th>${t('Status')}</th><th></th></tr></thead>
        <tbody id="recBody">${recRows || `<tr><td colspan="6" class="empty-state">${t('No recurring templates yet.')}</td></tr>`}</tbody>
      </table></div></div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>${t('Invoice')}</th><th>${t('Customer')}</th><th>${t('Dates')}</th><th>${t('Total')}</th><th>${t('Status')}</th><th></th></tr></thead>
      <tbody>${body || `<tr><td colspan="6" class="empty-state">${t('No invoices yet.')}</td></tr>`}</tbody>
    </table></div>`;

  $('#addRecurring').onclick = () => editRecurring(null);
  $('#recBody').addEventListener('click', e => {
    const btn = e.target.closest('button[data-ract]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const rec = store.data.recurring.find(x => x.id === id);
    if (!rec) return;
    const act = btn.dataset.ract;
    if (act === 'run') { runRecurringTemplate(parseInt(btn.dataset.id, 10)); return; }
    if (act === 'edit') { editRecurring(rec); return; }
    if (act === 'del') { confirmDelete(t('Recurring invoice'), () => {
      if (inServerMode()) { txCall('recurring-delete', { id }, t('Recurring template deleted')); return; }
      store.data.recurring = store.data.recurring.filter(x => x.id !== id);
      store.save(); toast(t('Recurring template deleted')); render();
    }); return; }
    const next = act === 'pause' ? 'paused' : 'active';
    if (inServerMode()) { txCall('recurring-status', { id, status: next }, t(next)); return; }
    rec.status = next; store.save(); render();
  });

  $('#addInvoice').onclick = () => editInvoice(null);
  $('#view-invoices').querySelector('tbody').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const inv = store.invoice(id);
    if (btn.dataset.act === 'edit') editInvoice(inv);
    if (btn.dataset.act === 'paid') { saveInvoice(inv, { status: 'paid' }); toast(`${inv.number} ${t('marked paid')}`); render(); }
    if (btn.dataset.act === 'del') confirmDelete(`${t('invoice')} ${inv.number}`, () => {
      if (inServerMode()) { txCall('invoice-delete', { id }, t('Invoice deleted')); return; }
      if (inv.stock_applied) applyStock(inv.items, +1, { reason: 'invoice-delete', ref_type: 'invoice', ref_id: inv.id });
      store.remove('invoices', id);
      store.save();
      toast(t('Invoice deleted'));
    });
  });
}

/* ---------------- Purchase orders ---------------- */

function editPurchase(po) {
  const isNew = !po;
  const row = po || {
    number: `PO-${String(store.data.meta.purchaseSeq).padStart(4, '0')}`,
    status: 'ordered', order_date: todayStr(), supplier_id: '', items: [], notes: '',
  };
  const html = `
    <div class="form-grid">
      <div class="field"><label>${t('PO #')}</label><input value="${esc(row.number)}" disabled></div>
      <div class="field"><label>${t('Status')}</label>
        <select name="status">
          <option value="ordered"${row.status === 'ordered' ? ' selected' : ''}>${t('ordered')}</option>
          <option value="received"${row.status === 'received' ? ' selected' : ''}>${t('received')}</option>
        </select></div>
      <div class="field"><label>${t('Supplier')} *</label>
        <select name="supplier_id" required>
          <option value="">${t('— choose —')}</option>
          ${store.data.suppliers.map(s => `<option value="${s.id}"${row.supplier_id === s.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select></div>
      <div class="field"><label>${t('Order date')}</label><input name="order_date" type="date" value="${esc(row.order_date)}"></div>
      <div class="field full"><label>${t('Notes')}</label><input name="notes" value="${esc(row.notes || '')}"></div>
    </div>
    <div class="lines-head"><h4>${t('Items')}</h4><button type="button" class="secondary-btn add-line">+ ${t('Add line')}</button></div>
    <table class="lines"><thead><tr><th style="width:32%">${t('Product')}</th><th>${t('Description')}</th><th style="width:80px">${t('Qty')}</th><th style="width:110px">${t('Unit cost')}</th><th style="width:80px">${t('Total')}</th><th></th></tr></thead>
      <tbody class="lines-body">${(row.items.length ? row.items : [{ qty: 1, cost: 0 }]).map(it => lineRowHtml({ ...it, price: it.cost }, 'cost')).join('')}</tbody>
    </table>
    <div class="doc-totals"><div class="doc-grand">${t('Total')}: <strong class="doc-total">0.00</strong></div></div>`;

  openDocumentModal(isNew ? t('New purchase order') : `${t('Edit')} ${row.number}`, html);
  const form = $('#modalForm');
  wireLineItems(form, 'cost', sub => { form.querySelector('.doc-total').textContent = sub.toFixed(2); });

  modalSubmit = () => {
    const supplier_id = idsOrNull(form.querySelector('[name=supplier_id]').value);
    if (!supplier_id) { alert(t('Choose a supplier first.')); return; }
    const items = collectLines(form).map(it => ({ product_id: it.product_id, qty: it.qty, cost: it.price }));
    if (!items.length) { alert(t('Add at least one line item.')); return; }
    const out = {
      status: form.querySelector('[name=status]').value,
      supplier_id,
      order_date: form.querySelector('[name=order_date]').value,
      notes: form.querySelector('[name=notes]').value.trim(),
      items,
    };
    if (inServerMode()) { txCall('purchase-save', { id: po && po.id, out }, po ? `${t('Purchase order')} ${po.number} ${t('updated')}` : `${t('Purchase order')} ${t('created')}`); closeModal(); render(); return; }
    let rec;
    if (po) {
      rec = store.update('purchases', po.id, out);
    } else {
      out.number = `PO-${String(store.data.meta.purchaseSeq).padStart(4, '0')}`;
      store.data.meta.purchaseSeq++;
      out.stock_applied = false;
      out.ledger_posted = false;
      rec = store.add('purchases', out);
    }
    if (rec.status === 'received' && !rec.stock_applied) {
      applyStock(rec.items.map(it => ({ product_id: it.product_id, qty: it.qty })), +1, { reason: 'purchase', ref_type: 'purchase', ref_id: rec.id });
      rec.stock_applied = true;
      rec.received_date = todayStr();
    }
    if (typeof ensureCOA === 'function' && rec.status === 'received' && !rec.journal_received) {
      ensureCOA();
      if (postPurchaseReceivedJournal(rec)) rec.journal_received = true;
    }
    if (rec.status === 'received' && !rec.ledger_posted) {
      store.add('ledger', {
        date: todayStr(), type: 'expense', category: 'Purchases',
        amount: Math.round(purchaseTotal(rec) * 100) / 100,
        ref_type: 'purchase', ref_id: rec.id,
        memo: `${rec.number} received`,
      });
      rec.ledger_posted = true;
    }
    store.save();
    toast(`${t('Purchase order')} ${rec.number} ${t('saved')}`);
    closeModal();
    render();
  };
}

function renderPurchases() {
  const rows = store.data.purchases.slice().sort((a, b) => b.created_at < a.created_at ? -1 : 1);
  const body = rows.map(po => {
    const s = po.supplier_id ? store.supplier(po.supplier_id) : null;
    const n = (po.items || []).length;
    return `<tr>
      <td><div class="cell-main">${esc(po.number)}</div><div class="cell-sub">${n} ${t('items')}</div></td>
      <td>${s ? esc(s.name) : '—'}</td>
      <td><div>${esc(po.order_date || '—')}</div>${po.received_date ? `<div class="cell-sub">${t('received')} ${esc(po.received_date)}</div>` : ''}</td>
      <td>${money(purchaseTotal(po))}</td>
      <td><span class="badge ${po.status === 'received' ? 'won' : 'open'}">${t(po.status)}</span></td>
      <td class="row-actions">
        <button class="icon-btn" data-act="edit" data-id="${po.id}" title="${t('Edit')}">✏️</button>
        <button class="danger-btn" data-act="del" data-id="${po.id}" title="${t('Delete')}">🗑</button>
      </td>
    </tr>`;
  }).join('');

  $('#view-purchases').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Purchase Orders')}</h2><div class="sub">${rows.filter(p => p.status === 'ordered').length} ${t('awaiting delivery')}</div></div>
      <button class="primary-btn" id="addPO">+ ${t('New purchase order')}</button>
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>${t('PO')}</th><th>${t('Supplier')}</th><th>${t('Dates')}</th><th>${t('Total')}</th><th>${t('Status')}</th><th></th></tr></thead>
      <tbody>${body || `<tr><td colspan="6" class="empty-state">${t('No purchase orders yet.')}</td></tr>`}</tbody>
    </table></div>`;

  $('#addPO').onclick = () => editPurchase(null);
  $('#view-purchases').querySelector('tbody').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const po = store.data.purchases.find(x => x.id === id);
    if (btn.dataset.act === 'edit') editPurchase(po);
    if (btn.dataset.act === 'del') confirmDelete(`${t('purchase order')} ${po.number}`, () => {
      if (inServerMode()) { txCall('purchase-delete', { id }, t('Purchase order deleted')); return; }
      if (po.stock_applied) applyStock(po.items.map(it => ({ product_id: it.product_id, qty: it.qty })), -1, { reason: 'purchase-delete', ref_type: 'purchase', ref_id: po.id });
      store.remove('purchases', id);
      store.save();
      toast(t('Purchase order deleted'));
    });
  });
}

/* ---------------- Registration ---------------- */

App.views.products = renderProducts;
App.views.suppliers = renderSuppliers;
App.views.invoices = renderInvoices;
App.views.purchases = renderPurchases;
App.quickAdd.products = () => editProduct(null);
App.quickAdd.suppliers = () => editSupplier(null);
App.quickAdd.invoices = () => editInvoice(null);
App.quickAdd.purchases = () => editPurchase(null);
App.editors.product = editProduct;
App.editors.invoice = editInvoice;
App.editors.supplier = editSupplier;
