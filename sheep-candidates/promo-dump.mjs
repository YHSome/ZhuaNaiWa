/**
 * 从真游戏里导出一局"第 4 关"的牌面 + 求解器给的解法顺序，
 * 写进 promo/board-data.js 供宣传片使用——这样宣传片里的牌位、层级、
 * 以及"抓到第 3 张相同的才消"都是真游戏的规则，不会再出现"没凑够三个就消了"。
 *
 * 用法: node promo-dump.mjs [cdpPort] [取前几步(默认18)]
 */
import fs from 'node:fs';
import path from 'node:path';

const CDP_PORT = Number(process.argv[2] || 9222);
const STEPS = Number(process.argv[3] || 18);
const OUT = path.join(import.meta.dirname, '..', 'promo', 'board-data.js');
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
const URL_TARGET = process.argv[4] || 'file:///C:/Users/YHSome/Projects/OtherProjects/ZhuaNaiWa/index.html';
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(3200);
await page.ev(`localStorage.setItem('naiwa.progress.v1', JSON.stringify({unlocked:5, cleared:[1,2,3,4], best:{}, stars:{}}))`);
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(3200);

// 开第 4 关，等发牌验证停稳（避免导出到"半路重发"的牌）
await page.ev(`(function(){ window.__NAIWA_SOLVE__ = []; var b = document.querySelector('.nw-lv[data-lv="4"]'); if (b) b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
await sleep(6000);
const raw = await page.ev(`(function(){
  var cards = [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]'); });
  var out = cards.map(function(c){
    var st = c.getAttribute('style') || '';
    return {
      id: c.__nwId,
      type: Number(c.querySelector('img').getAttribute('alt')),
      top: parseFloat((/top:\\s*(-?[\\d.]+)px/.exec(st) || [])[1]),
      left: parseFloat((/left:\\s*(-?[\\d.]+)px/.exec(st) || [])[1]),
      z: parseInt((/z-index:\\s*(-?\\d+)/.exec(st) || [])[1], 10) || 0
    };
  });
  var hint = window.__NAIWA_HINT__();
  return { tiles: out, seq: (hint.seq || []).map(function(s){ return { id: s.key, type: String(s.type) }; }), ok: hint.ok, peak: hint.maxTray, solve: window.__NAIWA_SOLVE__.slice(-3) };
})()`);

const tiles = raw.tiles.filter((t) => isFinite(t.top) && isFinite(t.left));
const xs = tiles.map((t) => t.left), ys = tiles.map((t) => t.top);
const box = { minX: Math.min.apply(null, xs), maxX: Math.max.apply(null, xs), minY: Math.min.apply(null, ys), maxY: Math.max.apply(null, ys) };
const seq = raw.seq.slice(0, STEPS);
// 解法里每一步要能对应到牌面上的牌
const byId = {};
tiles.forEach((t) => { byId['id:' + t.id] = t; });
const seqOk = seq.filter((s) => byId[s.id]).length;

const js = `/* 由 sheep-candidates/promo-dump.mjs 从真游戏导出：第 4 关的一副真牌 + 求解器给的取牌顺序
   牌面：${tiles.length} 张，层级 ${Math.max.apply(null, tiles.map((t) => t.z)) + 1} 层，
   未缩放的原始坐标范围 x ${box.minX}~${box.maxX} / y ${box.minY}~${box.maxY}（游戏里每张 40px）
   顺序取自 __NAIWA_HINT__（贪心求解器），宣传片照着取，所以每一步都点得到、且第 3 张同色才消 */
window.REAL_BOARD = ${JSON.stringify({ tiles: tiles, seq: seq, tilePx: 40, box: box }, null, 0)};
`;
fs.writeFileSync(OUT, js, 'utf8');

console.log('牌面 ' + tiles.length + ' 张（层级 ' + (Math.max.apply(null, tiles.map((t) => t.z)) + 1) + ' 层）');
console.log('坐标范围 x ' + box.minX + '~' + box.maxX + ' / y ' + box.minY + '~' + box.maxY);
console.log('解法前 ' + seq.length + ' 步，能对上牌面的 ' + seqOk + ' 步；求解器：' + (raw.ok ? '有解，托盘峰值 ' + raw.peak : '没找到通路'));
console.log('取法顺序的类型: ' + seq.map((s) => s.type).join(','));
console.log('已写入 ' + path.relative(process.cwd(), OUT));

await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(150);
process.exit(0);
