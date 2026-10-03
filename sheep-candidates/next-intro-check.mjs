/** "难度飙升"过渡页专项验收：三条出口 + 参数对比 + 倒计时 */
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
      if (m.method === 'Runtime.exceptionThrown') this.errors.push((m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description) || m.params.exceptionDetails.text);
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
  async shot(name) {
    fs.mkdirSync(OUT, { recursive: true });
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64'));
    return 'shots/' + name + '.png';
  }
}

/* 页面内复用：自动打完当前这一关 */
const PLAY = `async function playLevel(max) {
  for (let k = 0; k < (max || 80); k++) {
    const free = [...document.querySelectorAll('.card')].filter(c => !c.closest('div[w-295px]') && !c.querySelector('.mask'));
    if (!free.length) break;
    const cnt = {}; free.forEach(c => { const t = c.querySelector('img').alt; cnt[t] = (cnt[t] || 0) + 1; });
    free.sort((a, b) => cnt[b.querySelector('img').alt] - cnt[a.querySelector('img').alt]);
    free[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    free[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 170));
  }
  await new Promise(r => setTimeout(r, 900));
}`;

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
await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(4200);
await page.ev(`localStorage.setItem('naiwa.progress.v1', JSON.stringify({unlocked:4,cleared:[],best:{}}))`);
await page.send('Page.reload');
await sleep(4200);

const stat = `(() => { const c=[...document.querySelectorAll('.card')].filter(x=>!x.closest('div[w-295px]')); return { 张数:c.length, hud:document.querySelector('[data-el="level"]').textContent.trim() }; })()`;

/* ---------- 阶段 1：过关 → 下一关 → 难度飙升 → 选关（并确认 4 秒内不会自动开战） ---------- */
const p1 = await page.ev(`(async () => {
  ${PLAY}
  document.querySelector('.nw-lv[data-lv="1"]').click();
  await new Promise(r => setTimeout(r, 700));
  await playLevel();
  const winTitle = document.querySelector('.nw-title').textContent;
  [...document.querySelectorAll('.nw-actions .nw-btn')].find(b => /下一关/.test(b.textContent)).click();
  await new Promise(r => setTimeout(r, 300));
  const p = document.querySelector('[data-el="panel"]');
  const spike = p.querySelector('.nw-spike')?.textContent;
  const rows = [...p.querySelectorAll('.nw-row')].map(r => r.textContent.replace(/\\s+/g, ' ').trim());
  const dots = p.querySelectorAll('.nw-dots span.on').length;
  const btns = [...p.querySelectorAll('.nw-actions .nw-btn')].map(b => b.textContent.trim());
  const autoText = p.querySelector('[data-el="auto"]')?.textContent;
  return { 过关面板: winTitle, 过渡页标题: spike, 对比: rows, 难度点亮数: dots, 按钮: btns, 倒计时文案: autoText };
})()`);
const s1 = await page.shot('ui-7-next-intro');
console.log('① 难度飙升过渡页：' + JSON.stringify(p1));

const p1b = await page.ev(`(async () => {
  [...document.querySelectorAll('.nw-actions .nw-btn')].find(b => /选关/.test(b.textContent)).click();
  await new Promise(r => setTimeout(r, 400));
  const selectShowing = !!document.querySelector('.nw-lv');
  await new Promise(r => setTimeout(r, 3600));            // 超过 3 秒倒计时
  const c = [...document.querySelectorAll('.card')].filter(x => !x.closest('div[w-295px]'));
  return { 选关界面在显示: selectShowing, 四秒后张数: c.length, 遮罩仍打开: !document.querySelector('[data-el="overlay"]').hidden };
})()`);
console.log('② 过渡页点"选关"后：' + JSON.stringify(p1b) + '（牌面应保持 0，说明倒计时被取消）');

/* ---------- 阶段 2：再过一次关卡 → 等着倒计时自动开战 ---------- */
const p2 = await page.ev(`(async () => {
  ${PLAY}
  document.querySelector('.nw-lv[data-lv="1"]').click();
  await new Promise(r => setTimeout(r, 700));
  await playLevel();
  [...document.querySelectorAll('.nw-actions .nw-btn')].find(b => /下一关/.test(b.textContent)).click();
  await new Promise(r => setTimeout(r, 3600));            // 等倒计时走完
  const c = [...document.querySelectorAll('.card')].filter(x => !x.closest('div[w-295px]'));
  return { 自动开战后: { 张数: c.length, hud: document.querySelector('[data-el="level"]').textContent.trim() }, 遮罩已关: document.querySelector('[data-el="overlay"]').hidden };
})()`);
console.log('③ 倒计时自动开战 → ' + JSON.stringify(p2));

/* ---------- 阶段 3：打完第 2 关 → 过渡页点"开战！"立刻开始 ---------- */
const p3 = await page.ev(`(async () => {
  ${PLAY}
  await playLevel();                                       // 第 2 关（24 张）
  const winTitle = document.querySelector('.nw-title').textContent;
  [...document.querySelectorAll('.nw-actions .nw-btn')].find(b => /下一关/.test(b.textContent)).click();
  await new Promise(r => setTimeout(r, 400));
  const spike = document.querySelector('.nw-spike')?.textContent;
  [...document.querySelectorAll('.nw-actions .nw-btn')].find(b => /开战/.test(b.textContent)).click();
  await new Promise(r => setTimeout(r, 700));
  const c = [...document.querySelectorAll('.card')].filter(x => !x.closest('div[w-295px]'));
  return { 第2关过关: winTitle, 过渡页: spike, 点开战后: { 张数: c.length, 种类: new Set(c.map(x=>x.querySelector('img').alt)).size, hud: document.querySelector('[data-el="level"]').textContent.trim() } };
})()`);
console.log('④ 过渡页点"开战！" → ' + JSON.stringify(p3));

console.log('\nJS 报错（音频策略除外）: ' + (page.errors.filter(e => !/NotAllowedError/.test(e)).length ? page.errors.filter(e => !/NotAllowedError/.test(e)).slice(0, 3) : 'none'));
console.log('截图: ' + s1);

await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(200);
process.exit(0);
