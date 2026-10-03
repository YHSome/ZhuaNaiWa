/** 动画验收：抓牌瞬间连拍 + 校验 WEB Animations 是否真的在跑，并抓消除反馈 */
import fs from 'node:fs';
import path from 'node:path';

const URL_TARGET = process.argv[2] || 'http://127.0.0.1:8123/sheep-candidates/xlegex-patched/';
const VP = (process.argv[3] || '390x844').split('x').map(Number);
const CDP_PORT = Number(process.argv[4] || 9222);
const OUT = path.join(import.meta.dirname, 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve } = this.pending.get(m.id);
        this.pending.delete(m.id);
        resolve(m.result);
        return;
      }
      for (const cb of this.listeners.get(m.method) || []) cb(m.params);
    });
  }
  on(m, cb) { if (!this.listeners.has(m)) this.listeners.set(m, []); this.listeners.get(m).push(cb); }
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
  async shot(name) {
    fs.mkdirSync(OUT, { recursive: true });
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return path.relative(process.cwd(), file);
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
await page.send('Network.enable');
page.on('Page.javascriptDialogOpening', () => page.send('Page.handleJavaScriptDialog', { accept: true }));
await page.send('Network.setCacheDisabled', { cacheDisabled: true });
await page.send('Emulation.setDeviceMetricsOverride', { width: VP[0], height: VP[1], deviceScaleFactor: 1, mobile: false });
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(4200);

const tag = VP.join('x');

/* 1) 抓牌：记录原位 → 点击 → 70ms 内看到动画在跑且牌不在终点 */
const fly = await page.evaluate(`(async () => {
  const free = [...document.querySelectorAll('.card')].filter(c => !c.querySelector('.mask') && c.querySelector('img') && !c.closest('div[w-295px]'));
  if (!free.length) return { error: '没有可点的牌' };
  const card = free[Math.floor(free.length / 2)];
  const src = card.getBoundingClientRect();
  const alt = card.querySelector('img').alt;
  const before = document.querySelectorAll('div[w-295px] .card').length;
  card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 70));
  const anims = document.getAnimations ? document.getAnimations().filter(a => a.effect && a.effect.target && a.effect.target.classList && a.effect.target.classList.contains('card')) : [];
  const flight = anims.map(a => {
    const r = a.effect.target.getBoundingClientRect();
    return { state: a.playState, dur: Math.round(a.effect.getTiming().duration), left: Math.round(r.left), top: Math.round(r.top), progress: a.effect.getComputedTiming().progress };
  });
  const docked = [...document.querySelectorAll('div[w-295px] .card')];
  const target = docked.find(c => c.querySelector('img') && c.querySelector('img').alt === alt);
  const dst = target ? target.getBoundingClientRect() : null;
  return {
    alt: alt,
    src: { left: Math.round(src.left), top: Math.round(src.top) },
    dst: dst ? { left: Math.round(dst.left), top: Math.round(dst.top) } : null,
    running: flight.length,
    flight: flight[0] || null,
    trayBefore: before,
    trayAfter: docked.length,
  };
})()`);
const shot1 = await page.shot('anim-1-flying-' + tag);
await sleep(600);
const shot2 = await page.shot('anim-2-settled-' + tag);

/* 2) 消除：连点同图案三张，抓闪光 + 飘字 */
const match = await page.evaluate(`(async () => {
  const free = [...document.querySelectorAll('.card')].filter(c => !c.querySelector('.mask') && c.querySelector('img') && !c.closest('div[w-295px]'));
  const byType = {};
  for (const c of free) { const t = c.querySelector('img').alt; (byType[t] = byType[t] || []).push(c); }
  const pick = Object.entries(byType).find(([, arr]) => arr.length >= 3);
  if (!pick) return { error: '没有 3 张同类可点牌' };
  for (const c of pick[1].slice(0, 3)) {
    c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    c.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 240));
  }
  await new Promise(r => setTimeout(r, 200));
  const tray = document.querySelector('div[w-295px]');
  const float = tray.querySelector('.zw-float');
  const fr = float ? float.getBoundingClientRect() : null;
  return {
    type: pick[0],
    flashClass: tray.classList.contains('is-match'),
    floatText: float ? float.textContent : null,
    floatRect: fr ? { left: Math.round(fr.left), top: Math.round(fr.top) } : null,
    trayCards: tray.querySelectorAll('.card').length,
  };
})()`);
const shot3 = await page.shot('anim-3-match-' + tag);

console.log('视口:', tag);
console.log('\n【抓牌飞行】');
console.log('  图案 alt =', fly.alt, '| 原位', JSON.stringify(fly.src), '-> 槽位', JSON.stringify(fly.dst));
console.log('  70ms 时正在跑的 card 动画数 =', fly.running, fly.flight ? '| ' + JSON.stringify(fly.flight) : '');
console.log('  托盘张数', fly.trayBefore, '->', fly.trayAfter);
console.log('  截图:', shot1, '/', shot2);
console.log('\n【消除反馈】');
console.log('  托盘闪光 class =', match.flashClass, '| 飘字 =', JSON.stringify(match.floatText), '| 位置', JSON.stringify(match.floatRect), '| 托盘剩', match.trayCards, '张');
console.log('  截图:', shot3);

await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(200);
process.exit(0);
