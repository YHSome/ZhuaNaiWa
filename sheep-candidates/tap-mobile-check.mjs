/** 轻点兜底 + 手机端布局验收 */
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
    return this.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 12, radiusY: 12, force: 1 }] });
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
await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(4200);
await page.ev(`localStorage.setItem('naiwa.progress.v1', JSON.stringify({unlocked:4,cleared:[],best:{}}))`);
await page.send('Page.reload');
await sleep(4200);
await page.ev(`(async()=>{ const b=document.querySelector('.nw-lv[data-lv="1"]'); if(b) b.click(); await new Promise(r=>setTimeout(r,900)); })()`);

const trayCount = 'document.querySelectorAll("div[w-295px] .card").length';
const firstFree = `(() => {
  const c = [...document.querySelectorAll('.card')].filter(x => !x.closest('div[w-295px]') && !x.querySelector('.mask'))[0];
  if (!c) return null;
  const r = c.getBoundingClientRect();
  const img = c.querySelector('img');
  return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), alt: img && img.alt };
})()`;

/* ① 浏览器吞掉 click：只发 pointerdown + pointerup（不产生 click） */
const t1 = await page.ev(`(async () => {
  const p = ${firstFree};
  const before = ${trayCount};
  const el = document.elementFromPoint(p.x, p.y);
  const opt = { bubbles: true, cancelable: true, pointerType: 'touch', clientX: p.x, clientY: p.y, isPrimary: true };
  el.dispatchEvent(new PointerEvent('pointerdown', opt));
  await new Promise(r => setTimeout(r, 60));
  el.dispatchEvent(new PointerEvent('pointerup', opt));
  await new Promise(r => setTimeout(r, 600));      // 等兜底桥接的 350ms
  return { before, after: ${trayCount}, 说明: '只发 pointer 事件，无 click' };
})()`);
console.log('① 事件被吞时（无 click）: 托盘 ' + t1.before + ' → ' + t1.after + (t1.after === t1.before + 1 ? ' ✅ 兜底补发成功' : ' ❌ 没补上'));

/* ② click 迟到 600ms：兜底先手，迟到的 click 必须被丢弃（不能抓两张） */
const t2 = await page.ev(`(async () => {
  const p = ${firstFree};
  const before = ${trayCount};
  const el = document.elementFromPoint(p.x, p.y);
  const opt = { bubbles: true, cancelable: true, pointerType: 'touch', clientX: p.x, clientY: p.y, isPrimary: true };
  el.dispatchEvent(new PointerEvent('pointerdown', opt));
  await new Promise(r => setTimeout(r, 60));
  el.dispatchEvent(new PointerEvent('pointerup', opt));
  await new Promise(r => setTimeout(r, 600));      // 此时兜底已补发
  const mid = ${trayCount};
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y }));   // 迟到的真 click
  await new Promise(r => setTimeout(r, 400));
  return { before, mid, after: ${trayCount} };
})()`);
console.log('② click 迟到:' + ' 托盘 ' + t2.before + ' →(兜底后) ' + t2.mid + ' →(迟到 click 后) ' + t2.after +
  (t2.mid === t2.before + 1 && t2.after === t2.mid ? ' ✅ 只抓一张' : ' ❌ 抓重了'));

/* ③ 正常触摸（CDP 真实 touch 序列，会自带 click）：也不能重复抓 */
await page.ev(`(async()=>{ const b=document.querySelector('.nw-lv[data-lv="1"]'); if(b) b.click(); await new Promise(r=>setTimeout(r,900)); })()`);
const p3 = await page.ev(firstFree);
const before3 = await page.ev(trayCount);
await page.touch('touchStart', p3.x, p3.y);
await sleep(60);
await page.touch('touchEnd', p3.x, p3.y);
await sleep(800);
const after3 = await page.ev(trayCount);
console.log('③ 真实轻点: 托盘 ' + before3 + ' → ' + after3 + (after3 === before3 + 1 ? ' ✅ 只抓一张' : ' ❌ 数量不对'));

/* ④ 窄屏布局：320x568 下托盘是否放得下 */
await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 2, mobile: true });
await sleep(700);
const narrow = await page.ev(`(() => {
  const tray = document.querySelector('div[w-295px]');
  const tr = tray.getBoundingClientRect();
  const hud = document.querySelector('.nw-hud').getBoundingClientRect();
  const lv = document.querySelector('.nw-btn');
  return {
    视口宽: window.innerWidth,
    托盘宽: Math.round(tr.width),
    托盘左右边距: [Math.round(tr.left), Math.round(window.innerWidth - tr.right)],
    托盘溢出: tr.left < 0 || tr.right > window.innerWidth,
    顶栏高度: Math.round(hud.height),
    顶栏是否换行: hud.height > 60,
    顶栏按钮高: lv ? Math.round(lv.getBoundingClientRect().height) : null,
  };
})()`);
console.log('④ 320px 窄屏: ' + JSON.stringify(narrow));
const shotNarrow = await page.shot('ui-8-narrow-320');

const mid = await page.ev(`(() => {
  document.querySelector('[data-act="levels"]').click();
  return new Promise(r => setTimeout(() => {
    const p = document.querySelector('.nw-panel').getBoundingClientRect();
    r({ 面板宽: Math.round(p.width), 视口宽: window.innerWidth, 面板高: Math.round(p.height), 视口高: window.innerHeight, 溢出: p.height > window.innerHeight });
  }, 400));
})()`);
console.log('⑤ 320px 下选关面板: ' + JSON.stringify(mid));
const shotPanel = await page.shot('ui-9-narrow-panel');

console.log('\nJS 报错: ' + (page.errors.length ? page.errors.slice(0, 3) : 'none'));
console.log('截图: ' + [shotNarrow, shotPanel].join(', '));

await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(200);
process.exit(0);
