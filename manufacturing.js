'use strict';
/* manufacturing.js — bills of materials and production runs.
   A BOM lives on the finished product; a production run consumes
   components and outputs finished goods through the single stock-move
   path, and posts a balanced inventory journal (difference to
   Manufacturing Variance). Everything commits through server ops
   (bom-save / produce) so identity, permissions and the books stay
   server-authoritative. */

function bomUnitCost(bom) {
  return Math.round((bom || []).reduce((s, l) => {
    const c = (store.data.products || []).find(x => x.id === l.product_id);
    return s + (c ? num(c.cost) * num(l.qty) : 0);
  }, 0) * 100) / 100;
}

function renderManufacturing() {
  const products = store.data.products || [];
  const runs = (store.data.production || []).slice().sort((a, b) => b.id - a.id);
  const serverUp = inServerMode();

  const prodOptions = (sel) => products.map(p =>
    `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');

  /* BOM editor */
  const bomProdId = Number($('#bomProduct') && $('#bomProduct').value) || (products[0] && products[0].id);
  const bomProd = products.find(p => p.id === bomProdId);
  const bom = (bomProd && Array.isArray(bomProd.bom)) ? bomProd.bom : [];
  const bomRows = bom.map((l, i) => {
    const c = products.find(x => x.id === l.product_id);
    return `<tr><td>${c ? esc(c.name) : '?'}</td><td>${l.qty}</td>
      <td>${money(num(c ? c.cost : 0) * num(l.qty))}</td>
      <td class="row-actions"><button class="icon-btn" data-bom-del="${i}" title="${t('Delete')}">🗑️</button></td></tr>`;
  }).join('');

  /* Production form */
  const mfgProducts = products.filter(p => Array.isArray(p.bom) && p.bom.length);
  const runProdId = Number($('#runProduct') && $('#runProduct').value) || (mfgProducts[0] && mfgProducts[0].id);
  const runProd = mfgProducts.find(p => p.id === runProdId);
  const needRows = runProd ? runProd.bom.map(l => {
    const c = products.find(x => x.id === l.product_id);
    const have = c ? num(c.stock) : 0;
    const ok = have + 1e-9 >= num(l.qty);
    return `<tr><td>${c ? esc(c.name) : '?'}</td><td>${l.qty}</td>
      <td style="color:${ok ? 'var(--green)' : 'var(--red)'}">${have}</td></tr>`;
  }).join('') : '';

  const runRows = runs.slice(0, 50).map(r => {
    const p = products.find(x => x.id === r.product_id);
    return `<tr><td>${esc(r.date || '—')}</td><td><div class="cell-main">${p ? esc(p.name) : '?'}</div>
      <div class="cell-sub">${t('Production')} #${r.id}</div></td><td>${r.qty}</td></tr>`;
  }).join('');

  $('#view-manufacturing').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Manufacturing')}</h2><div class="sub">${t('Bills of materials and production runs — components out, finished goods in, books posted live')}</div>
      <div class="sub">${t('Scope: single-level BOM stock conversion with variance accounting. Not production planning, work centers or WIP tracking.')}</div></div>
    </div>
    ${serverUp ? '' : `<div class="card" style="border-color:var(--red)"><p><strong>${t('Manufacturing needs the server.')}</strong></p></div>`}
    <div class="card"><h3>${t('Bill of materials')}</h3>
      <p class="cell-sub">${t('Choose a product and list the components needed to make one unit. Finished goods are valued at the product cost — set it near the component cost below.')}</p>
      <div class="form-grid">
        <label>${t('Product')}<select id="bomProduct">${prodOptions(bomProdId)}</select></label>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>${t('Component')}</th><th>${t('Qty')}</th><th>${t('Cost')}</th><th></th></tr></thead>
        <tbody>${bomRows || `<tr><td colspan="4" class="empty-state">${t('No components yet.')}</td></tr>`}</tbody></table></div>
      <div class="form-grid">
        <label>${t('Component')}<select id="bomComp">${prodOptions()}</select></label>
        <label>${t('Qty')}<input id="bomQty" type="number" min="0.001" step="any" value="1"></label>
        <button class="secondary-btn" id="bomAdd">${t('Add component')}</button>
      </div>
      <p>${t('Component cost per unit')}: <strong>${money(bomUnitCost(bom))}</strong>${bomProd ? ` · ${t('Product cost')}: <strong>${money(bomProd.cost || 0)}</strong>` : ''}</p>
      <button class="primary-btn" id="bomSave">${t('Save BOM')}</button>
    </div>
    <div class="card"><h3>${t('New production run')}</h3>
      <div class="form-grid">
        <label>${t('Product')}<select id="runProduct">${mfgProducts.length ? prodOptions(runProdId) : `<option value="">${t('— none —')}</option>`}</select></label>
        <label>${t('Quantity')}<input id="runQty" type="number" min="0.001" step="any" value="1"></label>
        <button class="primary-btn" id="runGo">${t('Produce')}</button>
      </div>
      ${runProd ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>${t('Component')}</th><th>${t('Needed per unit')}</th><th>${t('In stock')}</th></tr></thead>
        <tbody>${needRows}</tbody></table></div>` : `<p class="empty-state">${t('No products with a bill of materials yet.')}</p>`}
    </div>
    <div class="card"><h3>${t('Production history')}</h3>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>${t('Date')}</th><th>${t('Product')}</th><th>${t('Qty')}</th></tr></thead>
        <tbody>${runRows || `<tr><td colspan="3" class="empty-state">${t('No production runs yet.')}</td></tr>`}</tbody></table></div>
    </div>`;

  const bomSel = $('#bomProduct');
  if (bomSel) bomSel.onchange = () => render();
  const runSel = $('#runProduct');
  if (runSel) runSel.onchange = () => render();

  document.querySelectorAll('[data-bom-del]').forEach(b => b.onclick = () => {
    const list = (bomProd.bom || []).slice();
    list.splice(Number(b.dataset.bomDel), 1);
    txCall('bom-save', { product_id: bomProd.id, lines: list }, t('BOM saved'));
  });
  const addBtn = $('#bomAdd');
  if (addBtn) addBtn.onclick = () => {
    const cid = Number($('#bomComp').value), q = num($('#bomQty').value);
    if (!cid || !(q > 0) || !bomProd) return;
    const list = (bomProd.bom || []).filter(l => l.product_id !== cid);
    list.push({ product_id: cid, qty: q });
    txCall('bom-save', { product_id: bomProd.id, lines: list }, t('BOM saved'));
  };
  const saveBtn = $('#bomSave');
  if (saveBtn) saveBtn.onclick = () => {
    if (bomProd) txCall('bom-save', { product_id: bomProd.id, lines: bomProd.bom || [] }, t('BOM saved'));
  };
  const goBtn = $('#runGo');
  if (goBtn) goBtn.onclick = () => {
    const pid = Number($('#runProduct').value), q = num($('#runQty').value);
    if (!pid || !(q > 0)) return;
    /* one client_ref per click: a retry or double submit returns the
       original run server-side instead of double-producing */
    goBtn.disabled = true;
    const ref = 'mfg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    txCall('produce', { product_id: pid, qty: q, client_ref: ref }, t('Production recorded'));
  };
}

App.views['manufacturing'] = renderManufacturing;
