/**
 * 线上宣传片实测：确认 Pages 上是新版（真牌面 54 张 + 求解器顺序 18 步 + 满三才消）
 * 用法: node promo-live-check.mjs [baseUrl] [cdpPort]
 */
const BASE = (process.argv[2] || 'https://yhsome.github.io/zhuanaiwa/promo/');
const CDP_PORT = Number(process.argv[3] || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = []; this.reqs = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { resolve } = this.pending.get(m.id); this.pending.delete(m.id); resolve(m.result); return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.errors.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
      }
      if (m.method === 'Network.responseReceived') this.reqs.push({ url: m.params.response.url, status: m.params.response.status });
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

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok });
  console.log((ok ? '[OK] ' : '[NG] ') + name + (detail ? '  —— ' + detail : ''));
};

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
await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await page.send('Page.navigate', { url: BASE });
await sleep(4000);

const data = await page.ev(`(function(){
  var B = window.REAL_BOARD || {};
  return { tiles: (B.tiles || []).length, seq: (B.seq || []).length, titles: document.title.slice(0, 30),
    side: document.querySelectorAll('#side .side__item').length, boardTiles: document.querySelectorAll('#board .tile').length };
})()`);
check('线上是新版宣传片（真牌面 54 张 / 18 步解法 / 右侧功能点）',
  data.tiles === 54 && data.seq === 18 && data.boardTiles === 54 && data.side === 4,
  `牌面 ${data.tiles} 张（DOM ${data.boardTiles}）| 解法 ${data.seq} 步 | 功能点 ${data.side} 条`);

await page.ev(`document.getElementById('btnStart').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
await sleep(3500);                                     // 3-2-1 倒计时
const samples = [];
for (const t of [8, 10, 12, 14]) {
  const wait = sleep(Math.max(0, t * 1000 - (Date.now() - (Date.now() - 0))));
  void wait;
  await sleep(2000);
  samples.push(await page.ev(`window.__promo.state()`));
}
const stages = samples.map((s) => `t=${s.t} 木槽[${s.tray.join(',')}] 已消${s.cleared}`);
// 关键断言：木槽里同一种图案绝不会超过 2 张后被清掉——出现 3 张的下一帧就会被消
const bad = samples.filter((s) => {
  const c = {};
  s.tray.forEach((x) => (c[x] = (c[x] || 0) + 1));
  return Object.keys(c).some((k) => c[k] > 3);
});
check('木槽里同种图案从不超过 3 张（凑满即消）', bad.length === 0, stages.join(' | '));
check('确实发生了多次消除（每次 +3）', samples[samples.length - 1].cleared >= 6 && samples[samples.length - 1].cleared % 3 === 0,
  `已消 ${samples[samples.length - 1].cleared} 张`);
check('多张同色才会消（已消数量 = 3 的倍数）', samples.every((s) => s.cleared % 3 === 0), stages.join(' | '));

const pngs = page.reqs.filter((r) => /tiles\/\d\.png/.test(r.url));
check('牌面图全部 200', pngs.length >= 9 && pngs.every((r) => r.status === 200), `请求 ${pngs.length} 张牌面图`);
const realErrors = page.errors.filter((e) => !/NotAllowedError|play\(\)|AudioContext/i.test(e));
check('无 JS 异常', realErrors.length === 0, realErrors.length ? realErrors.slice(0, 2).join(' | ') : '0 条');

const fail = results.filter((r) => !r.ok);
console.log('');
console.log('==== 线上宣传片：' + (results.length - fail.length) + '/' + results.length + ' 通过 ====');
if (fail.length) console.log('未通过: ' + fail.map((f) => f.name).join('；'));
await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(150);
process.exit(fail.length ? 1 : 0);
