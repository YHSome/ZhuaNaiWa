/** 牌面统计：打开游戏后打印牌堆实际张数与图案种类（用来确认关卡配置真的生效） */
const URL_TARGET = process.argv[2] || 'http://127.0.0.1:8123/sheep-candidates/xlegex-patched/';
const CDP_PORT = Number(process.argv[3] || 9222);

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve } = this.pending.get(m.id);
        this.pending.delete(m.id);
        resolve(m.result);
      }
    });
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
await page.send('Network.setCacheDisabled', { cacheDisabled: true });
await page.send('Page.navigate', { url: URL_TARGET });
await new Promise((r) => setTimeout(r, 4000));

const stats = await page.evaluate(`(async () => {
  const t0 = Date.now();
  while (document.querySelectorAll('.card').length === 0 && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 200));
  const cards = [...document.querySelectorAll('.card')];
  const alts = cards.map(c => c.querySelector('img')?.alt).filter(Boolean);
  const counted = alts.reduce((m, a) => (m[a] = (m[a] || 0) + 1, m), {});
  const free = cards.filter(c => !c.querySelector('.mask')).length;
  return {
    cards: cards.length,
    types: new Set(alts).size,
    perType: counted,
    freeCards: free,
    trayEmpty: !document.querySelector('div[w-295px] .card'),
  };
})()`);

console.log('牌堆张数 :', stats.cards);
console.log('图案种类 :', stats.types);
console.log('每种张数 :', JSON.stringify(stats.perType));
console.log('当前可点 :', stats.freeCards, '张');

await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
process.exit(0);
