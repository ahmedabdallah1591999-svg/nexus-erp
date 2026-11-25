'use strict';
/* extras.js — Notes module, Contact-us form, and the admin message inbox. */

/* ---------------- Notes ---------------- */

const noteFields = row => [
  { key: 'title', label: t('Title'), required: true, value: row?.title, full: true },
  { key: 'body', label: t('Note'), type: 'textarea', required: true, value: row?.body },
  { key: 'pinned', label: t('Pinned'), type: 'select', options: [{ value: '', label: t('No') }, { value: '1', label: t('Yes') }], value: row?.pinned ? '1' : '' },
];

function editNote(row) {
  openModal(row ? t('Edit note') : t('New note'), noteFields(row), out => {
    out.pinned = out.pinned === '1' ? 1 : 0;
    if (row) { store.update('notes', row.id, out); toast(t('Note updated')); }
    else { store.add('notes', out); toast(t('Note added')); }
    render();
  });
}

function renderNotes() {
  const rows = (store.data.notes || []).slice()
    .sort((a, b) => (b.pinned - a.pinned) || (a.created_at < b.created_at ? 1 : -1));
  const cards = rows.length ? rows.map(n => `
    <div class="note-card${n.pinned ? ' pinned' : ''}">
      <div class="note-head">
        <div class="title">${n.pinned ? '📌 ' : ''}${esc(n.title)}</div>
        <div class="row-actions">
          <button class="icon-btn" data-act="edit" data-id="${n.id}" title="${t('Edit')}">✏️</button>
          <button class="danger-btn" data-act="del" data-id="${n.id}" title="${t('Delete')}">🗑</button>
        </div>
      </div>
      <div class="note-body">${esc(n.body)}</div>
      <div class="meta">${relTime(n.created_at)}</div>
    </div>`).join('') : `<div class="empty-state">${t('No notes yet.')}</div>`;

  $('#view-notes').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Notes')}</h2><div class="sub">${rows.length ? rows.length + ' ' + t('notes') : t('General notes for the team')}</div></div>
      <div class="head-actions"><button id="addNote" class="primary-btn">+ ${t('New note')}</button></div>
    </div>
    <div class="notes-grid">${cards}</div>`;

  $('#addNote').onclick = () => editNote(null);
  $('#view-notes').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const row = (store.data.notes || []).find(x => x.id === id);
    if (btn.dataset.act === 'edit') editNote(row);
    if (btn.dataset.act === 'del') confirmDelete(`${t('note')} "${row.title}"`, () => { store.remove('notes', id); toast(t('Note deleted')); });
  });
}

/* ---------------- Contact us ---------------- */

function renderContact() {
  $('#view-contact').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Contact us')}</h2><div class="sub">${t('Write to the system admin — only the admin can read these messages.')}</div></div>
    </div>
    <div class="panel contact-panel">
      <form id="contactForm" class="form-grid">
        <div class="field"><label>${t('Name')} *</label><input name="name" required value="${esc(Auth.current ? Auth.current.username : '')}"></div>
        <div class="field"><label>${t('Subject')} *</label><input name="subject" required></div>
        <div class="field full"><label>${t('Message')} *</label><textarea name="body" required placeholder="${esc(t('Write your message here…'))}"></textarea></div>
        <div class="modal-actions"><button type="submit" class="primary-btn">${t('Send message')}</button></div>
      </form>
    </div>`;

  $('#contactForm').addEventListener('submit', e => {
    e.preventDefault();
    if (!e.target.reportValidity()) return;
    const out = {};
    new FormData(e.target).forEach((v, k) => { out[k] = String(v).trim(); });
    out.read = 0;
    store.add('messages', out);
    toast(t('Message sent to the admin'));
    updateInboxBadge();
    renderContact();
  });
}

/* ---------------- Admin inbox ---------------- */

function updateInboxBadge() {
  const badge = $('#inboxBadge');
  if (!badge) return;
  const unread = (store.data && store.data.messages ? store.data.messages : []).filter(m => !m.read).length;
  badge.textContent = unread;
  badge.style.display = (Auth.isAdmin() && unread > 0) ? '' : 'none';
}

function renderInbox() {
  const msgs = (store.data.messages || []).slice().sort((a, b) => a.created_at < b.created_at ? 1 : -1);
  const rows = msgs.length ? msgs.map(m => `
    <div class="msg-item${m.read ? '' : ' unread'}">
      <div class="grow">
        <div class="title">${m.read ? '' : '● '}${esc(m.subject)}</div>
        <div class="meta">${esc(m.name)} · ${relTime(m.created_at)}</div>
        <div class="msg-body">${esc(m.body)}</div>
      </div>
      <div class="row-actions">
        <button class="icon-btn" data-act="toggle" data-id="${m.id}" title="${m.read ? t('Mark unread') : t('Mark read')}">${m.read ? '↩️' : '✔️'}</button>
        <button class="danger-btn" data-act="del" data-id="${m.id}" title="${t('Delete')}">🗑</button>
      </div>
    </div>`).join('') : `<div class="empty-state">${t('No messages yet.')}</div>`;

  $('#view-inbox').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Inbox')}</h2><div class="sub">${t('Messages from the Contact us form')}</div></div>
    </div>
    <div class="panel">${rows}</div>`;

  $('#view-inbox').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const row = (store.data.messages || []).find(x => x.id === id);
    if (btn.dataset.act === 'toggle') { store.update('messages', id, { read: row.read ? 0 : 1 }); updateInboxBadge(); render(); }
    if (btn.dataset.act === 'del') confirmDelete(`${t('message')} "${row.subject}"`, () => { store.remove('messages', id); updateInboxBadge(); });
  });
}

/* ---------------- Registration ---------------- */

App.views.notes = renderNotes;
App.views.contact = renderContact;
App.views.inbox = renderInbox;
App.quickAdd.notes = () => editNote(null);
