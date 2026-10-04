/**
 * 手机端"UI 尺寸"体检：把关键元素的真实像素量出来（牌面/图案/木槽/顶栏/按钮/选关文字）
 * 用法: node mobile-size-check.mjs [url] [cdpPort]
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
  async shot(name, dir) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(dir, name + '.png');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(out, Buffer.from(data, 'base64'));
    return name + '.png';
  }
}

const SHOTS = new URL('file://' + process.cwd().replace(/\\/g, '/') + '/sheep-candidates/shots-v2/').pathname.replace(/^\//, '');
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
await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(3400);

const probe = `(function(){
  var px = function(v){ return Math.round(v * 10) / 10; };
  var r = function(sel){ var e = document.querySelector(sel); if (!e) return null; var b = e.getBoundingClientRect(); return { w: px(b.width), h: px(b.height) }; };
  var fs = function(sel){ var e = document.querySelector(sel); return e ? px(parseFloat(getComputedStyle(e).fontSize)) : null; };
  var board = [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]'); });
  var rects = board.map(function(c){ return c.getBoundingClientRect(); }).filter(function(b){ return b.width > 0; });
  var tray = document.querySelector('div[w-295px]');
  var tr = tray ? tray.getBoundingClientRect() : null;
  var tcards = tray ? [].slice.call(tray.querySelectorAll('.card')) : [];
  var scale = getComputedStyle(document.querySelector('#app div[relative][flex-1]')).transform;
  return {
    view: window.innerWidth + '×' + window.innerHeight,
    boardScale: Number((/matrix\\(([\\d.]+)/.exec(scale) || [])[1] || 1).toFixed(3),
    tile: rects.length ? px(rects[0].width) : null,
    tileImg: r('#app div[relative][flex-1] .card img'),
    boardBox: rects.length ? (px(Math.min.apply(null, rects.map(function(b){ return b.left; }))) + '~' + px(Math.max.apply(null, rects.map(function(b){ return b.right; })))
      + ' / ' + px(Math.min.apply(null, rects.map(function(b){ return b.top; }))) + '~' + px(Math.max.apply(null, rects.map(function(b){ return b.bottom; })))) : null,
    trayOuter: tr ? { w: px(tr.width), left: px(tr.left), right: px(tr.right), top: px(tr.top) } : null,
    slot: (function(){ var s = document.querySelector('#app div[w-295px] .nw-slots i'); if (!s) return null; var b = s.getBoundingClientRect(); return { w: px(b.width), h: px(b.height) }; })(),
    trayCard: tcards.length ? px(tcards[0].getBoundingClientRect().width) : '空槽',
    trayImgW: 26,
    hudChipFont: fs('.nw-chip'),
    hudBtn: r('.nw-btn'),
    hudTop: (function(){ var e = document.querySelector('.nw-hud'); return e ? px(e.getBoundingClientRect().top) : null; })(),
    bar: r('.nw-progress'),
    titleFont: fs('#app > div > div[text-44px]'),
    boardAreaTop: rects.length ? px(Math.min.apply(null, rects.map(function(b){ return b.top; }))) : null,
    gapAbove: rects.length ? px(Math.min.apply(null, rects.map(function(b){ return b.top; })) - document.querySelector('.nw-progress').getBoundingClientRect().bottom) : null,
    gapBelowTray: tr ? px(document.querySelector('#app > div > div[h-50px][text-center]').getBoundingClientRect().top - (document.querySelector('div[w-295px]').getBoundingClientRect().bottom)) : null,
    toolBtn: r('#app button'),
    helperFont: fs('.nw-tip')
  };
})()`;

console.log('== 游戏内（开局第 1 关，9 张）==');
for (const [w, h] of [[390, 844], [360, 780], [320, 568]]) {
  await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  const m = await page.ev(probe);
  console.log(` ${m.view.padEnd(9)} 牌堆缩放 ${m.boardScale} | 牌 ${m.tile}px（图案 ${m.tileImg.w}px）| 木槽外宽 ${m.trayOuter.w}px 槽位 ${m.slot ? m.slot.w : '-'}px | 顶栏文字 ${m.hudChipFont}px 按钮 ${m.hudBtn ? m.hudBtn.h + 'px' : '-'} | 道具按钮 ${m.toolBtn ? m.toolBtn.h + 'px' : '-'}`);
  console.log(`           牌堆 ${m.boardBox} | 距顶栏 ${m.gapAbove}px | 木槽顶 ${m.trayOuter.top}px | 标题 ${m.titleFont}px`);
}

// 第 4 关（54 张）和 6 层大塔：看自适应缩放会不会把牌压得太小
await page.ev(`localStorage.setItem('naiwa.progress.v1', JSON.stringify({unlocked:5, cleared:[1,2,3,4], best:{}, stars:{}}))`);
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(3200);
console.log('');
console.log('== 第 4 关（54 张）与大塔（自适应缩放）==');
for (const [w, h] of [[390, 844], [320, 568]]) {
  await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  await page.ev(`(function(){ var b = document.querySelector('.nw-lv[data-lv="4"]'); if (b) b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
  await sleep(1500);
  const m4 = await page.ev(probe);
  await page.ev(`(function(){ window.__NAIWA_START_ENDLESS__(4, true); return true; })()`);
  await sleep(1600);
  const mg = await page.ev(probe);
  console.log(` ${w}×${h}  第4关：牌 ${m4.tile}px 图案 ${m4.tileImg.w}px 缩放 ${m4.boardScale} | 大塔：牌 ${mg.tile}px 图案 ${mg.tileImg.w}px 缩放 ${mg.boardScale}`);
}

console.log('');
console.log('== 选关界面 ==');
await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(300);
await page.ev(`(function(){ var b = document.querySelector('.nw-btn[data-act="levels"]'); if (b) b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
await sleep(600);
const ui = await page.ev(`(function(){
  var px = function(v){ return Math.round(v * 10) / 10; };
  var fs = function(sel){ var e = document.querySelector(sel); return e ? px(parseFloat(getComputedStyle(e).fontSize)) : null; };
  var b = document.querySelector('.nw-lv').getBoundingClientRect();
  var panel = document.querySelector('.nw-panel').getBoundingClientRect();
  return { lv: { w: px(b.width), h: px(b.height) }, lvName: fs('.nw-lv b'), lvMeta: fs('.nw-lv em'), lvNum: px(document.querySelector('.nw-lv i').getBoundingClientRect().width),
    title: fs('.nw-title'), sub: fs('.nw-sub'), tip: fs('.nw-tip'), btn: px(document.querySelector('.nw-actions .nw-btn').getBoundingClientRect().height),
    panelW: px(panel.width) };
})()`);
console.log(` 关卡格子 ${ui.lv.w}×${ui.lv.h}px | 关卡名 ${ui.lvName}px | 描述 ${ui.lvMeta}px | 数字牌 ${ui.lvNum}px`);
console.log(` 面板标题 ${ui.title}px | 副标题 ${ui.sub}px | 提示 ${ui.tip}px | 按钮高 ${ui.btn}px | 面板宽 ${ui.panelW}px`);
try { console.log(' 截图: ' + await page.shot('40-手机端尺寸体检', SHOTS)); } catch (e) { console.log(' 截图失败: ' + e.message); }

await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(150);
process.exit(0);
