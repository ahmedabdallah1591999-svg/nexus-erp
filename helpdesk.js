'use strict';
/* helpdesk.js — support tickets with a shared queue, threaded replies and
   internal notes. Server-owned: the session user is the author of every
   ticket and reply (identity never from the payload), ticket numbers are
   server-assigned, assignees are validated against real accounts. */

let selectedTicketId = null;
let ticketFilter = 'all';

const TICKET_STATUSES = ['open', 'in-progress', 'resolved', 'closed'];
const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

const ticketFields = row => [
  { key: 'subject', label: t('Subject'), required: true, value: row?.subject },
  {
    key: 'contact_id', label: t('Customer (CRM contact)'), type: 'select',
    options: [{ value: '', label: t('— none —') }, ...store.data.contacts.map(c => ({ value: c.id, label: contactName(c) }))],
    value: row?.contact_id || '',
  },
  {
    key: 'priority', label: t('Priority'), type: 'select',
    options: TICKET_PRIORITIES.map(v => ({ value: v, label: t(v) })),
    value: row?.priority || 'medium',
  },
  ...(row ? [{
    key: 'status', label: t('Status'), type: 'select',
    options: TICKET_STATUSES.map(v => ({ value: v, label: t(v) })),
    value: row.status,
  }] : []),
  { key: 'assigned_to', label: t('Assigned to (username)'), value: row?.assigned_to || '' },
  { key: 'description', label: t('Description'), value: row?.description || '', full: true },
];

function editTicket(row) {
  openModal(row ? t('Edit ticket') : t('New ticket'), ticketFields(row), out => {
    out.contact_id = out.contact_id ? Number(out.contact_id) : null;
    if (inServerMode()) { txCall('ticket-save', { id: row && row.id, out }, t('Ticket saved')); return; }
    const now = new Date().toISOString();
    if (row) { Object.assign(row, out, { updated_at: now }); }
    else {
      const seq = store.data.meta.ticketSeq = store.data.meta.ticketSeq || 1;
      store.add('tickets', {
        number: `TKT-${String(store.data.meta.ticketSeq++).padStart(4, '0')}`,
        ...out, status: 'open', created_by: (Auth.current && Auth.current.username) || 'local',
        created_at: now, updated_at: now,
      });
    }
    store.save(); render(); toast(t('Ticket saved'));
  });
}

function ticketStatus(tk, status) {
  if (inServerMode()) { txCall('ticket-status', { id: tk.id, status }, t('Ticket updated')); return; }
  tk.status = status; tk.updated_at = new Date().toISOString();
  store.save(); render(); toast(t('Ticket updated'));
}

function replyTicket(tk, body, internal) {
  if (inServerMode()) { txCall('ticket-reply', { ticket_id: tk.id, body, internal }, t('Reply added')); return; }
  const now = new Date().toISOString();
  store.add('ticket_replies', { ticket_id: tk.id, author: (Auth.current && Auth.current.username) || 'local', body, internal, created_at: now });
  tk.updated_at = now;
  store.save(); render(); toast(t('Reply added'));
}

function renderHelpdesk() {
  const tickets = (store.data.tickets || []).slice().sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  const replies = store.data.ticket_replies || [];
  const me = (typeof Auth !== 'undefined' && Auth.current) || null;
  let tk = tickets.find(x => x.id === selectedTicketId) || null;
  if (selectedTicketId && !tk) selectedTicketId = null;

  const filtered = tickets.filter(x => {
    if (ticketFilter === 'all') return true;
    if (ticketFilter === 'mine') return me && (x.assigned_to === me.username || x.created_by === me.username);
    return x.status === ticketFilter;
  });

  const chips = ['all', 'open', 'in-progress', 'resolved', 'closed', 'mine'].map(f =>
    `<button class="chip ${ticketFilter === f ? 'chip-active' : ''}" data-tf="${f}">${t(f === 'all' ? 'All' : f === 'mine' ? 'Mine' : f)}</button>`).join('');

  const prioBadge = p => `<span class="badge ${p === 'urgent' ? 'lost' : p === 'high' ? 'inactive' : p === 'low' ? 'lead' : 'won'}">${t(p)}</span>`;
  const statusBadge = st => `<span class="badge ${st === 'open' ? 'won' : st === 'in-progress' ? 'lead' : st === 'resolved' ? 'inactive' : 'lost'}">${t(st)}</span>`;

  const rows = filtered.map(x => {
    const cust = x.contact_id ? contactName(store.data.contacts.find(c => c.id === x.contact_id) || {}) : '—';
    return `
    <tr class="${selectedTicketId === x.id ? 'row-selected' : ''}" data-tkid="${x.id}" style="cursor:pointer">
      <td><strong>${esc(x.number)}</strong></td>
      <td><strong>${esc(x.subject)}</strong>${x.description ? `<div class="cell-sub">${esc(x.description.slice(0, 80))}</div>` : ''}</td>
      <td>${esc(cust)}</td>
      <td>${prioBadge(x.priority)}</td>
      <td>${statusBadge(x.status)}</td>
      <td>${esc(x.assigned_to || '—')}</td>
      <td>${esc((x.updated_at || '').slice(0, 10))}</td>
      <td class="row-actions">
        <button class="icon-btn" data-hact="edit" data-id="${x.id}" title="${t('Edit')}">✏️</button>
        <button class="danger-btn" data-hact="del" data-id="${x.id}" title="${t('Delete')}">🗑</button>
      </td>
    </tr>`;
  }).join('');

  let detail = '';
  if (tk) {
    const thread = replies.filter(r => r.ticket_id === tk.id).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    const tRows = thread.map(r => `
      <div class="note-item ${r.internal ? 'note-internal' : ''}">
        <div class="note-head"><strong>${esc(r.author)}</strong> · ${esc((r.created_at || '').replace('T', ' ').slice(0, 16))}${r.internal ? ` · <span class="badge inactive">${t('Internal note')}</span>` : ''}</div>
        <div>${esc(r.body)}</div>
      </div>`).join('');
    const next = tk.status === 'open' ? [['in-progress', 'Start progress']] : tk.status === 'in-progress' ? [['resolved', 'Resolve']] : tk.status === 'resolved' ? [['closed', 'Close']] : [];
    const reopen = (tk.status === 'resolved' || tk.status === 'closed') ? [['open', 'Reopen']] : [];
    const actions = [...next, ...reopen].map(([st, label]) => `<button class="secondary-btn" data-hstat="${st}">${t(label)}</button>`).join(' ');
    detail = `
    <h3 style="margin:18px 0 8px">${esc(tk.number)} — ${esc(tk.subject)} ${statusBadge(tk.status)} ${prioBadge(tk.priority)}</h3>
    <div class="sub" style="margin-bottom:8px">${t('Created by')} ${esc(tk.created_by || '—')} · ${t('Assigned to')}: ${esc(tk.assigned_to || '—')}</div>
    ${tk.description ? `<p>${esc(tk.description)}</p>` : ''}
    <div class="head-actions" style="margin:8px 0">${actions} <button class="secondary-btn" id="assignMe">${t('Assign to me')}</button></div>
    <div id="ticketThread">${tRows || `<div class="empty-state">${t('No replies yet.')}</div>`}</div>
    <div class="reply-box" style="margin-top:10px">
      <textarea id="replyBody" rows="2" style="width:100%" placeholder="${t('Write a reply…')}"></textarea>
      <label class="check-item"><input type="checkbox" id="replyInternal"> ${t('Internal note (team only)')}</label>
      <button class="primary-btn" id="sendReply">${t('Send reply')}</button>
    </div>`;
  }

  $('#view-helpdesk').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Helpdesk')}</h2><div class="sub">${t('Support tickets, threaded replies and internal notes.')}</div></div>
      <div class="head-actions"><button class="secondary-btn" id="addTicket">+ ${t('New ticket')}</button></div>
    </div>
    <div class="chip-row" style="margin-bottom:8px">${chips}</div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>${t('Ticket #')}</th><th>${t('Subject')}</th><th>${t('Customer')}</th><th>${t('Priority')}</th><th>${t('Status')}</th><th>${t('Assigned')}</th><th>${t('Updated')}</th><th></th></tr></thead>
      <tbody id="tkBody">${rows || `<tr><td colspan="8" class="empty-state">${t('No tickets yet.')}</td></tr>`}</tbody>
    </table></div>
    ${detail}`;

  $('#addTicket').onclick = () => editTicket(null);
  document.querySelectorAll('[data-tf]').forEach(b => b.onclick = () => { ticketFilter = b.dataset.tf; renderHelpdesk(); });
  $('#tkBody').addEventListener('click', e => {
    const btn = e.target.closest('button[data-hact]');
    if (btn) {
      e.stopPropagation();
      const x = tickets.find(v => v.id === Number(btn.dataset.id));
      if (btn.dataset.hact === 'edit') editTicket(x);
      else confirmDelete(t('this ticket'), () => {
        if (inServerMode()) { txCall('ticket-delete', { id: x.id }, t('Ticket deleted')); return; }
        store.data.tickets = store.data.tickets.filter(v => v.id !== x.id);
        store.data.ticket_replies = (store.data.ticket_replies || []).filter(r => r.ticket_id !== x.id);
        if (selectedTicketId === x.id) selectedTicketId = null;
        store.save(); render(); toast(t('Ticket deleted'));
      });
      return;
    }
    const tr = e.target.closest('tr[data-tkid]');
    if (tr) { selectedTicketId = Number(tr.dataset.tkid); renderHelpdesk(); }
  });
  if (tk) {
    document.querySelectorAll('[data-hstat]').forEach(b => b.onclick = () => ticketStatus(tk, b.dataset.hstat));
    const am = $('#assignMe');
    if (am) am.onclick = () => {
      const out = { subject: tk.subject, description: tk.description || '', contact_id: tk.contact_id || null, priority: tk.priority, status: tk.status, assigned_to: me ? me.username : '' };
      if (inServerMode()) { txCall('ticket-save', { id: tk.id, out }, t('Ticket updated')); return; }
      tk.assigned_to = me ? me.username : tk.assigned_to; tk.updated_at = new Date().toISOString();
      store.save(); render(); toast(t('Ticket updated'));
    };
    const sr = $('#sendReply');
    if (sr) sr.onclick = () => {
      const body = $('#replyBody').value.trim();
      if (!body) return;
      replyTicket(tk, body, $('#replyInternal').checked);
    };
  }
}

App.views.helpdesk = renderHelpdesk;
