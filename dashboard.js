'use strict';
/* dashboard.js — the combined ERP + CRM overview. */

function renderDashboard() {
  const d = store.data;
  const openDeals = d.deals.filter(x => OPEN_STAGES.includes(x.stage));
  const openValue = openDeals.reduce((s, x) => s + num(x.value), 0);
  const wonValue = d.deals.filter(x => x.stage === 'Won').reduce((s, x) => s + num(x.value), 0);
  const openTasks = d.tasks.filter(x => !x.done);
  const td = todayStr();
  const overdue = openTasks.filter(x => x.due_date && x.due_date < td).length;
  const receivable = d.invoices.filter(i => i.status !== 'paid').reduce((s, i) => s + invoiceTotal(i), 0);
  const lowStock = d.products.filter(p => num(p.reorder_level) > 0 && num(p.stock) <= num(p.reorder_level));
  const totals = monthTotals(monthStr());

  const stageVals = STAGES.map(s => d.deals.filter(x => x.stage === s).reduce((a, x) => a + num(x.value), 0));
  const maxStageVal = Math.max(1, ...stageVals);
  const funnel = STAGES.map((s, i) => {
    const count = d.deals.filter(x => x.stage === s).length;
    const pct = Math.round((stageVals[i] / maxStageVal) * 100);
    return `<div class="funnel-row">
      <span class="stage-name">${t(s)}</span>
      <div class="funnel-track"><div class="funnel-fill" style="width:${pct}%;background:${STAGE_COLORS[s]}"></div></div>
      <span class="stage-stats">${count} · ${money0(stageVals[i])}</span>
    </div>`;
  }).join('');

  const upcoming = openTasks.slice()
    .sort((a, b) => (a.due_date || '9999') < (b.due_date || '9999') ? -1 : 1)
    .slice(0, 5);
  const upcomingHtml = upcoming.length ? upcoming.map(x => {
    const od = x.due_date && x.due_date < td;
    return `<div class="row-item">
      <div class="grow">
        <div class="title">${esc(x.title)}</div>
        <div class="meta">${x.contact_id ? esc(contactName(store.contact(x.contact_id))) + ' · ' : ''}<span class="${od ? 'overdue-text' : ''}">${dueLabel(x.due_date)}</span></div>
      </div>
      <span class="badge ${esc(x.priority)}">${t(x.priority)}</span>
    </div>`;
  }).join('') : `<div class="empty-state">${t('No open tasks. You are all caught up.')}</div>`;

  const recent = d.activities.slice().sort((a, b) => b.created_at < a.created_at ? -1 : 1).slice(0, 6);
  const recentHtml = recent.length ? recent.map(a => {
    const c = a.contact_id ? store.contact(a.contact_id) : null;
    const icon = { note: '📝', call: '📞', email: '✉️', meeting: '🤝' }[a.type] || '📝';
    return `<div class="row-item">
      <span>${icon}</span>
      <div class="grow">
        <div class="title">${esc(a.subject)}</div>
        <div class="meta">${c ? esc(contactName(c)) + ' · ' : ''}${relTime(a.created_at)}</div>
      </div>
    </div>`;
  }).join('') : `<div class="empty-state">${t('No activity yet.')}</div>`;

  const lowStockHtml = lowStock.length ? lowStock.map(p => `
    <div class="row-item">
      <div class="grow"><div class="title">${esc(p.name)}</div><div class="meta">${t('Stock')}: ${num(p.stock)} · ${t('reorder at')} ${num(p.reorder_level)}</div></div>
      <span class="badge high">${t('low')}</span>
    </div>`).join('') : `<div class="empty-state">${t('All products above reorder level.')}</div>`;

  $('#view-dashboard').innerHTML = `
    <div class="view-head"><div><h2>${t('Dashboard')}</h2><div class="sub">${t('Your business at a glance')}</div></div></div>
    <div class="cards">
      <div class="stat-card"><div class="label">${t('Contacts')}</div><div class="value">${d.contacts.length}</div><div class="hint">${d.contacts.filter(c => c.status === 'active').length} ${t('active')} · ${d.contacts.filter(c => c.status === 'lead').length} ${t('leads')}</div></div>
      <div class="stat-card"><div class="label">${t('Open pipeline')}</div><div class="value">${money0(openValue)}</div><div class="hint">${openDeals.length} ${t('open deals')} · ${money0(wonValue)} ${t('won')}</div></div>
      <div class="stat-card"><div class="label">${t('Outstanding invoices')}</div><div class="value">${money(receivable)}</div><div class="hint">${d.invoices.filter(i => i.status !== 'paid').length} ${t('unpaid')}</div></div>
      <div class="stat-card"><div class="label">${t('Net this month')}</div><div class="value" style="color:${totals.net >= 0 ? 'var(--green)' : 'var(--red)'}">${money(totals.net)}</div><div class="hint">${money(totals.income)} ${t('in')} · ${money(totals.expense)} ${t('out')}</div></div>
      <div class="stat-card"><div class="label">${t('Open tasks')}</div><div class="value">${openTasks.length}</div><div class="hint">${overdue ? `${overdue} ${t('overdue')}` : t('nothing overdue')}</div></div>
    </div>
    <div class="dash-grid">
      <div class="panel"><h3>${t('Pipeline by stage')}</h3>${funnel}</div>
      <div>
        <div class="panel"><h3>${t('Next follow-ups')}</h3>${upcomingHtml}</div>
        <div class="panel"><h3>${t('Low stock alerts')}</h3>${lowStockHtml}</div>
        <div class="panel"><h3>${t('Recent activity')}</h3>${recentHtml}</div>
      </div>
    </div>`;
}

App.views.dashboard = renderDashboard;
App.quickAdd.dashboard = () => App.editors.contact(null);
