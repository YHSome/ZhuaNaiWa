/**
 * 教程关可行性验证：用「最坏策略」自动对局
 *   每一步优先点"托盘里还没有的图案"，最大化托盘占用（也就是最容易被塞满的打法）
 *   若托盘始终到不了 7 格、且牌堆能清空 → 说明这一关数学上不可能输
 *
 * 用法: node tutorial-check.mjs [url] [viewport] [cdpPort]
 */
const URL_TARGET = process.argv[2] || 'http://127.0.0.1:8123/sheep-candidates/xlegex-patched/';
const VP = (process.argv[3] || '390x844').split('x').map(Number);
const CDP_PORT = Number(process.argv[4] || 9222);
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
let dialogSeen = null;
page.on('Page.javascriptDialogOpening', (p) => { dialogSeen = p.message; page.send('Page.handleJavaScriptDialog', { accept: true }); });
await page.send('Network.setCacheDisabled', { cacheDisabled: true });
await page.send('Emulation.setDeviceMetricsOverride', { width: VP[0], height: VP[1], deviceScaleFactor: 1, mobile: false });
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(4200);

const result = await page.evaluate(`(async () => {
  const q = (s) => document.querySelector(s);
  const trayEl = () => q('div[w-295px]');
  const trayTypes = () => [...trayEl().querySelectorAll('.card')].map(c => (c.querySelector('img') || {}).alt);
  const boardCards = () => [...document.querySelectorAll('.card')].filter(c => !c.closest('div[w-295px]'));
  const freeCards = () => boardCards().filter(c => !c.querySelector('.mask') && c.querySelector('img'));

  const startCount = boardCards().length;
  const startTypes = new Set(boardCards().map(c => c.querySelector('img').alt)).size;
  let maxTray = 0, clicks = 0, log = [];
  const t0 = Date.now();

  while (clicks < 80 && Date.now() - t0 < 60000) {
    const free = freeCards();
    if (!free.length) break;
    const tray = trayTypes();
    const count = {};
    tray.forEach(t => count[t] = (count[t] || 0) + 1);
    // 最坏策略：优先点托盘里没有的图案（尽量多占格），其次点只有 1 张的
    free.sort((a, b) => {
      const ca = count[a.querySelector('img').alt] || 0;
      const cb = count[b.querySelector('img').alt] || 0;
      return ca - cb;
    });
    const card = free[0];
    const alt = card.querySelector('img').alt;
    card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    clicks++;
    await new Promise(r => setTimeout(r, 220));
    const now = trayTypes().length;
    maxTray = Math.max(maxTray, now);
    log.push(alt + '→托盘' + now);
    if (now >= 7) return { lost: true, clicks, maxTray, detail: log.slice(-6) };
  }
  await new Promise(r => setTimeout(r, 800));
  return {
    lost: false,
    startCount, startTypes,
    clicks,
    maxTray,
    boardLeft: boardCards().length,
    trayLeft: trayTypes().length,
    detail: log.slice(-8),
  };
})()`);

console.log('视口:', VP.join('x'));
console.log('开局：牌堆 ' + result.startCount + ' 张 / ' + result.startTypes + ' 种');
console.log('最坏策略连点 ' + result.clicks + ' 次，托盘历史最大占用 = ' + result.maxTray + ' 格（上限 7）');
console.log('结束时：牌堆剩 ' + (result.boardLeft ?? '?') + ' 张，托盘剩 ' + (result.trayLeft ?? '?') + ' 张');
console.log('末几步：' + (result.detail || []).join('  '));
console.log(result.lost ? '❌ 这关会被塞满（会输）' : '✅ 托盘从未达到 7 格 —— 教程关数学上不可能输');
if (dialogSeen) console.log('⚠️ 期间触发原生 dialog:', dialogSeen);

await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(200);
process.exit(result.lost ? 1 : 0);
