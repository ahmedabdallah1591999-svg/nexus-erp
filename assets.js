'use strict';
/* assets.js — fixed-asset register with straight-line monthly depreciation.
   Server-owned: acquisition posting is an explicit opt-in, the monthly
   depreciation run is an explicit action with a visible catch-up count
   (re-running a month is a no-op via the per-asset cursor), and disposal
   computes book value from actually-posted depreciation. */

const assetFields = row => [
  { key: 'name', label: t('Asset name'), required: true, value: row?.name },
  { key: 'category', label: t('Category'), value: row?.category || '' },
  { key: 'purchase_date', label: t('Purchase date'), type: 'date', required: true, value: row?.purchase_date || todayStr() },
  { key: 'cost', label: t('Cost (USD)'), type: 'number', required: true, value: row?.cost ?? '' },
  { key: 'salvage', label: t('Salvage value'), type: 'number', value: row?.salvage ?? 0 },
  { key: 'life_months', label: t('Useful life (months)'), type: 'number', required: true, value: row?.life_months ?? 36 },
  ...(row ? [] : [{
    key: 'post_acquisition', label: t('Post acquisition from cash now (otherwise register only)'), type: 'select',
    options: [{ value: '0', label: t('No') }, { value: '1', label: t('Yes') }],
    value: '0',
  }]),
];

function editAsset(row) {
  openModal(row ? t('Edit asset') : t('New asset'), assetFields(row), out => {
    const payload = {
      name: out.name, category: out.category || '', purchase_date: out.purchase_date,
      cost: num(out.cost), salvage: num(out.salvage), life_months: num(out.life_months),
      post_acquisition: out.post_acquisition === '1' || out.post_acquisition === true,
    };
    if (inServerMode()) { txCall('asset-save', { id: row && row.id, out: payload }, t('Asset saved')); return; }
    if (row) Object.assign(row, payload);
    else store.add('assets', { ...payload, status: 'active', depr_through: null, disposed_date: null, proceeds: null, created_by: (Auth.current && Auth.current.username) || 'local', created_at: new Date().toISOString() });
    store.save(); render(); toast(t('Asset saved'));
  });
}

function runDepreciation() {
  const m = (store.data.settings && store.data.settings.ui_month) || todayStr().slice(0, 7);
  const month = window.prompt(t('Depreciation month (YYYY-MM)'), m);
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return;
  /* visible catch-up preview before anything posts — recognized assets only;
     register-only assets never post GL depreciation */
  const preview = (store.data.assets || []).filter(a => a.status === 'active'
    && (a.acquisition_posted || a.opening_recognized)
    && (a.purchase_date || '').slice(0, 7) < month
    && (!a.depr_through || a.depr_through < month));
  if (!preview.length) { alert(t('Nothing to post for this month.')); return; }
  if (!window.confirm(`${t('Post depreciation for')} ${month}?\n${preview.length} ${t('asset(s)')}`)) return;
  if (inServerMode()) { txCall('asset-depreciate', { month }, t('Depreciation posted')); return; }
  alert(t('This change needs the server.'));
}

function recognizeAsset(a) {
  openModal(t('Recognize asset'), [
    { key: 'date', label: t('Recognition date'), type: 'date', required: true, value: todayStr() },
    { key: 'opening_accum', label: t('Opening accumulated depreciation'), type: 'number', value: 0 },
  ], out => {
    const oa = Math.round(num(out.opening_accum) * 100) / 100;
    const net = Math.round((a.cost - oa) * 100) / 100;
    /* dated Dr/Cr preview; recognition happens only after explicit approval */
    const preview = [
      `${t('Recognition date')}: ${out.date}`,
      `Dr 1500 ${t('Fixed Assets')} ${money(a.cost)}`,
      oa > 0 ? `Cr 1590 ${t('Accumulated depreciation')} ${money(oa)}` : null,
      net > 0 ? `Cr 3000 ${t("Owner's Equity")} ${money(net)}` : null,
    ].filter(Boolean).join('\n');
    if (!window.confirm(preview)) return;
    if (inServerMode()) { txCall('asset-recognize', { id: a.id, date: out.date, opening_accum: oa }, t('Asset recognized in the books')); return; }
    alert(t('This change needs the server.'));
  });
}

function disposeAsset(a) {
  if (!a.acquisition_posted && !a.opening_recognized
    && !window.confirm(t('This asset is not recognized in the books; disposal records no journal entry and any proceeds stay out of the cash books until a reviewed recognition or journal entry. Continue?'))) return;
  openModal(t('Dispose asset'), [
    { key: 'date', label: t('Disposal date'), type: 'date', required: true, value: todayStr() },
    { key: 'proceeds', label: t('Sale proceeds (USD)'), type: 'number', value: 0 },
  ], out => {
    if (inServerMode()) { txCall('asset-dispose', { id: a.id, date: out.date, proceeds: num(out.proceeds) }, t('Asset disposed')); return; }
    alert(t('This change needs the server.'));
  });
}

function renderAssets() {
  const assets = (store.data.assets || []).slice().sort((a, b) => a.id - b.id);
  const isAdmin = Auth.current && Auth.current.role === 'admin';
  const nowMonth = todayStr().slice(0, 7);
  const rows = assets.map(a => {
    const monthly = Math.round((a.cost - a.salvage) / a.life_months * 100) / 100;
    const recognized = !!(a.acquisition_posted || a.opening_recognized);
    let accumCell, bookCell;
    if (recognized) {
      const accum = Math.round(((typeof accumDepr === 'function' ? accumDepr(a.id) : 0) + num(a.opening_accum || 0)) * 100) / 100;
      const book = Math.round((a.cost - (a.status === 'disposed' ? 0 : accum)) * 100) / 100;
      accumCell = money(accum);
      bookCell = a.status === 'disposed' ? '—' : money(Math.max(a.salvage, book));
    } else {
      /* tracking-only figure for an unrecognized asset: elapsed months x
         straight-line, visibly separate from the posted books */
      const pm = (a.purchase_date || '').slice(0, 7);
      let elapsed = 0;
      if (pm && pm < nowMonth) {
        const [y1, m1] = pm.split('-').map(Number), [y2, m2] = nowMonth.split('-').map(Number);
        elapsed = (y2 - y1) * 12 + (m2 - m1);
      }
      const track = Math.round(Math.min(elapsed, a.life_months) * monthly * 100) / 100;
      const capped = Math.min(track, a.cost - a.salvage);
      accumCell = `${money(a.status === 'disposed' ? 0 : capped)}<div class="cell-sub">${t('tracking only')}</div>`;
      bookCell = `—<div class="cell-sub">${t('not recognized in books')}</div>`;
    }
    return `
    <tr>
      <td><strong>${esc(a.name)}</strong>${a.category ? `<div class="cell-sub">${esc(a.category)}</div>` : ''}</td>
      <td>${esc(a.purchase_date || '—')}</td>
      <td>${money(a.cost)}</td>
      <td>${money(monthly)}</td>
      <td>${accumCell}</td>
      <td>${bookCell}</td>
      <td><span class="badge ${a.status === 'active' ? 'won' : 'lost'}">${t(a.status)}</span>${a.depr_through ? `<div class="cell-sub">${t('depreciated through')} ${esc(a.depr_through)}</div>` : ''}</td>
      <td class="row-actions">
        ${a.status === 'active' && !recognized && isAdmin ? `<button class="secondary-btn" data-aact2="recognize" data-id="${a.id}">${t('Recognize in books')}</button>` : ''}
        ${a.status === 'active' ? `<button class="secondary-btn" data-aact2="dispose" data-id="${a.id}">${t('Dispose')}</button>` : `<div class="cell-sub">${esc(a.disposed_date || '')} · ${money(a.proceeds || 0)}${!recognized && num(a.proceeds) > 0 ? ` · ${t('not posted, needs reviewed entry')}` : ''}</div>`}
        ${a.status === 'active' && !a.depr_through && !a.acquisition_posted && !a.opening_recognized ? `<button class="icon-btn" data-aact2="edit" data-id="${a.id}" title="${t('Edit')}">✏️</button><button class="danger-btn" data-aact2="del" data-id="${a.id}" title="${t('Delete')}">🗑</button>` : ''}
      </td>
    </tr>`;
  }).join('');

  $('#view-assets').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Assets')}</h2><div class="sub">${t('Fixed assets, straight-line monthly depreciation, disposal at book value.')}</div></div>
      <div class="head-actions">
        <button class="secondary-btn" id="runDepr">${t('Run monthly depreciation')}</button>
        <button class="primary-btn" id="addAsset">+ ${t('New asset')}</button>
      </div>
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>${t('Asset name')}</th><th>${t('Purchase date')}</th><th>${t('Cost')}</th>${''}<th>${t('Monthly depreciation')}</th><th>${t('Accumulated')}</th><th>${t('Book value')}</th><th>${t('Status')}</th><th></th></tr></thead>
      <tbody id="assetBody">${rows || `<tr><td colspan="8" class="empty-state">${t('No assets yet.')}</td></tr>`}</tbody>
    </table></div>`;

  $('#addAsset').onclick = () => editAsset(null);
  $('#runDepr').onclick = runDepreciation;
  $('#assetBody').addEventListener('click', e => {
    const btn = e.target.closest('button[data-aact2]');
    if (!btn) return;
    const a = assets.find(x => x.id === Number(btn.dataset.id));
    if (btn.dataset.aact2 === 'edit') return editAsset(a);
    if (btn.dataset.aact2 === 'dispose') return disposeAsset(a);
    if (btn.dataset.aact2 === 'recognize') return recognizeAsset(a);
    confirmDelete(t('this asset'), () => {
      if (inServerMode()) { txCall('asset-delete', { id: a.id }, t('Asset deleted')); return; }
      store.data.assets = store.data.assets.filter(x => x.id !== a.id);
      store.save(); render(); toast(t('Asset deleted'));
    });
  });
}

App.views.assets = renderAssets;
