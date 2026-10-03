/** 量尺：在指定视口下打印关键元素的字号/盒子，并追查缩放来源（zoom/transform/font-size 继承） */
const URL_TARGET = process.argv[2] || 'http://127.0.0.1:8123/sheep-candidates/xlegex-patched/';
const VP = (process.argv[3] || '1180x820').split('x').map(Number);
const CDP_PORT = Number(process.argv[4] || 9222);

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
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
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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
  if (!wsUrl) await new Promise((r) => setTimeout(r, 200));
}
const page = await CDP.connect(wsUrl);
await page.send('Runtime.enable');
await page.send('Page.enable');
await page.send('Emulation.setDeviceMetricsOverride', { width: VP[0], height: VP[1], deviceScaleFactor: 1, mobile: false });
await page.send('Page.navigate', { url: URL_TARGET });
await new Promise((r) => setTimeout(r, 3500));

const out = await page.evaluate(`(() => {
  const rows = [];
  const probe = (label, el) => {
    if (!el) return rows.push({ label, missing: true });
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    const chain = [];
    let p = el;
    while (p && p !== document.documentElement) {
      const pcs = getComputedStyle(p);
      if (pcs.transform !== 'none' || pcs.zoom !== '1' || pcs.fontSize !== getComputedStyle(p.parentElement || document.body).fontSize) {
        chain.push(p.tagName + '[' + (p.getAttributeNames().join(' ').slice(0, 40)) + '] fs=' + pcs.fontSize + ' tr=' + (pcs.transform === 'none' ? '-' : 'Y') + ' zoom=' + pcs.zoom);
      }
      p = p.parentElement;
    }
    rows.push({ label, font: cs.fontSize + '/' + cs.fontWeight, box: Math.round(r.width) + 'x' + Math.round(r.height), pad: cs.padding, border: cs.borderWidth, transform: cs.transform === 'none' ? '-' : cs.transform, zoom: cs.zoom, chain: chain.slice(0, 4) });
  };
  probe('title', document.querySelector('#app > div:first-child'));
  probe('pileContainer', document.querySelector('#app > div > div'));
  probe('tray', [...document.querySelectorAll('div')].find(e => /dashed/.test(getComputedStyle(e).borderStyle)) || document.querySelector('div[w-295px]'));
  probe('btnRow', document.querySelector('#app > div > div:last-child'));
  probe('button1', document.querySelector('button'));
  probe('credits', document.querySelector('#app > div:last-child'));
  probe('card', document.querySelector('.card'));
  return {
    rows,
    htmlAttrs: [...document.documentElement.attributes].map(a => a.name + '=' + a.value).join(' | '),
    bodyFont: getComputedStyle(document.body).fontSize,
    htmlFont: getComputedStyle(document.documentElement).fontSize,
    sheets: [...document.styleSheets].map(s => s.href || 'inline'),
    scaleRules: [...document.styleSheets].flatMap(s => { try { return [...s.cssRules] } catch { return [] } })
      .filter(r => r.style && (r.style.fontSize || r.style.zoom || r.style.transform))
      .filter(r => /html|body|#app|font-size/.test(r.selectorText || ''))
      .map(r => (r.selectorText || '@' + (r.media ? r.media.mediaText : '?')) + ' { ' + r.style.cssText.slice(0, 120) + ' }').slice(0, 14),
  };
})()`);

console.log('视口:', VP.join('x'), '| html 属性:', out.htmlAttrs);
console.log('html font:', out.htmlFont, '| body font:', out.bodyFont);
console.log('样式表:', out.sheets.map((s) => s.split('/').pop()).join(', '));
console.log('\n--- 元素量尺 ---');
out.rows.forEach((r) => console.log(r.missing ? `${r.label.padEnd(14)} (不存在)` : `${r.label.padEnd(14)} font=${r.font.padEnd(10)} box=${r.box.padEnd(10)} pad=${r.pad.padEnd(14)} border=${r.border.padEnd(4)} tr=${r.transform} zoom=${r.zoom}\n${r.chain && r.chain.length ? '               ↳ ' + r.chain.join('\n               ↳ ') : ''}`));
console.log('\n--- 含 font-size/transform 的全局规则 ---');
out.scaleRules.forEach((r) => console.log(r));

await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
process.exit(0);
