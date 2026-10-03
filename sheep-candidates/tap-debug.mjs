/** 调试：桥接为什么没补发 click */
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
await page.ev(`(async()=>{ const b=document.querySelector('.nw-lv[data-lv="1"]'); if(b) b.click(); await new Promise(r=>setTimeout(r,900)); })()`);

const out = await page.ev(`(async () => {
  const log = [];
  const c1 = (e) => log.push('doc:click' + (e.__naiwaSynthetic ? '(synth)' : '') + ' on ' + (e.target.tagName + '.' + (e.target.className || '')).slice(0, 30));
  document.addEventListener('click', c1, true);
  document.addEventListener('pointerdown', (e) => log.push('doc:pd type=' + (e.pointerType || '?')), true);
  document.addEventListener('pointerup', (e) => log.push('doc:pu type=' + (e.pointerType || '?')), true);

  const card = [...document.querySelectorAll('.card')].filter(x => !x.closest('div[w-295px]') && !x.querySelector('.mask'))[0];
  const r = card.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  const el = document.elementFromPoint(x, y);
  const info = {
    PointerEvent存在: typeof PointerEvent === 'function',
    cardAlt: card.querySelector('img')?.alt,
    命中元素: el ? el.tagName + '.' + (el.className || '') : null,
    命中可回溯到card: !!(el && el.closest && el.closest('.card')),
    命中是否被压住: !!(el && el.closest && el.closest('.card') && el.closest('.card').querySelector('.mask')),
    trayBefore: document.querySelectorAll('div[w-295px] .card').length,
  };

  const opt = { bubbles: true, cancelable: true, pointerType: 'touch', clientX: x, clientY: y, isPrimary: true };
  const pe = new PointerEvent('pointerdown', opt);
  info.合成事件pointerType = pe.pointerType;
  (el || document.body).dispatchEvent(pe);
  await new Promise(r => setTimeout(r, 60));
  (el || document.body).dispatchEvent(new PointerEvent('pointerup', opt));
  await new Promise(r => setTimeout(r, 700));
  info.trayAfter = document.querySelectorAll('div[w-295px] .card').length;
  info.log = log;

  // 对照：直接对同一个 card 发 click 能不能抓
  const before2 = document.querySelectorAll('div[w-295px] .card').length;
  card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 500));
  info.直接click能抓 = document.querySelectorAll('div[w-295px] .card').length > before2;
  document.removeEventListener('click', c1, true);
  return info;
})()`);
console.log(JSON.stringify(out, null, 1));
console.log('JS 报错: ' + (page.errors.length ? page.errors.slice(0, 3) : 'none'));
await browser.send('Target.closeTarget', { targetId });
process.exit(0);
