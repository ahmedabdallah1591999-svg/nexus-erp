'use strict';
/* quotes.js — Quotations (عروض الأسعار): draft → sent → accepted/rejected,
   one-click conversion of an accepted quote into a draft invoice.
   Completes the sales cycle: quote → order/invoice → payment → ledger. */

const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'rejected'];

function quoteSubtotal(q) { return invoiceSubtotal(q); }
function quoteTotal(q) { return invoiceTotal(q); }

function nextQuoteNumber() {
  return `Q-${String(store.data.meta.quoteSeq || 1).padStart(4, '0')}`;
}

function editQuote(quote) {
  const isNew = !quote;
  const row = quote || {
    number: nextQuoteNumber(), status: 'draft', issue_date: todayStr(),
    valid_until: todayStr(), tax_rate: 14, contact_id: '', deal_id: '', items: [], notes: '',
  };
  const statusOpt = v => `<option value="${v}"${row.status === v ? ' selected' : ''}>${t(v)}</option>`;
  const html = `
    <div class="form-grid">
      <div class="field"><label>${t('Quote #')}</label><input value="${esc(row.number)}" disabled></div>
      <div class="field"><label>${t('Status')}</label>
        <select name="status">${QUOTE_STATUSES.map(statusOpt).join('')}</select></div>
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
      <div class="field"><label>${t('Valid until')}</label><input name="valid_until" type="date" value="${esc(row.valid_until)}"></div>
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

  openDocumentModal(isNew ? t('New quote') : `${t('Edit')} ${row.number}`, html);
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
      valid_until: form.querySelector('[name=valid_until]').value,
      tax_rate: num(form.querySelector('[name=tax_rate]').value),
      notes: form.querySelector('[name=notes]').value.trim(),
      items,
    };
    if (quote) {
      store.update('quotes', quote.id, out);
      toast(`${t('Quote')} ${quote.number} ${t('updated')}`);
    } else {
      out.number = nextQuoteNumber();
      store.data.meta.quoteSeq = (store.data.meta.quoteSeq || 1) + 1;
      const q = store.add('quotes', out);
      toast(`${t('Quote')} ${q.number} ${t('created')}`);
    }
    closeModal();
    render();
  };
}

/* Convert a quote into a draft invoice. The invoice keeps a link back to the
   quote; the quote records which invoice it became. Stock and ledger effects
   stay governed by the invoice's own status rules. */
function convertQuoteToInvoice(q) {
  if (q.invoiced_invoice_id) { alert(t('This quote was already converted to an invoice.')); return; }
  const inv = {
    status: 'draft',
    contact_id: q.contact_id,
    deal_id: q.deal_id || null,
    issue_date: todayStr(),
    due_date: todayStr(),
    tax_rate: num(q.tax_rate),
    notes: `${t('From quote')} ${q.number}${q.notes ? ' — ' + q.notes : ''}`,
    items: (q.items || []).map(it => ({ product_id: it.product_id || null, description: it.description || '', qty: num(it.qty), price: num(it.price) })),
    quote_id: q.id,
  };
  saveInvoice(null, inv); // assigns INV number, keeps stock unapplied while draft
  const created = store.data.invoices[store.data.invoices.length - 1];
  store.update('quotes', q.id, { status: 'accepted', invoiced_invoice_id: created ? created.id : null });
  toast(`${t('Quote')} ${q.number} → ${t('Invoice')} ${created ? created.number : ''}`);
  render();
}

function renderQuotes() {
  const rows = (store.data.quotes || []).slice().sort((a, b) => b.created_at < a.created_at ? -1 : 1);
  const body = rows.map(q => {
    const c = q.contact_id ? store.contact(q.contact_id) : null;
    const n = (q.items || []).length;
    const linked = q.invoiced_invoice_id ? (store.data.invoices.find(i => i.id === q.invoiced_invoice_id) || {}).number : null;
    return `<tr>
      <td><div class="cell-main">${esc(q.number)}</div><div class="cell-sub">${n} ${t('items')}</div></td>
      <td>${c ? esc(contactName(c)) : '—'}</td>
      <td><div>${esc(q.issue_date || '—')}</div><div class="cell-sub">${t('Valid until')} ${esc(q.valid_until || '—')}</div></td>
      <td>${money(quoteTotal(q))}</td>
      <td><span class="badge ${q.status === 'accepted' ? 'won' : q.status === 'sent' ? 'lead' : q.status === 'rejected' ? 'high' : 'inactive'}">${t(q.status)}</span>
        ${linked ? `<div class="cell-sub">→ ${esc(linked)}</div>` : ''}</td>
      <td class="row-actions">
        ${!q.invoiced_invoice_id ? `<button class="icon-btn" data-act="convert" data-id="${q.id}" title="${t('Convert to invoice')}">🧾</button>` : ''}
        <button class="icon-btn" data-act="edit" data-id="${q.id}" title="${t('Edit')}">✏️</button>
        <button class="danger-btn" data-act="del" data-id="${q.id}" title="${t('Delete')}">🗑</button>
      </td>
    </tr>`;
  }).join('');

  const open = rows.filter(q => q.status === 'sent' || q.status === 'draft');
  const openVal = open.reduce((s, q) => s + quoteTotal(q), 0);

  $('#view-quotes').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Quotes')}</h2><div class="sub">${open.length} ${t('open')} · ${money(openVal)}</div></div>
      <div class="head-actions"><button id="addQuote" class="primary-btn">+ ${t('New quote')}</button></div>
    </div>
    <div class="panel">
      <table class="table">
        <thead><tr><th>${t('Quote #')}</th><th>${t('Customer')}</th><th>${t('Dates')}</th><th>${t('Total')}</th><th>${t('Status')}</th><th></th></tr></thead>
        <tbody>${body || `<tr><td colspan="6"><div class="empty-state">${t('No quotes yet.')}</div></td></tr>`}</tbody>
      </table>
    </div>`;

  $('#addQuote').onclick = () => editQuote(null);
  $('#view-quotes').querySelector('tbody').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const q = (store.data.quotes || []).find(x => x.id === id);
    if (!q) return;
    if (btn.dataset.act === 'edit') editQuote(q);
    if (btn.dataset.act === 'convert') convertQuoteToInvoice(q);
    if (btn.dataset.act === 'del') confirmDelete(`${t('Quote')} ${q.number}`, () => { store.remove('quotes', id); render(); });
  });
}

App.views.quotes = renderQuotes;
