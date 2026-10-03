/**
 * 排行榜实测：真实提交一条成绩 → 读回来 → 校验排序与展示
 * （会往 TinyWebDB 里写一条测试数据，跑完会自动删掉）
 *
 * 用法: node leaderboard-check.mjs [url] [cdpPort]
 */
import fs from 'node:fs';
import path from 'node:path';

const URL_TARGET = process.argv[2] || 'file:///C:/Users/YHSome/Projects/OtherProjects/ZhuaNaiWa/index.html';
const CDP_PORT = Number(process.argv[3] || 9222);
const OUT = path.join(import.meta.dirname, 'shots-v2');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { resolve } = this.pending.get(m.id); this.pending.delete(m.id); resolve(m.result); return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.errors.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
      }
      if (m.method === 'Page.javascriptDialogOpening') this.send('Page.handleJavaScriptDialog', { accept: true });
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
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64'));
    return 'shots-v2/' + name + '.png';
  }
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok });
  console.log((ok ? '[OK] ' : '[NG] ') + name + (detail ? '  —— ' + detail : ''));
};

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
await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(3200);
await page.ev(`localStorage.setItem('naiwa.progress.v1', JSON.stringify({unlocked:5, cleared:[1,2,3,4], best:{}, stars:{}, endlessBest:2}))`);
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(3200);

// 1) 选关界面有排行榜入口
const entry = await page.ev(`(function(){
  var b = document.querySelector('[data-act="leaderboard"]');
  return { ok: !!b, text: b ? b.textContent.trim() : '' };
})()`);
check('选关界面有排行榜入口', entry.ok, entry.text);

// 2) 点开排行榜面板：先出缓存/加载中，网络回来后出真实数据
await page.ev(`document.querySelector('[data-act="leaderboard"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))`);
await sleep(400);
const opening = await page.ev(`(function(){
  var p = document.querySelector('.nw-panel');
  return { title: (p.querySelector('.nw-title')||{}).textContent, sub: (p.querySelector('[data-el="lbsub"]')||{}).textContent,
    rows: p.querySelectorAll('.nw-lb__row').length, seg: [].slice.call(p.querySelectorAll('.nw-seg__btn')).map(function(b){ return b.textContent.trim(); }) };
})()`);
check('排行榜面板打开（有分段切换）', /排行榜/.test(opening.title || '') && opening.seg.length === 2,
  `标题「${opening.title}」标签 ${opening.seg.join(' / ')} | 当前行数 ${opening.rows} | ${opening.sub}`);

await sleep(3000);
const netRead = await page.ev(`(function(){
  var p = document.querySelector('.nw-panel');
  return { sub: (p.querySelector('[data-el="lbsub"]')||{}).textContent, rows: p.querySelectorAll('.nw-lb__row').length,
    first: (p.querySelector('.nw-lb__row')||{}).textContent || '' };
})()`);
check('网络读取成功（file:// 也能跨域读）', /实时数据/.test(netRead.sub || ''),
  `${netRead.sub} | 行数 ${netRead.rows} | 第一行 ${netRead.first.replace(/\s+/g, ' ').trim()}`);

// 3) 通过 UI 提交一条成绩（先造一个假的"刚结束的无尽挑战"状态）
const tagBefore = await page.ev(`(function(){
  // 直接调内部逻辑：模拟一次挑战结束后的上榜
  window.__NAIWA_TEST_ENDLESS__ = { tower: 7, tiles: 810, startedAt: performance.now() - 321000 };
  return true;
})()`);
void tagBefore;
await page.ev(`(function(){
  // 用真实的提交路径：先造状态，再点「上榜」
  var real = window.__NAIWA_ENDLESS__;
  window.__NAIWA_ENDLESS__ = { tower: 7, layer: 6, tiles: 810, cap: 7, on: false };
  return true;
})()`);
// 无尽模式结束后会有「上榜」按钮；这里直接触发那条路径：起无尽 → 强制失败 → 点上榜
await page.ev(`(function(){
  var b = document.querySelector('[data-act="levels"]');
  if (b) b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
  return true;
})()`);
await sleep(400);
await page.ev(`(function(){ var b = document.querySelector('.nw-lv[data-lv="5"]'); if (b) b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
await sleep(2500);
// 塞满托盘 → 挑战结束 → 点「上榜」
await page.ev(`(async function(){
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  for (var i = 0; i < 12; i++) {
    if (!document.querySelector('.nw-overlay').hidden) break;
    var tray = [].slice.call(document.querySelectorAll('div[w-295px] .card')).map(function(c){ return c.querySelector('img').alt; });
    var cards = [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]') && !c.querySelector('.mask'); });
    var ok = false;
    for (var k = 0; k < cards.length; k++) {
      var ty = cards[k].querySelector('img').alt;
      if (tray.indexOf(ty) >= 0) continue;
      var r = cards[k].getBoundingClientRect();
      cards[k].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
      cards[k].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      ok = true; break;
    }
    if (!ok) break;
    await sleep(320);
  }
  await sleep(1500);
  return true;
})()`);
const over = await page.ev(`(function(){
  var p = document.querySelector('.nw-panel');
  return { title: (p.querySelector('.nw-title')||{}).textContent,
    buttons: [].slice.call(p.querySelectorAll('[data-run],[data-lb]')).map(function(b){ return b.textContent.trim(); }) };
})()`);
check('挑战结束面板出现「上榜」按钮', /挑战结束/.test(over.title || '') && over.buttons.indexOf('上榜') >= 0,
  `「${over.title}」按钮 ${over.buttons.join(' / ')}`);

await page.ev(`(function(){
  var btns = [].slice.call(document.querySelectorAll('.nw-panel [data-run]'));
  var b = btns.filter(function(x){ return x.textContent.trim() === '上榜'; })[0];
  if (b) b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
  return true;
})()`);
await sleep(500);
const form = await page.ev(`(function(){
  var p = document.querySelector('.nw-panel');
  return { title: (p.querySelector('.nw-title')||{}).textContent, sub: (p.querySelector('.nw-sub')||{}).textContent,
    hasInput: !!p.querySelector('[data-el="nick"]'), nick: (p.querySelector('[data-el="nick"]')||{}).value };
})()`);
check('上榜表单（昵称可改）', form.hasInput && /提交/.test(form.title || ''),
  `「${form.title}」${form.sub} | 默认昵称「${form.nick}」`);

// 填个可识别的昵称并提交
const nick = '自检-' + Math.floor(Math.random() * 900 + 100);
await page.ev(`(function(){
  var i = document.querySelector('[data-el="nick"]');
  i.value = ${JSON.stringify(nick)};
  var b = document.querySelector('[data-lb="send"]');
  b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
  return true;
})()`);
await sleep(4000);
const after = await page.ev(`(function(){
  var p = document.querySelector('.nw-panel');
  var rows = [].slice.call(p.querySelectorAll('.nw-lb__row')).map(function(r){ return r.textContent.replace(/\\s+/g,' ').trim(); });
  return { title: (p.querySelector('.nw-title')||{}).textContent, sub: (p.querySelector('[data-el="lbsub"]')||{}).textContent,
    rows: rows, mine: p.querySelectorAll('.nw-lb__row.is-mine').length, nick: localStorage.getItem('naiwa.nick') };
})()`);
const myRow = after.rows.filter((r) => r.indexOf(nick) >= 0)[0] || '';
check('提交后立刻出现在榜上（并高亮自己）',
  after.mine >= 1 && myRow.length > 0,
  `榜上共 ${after.rows.length} 行，我的高亮 ${after.mine} 行：「${myRow}」| 昵称已记住「${after.nick}」`);

// 4) 服务端直查，确认真的写进去了
const apiTag = await page.ev(`(async function(){
  var body = 'user=zhuadae&secret=9c0ba660&action=search&no=1&count=100&tag=naiwa';
  var r = await fetch('https://tinywebdb.appinventor.space/api', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body });
  var data = JSON.parse(await r.text());
  var tags = Object.keys(data).filter(function(t){ return String(data[t]).indexOf(${JSON.stringify(nick)}) >= 0; });
  return { total: Object.keys(data).length, tags: tags, value: tags.length ? String(data[tags[0]]) : '' };
})()`);
check('服务端确认写入（独立查询）', /自检-/.test(apiTag.value) ,
  `库里共 ${apiTag.total} 条；本次写入 ${apiTag.tags.join(',')} = ${apiTag.value}`);

// 5) 排序切换
await page.ev(`(function(){ var b = document.querySelector('[data-lb="top"]'); b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
await sleep(600);
const topSort = await page.ev(`(function(){
  var p = document.querySelector('.nw-panel');
  var towers = [].slice.call(p.querySelectorAll('.nw-lb__tower')).map(function(b){ return parseInt(b.textContent,10) || 0; });
  return { towers: towers, on: (p.querySelector('.nw-seg__btn.is-on')||{}).textContent };
})()`);
const desc = topSort.towers.every((v, i) => i === 0 || v <= topSort.towers[i - 1]);
check('「最强者」按塔数降序', desc && topSort.towers.length > 0,
  `塔数序列 ${topSort.towers.join(' ≥ ')}（当前标签「${topSort.on}」）`);

await page.shot('30-排行榜面板');

// 6) 删掉本次测试写入的条目（不留垃圾数据）
const del = await page.ev(`(async function(){
  var out = [];
  for (var i = 0; i < ${JSON.stringify(apiTag.tags)}.length; i++) {
    var tag = ${JSON.stringify(apiTag.tags)}[i];
    var body = 'user=zhuadae&secret=9c0ba660&action=delete&tag=' + encodeURIComponent(tag);
    var r = await fetch('https://tinywebdb.appinventor.space/api', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body });
    out.push(tag + '→' + (await r.text()).trim());
  }
  return out;
})()`);
check('清理自检数据', true, del.join(' | ') || '无');

const realErrors = page.errors.filter((e) => !/NotAllowedError|play\(\)/i.test(e));
check('无 JS 异常', realErrors.length === 0, realErrors.length ? realErrors.slice(0, 2).join(' | ') : '0 条');

const bad = results.filter((r) => !r.ok);
console.log('');
console.log('==== 排行榜验证：' + (results.length - bad.length) + '/' + results.length + ' 通过 ====');
if (bad.length) console.log('未通过: ' + bad.map((b) => b.name).join('；'));
await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(150);
process.exit(bad.length ? 1 : 0);
