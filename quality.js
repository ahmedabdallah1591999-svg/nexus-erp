'use strict';
/* quality.js — quality inspections with nonconformance closure, plus a
   document REGISTER. Honest scope: the register stores metadata only (title,
   type, version, status, where the file lives, history). It does not host
   files, does not sign, and is not document-management parity.
   Server-owned: numbers, inspector, results and approvals come from the
   session; a failed inspection cannot be closed without a corrective action;
   a document owner cannot approve their own document. Requires the local
   server (authoritative mode). */

let qualityTab = 'checks';
let selectedDocId = null;

const QC_TYPES = ['incoming', 'in-process', 'final'];
const DOC_TYPES = ['policy', 'procedure', 'work-instruction', 'contract', 'form', 'other'];

function editQC(row) {
  openModal(row ? t('Edit inspection') : t('New inspection'), [
    { key: 'title', label: t('Title'), required: true, value: row?.title, full: true },
    { key: 'type', label: t('Type'), type: 'select', options: QC_TYPES.map(v => ({ value: v, label: t(v) })), value: row?.type || 'incoming' },
    { key: 'product_id', label: t('Product'), type: 'select',
      options: [{ value: '', label: t('— none —') }, ...store.data.products.map(p => ({ value: p.id, label: p.name }))], value: row?.product_id || '' },
    { key: 'reference', label: t('Reference (PO, lot, order)'), value: row?.reference || '' },
    { key: 'qty_inspected', label: t('Quantity inspected'), type: 'number', required: true, value: row?.qty_inspected ?? '' },
    { key: 'notes', label: t('Notes'), value: row?.notes || '', full: true },
  ], out => {
    out.product_id = out.product_id ? Number(out.product_id) : null;
    out.qty_inspected = Number(out.qty_inspected);
    txCall('qc-save', { id: row && row.id, out }, t('Inspection saved'));
  });
}

function recordQCResult(q, result) {
  if (result === 'pass') { txCall('qc-result', { id: q.id, result }, t('Inspection passed')); return; }
  openModal(t('Record failure'), [
    { key: 'qty_failed', label: t('Quantity failed'), type: 'number', required: true, value: '' },
  ], out => txCall('qc-result', { id: q.id, result: 'fail', qty_failed: Number(out.qty_failed) }, t('Failure recorded')));
}

function closeQC(q) {
  openModal(t('Close nonconformance'), [
    { key: 'corrective_action', label: t('Corrective action taken'), required: true, value: '', full: true },
  ], out => txCall('qc-close', { id: q.id, corrective_action: out.corrective_action }, t('Nonconformance closed')));
}

function editDoc(row) {
  openModal(row ? t('Edit document') : t('New document'), [
    { key: 'title', label: t('Title'), required: true, value: row?.title, full: true },
    { key: 'doc_type', label: t('Type'), type: 'select', options: DOC_TYPES.map(v => ({ value: v, label: t(v) })), value: row?.doc_type || 'procedure' },
    { key: 'location', label: t('Where the file is kept (path or link)'), value: row?.location || '', full: true },
    { key: 'summary', label: t('Summary'), value: row?.summary || '', full: true },
  ], out => txCall('doc-save', { id: row && row.id, out }, t('Document saved')));
}

function renderQuality() {
  const el = $('#view-quality');
  if (!inServerMode()) {
    el.innerHTML = `<div class="view-head"><div><h2>${t('Quality & documents')}</h2></div></div>
      <div class="empty-state">${t('This module needs the local server (it keeps results and approvals tamper-proof). Start server.js and sign in.')}</div>`;
    return;
  }
  const checks = (store.data.quality_checks || []).slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const docs = (store.data.documents || []).slice().sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  const prod = id => { const p = store.data.products.find(x => x.id === id); return p ? p.name : '—'; };
  const badge = (txt, cls) => `<span class="badge ${cls}">${esc(t(txt))}</span>`;
  const resBadge = q => q.result === 'pass' ? badge('pass', 'won') : q.result === 'fail' ? badge(q.status === 'open' ? 'nonconforming' : 'closed', 'lost') : badge('pending', 'lead');
  const docBadge = s => badge(s, s === 'approved' ? 'won' : s === 'review' ? 'lead' : s === 'obsolete' ? 'lost' : 'inactive');

  const open = checks.filter(q => q.status === 'open').length;
  const ncr = checks.filter(q => q.result === 'fail' && q.status === 'open').length;
  const tabs = `<div class="chip-row" style="margin-bottom:8px">
    <button class="chip ${qualityTab === 'checks' ? 'chip-active' : ''}" data-qtab="checks">${t('Inspections')} (${checks.length})</button>
    <button class="chip ${qualityTab === 'docs' ? 'chip-active' : ''}" data-qtab="docs">${t('Document register')} (${docs.length})</button></div>`;

  let body = '';
  if (qualityTab === 'checks') {
    const rows = checks.map(q => `<tr>
      <td><strong>${esc(q.number)}</strong></td><td>${esc(q.title)}${q.corrective_action ? `<div class="cell-sub">${esc(q.corrective_action)}</div>` : ''}</td>
      <td>${esc(t(q.type))}</td><td>${esc(prod(q.product_id))}</td><td>${q.qty_inspected} / ${q.qty_failed}</td>
      <td>${resBadge(q)}</td><td>${esc(q.inspected_by || q.created_by || '—')}</td>
      <td class="row-actions">
        ${q.status === 'open' && q.result === 'pending' ? `<button class="secondary-btn" data-qa="pass" data-id="${q.id}">${t('Pass')}</button> <button class="secondary-btn" data-qa="fail" data-id="${q.id}">${t('Fail')}</button> <button class="icon-btn" data-qa="edit" data-id="${q.id}">✏️</button>` : ''}
        ${q.status === 'open' && q.result === 'fail' ? `<button class="secondary-btn" data-qa="close" data-id="${q.id}">${t('Close with corrective action')}</button>` : ''}
        <button class="danger-btn" data-qa="del" data-id="${q.id}" title="${t('Delete')}">🗑</button></td></tr>`).join('');
    body = `<div class="sub" style="margin-bottom:6px">${open} ${t('open')} · ${ncr} ${t('open nonconformances')}</div>
      <div class="table-wrap"><table class="data"><thead><tr><th>#</th><th>${t('Title')}</th><th>${t('Type')}</th><th>${t('Product')}</th><th>${t('Inspected / failed')}</th><th>${t('Result')}</th><th>${t('Inspector')}</th><th></th></tr></thead>
      <tbody id="qBody">${rows || `<tr><td colspan="8" class="empty-state">${t('No inspections yet.')}</td></tr>`}</tbody></table></div>`;
  } else {
    const rows = docs.map(d => `<tr>
      <td><strong>${esc(d.number)}</strong></td><td>${esc(d.title)}${d.summary ? `<div class="cell-sub">${esc(d.summary.slice(0, 80))}</div>` : ''}</td>
      <td>${esc(t(d.doc_type))}</td><td>v${d.version}</td><td>${docBadge(d.status)}</td><td>${esc(d.owner)}</td>
      <td class="row-actions">
        ${d.status === 'draft' ? `<button class="secondary-btn" data-da="review" data-id="${d.id}">${t('Send for review')}</button> <button class="icon-btn" data-da="edit" data-id="${d.id}">✏️</button>` : ''}
        ${d.status === 'review' ? `<button class="secondary-btn" data-da="approved" data-id="${d.id}">${t('Approve')}</button> <button class="secondary-btn" data-da="draft" data-id="${d.id}">${t('Return to draft')}</button>` : ''}
        ${d.status === 'approved' ? `<button class="secondary-btn" data-da="revise" data-id="${d.id}">${t('Revise')}</button> <button class="secondary-btn" data-da="obsolete" data-id="${d.id}">${t('Mark obsolete')}</button>` : ''}
        <button class="icon-btn" data-da="history" data-id="${d.id}" title="${t('History')}">🕘</button>
        <button class="danger-btn" data-da="del" data-id="${d.id}" title="${t('Delete')}">🗑</button></td></tr>`).join('');
    const sel = docs.find(d => d.id === selectedDocId);
    const hist = sel ? `<h3 style="margin:14px 0 6px">${esc(sel.number)} — ${t('History')}</h3>` + sel.history.slice().reverse().map(h =>
      `<div class="note-item"><div class="note-head"><strong>${esc(h.by)}</strong> · v${h.version} · ${esc(h.at.replace('T', ' ').slice(0, 16))}</div><div>${esc(h.note)}</div></div>`).join('')
      + (sel.location ? `<div class="sub">${t('Kept at')}: ${esc(sel.location)}</div>` : '') : '';
    body = `<div class="sub" style="margin-bottom:6px">${t('Metadata register only: it records versions, status and where the file lives. It does not store or sign files.')}</div>
      <div class="table-wrap"><table class="data"><thead><tr><th>#</th><th>${t('Title')}</th><th>${t('Type')}</th><th>${t('Version')}</th><th>${t('Status')}</th><th>${t('Owner')}</th><th></th></tr></thead>
      <tbody id="dBody">${rows || `<tr><td colspan="7" class="empty-state">${t('No documents yet.')}</td></tr>`}</tbody></table></div>${hist}`;
  }

  el.innerHTML = `<div class="view-head">
      <div><h2>${t('Quality & documents')}</h2><div class="sub">${t('Inspections with nonconformance closure, and a document register (metadata only).')}</div></div>
      <div class="head-actions"><button class="secondary-btn" id="addQ">+ ${qualityTab === 'checks' ? t('New inspection') : t('New document')}</button></div>
    </div>${tabs}${body}`;

  $('#addQ').onclick = () => (qualityTab === 'checks' ? editQC(null) : editDoc(null));
  el.querySelectorAll('[data-qtab]').forEach(b => b.onclick = () => { qualityTab = b.dataset.qtab; renderQuality(); });
  const qb = $('#qBody');
  if (qb) qb.addEventListener('click', e => {
    const b = e.target.closest('button[data-qa]'); if (!b) return;
    const q = checks.find(x => x.id === Number(b.dataset.id)); const a = b.dataset.qa;
    if (a === 'edit') editQC(q);
    else if (a === 'pass' || a === 'fail') recordQCResult(q, a);
    else if (a === 'close') closeQC(q);
    else confirmDelete(q.number, () => txCall('qc-delete', { id: q.id }, t('Inspection deleted')));
  });
  const db = $('#dBody');
  if (db) db.addEventListener('click', e => {
    const b = e.target.closest('button[data-da]'); if (!b) return;
    const d = docs.find(x => x.id === Number(b.dataset.id)); const a = b.dataset.da;
    if (a === 'edit') editDoc(d);
    else if (a === 'history') { selectedDocId = d.id; renderQuality(); }
    else if (a === 'revise') openModal(t('Revise document'), [{ key: 'note', label: t('What changed'), required: true, value: '', full: true }],
      out => txCall('doc-revise', { id: d.id, note: out.note }, t('New version drafted')));
    else if (a === 'del') confirmDelete(d.number, () => txCall('doc-delete', { id: d.id }, t('Document deleted')));
    else txCall('doc-status', { id: d.id, status: a }, t('Status updated'));
  });
}

App.views.quality = renderQuality;
