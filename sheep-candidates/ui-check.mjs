/** UI 验收 v2：选关 / 跳关 / 中途继续 / 过关面板 + 自动切关闸门 / 失败面板 / 玩法说明 */
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

/* 先解锁到 4 关（模拟老玩家），再看选关界面 */
await page.ev(`localStorage.setItem('naiwa.progress.v1', JSON.stringify({unlocked:4,cleared:[1],best:{1:14}}))`);
await page.send('Page.reload');
await sleep(4200);

const stat = `(() => { const c=[...document.querySelectorAll('.card')].filter(x=>!x.closest('div[w-295px]')); return { 张数:c.length, 种类:new Set(c.map(x=>x.querySelector('img').alt)).size, hud:document.querySelector('[data-el="level"]').textContent.trim() }; })()`;

console.log('① 选关界面：');
console.log('   ' + JSON.stringify(await page.ev(`[...document.querySelectorAll('.nw-lv')].map(b=>({n:b.dataset.lv,locked:b.disabled,cleared:b.className.includes('is-cleared'),txt:b.textContent.replace(/\\s+/g,' ').trim()}))`)));
console.log('   按钮: ' + JSON.stringify(await page.ev(`[...document.querySelectorAll('.nw-actions .nw-btn')].map(b=>b.textContent.trim())`)));
const s1 = await page.shot('ui-1-levelselect');

/* 跳关 */
await page.ev(`(async()=>{ document.querySelector('.nw-lv[data-lv="3"]').click(); await new Promise(r=>setTimeout(r,900)); })()`);
console.log('② 点第 3 关 -> ' + JSON.stringify(await page.ev(stat)));
const s2 = await page.shot('ui-2-ingame-hud');

/* 中途进选关 → 应该有"继续游戏"，且点它能回去、牌局不变 */
const mid = await page.ev(`(async () => {
  document.querySelector('[data-act="levels"]').click();
  await new Promise(r => setTimeout(r, 250));
  const btns = [...document.querySelectorAll('.nw-actions .nw-btn')].map(b => b.textContent.trim());
  const resume = [...document.querySelectorAll('.nw-actions .nw-btn')].find(b => /继续游戏/.test(b.textContent));
  if (resume) resume.click();
  await new Promise(r => setTimeout(r, 300));
  const c = [...document.querySelectorAll('.card')].filter(x => !x.closest('div[w-295px]'));
  return { 面板按钮: btns, 面板已关闭: document.querySelector('[data-el="overlay"]').hidden, 恢复后张数: c.length };
})()`);
console.log('③ 中途选关 → 继续：' + JSON.stringify(mid));

/* 打完教程关 → 面板打开时先截一张（分两步 eval，避免阻塞） */
const winPanel = await page.ev(`(async () => {
  document.querySelector('[data-act="levels"]').click();
  await new Promise(r => setTimeout(r, 250));
  document.querySelector('.nw-lv[data-lv="1"]').click();
  await new Promise(r => setTimeout(r, 800));
  for (let k = 0; k < 40; k++) {
    const free = [...document.querySelectorAll('.card')].filter(c => !c.closest('div[w-295px]') && !c.querySelector('.mask'));
    if (!free.length) break;
    const cnt = {}; free.forEach(c => { const t = c.querySelector('img').alt; cnt[t] = (cnt[t] || 0) + 1; });
    free.sort((a, b) => cnt[b.querySelector('img').alt] - cnt[a.querySelector('img').alt]);
    free[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    free[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 200));
  }
  await new Promise(r => setTimeout(r, 1000));
  const p = document.querySelector('[data-el="panel"]');
  return {
    overlayVisible: !document.querySelector('[data-el="overlay"]').hidden,
    title: p.querySelector('.nw-title')?.textContent,
    stats: [...p.querySelectorAll('.nw-stat')].map(s => s.textContent.trim()),
    buttons: [...p.querySelectorAll('.nw-actions .nw-btn')].map(b => b.textContent.trim()),
    progress: localStorage.getItem('naiwa.progress.v1'),
  };
})()`);
const s3 = await page.shot('ui-3-win-panel');

/* 面板里点"下一关"，等 3.2 秒（比游戏自带 2s 自动切关更长）确认没被顶掉 */
const gate = await page.ev(`(async () => {
  const next = [...document.querySelectorAll('.nw-actions .nw-btn')].find(b => /下一关/.test(b.textContent));
  if (next) next.click();
  await new Promise(r => setTimeout(r, 3200));
  const c = [...document.querySelectorAll('.card')].filter(x => !x.closest('div[w-295px]'));
  return { 张数: c.length, hud: document.querySelector('[data-el="level"]').textContent.trim() };
})()`);
console.log('④ 过关面板：' + JSON.stringify(winPanel));
console.log('   点"下一关"3.2s 后：' + JSON.stringify(gate) + '（第 2 关应为 24 张；曾被游戏的自动切关顶成 36）');

/* 失败面板（手动触发游戏原本的 alert） */
const lose = await page.ev(`(async () => {
  window.alert('槽位已满，再接再厉~');
  await new Promise(r => setTimeout(r, 400));
  const p = document.querySelector('[data-el="panel"]');
  return { 标题: p.querySelector('.nw-title')?.textContent, 统计: [...p.querySelectorAll('.nw-stat')].map(s => s.textContent.trim()), 按钮: [...p.querySelectorAll('.nw-actions .nw-btn')].map(b => b.textContent.trim()) };
})()`);
console.log('⑤ 失败面板：' + JSON.stringify(lose));
const s4 = await page.shot('ui-4-lose-panel');

/* 玩法说明 */
const help = await page.ev(`(async () => {
  document.querySelector('.nw-actions .nw-btn').click();      // 失败面板的第一个按钮 = 重玩本关
  await new Promise(r => setTimeout(r, 600));
  document.querySelector('[data-act="levels"]').click();
  await new Promise(r => setTimeout(r, 250));
  [...document.querySelectorAll('.nw-actions .nw-btn')].find(b => /玩法说明/.test(b.textContent)).click();
  await new Promise(r => setTimeout(r, 300));
  return { 标题: document.querySelector('.nw-title')?.textContent, 条目: document.querySelectorAll('.nw-help li').length };
})()`);
console.log('⑥ 玩法说明：' + JSON.stringify(help));
const s5 = await page.shot('ui-5-help');

console.log('\nJS 报错（音频自动播放策略除外）: ' + (page.errors.filter(e => !/NotAllowedError/.test(e)).length ? page.errors.filter(e => !/NotAllowedError/.test(e)).slice(0, 3) : 'none'));
console.log('截图: ' + [s1, s2, s3, s4, s5].join(', '));

await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(200);
process.exit(0);
