/**
 * 触摸诊断：用真实 touch 事件点牌，并记录页面实际收到的事件序列
 *   · 单击（touchStart → touchEnd，间隔 ~60ms）
 *   · 长按（touchStart → 600ms → touchEnd）
 *   · 对照：纯 mouse 事件
 * 看"触摸后有没有 click 事件"以及"牌有没有被抓进托盘"，定位是事件被吞还是逻辑没跑
 */
import fs from 'node:fs';
import path from 'node:path';

const URL_TARGET = process.argv[2];
const CDP_PORT = Number(process.argv[3] || 9222);
const OUT = path.join(import.meta.dirname, 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { resolve } = this.pending.get(m.id); this.pending.delete(m.id); resolve(m.result); return; }
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.text);
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
    return this.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 12, radiusY: 12, force: 1 }],
    });
  }
  async shot(name) {
    fs.mkdirSync(OUT, { recursive: true });
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64'));
    return 'shots/' + name + '.png';
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
// 真机手感：移动端视口 + 触摸模拟
await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(4200);

/* 装一个事件记录器，看页面到底收到了什么 */
await page.ev(`(() => {
  window.__EV__ = [];
  const rec = (e) => window.__EV__.push(e.type + (e.isTrusted ? '' : '?'));
  ['pointerdown','pointerup','touchstart','touchend','mousedown','mouseup','click','contextmenu'].forEach(t =>
    document.addEventListener(t, rec, true));
  // 同时记录 .card 上的 click 是否冒泡到 document
  window.__CARDCLICK__ = 0;
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('.card')) window.__CARDCLICK__++; }, true);
  return true;
})()`);

/* 准备：先跳到第 1 关（教程）确保有牌可点 */
await page.ev(`(async () => {
  const lv = document.querySelector('.nw-lv[data-lv="1"]');
  if (lv) lv.click();
  await new Promise(r => setTimeout(r, 900));
})()`);

const helper = `(() => {
  const cards = [...document.querySelectorAll('.card')].filter(c => !c.closest('div[w-295px]'));
  const free = cards.filter(c => !c.querySelector('.mask'));
  const tray = document.querySelectorAll('div[w-295px] .card').length;
  return { 牌堆: cards.length, 可点: free.length, 托盘: tray,
           可点列表: free.slice(0,4).map(c => { const r = c.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; }) };
})()`;

async function probe(label, { longPress = false, useMouse = false } = {}) {
  await page.ev('window.__EV__ = []; window.__CARDCLICK__ = 0;');
  const before = await page.ev(helper);
  const p = before.可点列表[0];
  if (!p) { console.log(`${label}: 没有可点的牌，跳过`); return; }
  if (useMouse) {
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 0 });
  } else {
    await page.touch('touchStart', p.x, p.y);
    await sleep(longPress ? 600 : 60);
    await page.touch('touchEnd', p.x, p.y);
  }
  await sleep(700);
  const after = await page.ev(helper);
  const evs = await page.ev('window.__EV__');
  const cardClicks = await page.ev('window.__CARDCLICK__');
  console.log(`${label}: 托盘 ${before.托盘}→${after.托盘} ${after.托盘 > before.托盘 ? '✅ 抓到了' : '❌ 没抓到'} | .card click=${cardClicks}`);
  console.log('   事件序列: ' + (evs.length ? evs.join(' → ') : '（什么都没收到）'));
  return after;
}

console.log('视口 390x844 mobile=true，触摸模拟已开启\n');
await probe('① 单击（touchStart→60ms→touchEnd）');
await probe('② 长按（touchStart→600ms→touchEnd）', { longPress: true });
await probe('③ 鼠标点击（对照组）', { useMouse: true });
const shot = await page.shot('touch-diag');
console.log('\n截图: ' + shot);
console.log('JS 报错: ' + (page.errors.length ? page.errors.slice(0, 3) : 'none'));

await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(200);
process.exit(0);
