/** 四种输入方式对照：到底哪种能让游戏抓牌 */
const URL_TARGET = process.argv[2];
const CDP_PORT = Number(process.argv[3] || 9222);
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
// 先开局（选关遮罩是全屏模态，不关掉就 elementFromPoint 不到牌）
await page.ev(`(async () => {
  const b = document.querySelector('.nw-lv[data-lv="1"]');
  if (b) b.click();
  await new Promise(r => setTimeout(r, 1000));
  return document.querySelectorAll('.card').length;
})()`);

/* 工具：每次重新取一张"当前真实命中且可点"的牌 */
await page.ev(`(() => {
  window.__pick = () => {
    const tray = document.querySelectorAll('div[w-295px] .card').length;
    const cards = [...document.querySelectorAll('.card')].filter(c => !c.closest('div[w-295px]'));
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      const top = hit && hit.closest ? hit.closest('.card') : null;
      if (!top || top.querySelector('.mask')) continue;             // 命中的是被压住的牌 → 换一张
      const r2 = top.getBoundingClientRect();
      const x = Math.round(r2.left + r2.width / 2), y = Math.round(r2.top + r2.height / 2);
      const hit2 = document.elementFromPoint(x, y);
      if (hit2 && hit2.closest && hit2.closest('.card') === top) {  // 这张牌的中心确实命中它自己
        return { x, y, alt: top.querySelector('img')?.alt, tray, board: cards.length, ok: true };
      }
    }
    return { ok: false, tray, board: cards.length, log: [] };
  };
  window.__log = [];
  ['pointerdown','pointerup','click'].forEach(t =>
    document.addEventListener(t, (e) => window.__log.push(t + (e.__naiwaSynthetic ? '(syn)' : '') + '@' + (e.target.tagName || '?')), true));
  return true;
})()`);

const report = (label, r) => console.log(`${label}: ${r.ok ? '' : '(没有可点的牌) '}托盘 ${r.tray} → ${r.after} ${r.after > r.tray ? '✅ 抓到' : '❌ 没抓到'} | 事件: ${(r.log || []).join(' → ') || '无'}`);

/* A) 只发 click */
let r = await page.ev(`(async () => {
  const p = window.__pick(); if (!p.ok) return p;
  window.__log = [];
  const el = document.elementFromPoint(p.x, p.y);
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 500));
  return { ...p, after: document.querySelectorAll('div[w-295px] .card').length, log: window.__log };
})()`);
report('A 只发 click', r);

/* B) pointerdown + click */
r = await page.ev(`(async () => {
  const p = window.__pick(); if (!p.ok) return p;
  window.__log = [];
  const el = document.elementFromPoint(p.x, p.y);
  const o = { bubbles: true, cancelable: true, pointerType: 'touch', clientX: p.x, clientY: p.y, isPrimary: true };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 500));
  return { ...p, after: document.querySelectorAll('div[w-295px] .card').length, log: window.__log };
})()`);
report('B pointerdown+click', r);

/* C) pointerdown + pointerup（无 click，等桥接补发 350ms） */
r = await page.ev(`(async () => {
  const p = window.__pick(); if (!p.ok) return p;
  window.__log = [];
  const el = document.elementFromPoint(p.x, p.y);
  const o = { bubbles: true, cancelable: true, pointerType: 'touch', clientX: p.x, clientY: p.y, isPrimary: true };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  await new Promise(r => setTimeout(r, 60));
  el.dispatchEvent(new PointerEvent('pointerup', o));
  await new Promise(r => setTimeout(r, 900));
  return { ...p, after: document.querySelectorAll('div[w-295px] .card').length, log: window.__log };
})()`);
report('C pointerdown+up（靠桥接）', r);

/* D) 真实触摸（CDP） */
const p4 = await page.ev('window.__pick()');
if (p4.ok) {
  await page.ev('window.__log = []');
  await page.touch('touchStart', p4.x, p4.y);
  await sleep(60);
  await page.touch('touchEnd', p4.x, p4.y);
  await sleep(800);
  const after = await page.ev('document.querySelectorAll("div[w-295px] .card").length');
  const log = await page.ev('window.__log');
  report('D 真实触摸', { ...p4, after, log });
}

console.log('\nJS 报错: ' + (page.errors.length ? page.errors.slice(0, 3) : 'none'));
await browser.send('Target.closeTarget', { targetId });
process.exit(0);
