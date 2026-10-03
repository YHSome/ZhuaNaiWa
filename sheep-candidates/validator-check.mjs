/**
 * 可解性验证器实测：直接看 window.__NAIWA_SOLVE__ / __NAIWA_STATS__
 *
 * 做的事：
 *   1. 打印牌面 DOM 的 inline style，确认 top/left/z-index 能被解析（验证器读图的前提）
 *   2. 反复重置到第 4 关（9 种图案 / 54 张，最难的一关），等发牌稳定后读验证结果
 *   3. 统计：首次发牌不可解率、重发次数、每次判定的托盘峰值与牌数
 *
 * 用法: node validator-check.mjs [url] [cdpPort] [rounds]
 */
const URL_TARGET = process.argv[2] || 'file:///C:/Users/YHSome/Projects/OtherProjects/ZhuaNaiWa/index.html';
const CDP_PORT = Number(process.argv[3] || 9222);
const ROUNDS = Number(process.argv[4] || 6);
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
page.on('Page.javascriptDialogOpening', (p) => page.send('Page.handleJavaScriptDialog', { accept: true }));
await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(3500);

// 1) 读图前提检查
const pre = await page.evaluate(`(function(){  var cards = [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]'); });
  var sample = cards.slice(0, 3).map(function(c){ return c.getAttribute('style'); });
  var withZ = cards.filter(function(c){ return /z-?index:/.test(c.getAttribute('style')||''); }).length;
  var withTopLeft = cards.filter(function(c){ return /top:/.test(c.getAttribute('style')||'') && /left:/.test(c.getAttribute('style')||''); }).length;
  var layers = {};
  cards.forEach(function(c){ var z=(/z-?index:\\s*(-?\\d+)/.exec(c.getAttribute('style')||'')||[])[1]; layers[z||'none']=(layers[z||'none']||0)+1; });
  return { cards: cards.length, withZ: withZ, withTopLeft: withTopLeft, layers: layers, sample: sample };
})()`);
console.log('== 牌面 DOM 前提检查 ==');
console.log('盘面牌数:', pre.cards, '| 带 top/left:', pre.withTopLeft, '| 带 z-index:', pre.withZ);
console.log('层分布(z-index → 张数):', JSON.stringify(pre.layers));
console.log('前 3 张 inline style:');
pre.sample.forEach((s) => console.log('   ', s));
console.log('');

// 2) 开局自动发的第 1 关也要被验证（boot 时挂的验证）
const bootSolve = await page.evaluate(`(function(){
  return { c: window.__NAIWA__.current(), solve: window.__NAIWA_SOLVE__, stats: window.__NAIWA_STATS__ };
})()`);
console.log('== 开局自动发牌（第 ' + bootSolve.c + ' 关）==');
console.log('验证记录:', JSON.stringify(bootSolve.solve));
console.log('统计:', JSON.stringify(bootSolve.stats));
console.log('');

// 3) 解锁到第 4 关后重载，让选关按钮走真实路径
await page.evaluate(`localStorage.setItem('naiwa.progress.v1', JSON.stringify({unlocked:4, cleared:[1,2,3], best:{1:12,2:30,3:55}}))`);
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(3500);

// 4) 反复发第 4 关，读验证统计
const rows = [];
const total = { judged: 0, unsolvable: 0, rerolls: 0 };
for (let r = 1; r <= ROUNDS; r++) {
  await page.evaluate(`(function(){
    window.__NAIWA_SOLVE__ = []; window.__NAIWA_STATS__ = { judged:0, unsolvableAtFirstTry:0, rerolls:0 };
    var grid = document.querySelector('[data-lv="4"]');
    if (grid && !grid.disabled) grid.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    else window.__NAIWA__.start(4);
    return true;
  })()`);
  await sleep(3000);
  const res = await page.evaluate(`(function(){
    return {
      stats: window.__NAIWA_STATS__,
      solve: window.__NAIWA_SOLVE__,
      board: [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]'); }).length,
      level: window.__NAIWA__.current()
    };
  })()`);
  rows.push(res);
  total.judged += res.stats.judged;
  total.unsolvable += res.stats.unsolvableAtFirstTry;
  total.rerolls += res.stats.rerolls;
  const first = res.solve[0] || {};
  console.log(
    `第 ${r} 轮 | 关卡 ${res.level} | 盘面 ${res.board} 张 | 首次判定 ${first.ok === true ? '可解 ✅' : first.ok === false ? '不可解 ❌' : '未判定'}`
      + ` | 试算 ${res.solve.length} 次 | 托盘峰值 ${first.maxTray ?? '-'}`
      + (first.ok === false ? `（原因 ${first.reason}）` : '')
  );
  res.solve.forEach((s, i) => { if (i) console.log(`      重发 ${s.try}: ${s.ok ? '可解 ✅' : '不可解 ❌'} 托盘峰值 ${s.maxTray} 牌数 ${s.tiles}`); });
  await sleep(300);
}

console.log('');
console.log('== 汇总（第 4 关，' + ROUNDS + ' 轮）==');
console.log('判定关次:', total.judged, '| 首次发牌不可解:', total.unsolvable, '| 重发次数:', total.rerolls);
const rate = total.judged ? (total.unsolvable / total.judged * 100).toFixed(0) + '%' : '-';
console.log('原生发牌不可解率 ≈', rate, '（这就是"不加重发"时玩家会撞上的坑）');

await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(200);
process.exit(0);
