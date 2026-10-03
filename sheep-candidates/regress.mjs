/**
 * 抓奶蛙 · 回归测试（一次跑完）
 *
 * 覆盖：
 *   1  启动自检（游戏/动效层/UI 层/兜底桥是否都起来了）
 *   2  三种视口下 HUD 不压标题、不压牌面（390×844 / 320×568 / 844×390）
 *   3  木槽对齐（槽位节距、首张牌偏移、托盘不超出视口 + 槽位底板 9 个凹槽）
 *   4  槽位占用指示同步 + ≥7 格告警
 *   5  真实触摸轻点 = 恰好抓 1 张（不吞、也不重复抓）
 *   6  三消粒子生成与回收
 *   7  过关结算评星 + 选关界面星星
 *   8  过关 → 难度飙升过渡页 → 3 秒自动开下一关
 *   9  第 4 关发牌可解性/刁度门槛生效（最优解托盘峰值 ≤ 上限）
 *  10  JS 报错计数
 *
 * 用法: node regress.mjs [url] [cdpPort]
 */
const URL_TARGET = process.argv[2] || 'file:///C:/Users/YHSome/Projects/OtherProjects/ZhuaNaiWa/index.html';
const CDP_PORT = Number(process.argv[3] || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = []; this.dialogs = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { resolve } = this.pending.get(m.id); this.pending.delete(m.id); resolve(m.result); return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.errors.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
      }
      if (m.method === 'Page.javascriptDialogOpening') { this.dialogs.push(m.params.message); this.send('Page.handleJavaScriptDialog', { accept: true }); }
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
  async touch(type, x, y) {
    return this.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 12, radiusY: 12, force: 1 }] });
  }
  async viewport(w, h) {
    await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
    await sleep(500);
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`);
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
await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await page.viewport(390, 844);
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(3600);

/* ---------- 1. 启动自检 ---------- */
const boot = await page.ev(`(function(){
  var tray = document.querySelector('div[w-295px]');
  return {
    fx: window.__NAIWA_FX__, bridge: window.__NAIWA_TAPBRIDGE__,
    api: !!window.__NAIWA__, ui: !!document.getElementById('nw-ui'),
    cards: [].slice.call(document.querySelectorAll('.card')).filter(function(c){return !c.closest('div[w-295px]');}).length,
    pips: tray ? tray.querySelectorAll(':scope > .nw-slots > i').length : 0,
    fill: tray ? tray.getAttribute('data-fill') : null,
    overlayOpen: !document.querySelector('.nw-overlay').hidden
  };
})()`);
check('启动自检：游戏+动效层+兜底桥+UI 全就绪',
  boot.fx === 'on' && boot.bridge === 'on' && boot.api && boot.ui && boot.cards === 9 && boot.pips === 9,
  `fx=${boot.fx} bridge=${boot.bridge} 盘面=${boot.cards} 槽位底板=${boot.pips} 选关面板=${boot.overlayOpen ? '开' : '关'}`);

/* ---------- 公共：找一张"当前真的能点"的牌 ---------- */
async function pickPoint() {
  return page.ev(`(function(){
    var trayEl = document.querySelector('div[w-295px]');
    var tray = [].slice.call(trayEl.querySelectorAll('.card')).map(function(c){ return c.querySelector('img').alt; });
    var cnt = {}; tray.forEach(function(t){ cnt[t] = (cnt[t] || 0) + 1; });
    var all = document.querySelectorAll('.card').length - tray.length;   // 盘面总牌数（含被压住的）
    var cards = [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]') && !c.querySelector('.mask'); });
    cards.sort(function(a, b){ return (cnt[b.querySelector('img').alt] || 0) - (cnt[a.querySelector('img').alt] || 0); });
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i], r = c.getBoundingClientRect();
      var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      var hit = document.elementFromPoint(x, y);
      if (hit && hit.closest && hit.closest('.card') === c) {
        return { ok: true, x: x, y: y, alt: c.querySelector('img').alt, tray: tray.length, board: all, fill: trayEl.getAttribute('data-fill') };
      }
    }
    return { ok: false, tray: tray.length, board: all };
  })()`);
}

/** 用合成事件点一张盘面上的牌（按坐标重新取元素，避免拿到 Vue 换掉的旧节点） */
async function clickAt(x, y) {
  return page.ev(`(function(){
    var c = document.elementFromPoint(${x}, ${y});
    if (!c) return false;
    c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: ${x}, clientY: ${y} }));
    c.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  })()`);
}

/* 先在托盘里放 3 张不同图案的牌（第 1 关正好 3 种），方便量槽位对齐 */
async function fillTrayDistinct(n) {
  for (let i = 0; i < n; i++) {
    const picked = await page.ev(`(function(){
      var trayEl = document.querySelector('div[w-295px]');
      var tray = [].slice.call(trayEl.querySelectorAll('.card')).map(function(c){ return c.querySelector('img').alt; });
      var cards = [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]') && !c.querySelector('.mask'); });
      for (var i = 0; i < cards.length; i++) {
        var ty = cards[i].querySelector('img').alt;
        if (tray.indexOf(ty) >= 0 && tray.length < 3) continue;      // 优先抓没抓过的图案，避免提前三消
        var r = cards[i].getBoundingClientRect();
        var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
        var hit = document.elementFromPoint(x, y);
        if (!hit || !hit.closest || hit.closest('.card') !== cards[i]) continue;
        var c = cards[i];
        c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: x, clientY: y }));
        c.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return { ok: true, alt: ty };
      }
      return { ok: false };
    })()`);
    await sleep(320);
    if (!picked.ok) break;
  }
}

/* ---------- 1b. 品牌名一致（页面标题 / 游戏大标题 / 选关面板标题） ---------- */
const brand = await page.ev(`(function(){
  var h = document.querySelector('#app > div > div[text-44px]');
  var panel = document.querySelector('.nw-panel .nw-title');
  return { doc: document.title, game: h ? h.textContent.trim() : null, panel: panel ? panel.textContent.trim() : null };
})()`);
check('品牌名一致（都叫抓奶蛙）',
  brand.doc === '抓奶蛙' && brand.game === '抓奶蛙' && brand.panel === '抓奶蛙',
  `页面标题「${brand.doc}」游戏大标题「${brand.game}」选关面板「${brand.panel}」`);

/* ---------- 1c. 图片资源全部可用（离线包裁剪后不能有裂图） ---------- */
const imgs = await page.ev(`(function(){
  var broken = [], ok = 0;
  [].slice.call(document.querySelectorAll('img')).forEach(function(i){
    if (i.complete && i.naturalWidth > 0) ok++;
    else broken.push((i.getAttribute('src') || '?') + (i.getAttribute('alt') ? '[' + i.getAttribute('alt') + ']' : ''));
  });
  return { ok: ok, broken: broken };
})()`);
check('牌面图片全部加载成功（无裂图）', imgs.broken.length === 0,
  `已加载 ${imgs.ok} 张${imgs.broken.length ? '；裂图: ' + imgs.broken.join(', ') : ''}`);

/* ---------- 2/3. 三种视口：HUD 遮挡 + 木槽对齐 ---------- */
const measure = `(function(){
  var hud = document.querySelector('.nw-hud').getBoundingClientRect();
  var bar = document.querySelector('.nw-progress').getBoundingClientRect();
  var title = document.querySelector('#app > div > div[text-44px]');
  var tRect = title ? title.getBoundingClientRect() : null;
  var tray = document.querySelector('div[w-295px]');
  var tr = tray.getBoundingClientRect();
  var pips = [].slice.call(tray.querySelectorAll(':scope > .nw-slots > i')).map(function(p){ return p.getBoundingClientRect(); });
  var cards = [].slice.call(tray.querySelectorAll('.card')).map(function(c){ return c.getBoundingClientRect(); });
  var r1 = function(v){ return Math.round(v * 10) / 10; };
  var board = [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]'); });
  var tops = board.map(function(c){ return c.getBoundingClientRect(); }).filter(function(r){ return r.width > 0; });
  var topMost = tops.length ? Math.min.apply(null, tops.map(function(r){ return r.top; })) : null;
  var over = cards.filter(function(r){ return r.right > tr.right + .5 || r.left < tr.left - .5; }).length;
  return {
    vw: window.innerWidth, vh: window.innerHeight,
    hudTop: Math.round(hud.top), hudBottom: Math.round(hud.bottom),
    barTop: Math.round(bar.top), barBottom: Math.round(bar.bottom), barW: Math.round(bar.width),
    titleBottom: tRect && tRect.height ? Math.round(tRect.bottom) : null,
    topMostCardTop: topMost === null ? null : Math.round(topMost),
    trayW: Math.round(tr.width), trayLeft: Math.round(tr.left), trayRight: Math.round(tr.right),
    pipPitch: pips.length > 1 ? r1(pips[1].left - pips[0].left) : null,
    pip0: pips.length ? r1(pips[0].left) : null,
    cardPitch: cards.length > 1 ? r1(cards[1].left - cards[0].left) : null,
    card0: cards.length ? r1(cards[0].left) : null,
    overflow: over, trayCards: cards.length
  };
})()`;

await page.ev(`document.querySelector('.nw-lv[data-lv="1"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))`);
await sleep(1400);
await fillTrayDistinct(3);
await sleep(300);

const vps = [[390, 844], [320, 568], [844, 390]];
const mrows = [];
for (const [w, h] of vps) {
  await page.viewport(w, h);
  await sleep(350);
  const m = await page.ev(measure);
  mrows.push(m);
  const noTitleClash = m.titleBottom === null || m.hudTop >= m.titleBottom - 1;
  const noCardClash = m.topMostCardTop === null || m.barBottom <= m.topMostCardTop + 1;
  const barUnderHud = m.barTop >= m.hudBottom - 1 && m.barTop - m.hudBottom < 60;
  check(`${w}×${h} HUD+进度条 不压标题/不压牌面`, noTitleClash && noCardClash && barUnderHud,
    `HUD ${m.hudTop}~${m.hudBottom} | 进度条 ${m.barTop}~${m.barBottom} | 标题底 ${m.titleBottom ?? '-'} | 最高牌顶 ${m.topMostCardTop ?? '-'}`);
  const expectPitch = w <= 380 ? 32 : 36;
  const alignOk = m.pipPitch !== null && Math.abs(m.pipPitch - expectPitch) < 0.6
    && m.cardPitch !== null && Math.abs(m.cardPitch - m.pipPitch) < 0.6
    && Math.abs(m.card0 - m.pip0) < 0.6 && m.overflow === 0 && m.trayRight <= m.vw;
  check(`${w}×${h} 木槽对齐（牌位 vs 槽位）`, alignOk,
    `槽位节距 ${m.pipPitch} / 牌节距 ${m.cardPitch}（期望 ${expectPitch}）| 首槽 ${m.pip0} vs 首牌 ${m.card0}`
    + ` | 越界 ${m.overflow} 张 托盘 ${m.trayLeft}~${m.trayRight} / 视口 ${m.vw}（托 ${m.trayCards} 张）`);
}
await page.viewport(390, 844);
await sleep(350);

/* ---------- 4/5/6. 触摸抓牌 + 槽位同步 + 粒子 ---------- */
await page.ev(`(function(){
  var tray = document.querySelector('div[w-295px]');
  window.__sparks = 0;
  new MutationObserver(function(muts){
    muts.forEach(function(m){ [].forEach.call(m.addedNodes, function(n){ if (n.classList && n.classList.contains('zw-spark')) window.__sparks++; }); });
  }).observe(tray, { childList: true });
  return true;
})()`);

// 三次真实触摸：每次只抓 1 张（用"盘面牌数 -1"判定，三消只影响托盘不影响这个数）
const taps = [];
for (let i = 0; i < 3; i++) {
  const p = await pickPoint();
  if (!p.ok) break;
  await page.touch('touchStart', p.x, p.y);
  await sleep(50);
  await page.touch('touchEnd', p.x, p.y);
  await sleep(450);
  const after = await page.ev(`(function(){
    var t = document.querySelector('div[w-295px]');
    return {
      n: t.querySelectorAll('.card').length,
      fill: t.getAttribute('data-fill'),
      full: t.querySelectorAll(':scope > .nw-slots > i.is-full').length,
      danger: t.classList.contains('is-danger'),
      board: [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]'); }).length
    };
  })()`);
  taps.push({ p, after, delta: after.n - p.tray, boardDelta: p.board - after.board });
}
const totalGain = taps.reduce((a, t) => a + Math.max(0, t.delta), 0);
check('真实触摸轻点：每次恰好抓 1 张（不吞不重）',
  taps.length >= 2 && taps.every((t) => t.boardDelta === 1),
  taps.map((t, i) => `第${i + 1}次 盘面 -${t.boardDelta} 托 ${t.p.tray}→${t.after.n}`).join('，') + `（共抓 ${totalGain} 张）`);

const last = taps[taps.length - 1];
check('槽位占用指示与托盘同步',
  last && last.after.fill === String(last.after.n) && last.after.full === last.after.n,
  last ? `托盘 ${last.after.n} 张 / is-full ${last.after.full} 个 / data-fill=${last.after.fill}` : '无样本');

/* ---------- 4c. 进度条数值与剩余牌数一致 ---------- */
const barNow = await page.ev(`(function(){
  var bar = document.querySelector('.nw-progress');
  var i = bar.querySelector('i');
  var m = new DOMMatrixReadOnly(getComputedStyle(i).transform);
  var tray = document.querySelector('div[w-295px]');
  var cards = document.querySelectorAll('.card').length - tray.querySelectorAll('.card').length;
  return { scale: Math.round(m.a * 1000) / 1000, aria: Number(bar.getAttribute('aria-valuenow')), left: cards + tray.querySelectorAll('.card').length };
})()`);
// 本关总张数 = 开始时 9（教程关），已清 = (9 - 剩余) / 9
const expectedScale = (9 - barNow.left) / 9;
check('进度条随清除张数走动（数值对得上）',
  Math.abs(barNow.scale - expectedScale) < 0.02 && barNow.aria === Math.round(expectedScale * 100),
  `剩余 ${barNow.left}/9 → 进度 ${barNow.scale}（期望 ${expectedScale.toFixed(3)}）aria-valuenow=${barNow.aria}`);

/* 凑三消：连续抓同种直到托盘清空一次 */
let matched = null;
for (let i = 0; i < 14 && !matched; i++) {
  const p = await pickPoint();
  if (!p.ok) break;
  await page.ev(`(function(){
    var c = document.elementFromPoint(${p.x}, ${p.y});
    c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: ${p.x}, clientY: ${p.y} }));
    c.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(320);
  const st = await page.ev(`(function(){
    var t = document.querySelector('div[w-295px]');
    return { n: t.querySelectorAll('.card').length, danger: t.classList.contains('is-danger'), sparks: window.__sparks };
  })()`);
  if (st.sparks > 0) matched = st;
}
check('三消粒子生成', matched !== null && matched.sparks > 0, matched ? `粒子 ${matched.sparks} 个` : '未触发三消');
await sleep(900);
const sparkLeft = await page.ev(`document.querySelectorAll('.zw-spark').length`);
check('粒子自动回收（不留垃圾节点）', sparkLeft === 0, `残留 ${sparkLeft} 个`);

/* ---------- 4b. 危险告警：把托盘塞到 7 张不同图案（第 1 关只有 3 种，留到第 4 关测） ---------- */
let dangerState = { n: 0, danger: false, critical: false, picked: 0 };

/* ---------- 7/8. 过关评星 + 难度飙升 → 自动进下一关 ---------- */
await page.viewport(390, 844);
await page.ev(`(function(){ document.querySelector('.nw-btn[data-act="levels"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
await sleep(400);
await page.ev(`(function(){ document.querySelector('.nw-lv[data-lv="1"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
await sleep(1000);
await page.ev(`window.__NAIWA__.start(1)`);
await sleep(900);
// 贪心通关第 1 关（3 种图案，随便点都能过）
await page.ev(`(async function(){
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  for (var step = 0; step < 40; step++) {
    var free = [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]') && !c.querySelector('.mask'); });
    if (!free.length) break;
    var tray = [].slice.call(document.querySelectorAll('div[w-295px] .card')).map(function(c){ return c.querySelector('img').alt; });
    var cnt = {}; tray.forEach(function(t){ cnt[t] = (cnt[t] || 0) + 1; });
    var byType = {}; free.forEach(function(c){ var t = c.querySelector('img').alt; (byType[t] = byType[t] || []).push(c); });
    var pick = free.filter(function(c){ return cnt[c.querySelector('img').alt] === 2; })[0]
            || free.filter(function(c){ return (byType[c.querySelector('img').alt] || []).length >= 2; })[0]
            || free[0];
    pick.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    pick.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(180);
  }
  await sleep(700);
  return true;
})()`);
await sleep(900);
const win = await page.ev(`(function(){
  var panel = document.querySelector('.nw-panel');
  var stars = panel.querySelector('.nw-stars');
  return {
    open: !document.querySelector('.nw-overlay').hidden,
    title: (panel.querySelector('.nw-title') || {}).textContent || '',
    stars: stars ? stars.textContent.trim() : null,
    saved: (JSON.parse(localStorage.getItem('naiwa.progress.v1') || '{}').stars || {})['1'] || 0,
    actions: [].slice.call(panel.querySelectorAll('[data-run]')).map(function(b){ return b.dataset.run; })
  };
})()`);
check('过关结算显示评星并存档', win.stars !== null && win.stars.indexOf('★') >= 0 && win.saved >= 1,
  `标题「${win.title}」评星「${win.stars}」localStorage stars[1]=${win.saved} 按钮 ${win.actions.join('/')}`);

const barWin = await page.ev(`(function(){
  var i = document.querySelector('.nw-progress i');
  return new DOMMatrixReadOnly(getComputedStyle(i).transform).a;
})()`);
check('过关后进度条拉满', barWin > 0.98, `scaleX=${Number(barWin).toFixed(3)}`);

const next = win.actions.find((a) => a.indexOf('下一关') >= 0);
if (next) await page.ev(`(function(){ document.querySelector('.nw-panel [data-run=${JSON.stringify(next)}]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
await sleep(700);
const intro = await page.ev(`(function(){
  var p = document.querySelector('.nw-panel');
  return { spike: !!p.querySelector('.nw-spike'), text: (p.querySelector('.nw-auto') || {}).textContent || '', title: (p.querySelector('.nw-title') || {}).textContent || '' };
})()`);
check('过关后先弹「难度飙升」过渡页', intro.spike, `标题「${intro.title}」倒计时文案「${intro.text}」`);

await sleep(3200);
const lv2 = await page.ev(`(function(){
  return {
    board: [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]'); }).length,
    level: window.__NAIWA__.current(),
    overlay: !document.querySelector('.nw-overlay').hidden
  };
})()`);
check('过渡页 3 秒后自动开下一关', lv2.board === 24 && !lv2.overlay,
  `第 ${lv2.level} 关 盘面 ${lv2.board} 张 面板${lv2.overlay ? '仍开着' : '已关'}`);

/* ---------- 9c. 大牌堆自适应缩放：塔再高也不能顶到 HUD / 压到道具行 ---------- */
const fitRows = [];
// 320×568 这种矮屏，无尽模式自己会把塔高上限降到 4 层（见 endlessMaxLayer），
// 所以这里按"该视口真实能出现的最大塔"来测，不硬塞 6 层。
const fitPlan = [[390, 844, [2, 4, 6]], [320, 568, [2, 4]], [1280, 800, [2, 4, 6]]];
for (const [w, h, layers] of fitPlan) {
  await page.viewport(w, h);
  await sleep(300);
  for (const layer of layers) {
    await page.ev(`(function(){
      window.__NAIWA_LAYER_OVERRIDE__ = ${layer};
      window.__NAIWA_START_ENDLESS__(1, true);
      return true;
    })()`);
    await sleep(1500);
    const m = await page.ev(`(function(){
      var bar = document.querySelector('.nw-progress').getBoundingClientRect();
      var row = document.querySelector('#app > div > div[h-50px][text-center]').getBoundingClientRect();
      var tray = document.querySelector('div[w-295px]').getBoundingClientRect();
      var cards = [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]'); });
      var rs = cards.map(function(c){ return c.getBoundingClientRect(); });
      var hitInfo = function(c){ var r = c.getBoundingClientRect(); var e = document.elementFromPoint(Math.round(r.left + r.width/2), Math.round(r.top + r.height/2));
        return { el: e, ui: !!(e && !(e.closest && e.closest('.card'))) }; };
      var uiBlocked = [], covered = 0;
      cards.forEach(function(c){
        if (c.querySelector('.mask')) return;
        var h = hitInfo(c);
        if (!h.ui) return;
        if (h.el && h.el.closest && h.el.closest('.card') === c) return;
        // 中心命中"非牌面元素"才算出问题；命中别的牌只是被压住（原版规则如此，不算 bug）
        if (h.el && h.el.closest && h.el.closest('.card')) { covered++; return; }
        uiBlocked.push((h.el ? h.el.tagName + '.' + String(h.el.className || '').slice(0, 24) : 'null'));
      });
      return {
        tiles: cards.length,
        top: Math.round(Math.min.apply(null, rs.map(function(r){ return r.top; }))),
        bottom: Math.round(Math.max.apply(null, rs.map(function(r){ return r.bottom; }))),
        left: Math.round(Math.min.apply(null, rs.map(function(r){ return r.left; }))),
        right: Math.round(Math.max.apply(null, rs.map(function(r){ return r.right; }))),
        barBottom: Math.round(bar.bottom), rowTop: Math.round(row.top), trayTop: Math.round(tray.top),
        uiBlocked: uiBlocked, covered: covered, vw: window.innerWidth,
        scale: getComputedStyle(document.querySelector('#app div[relative][flex-1]')).transform
      };
    })()`);
    fitRows.push({ vp: w + 'x' + h, layer, ...m });
  }
}
await page.ev(`delete window.__NAIWA_LAYER_OVERRIDE__`);
// 矮屏：无尽模式自己要把塔高压下来（否则牌堆再缩也放不下）
await page.viewport(320, 568);
await sleep(300);
await page.ev(`(function(){ window.__NAIWA_START_ENDLESS__(9, true); return true; })()`);
await sleep(1500);
const smallCap = await page.ev(`(function(){
  var cards = [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]'); });
  return { tiles: cards.length, info: window.__NAIWA_ENDLESS__ };
})()`);
check('矮屏自动限制塔高（320×568 最高 4 层 / 108 张）',
  smallCap.tiles === 108 && smallCap.info.layer === 4,
  `320×568 上第 9 塔实际只有 ${smallCap.tiles} 张（${smallCap.info.layer} 层）`);
await page.viewport(390, 844);
await sleep(300);
console.log('');
console.log('大牌堆自适应缩放（牌堆要落在"进度条下方 ~ 道具行上方"之间，且不被 UI 挡住）');
console.log(' 视口     | 层 | 张数 | 牌堆纵向      | 上界 | 下界 | 缩放 | 被UI挡 | 被牌压住');
console.log('----------|----|------|---------------|------|------|------|--------|---------');
for (const r of fitRows) {
  const sc = /matrix\(([\d.]+)/.exec(r.scale);
  console.log(` ${r.vp.padEnd(8)} | ${String(r.layer).padStart(2)} | ${String(r.tiles).padStart(4)} | ${String(r.top).padStart(4)}~${String(r.bottom).padStart(4)}      | ${String(r.barBottom).padStart(4)} | ${String(r.rowTop).padStart(4)} | ${(sc ? Number(sc[1]) : 1).toFixed(2)} | ${String(r.uiBlocked.length).padStart(6)} | ${String(r.covered).padStart(6)}`);
}
const fitBad = fitRows.filter((r) => r.top < r.barBottom - 1 || r.bottom > r.rowTop + 1 || r.uiBlocked.length > 0 || r.left < 0 || r.right > r.vw + 1);
check('大牌堆不会顶到 HUD / 压到道具行 / 被 UI 挡住',
  fitBad.length === 0,
  fitBad.length
    ? fitBad.map((r) => `${r.vp}/${r.layer}层 牌堆${r.top}~${r.bottom} 区间${r.barBottom}~${r.rowTop} 被挡${r.uiBlocked.join(',') || '无'}`).join('；')
    : `${fitRows.length} 种尺寸全部落在安全区内（最大 6 层 162 张）`);

/* ---------- 9. 第 4 关发牌门槛 ---------- */await page.ev(`localStorage.setItem('naiwa.progress.v1', JSON.stringify({unlocked:4, cleared:[1,2,3], best:{1:9,2:31,3:58}, stars:{1:3,2:3,3:2}}))`);
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(3400);
const deals = [];
for (let i = 0; i < 5; i++) {
  await page.ev(`(function(){
    window.__NAIWA_SOLVE__ = []; window.__NAIWA_STATS__ = { judged:0, unsolvableAtFirstTry:0, tooTightAtFirstTry:0, rerolls:0, acceptedTight:0 };
    var b = document.querySelector('.nw-lv[data-lv="4"]');
    if (b && !b.disabled) b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    else window.__NAIWA__.start(4);
    return true;
  })()`);
  await sleep(3000);
  const d = await page.ev(`(function(){
    return { solve: window.__NAIWA_SOLVE__, stats: window.__NAIWA_STATS__,
      board: [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]'); }).length };
  })()`);
  deals.push(d);
}
const allSolve = deals.flatMap((d) => d.solve);
const accepted = deals.map((d) => d.solve[d.solve.length - 1]).filter(Boolean);
const statsSum = deals.reduce((a, d) => ({
  judged: a.judged + d.stats.judged, unsolvable: a.unsolvable + d.stats.unsolvableAtFirstTry,
  tooTight: a.tooTight + d.stats.tooTightAtFirstTry, rerolls: a.rerolls + d.stats.rerolls,
}), { judged: 0, unsolvable: 0, tooTight: 0, rerolls: 0 });
check('第 4 关：发牌全部可解且刁度达标',
  accepted.length === deals.length && accepted.every((s) => s.ok && s.maxTray <= s.cap),
  accepted.map((s, i) => `#${i + 1} 峰值${s.maxTray}/${s.cap}${s.try > 1 ? '(重发' + s.try + '次)' : ''}`).join(' '));
check('每关都有验证记录（开局自动发的牌也验）', allSolve.length > 0, `共 ${allSolve.length} 条判定记录；5 轮合计 判${statsSum.judged} 首验不可解${statsSum.unsolvable} 首验偏刁${statsSum.tooTight} 重发${statsSum.rerolls}`);
console.log('   首验峰值分布:', allSolve.filter((s) => s.try === 1).map((s) => s.maxTray).join(', '));

/* ---------- 9b. 第 4 关填托盘：抓 7 种不同图案，验证 ≥7 格告警 ---------- */
await page.ev(`(function(){ window.__NAIWA_SOLVE__ = []; window.__NAIWA__.start(4); return true; })()`);
await sleep(2600);
for (let i = 0; i < 9 && dangerState.n < 7; i++) {
  const got = await page.ev(`(function(){
    var trayEl = document.querySelector('div[w-295px]');
    var tray = [].slice.call(trayEl.querySelectorAll('.card')).map(function(c){ return c.querySelector('img').alt; });
    var cards = [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]') && !c.querySelector('.mask'); });
    for (var i = 0; i < cards.length; i++) {
      var ty = cards[i].querySelector('img').alt;
      if (tray.indexOf(ty) >= 0) continue;                     // 只抓托盘里没有的图案 → 永远凑不成三
      var r = cards[i].getBoundingClientRect();
      var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      var hit = document.elementFromPoint(x, y);
      if (!hit || !hit.closest || hit.closest('.card') !== cards[i]) continue;
      cards[i].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: x, clientY: y }));
      cards[i].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return { ok: true, alt: ty };
    }
    return { ok: false };
  })()`);
  await sleep(300);
  const st = await page.ev(`(function(){
    var t = document.querySelector('div[w-295px]');
    return { n: t.querySelectorAll('.card').length, danger: t.classList.contains('is-danger'), critical: t.classList.contains('is-critical') };
  })()`);
  dangerState = { ...st, picked: i + 1 };
  if (!got.ok) break;
}
check('托盘 ≥7 格触发告警样式（第 4 关）', dangerState.n >= 7 && dangerState.danger,
  `托盘 ${dangerState.n} 张（抓到第 ${dangerState.picked} 种不同图案）| is-danger=${dangerState.danger} is-critical=${dangerState.critical}`);

/* ---------- 10. JS 报错 ---------- */
const audioNoise = page.errors.filter((e) => /NotAllowedError|play\(\)|play request/i.test(e));
const realErrors = page.errors.filter((e) => audioNoise.indexOf(e) < 0);
check('无 JS 异常', realErrors.length === 0,
  realErrors.length ? realErrors.slice(0, 2).join(' | ')
    : `0 条（另有 ${audioNoise.length} 条音频自动播放拒绝：脚本合成点击不算用户手势，真人点击不会出现）`);

const bad = results.filter((r) => !r.ok);
console.log('');
console.log('==== 回归结果：' + (results.length - bad.length) + '/' + results.length + ' 通过 ====');
if (bad.length) console.log('未通过: ' + bad.map((b) => b.name).join('；'));
await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(200);
process.exit(bad.length ? 1 : 0);
