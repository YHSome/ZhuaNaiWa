/**
 * 通用探针：判断一个网页版小游戏在「静态托管 + 子路径」下能否真正跑起来
 * （等价于 GitHub Pages 的 https://<user>.github.io/<repo>/ 场景）
 *
 * 用法: node probe.mjs <url> [waitSeconds] [cdpPort]
 * 输出: 截图 + 控制台报错 + 失败请求(404 等) + 关键 DOM 状态
 */
import fs from 'node:fs';
import path from 'node:path';

const TARGET_URL = process.argv[2];
const WAIT_S = Number(process.argv[3] || 10);
const CDP_PORT = Number(process.argv[4] || 9222);
const CLICKS = process.argv.slice(5).filter((a) => /^--click=/.test(a)).map((a) => a.slice(8).split(',').map(Number));
const JS_CLICK = process.argv.includes('--jsclick');
const DIAG = process.argv.includes('--diag');
const VIEWPORT = (process.argv.find((a) => /^--viewport=/.test(a)) || '').slice(11);
if (!TARGET_URL) { console.error('用法: node probe.mjs <url> [waitSeconds] [cdpPort] [--click=x,y ...]'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOT_DIR = path.join(import.meta.dirname, 'shots');

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    this.errors = []; this.failed = []; this.bad = []; this.requests = 0;
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
        return;
      }
      const p = m.params || {};
      if (m.method === 'Runtime.exceptionThrown') {
        const d = p.exceptionDetails;
        this.errors.push(d.exception?.description?.split('\n')[0] || d.text);
      }
      if (m.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
        this.errors.push('console.error: ' + p.args.map((a) => a.value ?? a.description).join(' ').split('\n')[0]);
      }
      if (m.method === 'Log.entryAdded' && p.entry.level === 'error') {
        const e = p.entry;
        this.errors.push(`log: ${e.text} ${e.url ? '| ' + e.url : ''}`.slice(0, 200));
      }
      if (m.method === 'Network.requestWillBeSent') this.requests++;
      if (m.method === 'Network.loadingFailed') this.failed.push(`${p.type} ${p.errorText} ${p.requestId}`);
      if (m.method === 'Network.responseReceived' && p.response.status >= 400) {
        this.bad.push(`${p.response.status} ${p.response.url}`);
      }
      for (const cb of this.listeners.get(m.method) || []) cb(p);
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WS 连接失败')), { once: true });
    });
    return new CDP(ws);
  }
  on(m, cb) { if (!this.listeners.has(m)) this.listeners.set(m, []); this.listeners.get(m).push(cb); }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
}

/* 1) 通过 browser endpoint 新开一个标签页 */
const ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
const browser = await CDP.connect(ver.webSocketDebuggerUrl);
const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });

/* 2) 找到这个标签页自己的 WS 地址 */
let pageUrl = null;
for (let i = 0; i < 40 && !pageUrl; i++) {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  pageUrl = list.find((t) => t.id === targetId)?.webSocketDebuggerUrl;
  if (!pageUrl) await sleep(200);
}
if (!pageUrl) throw new Error('找不到新标签页');

const page = await CDP.connect(pageUrl);
await page.send('Runtime.enable');
await page.send('Log.enable');
await page.send('Page.enable');
await page.send('Network.enable');
await page.send('Network.setCacheDisabled', { cacheDisabled: true });   // 否则换图后仍是旧缓存
if (VIEWPORT) {
  const [vw, vh] = VIEWPORT.split('x').map(Number);
  await page.send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 1, mobile: false });
}

const loaded = new Promise((res) => page.on('Page.loadEventFired', res));
await page.send('Page.navigate', { url: TARGET_URL });
await Promise.race([loaded, sleep(20000)]);
await sleep(WAIT_S * 1000);

const state = await page.evaluate(`(() => {
  const cvs = [...document.querySelectorAll('canvas')].map(c => c.width + 'x' + c.height);
  const imgs = [...document.images].filter(i => !i.complete || i.naturalWidth === 0).map(i => i.src).slice(0, 5);
  return {
    title: document.title,
    text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 160),
    canvas: cvs,
    brokenImgs: imgs,
    nodes: document.body ? document.body.querySelectorAll('*').length : 0,
    viewport: window.innerWidth + 'x' + window.innerHeight,
    dpr: window.devicePixelRatio,
    scroll: (document.documentElement.scrollHeight || 0) + 'x' + (document.documentElement.scrollWidth || 0),
  };
})()`);

fs.mkdirSync(SHOT_DIR, { recursive: true });
const safe = TARGET_URL.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_').slice(0, 60) + (VIEWPORT ? '_' + VIEWPORT : '');
async function shot(suffix) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(SHOT_DIR, safe + (suffix ? '-' + suffix : '') + '.png');
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}
const first = await shot('');

/* 可选：模拟点击（用于判断点了「开始」之后还能不能继续玩） */
const clickLog = [];
if (DIAG) {
  const info = await page.evaluate(`(() => {
    const tiles = [...document.querySelectorAll('div,img,span')]
      .filter(e => e.children.length === 0 || e.tagName === 'IMG')
      .map(e => e.className || e.tagName)
      .filter((c, i, a) => c && a.indexOf(c) === i)
      .slice(0, 25);
    return { classes: tiles };
  })()`);
  console.log('leafClasses:', info.classes.join(' | '));
}
for (let i = 0; i < CLICKS.length; i++) {
  const [x, y] = CLICKS[i];
  const hit = await page.evaluate(`(() => {
    const el = document.elementFromPoint(${x}, ${y});
    return el ? (el.tagName + '.' + (el.className || '') + ' | parent=' + (el.parentElement ? el.parentElement.className : '')) : 'null';
  })()`);
  if (JS_CLICK) {
    await page.evaluate(`(() => { const el = document.elementFromPoint(${x}, ${y}); if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true; })()`);
  } else {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
    }
  }
  await sleep(2500);
  const after = await page.evaluate(`(() => {
    const t = document.body ? document.body.innerText.replace(/\\s+/g, ' ').trim() : '';
    return { text: t.slice(0, 120), nodes: document.body ? document.body.querySelectorAll('*').length : 0,
             imgs: document.images.length };
  })()`);
  clickLog.push({ x, y, hit, text: after.text, nodes: after.nodes, imgs: after.imgs });
  await shot('after-click-' + (i + 1));
}

console.log('URL      :', TARGET_URL);
console.log('title    :', state.title);
console.log('canvas   :', state.canvas.join(', ') || '(none)');
console.log('text     :', state.text || '(empty)');
console.log('nodes    :', state.nodes, '| requests:', page.requests, '| viewport:', state.viewport, 'dpr', state.dpr);
console.log('scroll   :', state.scroll);
console.log('brokenImg:', state.brokenImgs.length ? state.brokenImgs : 'none');
console.log('HTTP>=400:', page.bad.length ? page.bad.slice(0, 8) : 'none');
console.log('requestsFailed:', page.failed.length ? page.failed.slice(0, 5) : 'none');
/* 可选：三消自动校验（挑一种有 ≥3 张可点牌的图案，点三张看是否消除） */
if (process.argv.includes('--match3')) {
  const before = await page.evaluate(`document.querySelectorAll('.card').length`);
  const r = await page.evaluate(`(async () => {
    const cards = [...document.querySelectorAll('.card')];
    const free = cards.filter(c => !c.querySelector('.mask') && c.querySelector('img'));
    const byType = {};
    for (const c of free) { const t = c.querySelector('img').alt; (byType[t] = byType[t] || []).push(c); }
    const pick = Object.entries(byType).find(([, arr]) => arr.length >= 3);
    if (!pick) return { ok: false, reason: '没有一种图案有 3 张可点牌', freeTypes: Object.entries(byType).map(([k, v]) => k + ':' + v.length) };
    for (const c of pick[1].slice(0, 3)) { c.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); await new Promise(r => setTimeout(r, 260)); }
    await new Promise(r => setTimeout(r, 1400));
    const tray = [...document.querySelectorAll('div[w-295px] .card')].map(c => c.querySelector('img')?.alt);
    return { ok: true, type: pick[0], cardsBefore: cards.length, cardsAfter: document.querySelectorAll('.card').length, tray, trayCount: tray.length };
  })()`);
  console.log('\n--- 三消校验 ---');
  if (!r.ok) {
    console.log('  跳过：' + (r.reason || JSON.stringify(r)));
  } else {
    console.log(`  点击图案「${r.type}」三张：牌数 ${before} -> ${r.cardsAfter}，托盘剩余 [${(r.tray || []).join(', ')}] ${r.cardsAfter === before - 3 && r.trayCount === 0 ? '✅ 消除正常' : '⚠️ ' + JSON.stringify(r)}`);
  }
}

console.log('jsErrors :', page.errors.length ? page.errors.slice(0, 6) : 'none');
console.log('shot     :', path.relative(process.cwd(), first));
if (clickLog.length) {
  for (const c of clickLog) console.log(`click(${c.x},${c.y}) hit=[${c.hit}] -> nodes=${c.nodes} imgs=${c.imgs} text="${c.text}"`);
}

await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(300);
process.exit(0);
