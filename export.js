'use strict';
/* export.js — Excel (.xlsx) export with a charts sheet, plus Google Drive upload.
   The xlsx file is built directly (via JSZip) so charts rendered on a canvas can be
   embedded as images in a dedicated charts sheet — no server involved. */

/* ---------------- Minimal xlsx writer ---------------- */

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function xesc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function colRef(idx) { // 0-based → A, B, …, Z, AA
  let s = '', n = idx + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function safeSheetName(name, used) {
  let n = String(name).replace(/[\[\]:*?\/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let base = n, i = 2;
  while (used.has(n)) { n = (base.slice(0, 28) + ' ' + i).trim(); i++; }
  used.add(n);
  return n;
}

/* sheets: [{ name, rows: [[cell,…],…] }] — cell is string, number, null.
   images: [{ sheet: <sheet index>, name, base64, widthPx, heightPx, anchorCol, anchorRow }] (all anchored on one sheet is fine) */
async function buildXlsx(sheets, images) {
  const used = new Set();
  sheets.forEach(sh => { sh.safeName = safeSheetName(sh.name, used); });
  const zip = new JSZip();

  const sheetOverrides = sheets.map((sh, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  const hasDrawing = images && images.length;
  const drawingOverride = hasDrawing
    ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : '';

  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${hasDrawing ? '<Default Extension="png" ContentType="image/png"/>' : ''}
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheetOverrides}
${drawingOverride}
</Types>`);

  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);

  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
${sheets.map((sh, i) => `<sheet name="${xesc(sh.safeName)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('\n')}
</sheets>
</workbook>`);

  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((sh, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
</Relationships>`);

  sheets.forEach((sh, i) => {
    const rowsXml = sh.rows.map((row, r) => {
      const cells = row.map((cell, c) => {
        if (cell === null || cell === undefined || cell === '') return '';
        const ref = colRef(c) + (r + 1);
        if (typeof cell === 'number' && Number.isFinite(cell)) return `<c r="${ref}"><v>${cell}</v></c>`;
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xesc(cell)}</t></is></c>`;
      }).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    }).join('\n');
    const chartImages = (images || []).filter(im => im.sheet === i);
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetData>
${rowsXml}
</sheetData>
${chartImages.length ? '<drawing r:id="rId1"/>' : ''}
</worksheet>`);
    if (chartImages.length) {
      zip.folder('xl/worksheets/_rels').file(`sheet${i + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`);
    }
  });

  if (hasDrawing) {
    const anchors = images.map((im, i) => `
<xdr:twoCellAnchor>
<xdr:from><xdr:col>${im.anchorCol || 0}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${im.anchorRow || 0}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
<xdr:to><xdr:col>${(im.anchorCol || 0) + 9}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${(im.anchorRow || 0) + 20}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
<xdr:pic>
<xdr:nvPicPr><xdr:cNvPr id="${i + 2}" name="${xesc(im.name || ('Chart ' + (i + 1)))}"/><xdr:cNvPicPr/></xdr:nvPicPr>
<xdr:blipFill><a:blip r:embed="rId${i + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
<xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
</xdr:pic>
<xdr:clientData/>
</xdr:twoCellAnchor>`).join('\n');

    zip.file('xl/drawings/drawing1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${anchors}
</xdr:wsDr>`);

    zip.file('xl/drawings/_rels/drawing1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${images.map((im, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${i + 1}.png"/>`).join('\n')}
</Relationships>`);

    images.forEach((im, i) => {
      zip.file(`xl/media/image${i + 1}.png`, im.base64, { base64: true });
    });
  }

  const type = (typeof window !== 'undefined' && window.document) ? 'blob' : 'nodebuffer';
  return zip.generateAsync({ type, mimeType: XLSX_MIME, compression: 'DEFLATE' });
}

/* ---------------- Chart rendering (browser canvas) ---------------- */

function renderChartPng(title, entries, color) {
  // entries: [[label, value], …]
  const W = 940, H = 400, padL = 20, padB = 64, padT = 56, padR = 20;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#0f172a'; ctx.font = 'bold 22px Tahoma, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(String(title), W / 2, 34);

  const vals = entries.map(e => Math.max(0, Number(e[1]) || 0));
  const max = Math.max(1, ...vals);
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = entries.length;
  const slot = plotW / Math.max(1, n);
  const barW = Math.min(90, slot * 0.55);

  ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, padT + plotH); ctx.lineTo(W - padR, padT + plotH); ctx.stroke();

  const fmt = v => { try { return new Intl.NumberFormat(localeTag(), { notation: 'compact', maximumFractionDigits: 1 }).format(v); } catch (e) { return String(v); } };

  entries.forEach((e, i) => {
    const v = vals[i];
    const h = Math.round((v / max) * (plotH - 30));
    const x = padL + slot * i + (slot - barW) / 2;
    const y = padT + plotH - h;
    ctx.fillStyle = color;
    if (h > 0) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, barW, h, 4) : ctx.rect(x, y, barW, h); ctx.fill(); }
    ctx.fillStyle = '#0f172a'; ctx.font = '14px Tahoma, Arial, sans-serif';
    ctx.fillText(fmt(v), x + barW / 2, Math.max(padT + 14, y - 8));
    ctx.fillStyle = '#475569'; ctx.font = '13px Tahoma, Arial, sans-serif';
    const label = String(e[0]);
    ctx.fillText(label.length > 16 ? label.slice(0, 15) + '…' : label, x + barW / 2, padT + plotH + 22);
  });

  return canvas.toDataURL('image/png').split(',')[1];
}

/* ---------------- Data → sheets ---------------- */

function exportSheets() {
  const d = store.data;
  const cname = id => { const c = id ? store.contact(id) : null; return c ? contactName(c) : ''; };
  const comp = id => { const c = id ? store.company(id) : null; return c ? c.name : ''; };

  const totals = monthTotals(monthStr());
  const openVal = d.deals.filter(x => OPEN_STAGES.includes(x.stage)).reduce((s, x) => s + num(x.value), 0);
  const wonVal = d.deals.filter(x => x.stage === 'Won').reduce((s, x) => s + num(x.value), 0);
  const outstanding = d.invoices.filter(i => i.status !== 'paid').reduce((s, i) => s + invoiceTotal(i), 0);
  const revenue = d.invoices.filter(i => i.status === 'paid').reduce((s, i) => s + invoiceTotal(i), 0);
  const won = d.deals.filter(x => x.stage === 'Won').length;
  const lost = d.deals.filter(x => x.stage === 'Lost').length;

  const sheets = [];

  sheets.push({
    name: t('Summary'),
    rows: [
      ['أحمد عبدالله بيزنس ديفيلوبمنت — ' + t('Summary'), todayStr()],
      [],
      [t('Contacts'), d.contacts.length],
      [t('Companies'), d.companies.length],
      [t('Open pipeline'), openVal],
      [t('won'), wonVal],
      [t('Outstanding invoices'), outstanding],
      [t('Revenue (paid invoices)'), revenue],
      [t('Income this month'), totals.income],
      [t('Expenses this month'), totals.expense],
      [t('Net this month'), totals.net],
      [t('Stock value (at cost)'), d.products.reduce((s, p) => s + num(p.cost) * num(p.stock), 0)],
      [t('Win rate') + ' %', (won + lost) ? Math.round((won / (won + lost)) * 100) : 0],
    ],
  });

  sheets.push({
    name: t('Contacts'),
    rows: [[t('Name'), t('Company'), t('Email'), t('Phone'), t('Position'), t('Status'), t('Tags'), t('Notes'), t('Date')],
      ...d.contacts.map(c => [contactName(c), comp(c.company_id), c.email || '', c.phone || '', c.position || '', t(c.status || ''), c.tags || '', c.notes || '', (c.created_at || '').slice(0, 10)])],
  });

  sheets.push({
    name: t('Companies'),
    rows: [[t('Company name'), t('Industry'), t('Email'), t('Phone'), t('Website'), t('Address'), t('Notes')],
      ...d.companies.map(c => [c.name || '', c.industry || '', c.email || '', c.phone || '', c.website || '', c.address || '', c.notes || ''])],
  });

  sheets.push({
    name: t('Deals'),
    rows: [[t('Deal title'), t('Value (USD)'), t('Stage'), t('Contact'), t('Company'), t('Expected close'), t('Notes')],
      ...d.deals.map(x => [x.title || '', num(x.value), t(x.stage || ''), cname(x.contact_id), comp(x.company_id), x.expected_close || '', x.notes || ''])],
  });

  sheets.push({
    name: t('Tasks'),
    rows: [[t('Task'), t('Due date'), t('Priority'), t('Done'), t('Contact'), t('Description')],
      ...d.tasks.map(x => [x.title || '', x.due_date || '', t(x.priority || ''), x.done ? t('Done') : '', cname(x.contact_id), x.description || ''])],
  });

  sheets.push({
    name: t('Invoices'),
    rows: [[t('Invoice #'), t('Customer'), t('Issue date'), t('Status'), t('Subtotal'), t('Tax'), t('Total')],
      ...d.invoices.map(i => {
        const sub = invoiceSubtotal(i);
        return [i.number || '', cname(i.contact_id), i.issue_date || '', t(i.status || ''), sub, invoiceTotal(i) - sub, invoiceTotal(i)];
      })],
  });

  sheets.push({
    name: t('Inventory'),
    rows: [[t('Product name'), t('SKU'), t('Category'), t('Price'), t('Cost'), t('Stock'), t('Reorder level')],
      ...d.products.map(p => [p.name || '', p.sku || '', p.category || '', num(p.price), num(p.cost), num(p.stock), num(p.reorder_level)])],
  });

  sheets.push({
    name: t('Suppliers'),
    rows: [[t('Supplier name'), t('Contact person'), t('Email'), t('Phone')],
      ...d.suppliers.map(s => [s.name || '', s.contact_person || '', s.email || '', s.phone || ''])],
  });

  sheets.push({
    name: t('Purchases'),
    rows: [[t('PO #'), t('Supplier'), t('Order date'), t('Status'), t('Total')],
      ...d.purchases.map(p => [p.number || '', (p.supplier_id && store.supplier(p.supplier_id)) ? store.supplier(p.supplier_id).name : '', p.order_date || '', t(p.status || ''), purchaseTotal(p)])],
  });

  sheets.push({
    name: t('Finance'),
    rows: [[t('Date'), t('Type'), t('Category'), t('Amount'), t('Memo')],
      ...d.ledger.map(l => [l.date || '', t(l.type || ''), t(l.category || 'Other'), num(l.amount), l.memo || ''])],
  });

  sheets.push({
    name: t('Employees'),
    rows: [[t('Full name'), t('Department'), t('Monthly salary (USD)'), t('Hire date'), t('Status')],
      ...d.employees.map(e => [e.name || '', e.department || '', num(e.salary), e.hire_date || '', t(e.status || '')])],
  });

  sheets.push({
    name: t('Notes'),
    rows: [[t('Title'), t('Note'), t('Pinned'), t('Date')],
      ...(d.notes || []).map(n => [n.title || '', n.body || '', n.pinned ? t('Yes') : '', (n.created_at || '').slice(0, 10)])],
  });

  return sheets;
}

/* Chart data mirrors the reports module. */
function exportChartImages(chartsSheetIndex) {
  const d = store.data;
  const images = [];
  let row = 0;
  const push = (title, entries, color) => {
    if (!entries.length) return;
    try {
      images.push({ sheet: chartsSheetIndex, name: title, base64: renderChartPng(title, entries, color), anchorCol: 0, anchorRow: row });
      row += 22;
    } catch (e) { console.error('chart render failed', e); }
  };

  const byMonth = {};
  d.invoices.filter(i => i.status === 'paid').forEach(i => {
    const m = (i.issue_date || '').slice(0, 7) || '—';
    byMonth[m] = (byMonth[m] || 0) + invoiceTotal(i);
  });
  push(t('Sales by month (paid invoices)'), Object.keys(byMonth).sort().map(m => [m, byMonth[m]]), '#4f46e5');

  const exp = {};
  d.ledger.filter(l => l.type === 'expense').forEach(l => { exp[t(l.category || 'Other')] = (exp[t(l.category || 'Other')] || 0) + num(l.amount); });
  push(t('Expenses by category'), Object.entries(exp).sort((a, b) => b[1] - a[1]).slice(0, 8), '#dc2626');

  push(t('Deal pipeline'), STAGES.map(s => [t(s), d.deals.filter(x => x.stage === s).reduce((a, x) => a + num(x.value), 0)]), '#0891b2');

  const qty = {};
  d.invoices.filter(i => i.status !== 'draft').forEach(i => (i.items || []).forEach(it => {
    const name = it.product_id && store.product(it.product_id) ? store.product(it.product_id).name : (it.description || t('Custom line'));
    qty[name] = (qty[name] || 0) + num(it.qty);
  }));
  push(t('Top products by units sold'), Object.entries(qty).sort((a, b) => b[1] - a[1]).slice(0, 6), '#16a34a');

  return images;
}

async function buildExcelBlob() {
  const sheets = exportSheets();
  const chartsIndex = sheets.length;
  sheets.push({ name: t('Charts'), rows: [[t('Charts')]] });
  const images = (typeof document !== 'undefined') ? exportChartImages(chartsIndex) : [];
  return buildXlsx(sheets, images);
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function exportExcel() {
  try {
    toast(t('Preparing Excel file…'));
    const blob = await buildExcelBlob();
    downloadBlob(blob, `nexus-erp-${todayStr()}.xlsx`);
    toast(t('Excel file downloaded'));
  } catch (e) {
    console.error(e);
    alert(t('Could not build the Excel file.'));
  }
}

/* ---------------- Google Drive upload ---------------- */

function loadGis() {
  return new Promise((res, rej) => {
    if (window.google && google.accounts && google.accounts.oauth2) return res();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = res;
    s.onerror = () => rej(new Error('GIS load failed'));
    document.head.appendChild(s);
  });
}

function getDriveToken(clientId) {
  return new Promise((res, rej) => {
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: r => { r && r.access_token ? res(r.access_token) : rej(new Error('no token')); },
      error_callback: e => rej(e),
    });
    tc.requestAccessToken();
  });
}

async function exportToDrive() {
  const clientId = (store.data.settings && store.data.settings.driveClientId || '').trim();
  if (!clientId) { openDriveSettings(); return; }
  try {
    toast(t('Preparing Excel file…'));
    const blob = await buildExcelBlob();
    await loadGis();
    const token = await getDriveToken(clientId);
    const filename = `nexus-erp-${todayStr()}.xlsx`;
    const boundary = 'nexus' + Date.now();
    const meta = { name: filename, mimeType: XLSX_MIME };
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${XLSX_MIME}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ], { type: `multipart/related; boundary=${boundary}` });
    const resp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body,
    });
    if (!resp.ok) throw new Error('Drive upload failed: ' + resp.status);
    toast(t('Uploaded to Google Drive'));
  } catch (e) {
    console.error(e);
    if (e && e.type === 'popup_closed') return;
    alert(t('Google Drive upload did not complete. Check the Client ID and your Google sign-in.'));
  }
}

function openDriveSettings() {
  if (!Auth.isAdmin()) { alert(t('Only the admin can set up Google Drive.')); return; }
  const cur = (store.data.settings && store.data.settings.driveClientId) || '';
  openModal(t('Google Drive setup'), [
    { key: 'client_id', label: t('Google OAuth Client ID'), value: cur, full: true, placeholder: 'xxxx.apps.googleusercontent.com' },
  ], out => {
    store.data.settings = store.data.settings || {};
    store.data.settings.driveClientId = (out.client_id || '').trim();
    store.save();
    toast(t('Settings saved'));
  });
}

/* ---------------- Wiring ---------------- */

function bindExcelDrive() {
  const xl = $('#exportExcelBtn');
  if (xl) xl.onclick = () => {
    if (!Auth.isAdmin()) { alert(t('Only the admin can export data.')); return; }
    exportExcel();
  };
  const dr = $('#exportDriveBtn');
  if (dr) dr.onclick = () => {
    if (!Auth.isAdmin()) { alert(t('Only the admin can export data.')); return; }
    exportToDrive();
  };
  const ds = $('#driveSettingsBtn');
  if (ds) ds.onclick = openDriveSettings;
}

/* Node test hook */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildXlsx, safeSheetName, colRef };
}
