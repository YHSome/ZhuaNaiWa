/** 托盘对齐量尺：抓几张牌进托盘，打印托盘内容盒与每张落牌的坐标，用来把槽位线对齐 */
const URL_TARGET = process.argv[2] || 'http://127.0.0.1:8123/sheep-candidates/xlegex-patched/';
const CLICKS = Number(process.argv[3] || 3);
const VP = (process.argv[4] || '390x844').split('x').map(Number);
const CDP_PORT = Number(process.argv[5] || 9222);

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve } = this.pending.get(m.id);
        this.pending.delete(m.id);
        resolve(m.result);
        return;
      }
      for (const cb of this.listeners.get(m.method) || []) cb(m.params);
    });
  }
  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => this.pending.set(id, { resolve }));
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
}

const ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
const browser = await CDP.connect(ver.webSocketDebuggerUrl);
const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i++) {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  wsUrl = list.find((t) => t.id === targetId)?.webSocketDebuggerUrl;
  if (!wsUrl) await new Promise((r) => setTimeout(r, 200));
}
const page = await CDP.connect(wsUrl);
await page.send('Runtime.enable');
await page.send('Network.enable');
await page.send('Page.enable');
// 托盘塞满会弹原生 dialog，会把渲染进程卡住 → 自动确认
page.on('Page.javascriptDialogOpening', (p) => {
  console.log('⚠️ 触发原生 dialog:', JSON.stringify(p));
  page.send('Page.handleJavaScriptDialog', { accept: true });
});
await page.send('Network.setCacheDisabled', { cacheDisabled: true });
await page.send('Emulation.setDeviceMetricsOverride', { width: VP[0], height: VP[1], deviceScaleFactor: 1, mobile: false });
await page.send('Page.navigate', { url: URL_TARGET });
await new Promise((r) => setTimeout(r, 4000));

const out = await page.evaluate(`(async () => {
  // 抓 N 张不同类型的可点牌，凑出 N 个落牌
  const free = [...document.querySelectorAll('.card')].filter(c => !c.querySelector('.mask') && c.querySelector('img'));
  const seen = new Set();
  let picked = 0;
  for (const c of free) {
    const t = c.querySelector('img').alt;
    if (seen.has(t)) continue;
    seen.add(t);
    c.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    picked++;
    await new Promise(r => setTimeout(r, 260));
    if (picked >= ${CLICKS}) break;
  }
  await new Promise(r => setTimeout(r, 900));

  const tray = document.querySelector('div[w-295px]');
  if (!tray) return { error: '找不到托盘' };
  const tcs = getComputedStyle(tray);
  const tr = tray.getBoundingClientRect();
  const dockCards = [...tray.querySelectorAll('.card')];
  const cards = dockCards.map((c, i) => {
    const r = c.getBoundingClientRect();
    return { i, alt: c.querySelector('img')?.alt, left: +(r.left - tr.left).toFixed(2), top: +(r.top - tr.top).toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2), transform: getComputedStyle(c).transform };
  });
  return {
    picked,
    tray: {
      box: Math.round(tr.width) + 'x' + Math.round(tr.height),
      client: tray.clientWidth + 'x' + tray.clientHeight,
      border: tcs.borderTopWidth, padding: tcs.padding, gap: tcs.columnGap, justify: tcs.justifyContent, align: tcs.alignItems,
      boxSizing: tcs.boxSizing,
      bgLayers: tcs.backgroundImage.split('),').length,
    },
    cards,
    // 相邻落牌的中心距，应该等于「槽位节距」
    pitch: cards.length > 1 ? +(cards[1].left - cards[0].left).toFixed(2) : null,
  };
})()`);

if (out.error) { console.log('❌', out.error); process.exit(1); }
console.log('抓入托盘张数:', out.picked);
console.log('托盘:', JSON.stringify(out.tray, null, 1));
console.log('落牌:');
out.cards.forEach((c) => console.log(`  #${c.i} alt=${c.alt} left=${c.left} top=${c.top} size=${c.w}x${c.h} transform=${c.transform}`));
console.log('落牌节距 pitch =', out.pitch);

/* 截图存档：此时托盘里有牌，正好看槽位对齐 */
import fs from 'node:fs';
import path from 'node:path';
const dir = path.join(import.meta.dirname, 'shots');
fs.mkdirSync(dir, { recursive: true });
const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
const file = path.join(dir, `dock-${VP.join('x')}.png`);
fs.writeFileSync(file, Buffer.from(data, 'base64'));
console.log('截图:', path.relative(process.cwd(), file));

await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
process.exit(0);
