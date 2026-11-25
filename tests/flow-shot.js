// Login to the ERP, switch to a view, measure horizontal overflow, screenshot.
// usage: node app-shot.js <baseurl> <view> <outfile> <width> <height>
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const [base, view, out, W, H] = process.argv.slice(2);
const width = parseInt(W || '1440', 10), height = parseInt(H || '900', 10);
const port = 9333;

const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`, '--user-data-dir=/tmp/chromeprof-shot',
  '--disk-cache-size=1', `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch (e) {} });

function jget(path) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let targets = null;
  for (let i = 0; i < 50; i++) { try { targets = await jget('/json/list'); break; } catch (e) { await sleep(200); } }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let mid = 0; const pend = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params) => new Promise(res => { const id = ++mid; pend.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  const evalJs = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const res = r.result || {};
    if (res.exceptionDetails) return 'EXC:' + JSON.stringify(res.exceptionDetails).slice(0, 300);
    return res.result ? res.result.value : undefined;
  };
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/index.html' });
  await sleep(3000);
  const login = await evalJs("(async () => { const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin1234' }) }); const j = await r.json(); if (j.token) sessionStorage.setItem('nexus-erp-server-token', j.token); return 'token=' + !!j.token; })()");
  console.log('LOGIN:' + login);
  await send('Page.navigate', { url: base + '/index.html' });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(3500);
  const auth = await evalJs("(typeof Auth !== 'undefined' && Auth.current) ? Auth.current.username : 'none; stored=' + !!sessionStorage.getItem('nexus-erp-server-token')");
  console.log('AUTH:' + auth);
  const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync('/downloads/' + name, Buffer.from(r.result.data, 'base64')); console.log('SHOT:' + name); };
  const ev = async (js, ms) => { const r = await evalJs(js); await sleep(ms || 1500); return r; };
  console.log(await ev("switchView('purchases'); 'ok'", 2500));
  console.log('OPEN RETURN:', await ev("[...document.querySelectorAll('[data-act=preturn]')].find(b => b.closest('tr').textContent.includes('PO-0001')).click(); document.querySelector('#modalTitle').textContent"));
  await shot('ui1-return-modal.png');
  console.log('FILL:', await ev(`(() => { const f = document.querySelector('#modalForm'); f.querySelector('input[name=q0]').value = 5; f.querySelector('select[name=refund_confirmed]').value = 'credit'; f.querySelector('input[name=reason]').value = 'defective batch'; return [...f.querySelector('select[name=refund_confirmed]').options].map(o => o.textContent).join(' | '); })()`));
  await shot('ui2-return-filled.png');
  console.log('SUBMIT:', await ev("document.querySelector('#modalForm button[type=submit]').click(); 'ok'", 3000));
  console.log('VOIDS+CREDITS:', await ev("[...document.querySelectorAll('[data-usesc]')].length + ' use-credit buttons; void buttons ' + document.querySelectorAll('[data-void]').length"));
  await shot('ui3-after-return.png');
  console.log('OPEN APPLY:', await ev("document.querySelector('[data-usesc]').click(); document.querySelector('#modalTitle').textContent"));
  await shot('ui4-apply-modal.png');
  console.log('SUP DEFAULT AMOUNT:', await ev("document.querySelector('#modalForm [name=amount]').value + ' (credit remaining ' + store.data.supplier_credits[0].remaining + ', purchase open ' + purchaseOpenAmount(store.data.purchases.find(p => String(p.id) === document.querySelector('#modalForm [name=purchase]').value)) + ')'"));
  console.log('APPLY:', await ev(`(() => { const f = document.querySelector('#modalForm'); f.querySelector('input[name=amount]').value = 20; document.querySelector('#modalForm button[type=submit]').click(); return 'ok'; })()`, 3000));
  await shot('ui5-after-apply.png');
  console.log('STATE:', await ev("(() => { const c = store.data.supplier_credits[0]; const p = store.data.purchases.find(x => x.id === c.applications[0].purchase_id); return JSON.stringify({rem: c.remaining, status: c.status, apps: c.applications.length, paid: p.paid_amount}); })()"));
  console.log('VOIDTXT:', await ev("[...document.querySelectorAll('td')].filter(x => x.textContent.includes('cannot') || x.textContent.includes('لا يمكن')).map(x => x.textContent.trim()).join(' / ')"));
  console.log('PAY:', await ev("switchView('payments'); 'ok'", 2500));
  await shot('ui6-payments.png');
  console.log('INV VIEW:', await ev("switchView('invoices'); 'ok'", 2500));
  console.log('OPEN CC:', await ev("document.querySelector('[data-usecc]').click(); document.querySelector('#modalTitle').textContent"));
  console.log('CUST DEFAULT AMOUNT:', await ev("document.querySelector('#modalForm [name=amount]').value + ' (credit remaining ' + store.data.customer_credits[0].remaining + ', invoice open ' + invoiceOpenAmount(store.data.invoices.find(i => String(i.id) === document.querySelector('#modalForm [name=invoice]').value)) + ')'"));
  await shot('ui7-customer-apply-modal.png');
  ws.close(); chrome.kill('SIGKILL'); process.exit(0);
})().catch(e => { console.error('ERR', e.message); chrome.kill('SIGKILL'); process.exit(1); });
