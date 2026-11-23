'use strict';
/* crm.js — CRM module: contacts, companies, deals pipeline, tasks. */

/* ---------------- Field schemas ---------------- */

const companyFields = row => [
  { key: 'name', label: t('Company name'), required: true, value: row?.name },
  { key: 'industry', label: t('Industry'), value: row?.industry },
  { key: 'email', label: t('Email'), type: 'email', value: row?.email },
  { key: 'phone', label: t('Phone'), value: row?.phone },
  { key: 'website', label: t('Website'), type: 'url', value: row?.website, placeholder: 'https://…' },
  { key: 'address', label: t('Address'), value: row?.address },
  { key: 'notes', label: t('Notes'), type: 'textarea', value: row?.notes },
];

const contactFields = row => [
  { key: 'first_name', label: t('First name'), required: true, value: row?.first_name },
  { key: 'last_name', label: t('Last name'), value: row?.last_name },
  { key: 'email', label: t('Email'), type: 'email', value: row?.email },
  { key: 'phone', label: t('Phone'), value: row?.phone },
  { key: 'position', label: t('Position'), value: row?.position },
  {
    key: 'company_id', label: t('Company'), type: 'select', allowEmpty: t('— No company —'),
    options: store.data.companies.map(c => ({ value: c.id, label: c.name })),
    value: row?.company_id ?? '',
  },
  {
    key: 'status', label: t('Status'), type: 'select',
    options: [{ value: 'lead', label: t('lead') }, { value: 'active', label: t('active') }, { value: 'inactive', label: t('inactive') }],
    value: row?.status || 'lead',
  },
  { key: 'tags', label: t('Tags (comma separated)'), value: row?.tags, placeholder: 'vip, referral' },
  { key: 'notes', label: t('Notes'), type: 'textarea', value: row?.notes },
];

const dealFields = row => [
  { key: 'title', label: t('Deal title'), required: true, value: row?.title, full: true },
  { key: 'value', label: t('Value (USD)'), type: 'number', value: row?.value ?? 0 },
  { key: 'stage', label: t('Stage'), type: 'select', options: STAGES.map(s => ({ value: s, label: t(s) })), value: row?.stage || 'Lead' },
  {
    key: 'contact_id', label: t('Contact'), type: 'select', allowEmpty: t('— No contact —'),
    options: store.data.contacts.map(c => ({ value: c.id, label: contactName(c) })),
    value: row?.contact_id ?? '',
  },
  {
    key: 'company_id', label: t('Company'), type: 'select', allowEmpty: t('— No company —'),
    options: store.data.companies.map(c => ({ value: c.id, label: c.name })),
    value: row?.company_id ?? '',
  },
  { key: 'expected_close', label: t('Expected close'), type: 'date', value: row?.expected_close },
  { key: 'notes', label: t('Notes'), type: 'textarea', value: row?.notes },
];

const taskFields = row => [
  { key: 'title', label: t('Task'), required: true, value: row?.title, full: true },
  { key: 'due_date', label: t('Due date'), type: 'date', value: row?.due_date },
  {
    key: 'priority', label: t('Priority'), type: 'select',
    options: [{ value: 'low', label: t('low') }, { value: 'medium', label: t('medium') }, { value: 'high', label: t('high') }],
    value: row?.priority || 'medium',
  },
  {
    key: 'contact_id', label: t('Related contact'), type: 'select', allowEmpty: t('— None —'),
    options: store.data.contacts.map(c => ({ value: c.id, label: contactName(c) })),
    value: row?.contact_id ?? '',
  },
  {
    key: 'deal_id', label: t('Related deal'), type: 'select', allowEmpty: t('— None —'),
    options: store.data.deals.map(d => ({ value: d.id, label: d.title })),
    value: row?.deal_id ?? '',
  },
  { key: 'description', label: t('Description'), type: 'textarea', value: row?.description },
];

const activityFields = () => [
  {
    key: 'type', label: t('Type'), type: 'select',
    options: [{ value: 'note', label: t('Note') }, { value: 'call', label: t('Call') }, { value: 'email', label: t('Email') }, { value: 'meeting', label: t('Meeting') }],
    value: 'note',
  },
  { key: 'subject', label: t('Subject'), required: true },
  { key: 'body', label: t('Details'), type: 'textarea' },
];

/* ---------------- CRUD handlers ---------------- */

function editCompany(row) {
  openModal(row ? t('Edit company') : t('New company'), companyFields(row), out => {
    if (row) { store.update('companies', row.id, out); toast(t('Company updated')); }
    else { store.add('companies', out); toast(t('Company added')); }
    render();
  });
}

function editContact(row) {
  openModal(row ? t('Edit contact') : t('New contact'), contactFields(row), out => {
    out.company_id = idsOrNull(out.company_id);
    if (row) { store.update('contacts', row.id, out); toast(t('Contact updated')); }
    else { store.add('contacts', out); toast(t('Contact added')); }
    render();
  });
}

function editDeal(row, presetStage) {
  const base = row || (presetStage ? { stage: presetStage } : null);
  openModal(row ? t('Edit deal') : t('New deal'), dealFields(base), out => {
    out.value = num(out.value);
    out.contact_id = idsOrNull(out.contact_id);
    out.company_id = idsOrNull(out.company_id);
    if (row) { store.update('deals', row.id, out); toast(t('Deal updated')); }
    else { store.add('deals', { ...out, updated_at: new Date().toISOString() }); toast(t('Deal added')); }
    render();
  });
}

function editTask(row) {
  openModal(row ? t('Edit task') : t('New task'), taskFields(row), out => {
    out.contact_id = idsOrNull(out.contact_id);
    out.deal_id = idsOrNull(out.deal_id);
    if (row) { store.update('tasks', row.id, out); toast(t('Task updated')); }
    else { store.add('tasks', { ...out, done: 0 }); toast(t('Task added')); }
    render();
  });
}

function addActivity(contactId, dealId) {
  openModal(t('Log activity'), activityFields(), out => {
    store.add('activities', { ...out, contact_id: contactId || null, deal_id: dealId || null });
    toast(t('Activity logged'));
    render();
  });
}

/* ---------------- Views ---------------- */

function renderContacts() {
  const rows = store.data.contacts.slice().sort((a, b) => contactName(a).localeCompare(contactName(b)));
  const body = rows.map(c => {
    const comp = companyOf(c);
    const tags = (c.tags || '').split(',').map(s => s.trim()).filter(Boolean)
      .map(x => `<span class="tag-chip">${esc(x)}</span>`).join('');
    return `<tr>
      <td><div class="cell-main">${esc(contactName(c))}</div><div class="cell-sub">${esc(c.position || '')}</div></td>
      <td>${comp ? esc(comp.name) : '<span class="cell-sub">—</span>'}</td>
      <td><div>${esc(c.email || '—')}</div><div class="cell-sub">${esc(c.phone || '')}</div></td>
      <td><span class="badge ${esc(c.status)}">${t(c.status)}</span></td>
      <td>${tags}</td>
      <td class="row-actions">
        <button class="icon-btn" data-act="activity" data-id="${c.id}" title="${t('Log activity')}">📝</button>
        <button class="icon-btn" data-act="edit" data-id="${c.id}" title="${t('Edit')}">✏️</button>
        <button class="danger-btn" data-act="del" data-id="${c.id}" title="${t('Delete')}">🗑</button>
      </td>
    </tr>`;
  }).join('');

  $('#view-contacts').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Contacts')}</h2><div class="sub">${rows.length} ${t('people in your network')}</div></div>
      <button class="primary-btn" id="addContact">+ ${t('New contact')}</button>
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>${t('Name')}</th><th>${t('Company')}</th><th>${t('Contact info')}</th><th>${t('Status')}</th><th>${t('Tags')}</th><th></th></tr></thead>
      <tbody>${body || `<tr><td colspan="6" class="empty-state">${t('No contacts yet.')}</td></tr>`}</tbody>
    </table></div>`;

  $('#addContact').onclick = () => editContact(null);
  $('#view-contacts').querySelector('tbody').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const row = store.contact(id);
    if (btn.dataset.act === 'edit') editContact(row);
    if (btn.dataset.act === 'del') confirmDelete(`${t('contact')} "${contactName(row)}"`, () => { store.remove('contacts', id); toast(t('Contact deleted')); });
    if (btn.dataset.act === 'activity') addActivity(id, null);
  });
}

function renderCompanies() {
  const rows = store.data.companies.slice().sort((a, b) => a.name.localeCompare(b.name));
  const body = rows.map(c => {
    const people = store.data.contacts.filter(x => x.company_id === c.id).length;
    const deals = store.data.deals.filter(x => x.company_id === c.id);
    const openVal = deals.filter(x => OPEN_STAGES.includes(x.stage)).reduce((s, x) => s + num(x.value), 0);
    return `<tr>
      <td><div class="cell-main">${esc(c.name)}</div><div class="cell-sub">${esc(c.industry || '')}</div></td>
      <td><div>${esc(c.email || '—')}</div><div class="cell-sub">${esc(c.phone || '')}</div></td>
      <td>${c.website ? `<a href="${esc(c.website)}" target="_blank" rel="noopener">${esc(c.website.replace(/^https?:\/\//, ''))}</a>` : '—'}</td>
      <td>${people}</td>
      <td>${money0(openVal)}</td>
      <td class="row-actions">
        <button class="icon-btn" data-act="edit" data-id="${c.id}" title="${t('Edit')}">✏️</button>
        <button class="danger-btn" data-act="del" data-id="${c.id}" title="${t('Delete')}">🗑</button>
      </td>
    </tr>`;
  }).join('');

  $('#view-companies').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Companies')}</h2><div class="sub">${rows.length} ${t('accounts')}</div></div>
      <button class="primary-btn" id="addCompany">+ ${t('New company')}</button>
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>${t('Company')}</th><th>${t('Contact info')}</th><th>${t('Website')}</th><th>${t('People')}</th><th>${t('Open pipeline')}</th><th></th></tr></thead>
      <tbody>${body || `<tr><td colspan="6" class="empty-state">${t('No companies yet.')}</td></tr>`}</tbody>
    </table></div>`;

  $('#addCompany').onclick = () => editCompany(null);
  $('#view-companies').querySelector('tbody').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const row = store.company(id);
    if (btn.dataset.act === 'edit') editCompany(row);
    if (btn.dataset.act === 'del') confirmDelete(`${t('company')} "${row.name}"`, () => { store.remove('companies', id); toast(t('Company deleted')); });
  });
}

function renderDeals() {
  const d = store.data;
  const lanes = STAGES.map(stage => {
    const deals = d.deals.filter(x => x.stage === stage);
    const sum = deals.reduce((s, x) => s + num(x.value), 0);
    const cards = deals.map(x => {
      const c = x.contact_id ? store.contact(x.contact_id) : null;
      const co = x.company_id ? store.company(x.company_id) : null;
      return `<div class="deal-card" draggable="true" data-id="${x.id}">
        <div class="deal-title">${esc(x.title)}</div>
        <div class="deal-value">${money0(x.value)}</div>
        <div class="deal-meta">${[c && contactName(c), co && co.name].filter(Boolean).map(esc).join(' · ') || '&nbsp;'}</div>
        ${x.expected_close ? `<div class="deal-meta">${t('Close')}: ${esc(x.expected_close)}</div>` : ''}
      </div>`;
    }).join('');
    return `<div class="lane" data-stage="${stage}">
      <div class="lane-head"><span class="name" style="color:${STAGE_COLORS[stage]}">${t(stage)}</span><span class="sum">${deals.length} · ${money0(sum)}</span></div>
      <div class="lane-body">${cards}</div>
      <button class="lane-add" data-stage="${stage}">+ ${t('Add')}</button>
    </div>`;
  }).join('');

  const openVal = d.deals.filter(x => OPEN_STAGES.includes(x.stage)).reduce((s, x) => s + num(x.value), 0);
  $('#view-deals').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Deals')}</h2><div class="sub">${money0(openVal)} ${t('in open pipeline — drag cards between stages')}</div></div>
      <button class="primary-btn" id="addDeal">+ ${t('New deal')}</button>
    </div>
    <div class="board">${lanes}</div>`;

  $('#addDeal').onclick = () => editDeal(null);
  const board = $('#view-deals').querySelector('.board');

  board.querySelectorAll('.lane-add').forEach(b => { b.onclick = () => editDeal(null, b.dataset.stage); });
  board.querySelectorAll('.deal-card').forEach(card => {
    card.addEventListener('click', () => editDeal(store.deal(Number(card.dataset.id))));
    card.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', card.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
    });
  });
  board.querySelectorAll('.lane').forEach(lane => {
    lane.addEventListener('dragover', e => { e.preventDefault(); lane.classList.add('drag-over'); });
    lane.addEventListener('dragleave', () => lane.classList.remove('drag-over'));
    lane.addEventListener('drop', e => {
      e.preventDefault();
      lane.classList.remove('drag-over');
      const id = Number(e.dataTransfer.getData('text/plain'));
      const deal = store.deal(id);
      if (deal && deal.stage !== lane.dataset.stage) {
        store.update('deals', id, { stage: lane.dataset.stage });
        toast(t('Deal moved'));
        render();
      }
    });
  });
}

function renderTasks() {
  const td = todayStr();
  const tasks = store.data.tasks;
  const groups = [
    { name: t('Overdue'), rows: tasks.filter(x => !x.done && x.due_date && x.due_date < td) },
    { name: t('Today'), rows: tasks.filter(x => !x.done && x.due_date === td) },
    { name: t('Upcoming'), rows: tasks.filter(x => !x.done && (!x.due_date || x.due_date > td)).sort((a, b) => (a.due_date || '9999') < (b.due_date || '9999') ? -1 : 1) },
    { name: t('Completed'), rows: tasks.filter(x => x.done) },
  ];

  const taskRow = x => {
    const c = x.contact_id ? store.contact(x.contact_id) : null;
    const dl = x.deal_id ? store.deal(x.deal_id) : null;
    return `<div class="task-row${x.done ? ' done' : ''}">
      <input type="checkbox" data-id="${x.id}" ${x.done ? 'checked' : ''} title="${t('Mark done')}">
      <div class="grow">
        <div class="task-title">${esc(x.title)}</div>
        <div class="meta">
          ${x.done ? t('Done') : dueLabel(x.due_date)}
          ${c ? ' · ' + esc(contactName(c)) : ''}${dl ? ' · ' + esc(dl.title) : ''}
          ${x.description ? ' · ' + esc(x.description) : ''}
        </div>
      </div>
      <span class="badge ${x.done ? 'done' : esc(x.priority)}">${x.done ? t('done') : t(x.priority)}</span>
      <button class="icon-btn" data-act="edit" data-id="${x.id}" title="${t('Edit')}">✏️</button>
      <button class="danger-btn" data-act="del" data-id="${x.id}" title="${t('Delete')}">🗑</button>
    </div>`;
  };

  $('#view-tasks').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Tasks')}</h2><div class="sub">${tasks.filter(x => !x.done).length} ${t('open follow-ups')}</div></div>
      <button class="primary-btn" id="addTask">+ ${t('New task')}</button>
    </div>
    ${groups.map(g => g.rows.length ? `<div class="task-group"><h4>${g.name} (${g.rows.length})</h4>${g.rows.map(taskRow).join('')}</div>` : '').join('') || `<div class="empty-state">${t('No tasks yet.')}</div>`}`;

  $('#addTask').onclick = () => editTask(null);
  const view = $('#view-tasks');
  view.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.onchange = () => {
      store.update('tasks', Number(cb.dataset.id), { done: cb.checked ? 1 : 0 });
      toast(cb.checked ? t('Task completed') : t('Task reopened'));
      render();
    };
  });
  view.addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const row = store.data.tasks.find(x => x.id === id);
    if (btn.dataset.act === 'edit') editTask(row);
    if (btn.dataset.act === 'del') confirmDelete(`${t('task')} "${row.title}"`, () => { store.remove('tasks', id); toast(t('Task deleted')); });
  });
}

/* ---------------- Registration ---------------- */

App.views.contacts = renderContacts;
App.views.companies = renderCompanies;
App.views.deals = renderDeals;
App.views.tasks = renderTasks;
App.quickAdd.contacts = () => editContact(null);
App.quickAdd.companies = () => editCompany(null);
App.quickAdd.deals = () => editDeal(null);
App.quickAdd.tasks = () => editTask(null);
App.editors.contact = editContact;
App.editors.company = editCompany;
App.editors.deal = editDeal;
