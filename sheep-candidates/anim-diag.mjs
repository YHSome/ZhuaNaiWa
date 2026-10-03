/** 动画诊断：点击后按时序采样所有 card 动画，并输出一张"暂停在飞行中段"的证据图 */
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

console.log('--- 游戏自带样式里与 card 相关的动画 ---');
const cssInfo = await page.evaluate(`(() => {
  const out = [];
  for (const sheet of document.styleSheets) {
    let rules; try { rules = [...sheet.cssRules]; } catch (e) { continue; }
    for (const r of rules) {
      if (r.type === CSSRule.KEYFRAMES_RULE) out.push('@keyframes ' + r.name + ' stops=' + r.cssRules.length);
      if (r.style && r.style.animation && /card|dock/i.test(r.selectorText || '')) out.push(r.selectorText + ' { animation: ' + r.style.animation + ' }');
    }
  }
  return out;
})()`);
console.log(cssInfo.length ? cssInfo.join('\n') : '(无)');

console.log('\n--- 点击后按时序采样 card 动画 ---');
const samples = await page.evaluate(`(async () => {
  const out = [];
  const free = [...document.querySelectorAll('.card')].filter(c => !c.querySelector('.mask') && c.querySelector('img') && !c.closest('div[w-295px]'));
  const card = free[Math.floor(free.length / 2)];
  const src = card.getBoundingClientRect();
  const alt = card.querySelector('img').alt;
  const snapshot = (label) => {
    const list = (document.getAnimations ? document.getAnimations() : [])
      .filter(a => a.effect && a.effect.target && a.effect.target.classList && a.effect.target.classList.contains('card'))
      .map(a => {
        const t = a.effect.target, r = t.getBoundingClientRect(), ct = a.effect.getComputedTiming();
        return { kind: a.constructor.name, dur: Math.round(ct.duration), elapsed: Math.round(a.currentTime || 0), progress: +(ct.progress || 0).toFixed(2),
                 alt: (t.querySelector('img')||{}).alt, x: Math.round(r.left), y: Math.round(r.top) };
      });
    out.push({ label, anims: list });
  };
  card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  snapshot('0ms');
  for (const t of [40, 40, 60, 80, 120]) { await new Promise(r => setTimeout(r, t)); snapshot('+' + t + 'ms'); }
  return { alt, src: { x: Math.round(src.left), y: Math.round(src.top) }, samples: out };
})()`);
console.log('被点牌 alt=' + samples.alt + ' 原位=(' + samples.src.x + ',' + samples.src.y + ')');
samples.samples.forEach((s) => {
  console.log(' ' + s.label.padEnd(7), s.anims.length ? s.anims.map((a) => `[${a.kind} dur=${a.dur} t=${a.elapsed} p=${a.progress} alt=${a.alt} @(${a.x},${a.y})]`).join(' ') : '(无 card 动画)');
});

console.log('\n--- 证据图：把飞行动画暂停在 90ms 再截图 ---');
const frozen = await page.evaluate(`(async () => {
  const free = [...document.querySelectorAll('.card')].filter(c => !c.querySelector('.mask') && c.querySelector('img') && !c.closest('div[w-295px]'));
  const card = free[Math.floor(free.length / 2)];
  const src = card.getBoundingClientRect();
  card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 30));
  const anims = (document.getAnimations ? document.getAnimations() : [])
    .filter(a => a.effect && a.effect.target && a.effect.target.classList && a.effect.target.classList.contains('card') && a.effect.getTiming().duration > 150);
  anims.forEach(a => { a.pause(); a.currentTime = 90; });
  const r = anims.length ? anims[0].effect.target.getBoundingClientRect() : null;
  return { paused: anims.length, dur: anims.length ? Math.round(anims[0].effect.getTiming().duration) : 0, x: r ? Math.round(r.left) : null, y: r ? Math.round(r.top) : null, src: { x: Math.round(src.left), y: Math.round(src.top) } };
})()`);
const shot = await page.shot('anim-frozen-90ms-' + VP.join('x'));
console.log('暂停动画数=' + frozen.paused + ' 时长=' + frozen.dur + 'ms | 暂停在 90ms 时牌位于 (' + frozen.x + ',' + frozen.y + ')，原位 (' + frozen.src.x + ',' + frozen.src.y + ')');
console.log('截图:', shot);

await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(200);
process.exit(0);
