/** 结构探针：打印游戏的 DOM 结构、scoped 属性、关键元素的类名与计算样式 */
import fs from 'node:fs';
import path from 'node:path';

const URL_TARGET = process.argv[2] || 'http://127.0.0.1:8123/sheep-candidates/xlegex-patched/';
const CDP_PORT = Number(process.argv[3] || 9222);

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
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws fail')), { once: true });
    });
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
const { targetId } = await browser.send('Target.createTarget', { url: URL_TARGET });
await new Promise((r) => setTimeout(r, 3500));
const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = await CDP.connect(list.find((t) => t.id === targetId).webSocketDebuggerUrl);
await page.send('Runtime.enable');

const dump = await page.evaluate(`(() => {
  const app = document.getElementById('app');
  const scoped = new Set();
  document.querySelectorAll('*').forEach(e => [...e.attributes].forEach(a => { if (a.name.startsWith('data-v')) scoped.add(a.name); }));
  const info = (sel) => [...document.querySelectorAll(sel)].slice(0, 6).map(e => {
    const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
    return { tag: e.tagName, cls: e.className, text: (e.textContent || '').trim().slice(0, 14),
      box: Math.round(r.width) + 'x' + Math.round(r.height) + '@' + Math.round(r.left) + ',' + Math.round(r.top),
      bg: cs.backgroundColor, bgi: (cs.backgroundImage || '').slice(0, 40), font: cs.fontSize + '/' + cs.fontWeight, color: cs.color };
  });
  return {
    scoped: [...scoped],
    html: app.innerHTML.replace(/<!--[\\s\\S]*?-->/g, '').replace(/[\\s]+/g, ' ').slice(0, 700),
    htmlTail: app.innerHTML.replace(/<!--[\\s\\S]*?-->/g, '').replace(/[\\s]+/g, ' ').slice(-900),
    body: info('body > *'),
    h1: info('#app > div:first-child, h1,h2,h3'),
    dashed: [...document.querySelectorAll('div')].filter(e => /dashed/.test(getComputedStyle(e).borderStyle)).map(e => {
      const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
      return { cls: e.className, attrs: [...e.attributes].map(a => a.name).join(' '), box: Math.round(r.width) + 'x' + Math.round(r.height) + '@' + Math.round(r.left) + ',' + Math.round(r.top), border: cs.border, children: e.children.length };
    }).slice(0, 4),
    btns: info('button'),
    cardRule: [...document.styleSheets].flatMap(s => { try { return [...s.cssRules] } catch { return [] } })
      .filter(r => r.selectorText && /\.(card|mask)/.test(r.selectorText))
      .map(r => r.selectorText + ' { ' + r.style.cssText.slice(0, 260) + ' }'),
    globalRules: [...document.styleSheets].flatMap(s => { try { return [...s.cssRules] } catch { return [] } })
      .filter(r => r.selectorText && /^(body|button|html)/.test(r.selectorText))
      .map(r => r.selectorText + ' { ' + r.style.cssText.slice(0, 200) + ' }'),
    bgColor: getComputedStyle(document.body).backgroundColor,
  };
})()`);

console.log('scoped 属性:', dump.scoped.join(', '));
console.log('body 背景:', dump.bgColor);
console.log('\n--- .card / .mask 原规则 ---');
dump.cardRule.forEach((r) => console.log(r));
console.log('\n--- body/button 全局规则 ---');
dump.globalRules.forEach((r) => console.log(r));
console.log('\n--- 标题 ---');
dump.h1.forEach((b) => console.log(JSON.stringify(b)));
console.log('\n--- 虚线边框（托盘）---');
dump.dashed.length ? dump.dashed.forEach((b) => console.log(JSON.stringify(b))) : console.log('(无)');
console.log('\n--- 按钮 ---');
dump.btns.forEach((b) => console.log(JSON.stringify(b)));
console.log('\n--- innerHTML 尾部 900 字符 ---');
console.log(dump.htmlTail);

await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
process.exit(0);
