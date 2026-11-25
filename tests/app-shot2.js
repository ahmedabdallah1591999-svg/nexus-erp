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
  console.log('VIEW:' + await evalJs("switchView('" + view + "'); " + (process.argv[7]||'') + "; 'ok'"));
  await sleep(2500);
  const measure = await evalJs(`(() => {
    const over = [...document.querySelectorAll('body *')].filter(e => { const b = e.getBoundingClientRect(); return b.width && (b.right > innerWidth + 1 || b.left < -1); })
      .slice(0, 10).map(e => e.tagName + '.' + String(e.className).split(' ')[0] + '@' + Math.round(e.getBoundingClientRect().right));
    return JSON.stringify({ iw: innerWidth, sw: document.documentElement.scrollWidth, over });
  })()`);
  console.log('MEASURE:' + measure);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('SHOT:' + out);
  ws.close(); chrome.kill('SIGKILL'); process.exit(0);
})().catch(e => { console.error('ERR', e.message); chrome.kill('SIGKILL'); process.exit(1); });
