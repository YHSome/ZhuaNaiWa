/**
 * 无尽模式实测
 *
 * A. 难度来源：层数（牌数）vs 槽位容量
 *      · 只加高层数不会变难（9 种图案下牌越多越好凑三）
 *      · 收窄槽位才是真难度：同一种牌 9 格轻松、7 格连求解器都有 1/3 走不通
 * B. 完整流程：进无尽模式 → 清空第 1 塔 → 自动开第 2 塔（更紧）
 *      → 把托盘塞满 → 挑战结束面板要报出"止步第 N 塔"，并把最高纪录写进 localStorage
 * C. 顺带检查：底部署名行已隐藏、桌面端 HUD 与牌桌同宽
 *
 * 清塔用的是页面内置求解器当"军师"（__NAIWA_HINT__）：它按真实遮挡规则算出一条能通的线，
 * 返回下一步该抓哪种图案，测试照着点即可——这样验证的是"流程"，而不是某个 bot 的运气。
 *
 * 用法: node endless-check.mjs [url] [cdpPort]
 */
const URL_TARGET = process.argv[2] || 'file:///C:/Users/YHSome/Projects/OtherProjects/ZhuaNaiWa/index.html';
const CDP_PORT = Number(process.argv[3] || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { resolve } = this.pending.get(m.id); this.pending.delete(m.id); resolve(m.result); return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.errors.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
      }
      if (m.method === 'Page.javascriptDialogOpening') this.send('Page.handleJavaScriptDialog', { accept: true });
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
  async viewport(w, h) {
    await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
    await sleep(500);
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
await page.viewport(390, 844);
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(3200);
// 解锁到第 5 关（无尽模式随"通关第 4 关"解锁，这里直接给存档，省去真打一遍）
await page.ev(`localStorage.setItem('naiwa.progress.v1', JSON.stringify({unlocked:5, cleared:[1,2,3,4], best:{1:7,2:29,3:64,4:121}, stars:{1:3,2:2,3:1,4:1}}))`);
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(3200);

/* ---------- C1. 署名行已隐藏 ---------- */
const foot = await page.ev(`(function(){
  var d = document.querySelector('#app > div > div[pb-10px]');
  var tip = document.querySelector('#app > div > div[flex-1] > div[text-28px]');
  return { exists: !!d, display: d ? getComputedStyle(d).display : 'n/a', tipDisplay: tip ? getComputedStyle(tip).display : 'n/a' };
})()`);
check('原版署名行已隐藏', foot.exists && foot.display === 'none',
  `署名行 display=${foot.display}（节点还在，只是不显示）| 原版自带文字提示 display=${foot.tipDisplay}`);

/* ---------- C2. 无尽模式格子 ---------- */
const cell = await page.ev(`(function(){
  var b = document.querySelector('.nw-lv[data-lv="5"]');
  if (!b) return { ok: false };
  var r = b.getBoundingClientRect();
  return { ok: true, txt: b.textContent.replace(/\\s+/g,' ').trim(), w: Math.round(r.width), h: Math.round(r.height), disabled: b.disabled,
    gridW: Math.round(document.querySelector('.nw-grid').getBoundingClientRect().width) };
})()`);
check('选关界面出现「无尽模式」横幅格子', cell.ok && !cell.disabled && cell.w > cell.gridW * 0.9,
  `${cell.txt}（${cell.w}×${cell.h}，占满 ${cell.gridW}px 行宽）`);

/* ---------- A. 层数 vs 难度 ---------- */
await page.ev(`(function(){ var b = document.querySelector('.nw-lv[data-lv="5"]'); b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
await sleep(1400);
const tower1 = await page.ev(`(function(){
  return { info: window.__NAIWA_ENDLESS__, hud: document.querySelector('[data-el="level"]').textContent.replace(/\\s+/g,' ').trim(),
    board: [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]'); }).length };
})()`);
check('点「无尽模式」直接开出第 1 塔（3 层 / 81 张 / 9 格）',
  tower1.info && tower1.info.tower === 1 && tower1.info.layer === 3 && tower1.info.tiles === 81
    && tower1.info.cap === 9 && tower1.board === 81,
  `配置 ${JSON.stringify(tower1.info)} | 盘面 ${tower1.board} 张 | 顶栏「${tower1.hud}」`);

const rows = [];
for (const layer of [2, 3, 4, 5, 6]) {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    await page.ev(`(function(){
      window.__NAIWA_LAYER_OVERRIDE__ = ${layer};
      window.__NAIWA_SOLVE__ = []; window.__NAIWA_STATS__ = { judged:0, unsolvableAtFirstTry:0, tooTightAtFirstTry:0, rerolls:0, acceptedTight:0 };
      window.__NAIWA_START_ENDLESS__(1, true);
      return true;
    })()`);
    await sleep(2700);
    const d = await page.ev(`(function(){
      var cards = [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]'); });
      var z = {}; cards.forEach(function(c){ var m = /z-index:\\s*(-?\\d+)/.exec(c.getAttribute('style')||''); if (m) z[m[1]] = 1; });
      return { tiles: cards.length, floors: Object.keys(z).length, solve: window.__NAIWA_SOLVE__, stats: window.__NAIWA_STATS__ };
    })()`);
    samples.push(d);
  }
  const first = samples.map((s) => s.solve[0]).filter(Boolean);
  const peaks = first.map((s) => s.maxTray);
  rows.push({
    layer: layer, tiles: samples[0].tiles, floors: samples[0].floors,
    solvable: first.filter((s) => s.ok).length, n: first.length,
    peakAvg: peaks.length ? (peaks.reduce((a, b) => a + b, 0) / peaks.length).toFixed(1) : '-',
    rerolls: samples.reduce((a, s) => a + s.stats.rerolls, 0),
  });
}
console.log('');
console.log('无尽模式：只加高层数（每档 5 副牌，首验数据）');
console.log(' 层数 | 张数 | 实际层堆 | 可解 | 最优解托盘峰值 | 重发');
console.log('------|------|----------|------|----------------|-----');
for (const r of rows) {
  console.log(`  ${String(r.layer).padStart(2)}  | ${String(r.tiles).padStart(4)} |   ${String(r.floors).padStart(2)}     | ${r.solvable}/${r.n}  |      ${String(r.peakAvg).padStart(4)}      |  ${r.rerolls}`);
}
check('塔越高牌越多（层数→张数线性增长）',
  rows.every((r, i) => i === 0 || r.tiles > rows[i - 1].tiles),
  rows.map((r) => r.layer + '层=' + r.tiles + '张').join(' < '));

/* ---------- A2. 槽位容量才是难度旋钮 ---------- */
const CAP_N = 16;                                      // 样本 16 副：10 副时统计噪声大，偶尔会把方向判反
const capTable = { 9: [], 8: [], 7: [] };
for (let i = 0; i < CAP_N; i++) {
  await page.ev(`(function(){ window.__NAIWA_LAYER_OVERRIDE__ = 3; window.__NAIWA_START_ENDLESS__(1, true); return true; })()`);
  await sleep(1400);
  const r = await page.ev(`(function(){
    return { tiles: window.__NAIWA_JUDGE__(9).tiles, j: { 9: window.__NAIWA_JUDGE__(9), 8: window.__NAIWA_JUDGE__(8), 7: window.__NAIWA_JUDGE__(7) } };
  })()`);
  void r.tiles;
  [9, 8, 7].forEach((c) => capTable[c].push({ ok: r.j[c].ok, peak: r.j[c].maxTray }));
}
const capStat = [9, 8, 7].map((c) => {
  const arr = capTable[c];
  const ok = arr.filter((x) => x.ok);
  return {
    cap: c, rate: Math.round((ok.length / arr.length) * 100),
    peak: ok.length ? (ok.map((x) => x.peak).reduce((a, b) => a + b, 0) / ok.length).toFixed(1) : '-',
  };
});
await page.ev(`delete window.__NAIWA_LAYER_OVERRIDE__`);
console.log('');
console.log('同一批牌（3 层 / 81 张）换托盘容量，' + CAP_N + ' 副牌统计：');
console.log(' 容量 | 求解器可解率 | 最优解峰值均值');
console.log('------|--------------|---------------');
for (const s of capStat) console.log(`  ${String(s.cap).padStart(2)}  |     ${String(s.rate).padStart(3)}%     |      ${s.peak}`);
const gap = capStat[0].rate - capStat[2].rate;
check('收窄槽位确实抬高难度（9 格与 7 格可解率拉开 ≥25 个百分点）',
  gap >= 25 && capStat[0].rate > capStat[1].rate,
  `9 格 ${capStat[0].rate}%（峰值 ${capStat[0].peak}）→ 8 格 ${capStat[1].rate}%（峰值 ${capStat[1].peak}）→ 7 格 ${capStat[2].rate}%（峰值 ${capStat[2].peak}，上限 7）；9 格比 7 格高 ${gap} 个百分点`);

/* ---------- A3. 塔的难度曲线 ---------- */
const curve = await page.ev(`(function(){
  var out = [];
  for (var t = 1; t <= 6; t++) { window.__NAIWA_START_ENDLESS__(t, true); out.push(JSON.parse(JSON.stringify(window.__NAIWA_ENDLESS__))); }
  return out;
})()`);
await sleep(600);
check('塔越高：牌更多 + 托盘更紧（9→8 格）',
  curve.map((c) => c.tiles).join() === '81,108,135,162,162,162'
    && curve.map((c) => c.cap).join() === '9,9,8,8,8,8',
  curve.map((c) => '第' + c.tower + '塔 ' + c.tiles + '张/' + c.cap + '格').join(' → '));

/* 等"发牌验证"彻底停下来再取解法：验证器在开局几秒内可能重发（重发后牌的位置和图案
   全变了，同一条 inline style 会落到别的牌上，计划就废了）。 */
async function waitDealSettled(minQuietMs) {
  for (let k = 0; k < 60; k++) {
    const st = await page.ev(`(function(){
      var s = window.__NAIWA_SOLVE__ || [];
      var last = s.length ? s[s.length - 1] : null;
      return { n: s.length, quiet: last ? Math.round(performance.now() - last.t) : 99999, last: last };
    })()`);
    if (st.n > 0 && st.quiet >= minQuietMs) return st;
    await sleep(300);
  }
  return null;
}

/* ---------- B. 完整流程 ---------- */
// 清掉 A 段留下的验证记录：否则"静默 1.5 秒"会用旧记录判成已稳定，而当前这手牌之后还会重发
await page.ev(`(function(){ window.__NAIWA_TAPLOG__ = []; window.__NAIWA_SOLVE__ = []; window.__NAIWA_START_ENDLESS__(1, true); return true; })()`);
await sleep(800);
const settled = await waitDealSettled(1500);
console.log('   发牌已稳定: ' + (settled ? `${settled.n} 条验证记录，最后一条 ${settled.quiet}ms 前（牌数 ${settled.last.tiles}，重发第 ${settled.last.try} 次）` : '超时'));

/* 塔一开出来就求一条完整解法（每一步指定具体哪张牌，用 inline style 当身份证），
   然后严格照着走。为什么不在每步重算：求解器是"启发式 + 随机兜底"，
   中途重算可能走进它自己找不到通路的死胡同（盘面未必真的无解），那样就不稳。 */
const planInfo = await page.ev(`window.__NAIWA_HINT__()`);
const plan = planInfo.seq;
const tray0 = await page.ev(`[].slice.call(document.querySelectorAll('div[w-295px] .card')).map(function(c){ return c.querySelector('img').alt; })`);
console.log('   第 1 塔解法长度: ' + plan.length + ' 步，最优线托盘峰值 ' + planInfo.maxTray + ' / 9（起始托盘 ' + (tray0.length ? tray0.join(',') : '空') + '）');

async function followPlan(p, startTray, maxMs) {
  const t0 = Date.now();
  let i = 0, swallows = 0, diverge = null;
  const mismatch = [];
  // 按计划类型序列预先推出每一步托盘里应有的牌（模型规则：同种满 3 张立即消掉）
  const expect = [];
  let bag = startTray.slice();
  for (const step of p) {
    bag = bag.concat([step.type]);
    const n = bag.filter((x) => x === step.type).length;
    if (n >= 3) { let need = 3; bag = bag.filter((x) => (x === step.type && need > 0) ? (need--, false) : true); }
    expect.push(bag.slice());
  }
  while (i < p.length && Date.now() - t0 < maxMs) {
    const att = await page.ev(`(function(){
      var panel = document.querySelector('.nw-overlay');
      if (!panel.hidden) {
        var pn = document.querySelector('.nw-panel');
        return { kind: 'panel', spike: (pn.querySelector('.nw-spike')||{}).textContent || '',
          title: (pn.querySelector('.nw-title')||{}).textContent || '' };
      }
      var board = [].slice.call(document.querySelectorAll('.card')).filter(function(c){
        return !c.closest('div[w-295px]') && !/leave-active|leave-to/.test(c.className || '');   // 离场动画里的牌不算
      });
      if (!board.length) return { kind: 'empty' };
      var key = ${JSON.stringify('PLACEHOLDER')};
      var el = null;
      board.forEach(function(c){ if (('id:' + c.__nwId) === key) el = c; });
      if (!el) return { kind: 'gone', key: key, board: board.length };
      if (el.querySelector('.mask')) return { kind: 'masked', key: key, board: board.length };
      var r = el.getBoundingClientRect();
      var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      var hit = document.elementFromPoint(x, y);
      if (!(hit && hit.closest && hit.closest('.card') === el)) return { kind: 'covered', key: key, board: board.length };
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return { kind: 'clicked', board: board.length, type: el.querySelector('img') ? el.querySelector('img').getAttribute('alt') : null, key: key };
    })()`.replace(JSON.stringify('PLACEHOLDER'), JSON.stringify(p[i].key)));
    if (att.kind !== 'clicked') return { ...att, step: i, total: p.length, swallows: swallows, diverge: diverge, log: mismatch.slice(-10) };
    await sleep(300);
    const st = await page.ev(`(function(){
      var trayEl = document.querySelector('div[w-295px]');
      var board = [].slice.call(document.querySelectorAll('.card')).filter(function(c){
        return !c.closest('div[w-295px]') && !/leave-active|leave-to/.test(c.className || '');
      });
      var key = ${JSON.stringify('PLACEHOLDER')};
      var gone = !board.some(function(c){ return ('id:' + c.__nwId) === key; });
      return { board: board.length, gone: gone, tray: [].slice.call(trayEl.querySelectorAll('.card')).map(function(c){ return c.querySelector('img').alt; }) };
    })()`.replace(JSON.stringify('PLACEHOLDER'), JSON.stringify(p[i].key)));
    // 校验：要抓的那张确实被拿走了、而且只少了这一张
    if (!st.gone || st.board !== att.board - 1) {
      swallows++;
      if (swallows > 8) return { kind: 'swallow', step: i, board: att.board, after: st.board, gone: st.gone, swallows: swallows, log: mismatch.slice(-10) };
      continue;
    }
    i++;
    {
      const want = expect[i - 1].slice().sort().join(',');
      const got = st.tray.slice().sort().join(',');
      const bad = want !== got || att.type !== p[i - 1].type;
      mismatch.push({ step: i, planType: p[i - 1].type, clickedType: att.type, want: want, got: got, board: st.board });
      if (bad && !diverge) diverge = { step: i, want: want, got: got, planType: p[i - 1].type, clickedType: att.type };
    }
  }
  return { kind: i >= p.length ? 'done' : 'timeout', step: i, total: p.length, swallows: swallows, diverge: diverge, log: mismatch.slice(-10) };
}

const clearResult = await followPlan(plan, tray0, 180000);
console.log('   清塔结果: ' + JSON.stringify({ kind: clearResult.kind, step: clearResult.step, total: clearResult.total, swallows: clearResult.swallows }));
if (clearResult.log) for (const r of clearResult.log) console.log('     ' + JSON.stringify(r));
if (clearResult.kind === 'empty' || clearResult.kind === 'done') await sleep(900);
const towerPanel = await page.ev(`(function(){
  var ov = document.querySelector('.nw-overlay');
  if (ov.hidden) return { open: false };
  var p = document.querySelector('.nw-panel');
  var spike = p.querySelector('.nw-spike');
  return { open: true, spike: spike ? spike.textContent.trim() : null, sub: (p.querySelector('.nw-sub')||{}).textContent,
    rows: [].slice.call(p.querySelectorAll('.nw-row')).map(function(r){ return r.textContent.replace(/\\s+/g,' ').trim(); }),
    auto: (p.querySelector('[data-el="auto"]')||{}).textContent,
    state: window.__NAIWA_STATE__() };
})()`);
check('清空第 1 塔后弹出「第 1 塔 清空」过渡页',
  towerPanel.open && !!towerPanel.spike && /第 1 塔/.test(towerPanel.spike),
  towerPanel.open
    ? `${towerPanel.spike} | ${towerPanel.sub} | ${towerPanel.rows.join(' / ')} | ${towerPanel.auto}`
    : `面板是关的（清塔结果 ${JSON.stringify(clearResult)}）`);

await sleep(4400);                                       // 等自动开下一塔
const tower2 = await page.ev(`(function(){
  var tray = document.querySelector('div[w-295px]');
  return { info: window.__NAIWA_ENDLESS__, overlay: !document.querySelector('.nw-overlay').hidden,
    board: [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]'); }).length,
    hud: document.querySelector('[data-el="level"]').textContent.replace(/\\s+/g,' ').trim(),
    dataCap: tray.getAttribute('data-cap'), blocked: tray.querySelectorAll(':scope > .nw-slots > i.is-blocked').length,
    state: window.__NAIWA_STATE__() };
})()`);
check('4 秒后自动开出第 2 塔（4 层 / 108 张 / 9 格）',
  tower2.info && tower2.info.tower === 2 && tower2.info.tiles === 108 && tower2.board === 108 && !tower2.overlay
    && tower2.dataCap === '9' && tower2.blocked === 0,
  `第 ${tower2.info && tower2.info.tower} 塔 ${tower2.info && tower2.info.tiles} 张 / 托盘 ${tower2.info && tower2.info.cap} 格 | 盘面 ${tower2.board} 张`
  + ` | 槽位底板 data-cap=${tower2.dataCap} 封住 ${tower2.blocked} 格 | 纪录 ${tower2.state.best} 塔`);

// 塞满托盘（只点托盘里没有的图案，保证不会三消）→ 挑战结束
await page.ev(`(async function(){
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  for (var i = 0; i < 12; i++) {
    if (!document.querySelector('.nw-overlay').hidden) break;
    var tray = [].slice.call(document.querySelectorAll('div[w-295px] .card')).map(function(c){ return c.querySelector('img').alt; });
    var cards = [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]') && !c.querySelector('.mask'); });
    var ok = false;
    for (var k = 0; k < cards.length; k++) {
      var ty = cards[k].querySelector('img').alt;
      if (tray.indexOf(ty) >= 0) continue;
      var r = cards[k].getBoundingClientRect();
      var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      var hit = document.elementFromPoint(x, y);
      if (!hit || !hit.closest || hit.closest('.card') !== cards[k]) continue;
      cards[k].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: x, clientY: y }));
      cards[k].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      ok = true; break;
    }
    if (!ok) break;
    await sleep(320);
  }
  await sleep(1400);
  return true;
})()`);
await sleep(600);
const over = await page.ev(`(function(){
  var ov = document.querySelector('.nw-overlay');
  if (ov.hidden) return { open: false, state: window.__NAIWA_STATE__() };
  var p = document.querySelector('.nw-panel');
  return { open: true, title: (p.querySelector('.nw-title')||{}).textContent,
    sub: (p.querySelector('.nw-sub')||{}).textContent,
    stats: [].slice.call(p.querySelectorAll('.nw-stat')).map(function(s){ return s.textContent.replace(/\\s+/g,' ').trim(); }),
    saved: JSON.parse(localStorage.getItem('naiwa.progress.v1')||'{}').endlessBest || 0,
    state: window.__NAIWA_STATE__() };
})()`);
check('托盘塞满 = 挑战结束，面板报出止步塔数与最高纪录',
  over.open && /挑战结束/.test(over.title || '') && /第 2 塔/.test(over.sub || '') && over.saved === 2,
  over.open
    ? `${over.title} / ${over.sub} | ${over.stats.join(' / ')} | localStorage 最高 ${over.saved} 塔`
    : '面板是关的（托盘没塞满？）状态 ' + JSON.stringify(over.state));

/* ---------- C3. 桌面端 HUD 与牌桌同宽 ---------- */
await page.viewport(1440, 900);
await page.ev(`(function(){ var b = document.querySelector('.nw-btn[data-act="levels"]'); if (b) b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
await sleep(700);
const desk = await page.ev(`(function(){
  var app = document.querySelector('#app').getBoundingClientRect();
  var hud = document.querySelector('.nw-hud').getBoundingClientRect();
  var bar = document.querySelector('.nw-progress').getBoundingClientRect();
  var panel = document.querySelector('.nw-panel').getBoundingClientRect();
  var r = function(b){ return Math.round(b.left) + '~' + Math.round(b.right); };
  return { app: r(app), appW: Math.round(app.width), hud: r(hud), bar: r(bar), panel: r(panel),
    vw: window.innerWidth, top: Math.round(app.top), h: Math.round(app.height) };
})()`);
const aligned = Math.abs(parseFloat(desk.hud.split('~')[0]) - parseFloat(desk.app.split('~')[0])) < 30
  && Math.abs(parseFloat(desk.bar.split('~')[1]) - parseFloat(desk.app.split('~')[1])) < 30
  && parseFloat(desk.hud.split('~')[1]) < desk.vw * 0.75;
check('桌面端 HUD / 进度条与牌桌同宽（不再摊到整窗口）', aligned,
  `视口 ${desk.vw} | 牌桌 ${desk.app}（宽 ${desk.appW}，高 ${desk.h}）| HUD ${desk.hud} | 进度条 ${desk.bar} | 面板 ${desk.panel}`);

const realErrors = page.errors.filter((e) => !/NotAllowedError|play\(\)/i.test(e));
check('无 JS 异常', realErrors.length === 0, realErrors.length ? realErrors.slice(0, 2).join(' | ') : '0 条');

const bad = results.filter((r) => !r.ok);
console.log('');
console.log('==== 无尽模式验证：' + (results.length - bad.length) + '/' + results.length + ' 通过 ====');
if (bad.length) console.log('未通过: ' + bad.map((b) => b.name).join('；'));
await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(150);
process.exit(bad.length ? 1 : 0);
