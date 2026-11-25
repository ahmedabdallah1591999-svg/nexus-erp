'use strict';
/* stock.js — warehouses + append-only stock ledger. Every quantity change
   is a stock move with a reason and a running per-product balance; the
   product's stock equals the sum of its moves (checked by stockInvariants).
   Invoices, purchases, adjustments and transfers all flow through
   recordStockMove, one path only. */

function ensureWarehouses() {
  if (!store.data.warehouses) store.data.warehouses = [];
  if (!store.data.stock_moves) store.data.stock_moves = [];
  if (!store.data.warehouses.length) {
    store.add('warehouses', { name: t('Main warehouse'), location: '' });
    store.save();
  }
  return store.data.warehouses[0];
}

/* Products with stock but no moves (pre-ledger data) get an opening move
   in the main warehouse so sum(moves) == stock holds for every product. */
function ensureStockBaseline() {
  ensureWarehouses();
  const main = store.data.warehouses[0];
  let changed = false;
  for (const p of store.data.products) {
    const hasMoves = store.data.stock_moves.some(m => m.product_id === p.id);
    if (!hasMoves && num(p.stock) !== 0) {
      store.add('stock_moves', {
        date: todayStr(), product_id: p.id, warehouse_id: main.id,
        qty: num(p.stock), reason: 'opening', ref_type: null, ref_id: null,
        memo: t('Opening balance'), balance_after: num(p.stock),
      });
      changed = true;
    }
  }
  if (changed) store.save();
}

/* The single write path for every stock change. qty is signed. */
function recordStockMove({ product_id, warehouse_id, qty, reason, ref_type, ref_id, memo }) {
  const p = store.product(product_id);
  if (!p || !num(qty)) return null;
  ensureWarehouses();
  const wh = warehouse_id || store.data.warehouses[0].id;
  p.stock = Math.round((num(p.stock) + num(qty)) * 1000) / 1000;
  const row = store.add('stock_moves', {
    date: todayStr(), product_id: p.id, warehouse_id: wh,
    qty: num(qty), reason: reason || 'adjustment',
    ref_type: ref_type || null, ref_id: ref_id || null,
    memo: memo || '', balance_after: p.stock,
  });
  store.save();
  return row;
}

/* Per-warehouse quantity for one product, derived from the ledger. */
function productWarehouseStock(productId) {
  const byWh = {};
  for (const m of store.data.stock_moves) {
    if (m.product_id !== productId) continue;
    byWh[m.warehouse_id] = Math.round(((byWh[m.warehouse_id] || 0) + num(m.qty)) * 1000) / 1000;
  }
  return byWh;
}

function warehouseStock(warehouseId) {
  const byProduct = {};
  for (const m of store.data.stock_moves) {
    if (m.warehouse_id !== warehouseId) continue;
    byProduct[m.product_id] = Math.round(((byProduct[m.product_id] || 0) + num(m.qty)) * 1000) / 1000;
  }
  return byProduct;
}

function adjustStock(productId, warehouseId, qty, memo) {
  return recordStockMove({ product_id: productId, warehouse_id: warehouseId, qty, reason: 'adjustment', memo });
}

function transferStock(productId, fromWh, toWh, qty) {
  qty = num(qty);
  if (!(qty > 0) || fromWh === toWh) return null;
  const avail = productWarehouseStock(productId)[fromWh] || 0;
  if (qty > avail + 0.0005) return null;
  const outM = recordStockMove({ product_id: productId, warehouse_id: fromWh, qty: -qty, reason: 'transfer', ref_type: 'transfer', memo: `${t('Transfer out')}` });
  if (!outM) return null;
  recordStockMove({ product_id: productId, warehouse_id: toWh, qty, reason: 'transfer', ref_type: 'transfer', ref_id: outM.id, memo: `${t('Transfer in')}` });
  return outM;
}

/* Integrity: every product's stock equals the sum of its moves. */
function stockInvariants() {
  const bad = [];
  const sum = {};
  for (const m of store.data.stock_moves) sum[m.product_id] = (sum[m.product_id] || 0) + num(m.qty);
  for (const p of store.data.products) {
    const s = Math.round((sum[p.id] || 0) * 1000) / 1000;
    if (Math.abs(s - num(p.stock)) > 0.005) bad.push(`${p.name}: stock ${p.stock} != moves sum ${s}`);
  }
  return bad;
}

/* ---------------- UI ---------------- */

function warehouseFields() {
  return [
    { key: 'name', label: t('Warehouse name'), required: true },
    { key: 'location', label: t('Location'), value: '' },
  ];
}

function renderStock() {
  ensureStockBaseline();
  const violations = stockInvariants();
  const warehouses = store.data.warehouses;
  const products = store.data.products;

  const whRows = warehouses.map(w => {
    const stock = warehouseStock(w.id);
    const units = Object.values(stock).reduce((s, q) => s + q, 0);
    return `<tr><td><div class="cell-main">${esc(w.name)}</div><div class="cell-sub">${esc(w.location || '')}</div></td>
      <td>${Object.keys(stock).length}</td><td>${Math.round(units * 1000) / 1000}</td></tr>`;
  }).join('');

  const matrixRows = products.map(p => {
    const byWh = productWarehouseStock(p.id);
    return `<tr>
      <td><div class="cell-main">${esc(p.name)}</div><div class="cell-sub">${esc(p.sku || '')}</div></td>
      ${warehouses.map(w => `<td>${byWh[w.id] != null ? byWh[w.id] : ''}</td>`).join('')}
      <td><strong>${num(p.stock)}</strong></td>
      <td class="row-actions">
        <button class="icon-btn" data-act="adj" data-id="${p.id}" title="${t('Adjust')}">⚖️</button>
        ${warehouses.length > 1 ? `<button class="icon-btn" data-act="tr" data-id="${p.id}" title="${t('Transfer')}">🔁</button>` : ''}
      </td></tr>`;
  }).join('');

  const moves = store.data.stock_moves.slice().sort((a, b) => b.id - a.id).slice(0, 60).map(m => {
    const p = store.product(m.product_id);
    const w = warehouses.find(x => x.id === m.warehouse_id);
    return `<tr>
      <td>${esc(m.date || '—')}</td>
      <td>${p ? esc(p.name) : '—'}</td>
      <td>${w ? esc(w.name) : '—'}</td>
      <td class="${m.qty < 0 ? 'overdue-text' : ''}">${m.qty > 0 ? '+' : ''}${m.qty}</td>
      <td><span class="badge inactive">${t(m.reason || 'adjustment')}</span></td>
      <td>${m.balance_after != null ? m.balance_after : ''}</td>
      <td>${esc(m.memo || '')}</td></tr>`;
  }).join('');

  $('#view-stock').innerHTML = `
    <div class="view-head">
      <div><h2>${t('Stock ledger')}</h2><div class="sub">${t('Every movement recorded with reason and running balance')}</div></div>
      <div class="head-actions"><button class="secondary-btn" id="addWh">+ ${t('Warehouse')}</button></div>
    </div>
    ${violations.length ? `<div class="card" style="border-color:var(--red)"><h3>${t('Stock integrity violations')}</h3><ul>${violations.map(v => `<li>${esc(v)}</li>`).join('')}</ul></div>` : ''}
    <div class="card"><h3>${t('Warehouses')}</h3>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>${t('Warehouse')}</th><th>${t('Products')}</th><th>${t('Units')}</th></tr></thead>
        <tbody>${whRows}</tbody></table></div></div>
    <div class="card"><h3>${t('Stock by warehouse')}</h3>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>${t('Product')}</th>${warehouses.map(w => `<th>${esc(w.name)}</th>`).join('')}<th>${t('Total')}</th><th></th></tr></thead>
        <tbody>${matrixRows || `<tr><td colspan="${warehouses.length + 3}" class="empty-state">${t('No products yet.')}</td></tr>`}</tbody></table></div></div>
    <div class="card"><h3>${t('Recent movements')}</h3>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>${t('Date')}</th><th>${t('Product')}</th><th>${t('Warehouse')}</th><th>${t('Qty')}</th><th>${t('Reason')}</th><th>${t('Balance')}</th><th>${t('Memo')}</th></tr></thead>
        <tbody>${moves || `<tr><td colspan="7" class="empty-state">${t('No movements yet.')}</td></tr>`}</tbody></table></div></div>`;

  $('#addWh').onclick = () => openModal(t('New warehouse'), warehouseFields(), out => {
    store.add('warehouses', { name: out.name, location: out.location || '' });
    toast(t('Warehouse added'));
    render();
  });
  $('#view-stock').querySelectorAll('button[data-act="adj"]').forEach(btn => {
    btn.onclick = () => {
      const p = store.product(Number(btn.dataset.id));
      openModal(`${t('Adjust stock')} — ${p.name}`, [
        { key: 'warehouse_id', label: t('Warehouse'), type: 'select', options: warehouses.map(w => ({ value: w.id, label: w.name })) },
        { key: 'qty', label: t('Qty (negative to remove)'), type: 'number', required: true },
        { key: 'memo', label: t('Memo'), value: '', full: true },
      ], out => {
        if (!adjustStock(p.id, Number(out.warehouse_id), num(out.qty), out.memo)) { toast(t('Adjustment failed.')); return; }
        toast(t('Stock adjusted'));
        render();
      });
    };
  });
  $('#view-stock').querySelectorAll('button[data-act="tr"]').forEach(btn => {
    btn.onclick = () => {
      const p = store.product(Number(btn.dataset.id));
      openModal(`${t('Transfer stock')} — ${p.name}`, [
        { key: 'from', label: t('From warehouse'), type: 'select', options: warehouses.map(w => ({ value: w.id, label: w.name })) },
        { key: 'to', label: t('To warehouse'), type: 'select', options: warehouses.map(w => ({ value: w.id, label: w.name })) },
        { key: 'qty', label: t('Qty'), type: 'number', required: true },
      ], out => {
        if (!transferStock(p.id, Number(out.from), Number(out.to), num(out.qty))) { toast(t('Transfer failed — check quantities and warehouses.')); return; }
        toast(t('Stock transferred'));
        render();
      });
    };
  });
}

App.views.stock = renderStock;
