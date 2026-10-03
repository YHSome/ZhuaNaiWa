/**
 * 难度验证：自动对局，逐关统计牌数/种类/托盘峰值/胜负
 *
 * 两种策略：
 *   worst   每步优先点"托盘里没有的图案"（尽量多占格，最容易被塞满）
 *   careful 看盘打：优先凑手上已有的 2 张 → 其次选"还有 ≥3 张可点"的图案 → 不得已才开新图案
 *
 * 失败判定：劫持 window.alert —— 输的那一刻游戏会调 alert("槽位已满…")，这是同步信号；
 *           不能只看"托盘是否到 9 格"，因为输掉后游戏会清空牌堆并重启第 1 关，
 *           只看牌堆会被误判成"过关"。
 *
 * 用法: node level-check.mjs [url] [viewport] [cdpPort] [worst|careful] [--only1]
 */
const URL_TARGET = process.argv[2] || 'http://127.0.0.1:8123/sheep-candidates/xlegex-patched/';
const VP = (process.argv[3] || '390x844').split('x').map(Number);
const CDP_PORT = Number(process.argv[4] || 9222);
const STRATEGY = process.argv.slice(5).find((a) => a === 'worst' || a === 'careful') || 'worst';
const ONLY1 = process.argv.includes('--only1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { resolve } = this.pending.get(m.id); this.pending.delete(m.id); resolve(m.result); return; }
      for (const cb of this.listeners.get(m.method) || []) cb(m.params);
    });
  }
  on(m, cb) { if (!this.listeners.has(m)) this.listeners.set(m, []); this.listeners.get(m).push(cb); }
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
  async evaluate(x) {
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
await page.send('Network.enable');
page.on('Page.javascriptDialogOpening', (p) => page.send('Page.handleJavaScriptDialog', { accept: true }));   // 兜底
await page.send('Network.setCacheDisabled', { cacheDisabled: true });
await page.send('Emulation.setDeviceMetricsOverride', { width: VP[0], height: VP[1], deviceScaleFactor: 1, mobile: false });
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(4200);

const out = await page.evaluate(`(${async function (strategy, only1) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let alertCount = 0, lastAlert = null;
  const realAlert = window.alert;
  window.alert = (m) => { alertCount++; lastAlert = m; };      // 同步拿到失败信号

  const q = (s) => document.querySelector(s);
  const trayTypes = () => [...q('div[w-295px]').querySelectorAll('.card')].map(c => (c.querySelector('img') || {}).alt);
  const boardCards = () => [...document.querySelectorAll('.card')].filter(c => !c.closest('div[w-295px]'));
  const freeCards = () => boardCards().filter(c => !c.querySelector('.mask') && c.querySelector('img'));

  const levels = [];
  const t0 = Date.now();
  let guard = 0;

  while (levels.length < 6 && Date.now() - t0 < 180000 && guard++ < 800) {
    if (!boardCards().length) { await sleep(300); continue; }
    const start = boardCards();
    const lv = { cards: start.length, types: new Set(start.map(c => c.querySelector('img').alt)).size, clicks: 0, maxTray: 0, lost: false };
    const alertBefore = alertCount;
    while (lv.clicks < 150) {
      const free = freeCards();
      if (!free.length) break;
      const tray = trayTypes();
      const cnt = {}; tray.forEach(t => cnt[t] = (cnt[t] || 0) + 1);
      const freeByType = {};
      free.forEach(c => { const t = c.querySelector('img').alt; (freeByType[t] = freeByType[t] || []).push(c); });
      const score = (t) => {
        const inTray = cnt[t] || 0, freeN = freeByType[t].length;
        if (strategy !== 'careful') return -inTray * 100 - freeN;
        if (inTray === 2) return 1e6;
        if (freeN >= 3) return 1000 + inTray * 100 + freeN;
        if (inTray > 0) return 500 + inTray * 100 + freeN;
        return freeN * 10;
      };
      free.sort((a, b) => score(b.querySelector('img').alt) - score(a.querySelector('img').alt));
      const card = free[0];
      card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      lv.clicks++;
      await sleep(210);
      lv.maxTray = Math.max(lv.maxTray, trayTypes().length);
      if (alertCount > alertBefore) { lv.lost = true; break; }
    }
    await sleep(600);
    lv.boardLeft = boardCards().length;
    lv.trayLeft = trayTypes().length;
    if (!lv.lost && lv.boardLeft === 0) lv.cleared = true;
    levels.push(lv);
    if (lv.lost || only1) break;
    await sleep(2400);
    if (!boardCards().length) { await sleep(2500); if (!boardCards().length) break; }
  }
  window.alert = realAlert;
  return { levels, alertCount, lastAlert };
}.toString()})(${JSON.stringify(STRATEGY)}, ${ONLY1})`);

console.log('视口:', VP.join('x'), '| 策略:', STRATEGY === 'careful' ? '看盘打' : '最坏策略');
console.log('');
console.log('关卡 | 牌数 | 种类 | 点击 | 托盘峰值 | 结果');
console.log('-----|------|------|------|----------|------');
out.levels.forEach((lv, i) => {
  const verdict = lv.lost ? '❌ 被塞满（输）' : lv.cleared ? '✅ 清空过关' : '⚠️ 未判定（牌堆剩 ' + (lv.boardLeft ?? '?') + '）';
  console.log(`  ${i + 1}  |  ${String(lv.cards).padStart(2)}  |  ${String(lv.types).padStart(2)}  |  ${String(lv.clicks).padStart(2)}  |    ${String(lv.maxTray)}   | ${verdict}`);
});
console.log('');
console.log('全程触发失败 ' + out.alertCount + ' 次' + (out.lastAlert ? '（最后一条："' + out.lastAlert + '"）' : ''));

await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(200);
process.exit(0);
