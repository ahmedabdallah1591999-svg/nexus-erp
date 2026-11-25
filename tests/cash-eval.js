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
  const res = await evalJs("JSON.stringify([cashMovementReport(" + JSON.stringify(process.argv[7]) + "," + JSON.stringify(process.argv[8]) + "), (typeof cashAccrualCard==='function')])");
  console.log('REPORT:' + res);
  if (process.argv[9]) {
    const b64 = await evalJs("(async () => { const b = await buildExcelBlob(); const buf = await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); }); return buf.split(',')[1]; })()");
    if (typeof b64 === 'string' && !b64.startsWith('EXC:')) { fs.writeFileSync(process.argv[9], Buffer.from(b64, 'base64')); console.log('XLSX_OK'); } else console.log('XLSX_FAIL ' + b64);
    console.log('TOTALS:' + await evalJs("JSON.stringify(monthTotals(monthStr()))"));
  }
  const html = await evalJs("(() => { switchView('finance'); return 'ok'; })()"); await sleep(1500);
  const txt = await evalJs("document.querySelector('#view-finance') ? document.querySelector('#view-finance').innerText.length : -1");
  console.log('FINANCE_TEXT_LEN:' + txt);
  ws.close(); chrome.kill('SIGKILL'); process.exit(0);
})().catch(e => { console.error('ERR', e.message); chrome.kill('SIGKILL'); process.exit(1); });
