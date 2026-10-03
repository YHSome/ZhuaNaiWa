/**
 * 无尽模式"槽位难度"标定：同一副牌，用不通槽位容量判一次可解性
 *   · 牌越多越容易（9 种图案时牌多 = 同种牌多 = 更好凑三）
 *   · 真正卡人的是槽位容量
 * 用 __NAIWA_JUDGE__(cap) 直接对当前盘面求解，避免重发带来的噪声。
 *
 * 用法: node endless-scale.mjs [url] [cdpPort] [deals]
 */
const URL_TARGET = process.argv[2] || 'file:///C:/Users/YHSome/Projects/OtherProjects/ZhuaNaiWa/index.html';
const CDP_PORT = Number(process.argv[3] || 9222);
const DEALS = Number(process.argv[4] || 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { resolve } = this.pending.get(m.id); this.pending.delete(m.id); resolve(m.result); }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws')), { once: true }); });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => this.pending.set(id, { resolve }));
  }
  async ev(x) {
    const r = await this.send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
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
  if (!wsUrl) await sleep(200);
}
const page = await CDP.connect(wsUrl);
await page.send('Runtime.enable');
await page.send('Page.enable');
await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(3200);
await page.ev(`localStorage.setItem('naiwa.progress.v1', JSON.stringify({unlocked:5, cleared:[1,2,3,4], best:{}, stars:{}}))`);
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(3200);

const CAPS = [9, 8, 7, 6];
const table = [];
for (const layer of [2, 3, 4, 6]) {
  const acc = {}; CAPS.forEach((c) => (acc[c] = { ok: 0, peaks: [], fail: {} }));
  let tiles = 0;
  for (let i = 0; i < DEALS; i++) {
    await page.ev(`(function(){
      window.__NAIWA_LAYER_OVERRIDE__ = ${layer};
      window.__NAIWA_CAP__ = 9;                    // 发牌时先按 9 格，保证牌堆完整
      window.__NAIWA_START_ENDLESS__(1, true);
      return true;
    })()`);
    await sleep(1300);
    const one = await page.ev(`(function(){
      var out = { tiles: [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]'); }).length, caps: {} };
      [9, 8, 7, 6].forEach(function(cap){
        var r = window.__NAIWA_JUDGE__(cap);
        out.caps[cap] = { ok: r.ok, maxTray: r.maxTray, reason: r.reason };
      });
      return out;
    })()`);
    tiles = one.tiles;
    CAPS.forEach((c) => {
      const r = one.caps[c];
      if (r.ok) { acc[c].ok++; acc[c].peaks.push(r.maxTray); }
      else acc[c].fail[r.reason] = (acc[c].fail[r.reason] || 0) + 1;
    });
  }
  table.push({ layer, tiles, acc });
}
await page.ev(`delete window.__NAIWA_LAYER_OVERRIDE__; window.__NAIWA_CAP__ = 9`);

console.log(`每档 ${DEALS} 副牌，同一副牌分别按 9/8/7/6 格托盘判可解性`);
console.log('');
console.log('层数 | 张数 | 9 格 | 8 格 | 7 格 | 6 格   （可解率 / 最优解托盘峰值均值）');
console.log('-----|------|------|------|------|------');
for (const row of table) {
  const cell = (c) => {
    const a = row.acc[c];
    const rate = Math.round((a.ok / DEALS) * 100) + '%';
    const avg = a.peaks.length ? (a.peaks.reduce((x, y) => x + y, 0) / a.peaks.length).toFixed(1) : '-';
    return rate.padStart(4) + (a.ok ? '/' + avg : '    ');
  };
  console.log(`  ${row.layer}  | ${String(row.tiles).padStart(4)} | ${CAPS.map(cell).join(' | ')}`);
}
console.log('');
for (const row of table) {
  const f = Object.entries(row.acc[7].fail).map(([k, v]) => k + '×' + v).join(', ') || '无';
  console.log(`  ${row.layer} 层 · 7 格时失败原因: ${f}`);
}

await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(150);
process.exit(0);
