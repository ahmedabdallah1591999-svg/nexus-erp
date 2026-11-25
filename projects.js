'use strict';
/* projects.js — projects + timesheets with billable-time invoicing.
   Server-owned: the session user logs time (identity never from the
   payload); billed time is locked; billing creates a DRAFT invoice —
   sending it (posting) stays an explicit separate operation. */

let selectedProjectId = null;

const projectFields = row => [
  { key: 'name', label: t('Project name'), required: true, value: row?.name },
  {
    key: 'contact_id', label: t('Customer (CRM contact)'), type: 'select',
    options: [{ value: '', label: t('— none —') }, ...store.data.contacts.map(c => ({ value: c.id, label: contactName(c) }))],
    value: row?.contact_id || '',
  },
  {
    key: 'status', label: t('Status'), type: 'select',
    options: ['active', 'on-hold', 'done'].map(v => ({ value: v, label: t(v) })),
    value: row?.status || 'active',
  },
  { key: 'start_date', label: t('Start date'), type: 'date', value: row?.start_date || todayStr() },
  { key: 'due_date', label: t('Due date'), type: 'date', value: row?.due_date || '' },
  { key: 'budget_hours', label: t('Budget hours'), type: 'number', value: row?.budget_hours ?? 0 },
  { key: 'hourly_rate', label: t('Hourly rate (USD)'), type: 'number', value: row?.hourly_rate ?? 0 },
  { key: 'description', label: t('Description'), value: row?.description || '', full: true },
];

function editProject(row) {
  openModal(row ? t('Edit project') : t('New project'), projectFields(row), out => {
    out.contact_id = out.contact_id ? Number(out.contact_id) : null;
    if (inServerMode()) { txCall('project-save', { id: row && row.id, out }, t('Project saved')); return; }
    if (row) Object.assign(row, out);
    else store.add('projects', { ...out, status: out.status || 'active', created_by: (Auth.current && Auth.current.username) || 'local' });
    store.save(); render(); toast(t('Project saved'));
  });
}

const timeFields = (pr, row) => [
  { key: 'date', label: t('Date'), type: 'date', value: row?.date || todayStr(), required: true },
  { key: 'hours', label: t('Hours'), type: 'number', required: true, value: row?.hours ?? 1 },
  {
    key: 'billable', label: t('Billable'), type: 'select',
    options: [{ value: '1', label: t('Yes') }, { value: '0', label: t('No') }],
    value: row ? (row.billable ? '1' : '0') : '1',
  },
  { key: 'description', label: t('Description'), value: row?.description || '', full: true },
];

function editTime(pr, row) {
  openModal(row ? t('Edit time entry') : t('Log time'), timeFields(pr, row), out => {
    const payload = { project_id: pr.id, date: out.date, hours: num(out.hours), description: out.description || '', billable: out.billable === '1' || out.billable === true };
    if (inServerMode()) { txCall('timesheet-save', { id: row && row.id, out: payload }, t('Time logged')); return; }
    if (row) Object.assign(row, payload);
    else store.add('timesheets', { ...payload, employee: (Auth.current && Auth.current.username) || 'local', billed_invoice_id: null });
    store.save(); render(); toast(t('Time logged'));
  });
}

function billProject(pr) {
  const unbilled = (store.data.timesheets || []).filter(x => x.project_id === pr.id && x.billable && !x.billed_invoice_id);
  const hours = unbilled.reduce((s, x) => s + num(x.hours), 0);
  const amount = Math.round(hours * num(pr.hourly_rate) * 100) / 100;
  if (!window.confirm(`${t('Invoice unbilled time?')}\n${hours} ${t('hours')} × ${money(pr.hourly_rate)} = ${money(amount)}\n${t('A draft invoice is created — sending it stays a separate step.')}`)) return;
  if (inServerMode()) { txCall('timesheet-invoice', { project_id: pr.id }, t('Draft invoice created')); return; }
  const inv = saveInvoice(null, {
    status: 'draft', contact_id: pr.contact_id, deal_id: null,
    issue_date: todayStr(), due_date: todayStr(), tax_rate: 0,
    notes: `${t('Project')} ${pr.name}`,
    items: unbilled.map(x => ({ product_id: null, description: `${x.date} — ${x.description || t('Time')} (${x.hours}h × ${num(pr.hourly_rate)})`, qty: num(x.hours), price: num(pr.hourly_rate) })),
  });
  for (const x of unbilled) x.billed_invoice_id = inv.id;
  store.save(); render(); toast(t('Draft invoice created'));
}

function renderProjects() {
  const projects = (store.data.projects || []).slice().sort((a, b) => a.id - b.id);
  const ts = store.data.timesheets || [];
  const me = (typeof Auth !== 'undefined' && Auth.current) || null;
  const pr = projects.find(x => x.id === selectedProjectId) || null;
  if (selectedProjectId && !pr) selectedProjectId = null;

  const rows = projects.map(p => {
    const mine = ts.filter(x => x.project_id === p.id);
    const hours = mine.reduce((s, x) => s + num(x.hours), 0);
    const unbilled = mine.filter(x => x.billable && !x.billed_invoice_id).reduce((s, x) => s + num(x.hours), 0);
    const cust = p.contact_id ? contactName(store.data.contacts.find(c => c.id === p.contact_id) || {}) : '—';
    return `
    <tr class="${selectedProjectId === p.id ? 'row-selected' : ''}" data-prid="${p.id}" style="cursor:pointer">
      <td><strong>${esc(p.name)}</strong>${p.description ? `<div class="cell-sub">${esc(p.description)}</div>` : ''}</td>
      <td>${esc(cust)}</td>
      <td><span class="badge ${p.status === 'active' ? 'won' : p.status === 'done' ? 'lead' : 'inactive'}">${t(p.status)}</span></td>
      <td>${esc(p.due_date || '—')}</td>
      <td>${hours}${p.budget_hours ? ` / ${p.budget_hours}` : ''}</td>
      <td>${unbilled ? money(unbilled * num(p.hourly_rate)) : '—'}</td>
      <td class="row-actions">
        <button class="icon-btn" data-pact="edit" data-id="${p.id}" title="${t('Edit')}">✏️</button>
        <button class="danger-btn" data-pact="del" data-id="${p.id}" title="${t('Delete')}">🗑</button>
      </td>
    </tr>`;
  }).join('');

  let detail = '';
  if (pr) {
    const entries = ts.filter(x => x.project_id === pr.id).sort((a, b) => (a.date < b.date ? 1 : -1));
    const unbilledCount = entries.filter(x => x.billable && !x.billed_invoice_id).length;
    const canBill = unbilledCount > 0 && pr.contact_id && num(pr.hourly_rate) > 0 && me && (me.role === 'admin' || (me.modules || []).includes('invoices'));
    const tRows = entries.map(x => {
      const inv = x.billed_invoice_id ? (store.data.invoices || []).find(i => i.id === x.billed_invoice_id) : null;
      return `
      <tr>
        <td>${esc(x.date || '—')}</td>
        <td>${esc(x.employee || '')}</td>
        <td>${x.hours}</td>
        <td>${x.billable ? t('Yes') : t('No')}</td>
        <td>${esc(x.description || '')}</td>
        <td>${inv ? `<span class="badge lead">${esc(inv.number)} (${t(inv.status)})</span>` : '—'}</td>
        <td class="row-actions">
          ${!x.billed_invoice_id && me && (me.role === 'admin' || x.employee === me.username) ? `<button class="icon-btn" data-tact="edit" data-id="${x.id}" title="${t('Edit')}">✏️</button><button class="danger-btn" data-tact="del" data-id="${x.id}" title="${t('Delete')}">🗑</button>` : ''}
        </td>
      </tr>`;
    }).join('');
    detail = `
    <h3 style="margin:18px 0 8px">${esc(pr.name)} — ${t('Timesheets')}</h3>
    <div class="head-actions" style="margin-bottom:8px">
      <button class="secondary-btn" id="logTime">+ ${t('Log time')}</button>
      ${canBill ? `<button class="primary-btn" id="billTime">${t('Invoice unbilled time')} (${unbilledCount})</button>` : ''}
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>${t('Date')}</th><th>${t('Employee')}</th><th>${t('Hours')}</th><th>${t('Billable')}</th><th>${t('Description')}</th><th>${t('Invoice')}</th><th></th></tr></thead>
      <tbody id="tsBody">${tRows || `<tr><td colspan="7" class="empty-state">${t('No time logged yet.')}</td></tr>`}</tbody>
    </table></div>`;
  }

  $('#view-projects').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Projects')}</h2><div class="sub">${t('Track time per project and bill it as draft invoices.')}</div></div>
      <div class="head-actions"><button class="secondary-btn" id="addProject">+ ${t('New project')}</button></div>
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>${t('Project name')}</th><th>${t('Customer')}</th><th>${t('Status')}</th><th>${t('Due date')}</th><th>${t('Hours')}</th><th>${t('Unbilled')}</th><th></th></tr></thead>
      <tbody id="prBody">${rows || `<tr><td colspan="7" class="empty-state">${t('No projects yet.')}</td></tr>`}</tbody>
    </table></div>
    ${detail}`;

  $('#addProject').onclick = () => editProject(null);
  $('#prBody').addEventListener('click', e => {
    const btn = e.target.closest('button[data-pact]');
    if (btn) {
      e.stopPropagation();
      const p = projects.find(x => x.id === Number(btn.dataset.id));
      if (btn.dataset.pact === 'edit') editProject(p);
      else confirmDelete(t('this project'), () => {
        if (inServerMode()) { txCall('project-delete', { id: p.id }, t('Project deleted')); return; }
        store.remove('projects', p.id); if (selectedProjectId === p.id) selectedProjectId = null;
        store.save(); render(); toast(t('Project deleted'));
      });
      return;
    }
    const tr = e.target.closest('tr[data-prid]');
    if (tr) { selectedProjectId = Number(tr.dataset.prid); render(); }
  });
  if (pr) {
    $('#logTime').onclick = () => editTime(pr, null);
    const billBtn = $('#billTime');
    if (billBtn) billBtn.onclick = () => billProject(pr);
    $('#tsBody').addEventListener('click', e => {
      const btn = e.target.closest('button[data-tact]');
      if (!btn) return;
      const x = (store.data.timesheets || []).find(v => v.id === Number(btn.dataset.id));
      if (btn.dataset.tact === 'edit') editTime(pr, x);
      else confirmDelete(t('this time entry'), () => {
        if (inServerMode()) { txCall('timesheet-delete', { id: x.id }, t('Time entry deleted')); return; }
        store.remove('timesheets', x.id); store.save(); render(); toast(t('Time entry deleted'));
      });
    });
  }
}
App.views.projects = renderProjects;
