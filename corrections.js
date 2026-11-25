'use strict';
/* corrections.js — undo/correction path for posted documents.
   A posted invoice or received purchase is never edited. A mistake is
   corrected by a numbered credit note (sales) or purchase return
   (supplier) that the server posts with its own reversing journal, the
   matching stock move when goods really move, and refund records only when
   the reviewer names the refund method. Server mode only: the server owns
   every posting. */

Object.assign(I18N.ar, {
  'Settlement':'التسوية','Item':'بند','Credit note':'إشعار دائن','Credit notes':'إشعارات دائنة','Purchase return':'مرتجع مشتريات','Purchase returns':'مرتجعات المشتريات',
  'Reason (required)':'السبب (مطلوب)','Quantity to credit':'الكمية المراد إشعارها','Quantity to return':'الكمية المراد إرجاعها',
  'Put credited goods back in stock':'إرجاع البضاعة المرتجعة إلى المخزون','Yes':'نعم','No':'لا',
  'Refund method (only if more than the open balance)':'طريقة الرد (فقط إذا زاد عن الرصيد المفتوح)',
  'Refund method (only if the supplier already got paid)':'طريقة استرداد المورد (فقط إذا سُدد له سابقاً)',
  'Credit note posted':'تم ترحيل الإشعار الدائن','Purchase return posted':'تم ترحيل مرتجع المشتريات',
  'Corrections need the server.':'التصحيحات تحتاج الخادم.','Nothing left to credit':'لا شيء متبقٍ للإشعار','Nothing left to return':'لا شيء متبقٍ للإرجاع',
  'credited':'مُشعَر دائناً','No credit notes yet.':'لا توجد إشعارات دائنة بعد.','No purchase returns yet.':'لا توجد مرتجعات مشتريات بعد.',
  'Credit':'إشعار','Return to supplier':'إرجاع للمورد','Refunded':'مردود','Applied to balance':'مخصوم من الرصيد','Left to credit':'المتبقي للإشعار','Left to return':'المتبقي للإرجاع',
  'Posts a numbered credit note with its own reversing entries. The invoice is not edited.':'يُرحَّل إشعار دائن مرقم بقيوده العكسية. لا تُعدَّل الفاتورة.',
  'Posts a numbered return with its own entries and stock move. The purchase is not edited.':'يُرحَّل مرتجع مرقم بقيوده وحركة مخزون. لا يُعدَّل أمر الشراء.',
});

function creditedQtyByLine(inv) {
  const m = {};
  (store.data.credit_notes || []).filter(c => c.invoice_id === inv.id && c.status !== 'void')
    .forEach(c => c.items.forEach(it => { m[it.line] = (m[it.line] || 0) + num(it.qty); }));
  return m;
}
function returnedQtyByLine(po) {
  const m = {};
  (store.data.purchase_returns || []).filter(r => r.purchase_id === po.id && r.status !== 'void')
    .forEach(r => r.items.forEach(it => { m[it.line] = (m[it.line] || 0) + num(it.qty); }));
  return m;
}

function openCreditNote(inv) {
  if (!inServerMode()) { toast(t('Corrections need the server.')); return; }
  const done = creditedQtyByLine(inv);
  const lines = (inv.items || []).map((it, i) => ({ it, i, left: num(it.qty) - (done[i] || 0) })).filter(x => x.left > 1e-9);
  if (!lines.length) { toast(t('Nothing left to credit')); return; }
  const fields = [
    ...lines.map(x => ({ key: 'q' + x.i, type: 'number', label: `${t('Quantity to credit')}: ${x.it.description || (store.product(x.it.product_id) || {}).name || t('Item')} (${t('Left to credit')} ${x.left})`, value: 0 })),
    { key: 'restock', type: 'select', label: t('Put credited goods back in stock'), options: [{ value: 'no', label: t('No') }, { value: 'yes', label: t('Yes') }] },
    { key: 'refund_method', type: 'select', label: t('Refund method (only if more than the open balance)'), allowEmpty: '—', options: PAYMENT_METHODS.map(m => ({ value: m, label: m })) },
    { key: 'reason', label: t('Reason (required)'), required: true, full: true },
  ];
  openModal(`${t('Credit note')} — ${inv.number}`, fields, out => {
    const items = lines.map(x => ({ line: x.i, qty: num(out['q' + x.i]), restock: out.restock === 'yes' })).filter(x => x.qty > 0);
    if (!items.length) { toast(t('Nothing to return')); return; }
    txCall('credit-note-create', { invoice_id: inv.id, items, reason: out.reason, refund_method: out.refund_method || undefined,
      client_ref: 'cn-' + inv.id + '-' + Date.now() }, t('Credit note posted'));
    closeModal();
  });
}

function openPurchaseReturn(po) {
  if (!inServerMode()) { toast(t('Corrections need the server.')); return; }
  const done = returnedQtyByLine(po);
  const lines = (po.items || []).map((it, i) => ({ it, i, left: num(it.qty) - (done[i] || 0) })).filter(x => x.left > 1e-9);
  if (!lines.length) { toast(t('Nothing left to return')); return; }
  const fields = [
    ...lines.map(x => ({ key: 'q' + x.i, type: 'number', label: `${t('Quantity to return')}: ${x.it.description || (store.product(x.it.product_id) || {}).name || t('Item')} (${t('Left to return')} ${x.left})`, value: 0 })),
    { key: 'refund_method', type: 'select', label: t('Refund method (only if the supplier already got paid)'), allowEmpty: '—', options: PAYMENT_METHODS.map(m => ({ value: m, label: m })) },
    { key: 'reason', label: t('Reason (required)'), required: true, full: true },
  ];
  openModal(`${t('Return to supplier')} — ${po.number}`, fields, out => {
    const items = lines.map(x => ({ line: x.i, qty: num(out['q' + x.i]) })).filter(x => x.qty > 0);
    if (!items.length) { toast(t('Nothing to return')); return; }
    txCall('purchase-return-create', { purchase_id: po.id, items, reason: out.reason, refund_method: out.refund_method || undefined,
      client_ref: 'pr-' + po.id + '-' + Date.now() }, t('Purchase return posted'));
    closeModal();
  });
}

/* list of posted corrections, appended under the invoices / purchases table */
function renderCorrections(kind) {
  const host = $('#view-' + (kind === 'invoices' ? 'invoices' : 'purchases'));
  if (!host) return;
  const isInv = kind === 'invoices';
  const rows = ((isInv ? store.data.credit_notes : store.data.purchase_returns) || []).slice().sort((a, b) => b.id - a.id);
  const body = rows.map(r => `<tr>
    <td><div class="cell-main">${esc(r.number)}</div><div class="cell-sub">${esc(r.date)}</div></td>
    <td>${esc(isInv ? r.invoice_number : r.purchase_number)}</td>
    <td>${money(r.total)}</td>
    <td><div class="cell-sub">${t('Applied to balance')} ${money(isInv ? r.applied_to_receivable : r.applied_to_payable)}</div>${r.refunded > 0 ? `<div class="cell-sub">${t('Refunded')} ${money(r.refunded)} (${esc(r.refund_method)})</div>` : ''}</td>
    <td>${esc(r.reason)}</td></tr>`).join('');
  const div = document.createElement('div');
  div.className = 'card';
  div.style.marginTop = '14px';
  div.innerHTML = `<div class="lines-head" style="margin-bottom:8px"><h3>${t(isInv ? 'Credit notes' : 'Purchase returns')}</h3></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>#</th><th>${t(isInv ? 'Invoice' : 'PO')}</th><th>${t('Total')}</th><th>${t('Settlement')}</th><th>${t('Reason')}</th></tr></thead>
    <tbody>${body || `<tr><td colspan="5" class="empty-state">${t(isInv ? 'No credit notes yet.' : 'No purchase returns yet.')}</td></tr>`}</tbody></table></div>`;
  host.appendChild(div);
}
