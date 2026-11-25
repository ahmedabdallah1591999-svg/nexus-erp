'use strict';
/* hr.js — time-off requests with approval flow + attendance logging, shown
   inside the employees view. Server-owned: requester/recorder identity and
   computed days/hours come from the server; approval is the decision event
   (an employee cannot decide their own request). */

const LEAVE_TYPES = ['annual', 'sick', 'unpaid'];

const isSelfService = () => {
  const me = (typeof Auth !== 'undefined' && Auth.current) || null;
  return !!(me && me.role !== 'admin' && !(me.modules || []).includes('employees'));
};

const leaveFields = row => [
  ...(isSelfService() ? [] : [{
    key: 'employee_id', label: t('Employee'), type: 'select', required: true,
    options: store.data.employees.map(e => ({ value: e.id, label: e.name })),
    value: row?.employee_id || (store.data.employees[0] && store.data.employees[0].id),
  }]),
  {
    key: 'type', label: t('Leave type'), type: 'select',
    options: LEAVE_TYPES.map(v => ({ value: v, label: t(v) })),
    value: row?.type || 'annual',
  },
  { key: 'from_date', label: t('From date'), type: 'date', required: true, value: row?.from_date || todayStr() },
  { key: 'to_date', label: t('To date'), type: 'date', required: true, value: row?.to_date || todayStr() },
  { key: 'reason', label: t('Reason'), value: row?.reason || '', full: true },
];

function editLeave(row) {
  if (!isSelfService() && !store.data.employees.length) { alert(t('No employees yet.')); return; }
  openModal(row ? t('Edit leave request') : t('Request time off'), leaveFields(row), out => {
    if (isSelfService()) delete out.employee_id; else out.employee_id = Number(out.employee_id);
    if (inServerMode()) { txCall('leave-save', { id: row && row.id, out }, t('Leave request saved')); return; }
    const days = Math.round((new Date(out.to_date) - new Date(out.from_date)) / 86400000) + 1;
    if (row) Object.assign(row, out, { days });
    else store.add('leave_requests', { ...out, days, status: 'submitted', requested_by: (Auth.current && Auth.current.username) || 'local', decided_by: null, decided_at: null, decision_note: '', created_at: new Date().toISOString() });
    store.save(); render(); toast(t('Leave request saved'));
  });
}

const attendanceFields = row => [
  ...(isSelfService() ? [] : [{
    key: 'employee_id', label: t('Employee'), type: 'select', required: true,
    options: store.data.employees.map(e => ({ value: e.id, label: e.name })),
    value: row?.employee_id || (store.data.employees[0] && store.data.employees[0].id),
  }]),
  { key: 'date', label: t('Date'), type: 'date', required: true, value: row?.date || todayStr() },
  { key: 'check_in', label: t('Check-in (HH:MM)'), value: row?.check_in || '' },
  { key: 'check_out', label: t('Check-out (HH:MM)'), value: row?.check_out || '' },
  { key: 'note', label: t('Note'), value: row?.note || '', full: true },
];

function editAttendance(row) {
  if (!isSelfService() && !store.data.employees.length) { alert(t('No employees yet.')); return; }
  openModal(row ? t('Correct attendance') : t('Record attendance'), attendanceFields(row), out => {
    if (isSelfService()) delete out.employee_id; else out.employee_id = Number(out.employee_id);
    if (inServerMode()) { txCall('attendance-save', { out }, t('Attendance saved')); return; }
    const HHMM = v => /^([01]?\d|2[0-3]):[0-5]\d$/.test(v || '');
    let hours = 0;
    if (HHMM(out.check_in) && HHMM(out.check_out)) {
      const [h1, m1] = out.check_in.split(':').map(Number);
      const [h2, m2] = out.check_out.split(':').map(Number);
      let mins = (h2 * 60 + m2) - (h1 * 60 + m1);
      if (mins < 0) mins += 24 * 60;
      hours = Math.round(mins / 6) / 10;
    }
    const existing = (store.data.attendance || []).find(a => a.employee_id === out.employee_id && a.date === out.date);
    if (existing) Object.assign(existing, out, { hours });
    else store.add('attendance', { ...out, hours, recorded_by: (Auth.current && Auth.current.username) || 'local' });
    store.save(); render(); toast(t('Attendance saved'));
  });
}

function renderHrSections() {
  const host = document.querySelector('#hrSections');
  if (!host) return;
  const me = (typeof Auth !== 'undefined' && Auth.current) || null;
  const empName = id => { const e = (store.data.employees || []).find(x => x.id === id); if (e) return e.name; return me && me.employee_id === id ? me.username : '—'; };

  const leaves = (store.data.leave_requests || []).slice().sort((a, b) => b.id - a.id);
  const lRows = leaves.map(lr => {
    const canDecide = lr.status === 'submitted' && me && (me.role === 'admin' || lr.requested_by !== me.username);
    const canEdit = lr.status === 'submitted' && me && (me.role === 'admin' || lr.requested_by === me.username);
    return `
    <tr>
      <td><strong>${esc(empName(lr.employee_id))}</strong></td>
      <td>${t(lr.type)}</td>
      <td>${esc(lr.from_date)} → ${esc(lr.to_date)}</td>
      <td>${lr.days}</td>
      <td><span class="badge ${lr.status === 'approved' ? 'won' : lr.status === 'rejected' ? 'lost' : 'lead'}">${t(lr.status)}</span>${lr.decided_by ? `<div class="cell-sub">${t('by')} ${esc(lr.decided_by)}${lr.decision_note ? ` — ${esc(lr.decision_note)}` : ''}</div>` : `<div class="cell-sub">${t('by')} ${esc(lr.requested_by)}</div>`}</td>
      <td class="row-actions">
        ${canDecide ? `<button class="primary-btn" data-lact="approve" data-id="${lr.id}">${t('Approve')}</button> <button class="danger-btn" data-lact="reject" data-id="${lr.id}">${t('Reject')}</button>` : ''}
        ${canEdit ? `<button class="icon-btn" data-lact="edit" data-id="${lr.id}" title="${t('Edit')}">✏️</button><button class="danger-btn" data-lact="del" data-id="${lr.id}" title="${t('Delete')}">🗑</button>` : ''}
      </td>
    </tr>`;
  }).join('');

  const att = (store.data.attendance || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 50);
  const aRows = att.map(a => `
    <tr>
      <td>${esc(a.date)}</td>
      <td><strong>${esc(empName(a.employee_id))}</strong></td>
      <td>${esc(a.check_in || '—')}</td>
      <td>${esc(a.check_out || '—')}</td>
      <td>${a.hours || '—'}</td>
      <td>${esc(a.note || '')}</td>
      <td class="row-actions">
        <button class="icon-btn" data-aact="edit" data-id="${a.id}" title="${t('Edit')}">✏️</button>
        <button class="danger-btn" data-aact="del" data-id="${a.id}" title="${t('Delete')}">🗑</button>
      </td>
    </tr>`).join('');

  host.innerHTML = `
    <h3 style="margin:22px 0 8px">${t('Time off')}</h3>
    <div class="head-actions" style="margin-bottom:8px"><button class="secondary-btn" id="addLeave">+ ${t('Request time off')}</button></div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>${t('Employee')}</th><th>${t('Leave type')}</th><th>${t('Dates')}</th><th>${t('Days')}</th><th>${t('Status')}</th><th></th></tr></thead>
      <tbody id="lvBody">${lRows || `<tr><td colspan="6" class="empty-state">${t('No leave requests yet.')}</td></tr>`}</tbody>
    </table></div>
    <h3 style="margin:22px 0 8px">${t('Attendance')}</h3>
    <div class="head-actions" style="margin-bottom:8px"><button class="secondary-btn" id="addAtt">+ ${t('Record attendance')}</button></div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>${t('Date')}</th><th>${t('Employee')}</th><th>${t('Check-in')}</th><th>${t('Check-out')}</th><th>${t('Hours')}</th><th>${t('Note')}</th><th></th></tr></thead>
      <tbody id="atBody">${aRows || `<tr><td colspan="7" class="empty-state">${t('No attendance yet.')}</td></tr>`}</tbody>
    </table></div>`;

  $('#addLeave').onclick = () => editLeave(null);
  $('#addAtt').onclick = () => editAttendance(null);
  $('#lvBody').addEventListener('click', e => {
    const btn = e.target.closest('button[data-lact]');
    if (!btn) return;
    const lr = leaves.find(x => x.id === Number(btn.dataset.id));
    const act = btn.dataset.lact;
    if (act === 'edit') return editLeave(lr);
    if (act === 'del') return confirmDelete(t('this leave request'), () => {
      if (inServerMode()) { txCall('leave-delete', { id: lr.id }, t('Leave request deleted')); return; }
      store.data.leave_requests = store.data.leave_requests.filter(x => x.id !== lr.id);
      store.save(); render(); toast(t('Leave request deleted'));
    });
    if (act === 'approve') {
      if (inServerMode()) { txCall('leave-decide', { id: lr.id, decision: 'approved' }, t('Leave approved')); return; }
      Object.assign(lr, { status: 'approved', decided_by: me && me.username, decided_at: new Date().toISOString() });
      store.save(); render(); toast(t('Leave approved'));
    }
    if (act === 'reject') {
      const note = window.prompt(t('Reject reason'));
      if (!note) return;
      if (inServerMode()) { txCall('leave-decide', { id: lr.id, decision: 'rejected', note }, t('Leave rejected')); return; }
      Object.assign(lr, { status: 'rejected', decided_by: me && me.username, decided_at: new Date().toISOString(), decision_note: note });
      store.save(); render(); toast(t('Leave rejected'));
    }
  });
  $('#atBody').addEventListener('click', e => {
    const btn = e.target.closest('button[data-aact]');
    if (!btn) return;
    const a = (store.data.attendance || []).find(x => x.id === Number(btn.dataset.id));
    if (btn.dataset.aact === 'edit') editAttendance(a);
    else confirmDelete(t('this attendance record'), () => {
      if (inServerMode()) { txCall('attendance-delete', { id: a.id }, t('Attendance deleted')); return; }
      store.data.attendance = store.data.attendance.filter(x => x.id !== a.id);
      store.save(); render(); toast(t('Attendance deleted'));
    });
  });
}

/* Self-service page for users with hr-self but not the employees module:
   own leave requests and own attendance only (server already row-scopes). */
function renderHrSelf() {
  const host = document.querySelector('#view-hr-self');
  if (!host) return;
  host.innerHTML = `
    <div class="view-head">
      <div><h2>${t('My HR')}</h2><div class="sub">${t('Your leave requests and attendance.')}</div></div>
    </div>
    <div id="hrSections"></div>`;
  renderHrSections();
}
App.views['hr-self'] = renderHrSelf;
