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
  'Money already paid back to the customer? (needed only if they already paid)':'هل رُدّ المبلغ فعلياً للعميل؟ (مطلوب فقط إذا كان قد دفع)','Money already received back from the supplier? (needed only if we already paid)':'هل استُرد المبلغ فعلياً من المورد؟ (مطلوب فقط إذا كنا قد دفعنا)','No, nothing moved':'لا، لم تتحرك أموال','Yes, it was paid back':'نعم، تم الرد','Yes, it was received':'نعم، تم الاستلام','Refund method':'طريقة الرد','Refund reference (transfer / receipt no.)':'مرجع الرد (رقم التحويل / الإيصال)',
  'Credit note posted':'تم ترحيل الإشعار الدائن','Purchase return posted':'تم ترحيل مرتجع المشتريات',
  'Corrections need the server.':'التصحيحات تحتاج الخادم.','Void':'إلغاء','Keep it as a customer credit (no money moves)':'احتفظ بها كرصيد دائن للعميل (بدون حركة نقدية)','Keep it as a credit with the supplier (no money moves)':'احتفظ بها كرصيد لدى المورد (بدون حركة نقدية)','Supplier credits':'أرصدة الموردين لدينا','Supplier':'المورد','No open purchases for this supplier.':'لا توجد مشتريات مفتوحة لهذا المورد.','Purchase to apply to':'أمر الشراء المراد خصمه','Kept as credit':'محتفظ به كرصيد','Customer credits':'أرصدة العملاء الدائنة','Remaining':'المتبقي','Use credit':'استخدام الرصيد','Invoice to apply to':'الفاتورة المراد خصمها','Amount to apply':'المبلغ','Credit applied':'تم استخدام الرصيد','Open':'مفتوح','Used':'مستخدم','No customer credits.':'لا توجد أرصدة دائنة.','Void last receipt':'إلغاء آخر استلام','Voided':'ملغى','Status':'الحالة','Reason for voiding (at least 5 characters)':'سبب الإلغاء (5 أحرف على الأقل)','A void reason of at least 5 characters is required':'سبب الإلغاء مطلوب (5 أحرف على الأقل)','Void this document? The original stays on the record and its posting is reversed.':'إلغاء هذا المستند؟ يبقى الأصل في السجل ويُعكس قيده المحاسبي.','Document voided':'تم إلغاء المستند','Receive goods':'استلام بضاعة','Partly received (value)':'مستلم جزئياً (بالقيمة)','Quantity received now':'الكمية المستلمة الآن','Left to receive':'المتبقي للاستلام','Goods received':'تم الاستلام','Nothing left to receive':'لا شيء متبقٍ للاستلام','Enter a quantity to receive':'أدخل كمية للاستلام','Browser-only mode: data stays in this browser and nothing is enforced or protected here (no real accounts, permissions, locked accounting or corrections). For the protected mode run server.js.':'وضع المتصفح فقط: البيانات تبقى في هذا المتصفح ولا يوجد هنا أي إلزام أو حماية (لا حسابات حقيقية ولا صلاحيات ولا محاسبة مقفلة ولا تصحيحات). للوضع المحمي شغّل server.js.','Nothing left to credit':'لا شيء متبقٍ للإشعار','Nothing left to return':'لا شيء متبقٍ للإرجاع',
  'credited':'مُشعَر دائناً','No credit notes yet.':'لا توجد إشعارات دائنة بعد.','No purchase returns yet.':'لا توجد مرتجعات مشتريات بعد.',
  'Credit':'إشعار','Return to supplier':'إرجاع للمورد','Refunded':'مردود','Applied to balance':'مخصوم من الرصيد','Left to credit':'المتبقي للإشعار','Left to return':'المتبقي للإرجاع',
  'Posts a numbered credit note with its own reversing entries. The invoice is not edited.':'يُرحَّل إشعار دائن مرقم بقيوده العكسية. لا تُعدَّل الفاتورة.',
  'Posts a numbered return with its own entries and stock move. The purchase is not edited.':'يُرحَّل مرتجع مرقم بقيوده وحركة مخزون. لا يُعدَّل أمر الشراء.',
});

/* A refund is money that actually moved, not a method choice. These fields
   only matter when the credit is MORE than what is still owed; otherwise the
   server needs none of them. Without a confirmed refund the server blocks. */
function refundFields(side) {
  const c = side === 'customer';
  return [
    { key: 'refund_confirmed', type: 'select', label: t(c ? 'Money already paid back to the customer? (needed only if they already paid)' : 'Money already received back from the supplier? (needed only if we already paid)'), options: [{ value: 'no', label: t('No, nothing moved') }, { value: 'yes', label: t(c ? 'Yes, it was paid back' : 'Yes, it was received') }].concat([{ value: 'credit', label: t(c ? 'Keep it as a customer credit (no money moves)' : 'Keep it as a credit with the supplier (no money moves)') }]) },
    { key: 'refund_method', type: 'select', label: t('Refund method'), allowEmpty: '—', options: PAYMENT_METHODS.map(m => ({ value: m, label: m })) },
    { key: 'refund_reference', label: t('Refund reference (transfer / receipt no.)'), value: '' },
  ];
}
function refundPayload(out) {
  if (out.refund_confirmed === 'credit') return { store_credit: true };
  return out.refund_confirmed === 'yes' ? { refund_confirmed: true, refund_method: out.refund_method || undefined, refund_reference: out.refund_reference || '' } : {};
}

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
    ...refundFields('customer'),
    { key: 'reason', label: t('Reason (required)'), required: true, full: true },
  ];
  openModal(`${t('Credit note')} — ${inv.number}`, fields, out => {
    const items = lines.map(x => ({ line: x.i, qty: num(out['q' + x.i]), restock: out.restock === 'yes' })).filter(x => x.qty > 0);
    if (!items.length) { toast(t('Nothing to return')); return; }
    txCall('credit-note-create', { invoice_id: inv.id, items, reason: out.reason, ...refundPayload(out),
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
    ...refundFields('supplier'),
    { key: 'reason', label: t('Reason (required)'), required: true, full: true },
  ];
  openModal(`${t('Return to supplier')} — ${po.number}`, fields, out => {
    const items = lines.map(x => ({ line: x.i, qty: num(out['q' + x.i]) })).filter(x => x.qty > 0);
    if (!items.length) { toast(t('Nothing to return')); return; }
    txCall('purchase-return-create', { purchase_id: po.id, items, reason: out.reason, ...refundPayload(out),
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
    <td><div class="cell-sub">${t('Applied to balance')} ${money(isInv ? r.applied_to_receivable : r.applied_to_payable)}</div>${r.refunded > 0 ? `<div class="cell-sub">${t('Refunded')} ${money(r.refunded)} (${esc(r.refund_method)})</div>` : ''}${r.store_credit > 0 ? `<div class="cell-sub">${t('Kept as credit')} ${money(r.store_credit)}</div>` : ''}</td>
    <td>${esc(r.reason)}</td>
    <td>${r.status === 'void' ? `<span class="badge lost">${t('Voided')}</span><div class="cell-sub">${esc(r.void_reason || '')}</div>` : ((typeof Auth !== 'undefined' && Auth.current && Auth.current.role === 'admin' && inServerMode()) ? `<button class="mini-btn danger" data-void="${r.id}">${t('Void')}</button>` : '')}</td></tr>`).join('');
  const div = document.createElement('div');
  div.className = 'card';
  div.style.marginTop = '14px';
  div.innerHTML = `<div class="lines-head" style="margin-bottom:8px"><h3>${t(isInv ? 'Credit notes' : 'Purchase returns')}</h3></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>#</th><th>${t(isInv ? 'Invoice' : 'PO')}</th><th>${t('Total')}</th><th>${t('Settlement')}</th><th>${t('Reason')}</th><th>${t('Status')}</th></tr></thead>
    <tbody>${body || `<tr><td colspan="6" class="empty-state">${t(isInv ? 'No credit notes yet.' : 'No purchase returns yet.')}</td></tr>`}</tbody></table></div>`;
  host.appendChild(div);
  if (!isInv) {
    const scs = (store.data.supplier_credits || []).slice().sort((a, b) => b.id - a.id);
    if (scs.length) {
      const sd = document.createElement('div');
      sd.className = 'card'; sd.style.marginTop = '14px';
      const sup = id => (store.data.suppliers || []).find(x => x.id === id);
      sd.innerHTML = `<div class="lines-head" style="margin-bottom:8px"><h3>${t('Supplier credits')}</h3></div>
        <div class="table-wrap"><table class="data"><thead><tr><th>#</th><th>${t('Supplier')}</th><th>${t('Total')}</th><th>${t('Remaining')}</th><th>${t('Status')}</th><th></th></tr></thead><tbody>${scs.map(x => {
          const sp = sup(x.supplier_id);
          return `<tr><td><div class="cell-main">${esc(x.number)}</div><div class="cell-sub">${esc(x.date)}</div></td><td>${esc(sp ? sp.name : '')}</td><td>${money(x.amount)}</td><td>${money(x.remaining)}</td><td>${esc(t(x.status === 'open' ? 'Open' : x.status === 'used' ? 'Used' : 'Voided'))}</td><td>${x.status === 'open' && inServerMode() && Auth.current && Auth.current.role === 'admin' ? `<button class="mini-btn primary" data-usesc="${x.id}">${t('Use credit')}</button>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div>`;
      host.appendChild(sd);
      sd.querySelectorAll('[data-usesc]').forEach(b => b.addEventListener('click', () => {
        const sc = scs.find(x => x.id === Number(b.dataset.usesc));
        const opts = (store.data.purchases || []).filter(p => p.supplier_id === sc.supplier_id && p.status === 'received' && purchaseOpenAmount(p) > 0.005);
        if (!opts.length) { toast(t('No open purchases for this supplier.')); return; }
        openModal(`${t('Use credit')} — ${sc.number}`, [
          { key: 'purchase', type: 'select', label: t('Purchase to apply to'), options: opts.map(p => ({ value: p.id, label: `${p.number} (${money(purchaseOpenAmount(p))})` })) },
          { key: 'amount', type: 'number', label: `${t('Amount to apply')} (${t('Remaining')} ${money(sc.remaining)})`, value: sc.remaining, required: true },
        ], out => {
          txCall('supplier-credit-apply', { credit_id: sc.id, purchase_id: Number(out.purchase), amount: num(out.amount) }, t('Credit applied'));
          closeModal();
        });
      }));
    }
  }
  if (isInv) {
    const ccs = (store.data.customer_credits || []).slice().sort((a, b) => b.id - a.id);
    if (ccs.length) {
      const cd = document.createElement('div');
      cd.className = 'card'; cd.style.marginTop = '14px';
      cd.innerHTML = `<div class="lines-head" style="margin-bottom:8px"><h3>${t('Customer credits')}</h3></div>
        <div class="table-wrap"><table class="data"><thead><tr><th>#</th><th>${t('Customer')}</th><th>${t('Total')}</th><th>${t('Remaining')}</th><th>${t('Status')}</th><th></th></tr></thead><tbody>${ccs.map(x => {
          const ct = store.contact(x.contact_id);
          return `<tr><td><div class="cell-main">${esc(x.number)}</div><div class="cell-sub">${esc(x.date)}</div></td><td>${esc(ct ? contactName(ct) : '')}</td><td>${money(x.amount)}</td><td>${money(x.remaining)}</td><td>${esc(t(x.status === 'open' ? 'Open' : x.status === 'used' ? 'Used' : 'Voided'))}</td><td>${x.status === 'open' && inServerMode() && Auth.current && Auth.current.role === 'admin' ? `<button class="mini-btn primary" data-usecc="${x.id}">${t('Use credit')}</button>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div>`;
      host.appendChild(cd);
      cd.querySelectorAll('[data-usecc]').forEach(b => b.addEventListener('click', () => {
        const cc = ccs.find(x => x.id === Number(b.dataset.usecc));
        const opts = (store.data.invoices || []).filter(i => i.contact_id === cc.contact_id && ['sent', 'paid'].includes(i.status) && invoiceOpenAmount(i) > 0.005);
        if (!opts.length) { toast(t('No open invoices.')); return; }
        openModal(`${t('Use credit')} — ${cc.number}`, [
          { key: 'invoice', type: 'select', label: t('Invoice to apply to'), options: opts.map(i => ({ value: i.id, label: `${i.number} (${money(invoiceOpenAmount(i))})` })) },
          { key: 'amount', type: 'number', label: `${t('Amount to apply')} (${t('Remaining')} ${money(cc.remaining)})`, value: cc.remaining, required: true },
        ], out => {
          txCall('credit-apply', { credit_id: cc.id, invoice_id: Number(out.invoice), amount: num(out.amount) }, t('Credit applied'));
          closeModal();
        });
      }));
    }
  }
  div.querySelectorAll('[data-void]').forEach(b => b.addEventListener('click', () => {
    const reason = window.prompt(t('Reason for voiding (at least 5 characters)'));
    if (!reason || reason.trim().length < 5) { toast(t('A void reason of at least 5 characters is required')); return; }
    if (!window.confirm(t('Void this document? The original stays on the record and its posting is reversed.'))) return;
    txCall(isInv ? 'credit-note-void' : 'purchase-return-void', { id: Number(b.dataset.void), reason: reason.trim() }, t('Document voided'));
  }));
}


/* Partial receipt: receive part (or the rest) of an ordered purchase. Server mode only. */
function openReceive(po) {
  if (!inServerMode()) { toast(t('Corrections need the server.')); return; }
  const lines = (po.items || []).map((it, i) => ({ it, i, left: num(it.qty) - num(it.received_qty) })).filter(x => x.left > 1e-9);
  if (!lines.length) { toast(t('Nothing left to receive')); return; }
  const fields = lines.map(x => ({ key: 'q' + x.i, type: 'number', label: `${t('Quantity received now')}: ${x.it.description || (store.product(x.it.product_id) || {}).name || t('Item')} (${t('Left to receive')} ${x.left})`, value: x.left }));
  openModal(`${t('Receive goods')} — ${po.number}`, fields, out => {
    const items = lines.map(x => ({ line: x.i, qty: num(out['q' + x.i]) })).filter(x => x.qty > 0);
    if (!items.length) { toast(t('Enter a quantity to receive')); return; }
    txCall('purchase-receive', { id: po.id, items, client_ref: 'rc-' + po.id + '-' + Date.now() }, t('Goods received'));
    closeModal();
  });
}
