/**
 * 桌面端布局诊断：
 *   1. 打印游戏根节点的子元素结构（找"署名那行"和"第N关"提示的精确特征）
 *   2. 在 1440×900 / 1280×800 / 1920×1080 下量：标题、牌堆包围盒、木槽、道具按钮、HUD
 *   3. 检查牌堆是否溢出容器 / 是否与 HUD 重叠 / 木槽与牌堆间距
 * 用法: node desktop-diag.mjs [url] [cdpPort]
 */
import fs from 'node:fs';
import path from 'node:path';

const URL_TARGET = process.argv[2] || 'file:///C:/Users/YHSome/Projects/OtherProjects/ZhuaNaiWa/index.html';
const CDP_PORT = Number(process.argv[3] || 9222);
const OUT = path.join(import.meta.dirname, 'shots-v2');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { resolve } = this.pending.get(m.id); this.pending.delete(m.id); resolve(m.result); }
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
await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(3400);

console.log('== 游戏根节点结构（只看直接子元素）==');
console.log(await page.ev(`(function(){
  var root = document.querySelector('#app > div');
  return [].slice.call(root.children).map(function(c, i){
    var r = c.getBoundingClientRect();
    var txt = (c.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 46);
    var attrs = [].slice.call(c.attributes).map(function(a){ return a.name + '=' + a.value; }).join(' ').slice(0, 130);
    return i + ' <' + c.tagName.toLowerCase() + '> @' + Math.round(r.top) + ',' + Math.round(r.left)
      + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' 文本"' + txt + '"\\n     ' + attrs;
  }).join('\\n');
})()`));
console.log('');
console.log('== body / 根容器样式 ==');
console.log(await page.ev(`(function(){
  var cs = getComputedStyle(document.body);
  var root = document.querySelector('#app > div');
  var rs = getComputedStyle(root);
  return 'body: ' + cs.padding + ' | display=' + cs.display + ' | ' + cs.alignItems + ' | bg=' + cs.backgroundColor
    + '\\n#app>div: ' + root.getBoundingClientRect().width + 'x' + root.getBoundingClientRect().height
    + ' | padding=' + rs.padding;
})()`));

for (const [w, h] of [[1440, 900], [1280, 800], [1920, 1080]]) {
  await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  const m = await page.ev(`(function(){
    var r = function(e){ return e ? e.getBoundingClientRect() : null; };
    var box = function(b){ return b ? Math.round(b.left) + ',' + Math.round(b.top) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height) : 'n/a'; };
    var board = [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]'); });
    var rects = board.map(function(c){ return c.getBoundingClientRect(); }).filter(function(b){ return b.width > 0; });
    var minL = Math.min.apply(null, rects.map(function(b){ return b.left; }));
    var maxR = Math.max.apply(null, rects.map(function(b){ return b.right; }));
    var minT = Math.min.apply(null, rects.map(function(b){ return b.top; }));
    var maxB = Math.max.apply(null, rects.map(function(b){ return b.bottom; }));
    var host = document.querySelector('#app div[relative][flex-1]');
    var hostR = r(host);
    var tray = document.querySelector('div[w-295px]');
    var hud = document.querySelector('.nw-hud');
    var pips = document.querySelector('.nw-progress');
    return {
      vw: window.innerWidth, vh: window.innerHeight,
      title: box(r(document.querySelector('#app > div > div[text-44px]'))),
      host: box(hostR),
      board: Math.round(minL) + '~' + Math.round(maxR) + ' x ' + Math.round(minT) + '~' + Math.round(maxB),
      boardOverflowX: Math.round(Math.min(minL - hostR.left, hostR.right - maxR)),
      cardTop: Math.round(minT), cardBottom: Math.round(maxB),
      tray: box(r(tray)), hud: box(r(hud)), bar: box(r(pips)),
      trayGapFromBoard: Math.round(r(tray).top - maxB),
      btnRow: box(r(document.querySelector('#app button'))),
      foot: box(r(document.querySelector('#app > div > div:last-child'))),
      scaleHost: getComputedStyle(host).transform
    };
  })()`);
  console.log('');
  console.log(`---- ${w}×${h} ----`);
  console.log('  标题       ' + m.title);
  console.log('  牌堆容器   ' + m.host + '  (transform ' + m.scaleHost + ')');
  console.log('  牌堆实际   ' + m.board + ' | 横向余量 ' + m.boardOverflowX + 'px | 距木槽 ' + m.trayGapFromBoard + 'px');
  console.log('  木槽       ' + m.tray);
  console.log('  HUD/进度条 ' + m.hud + ' / ' + m.bar);
  console.log('  道具按钮   ' + m.btnRow);
  console.log('  底部署名   ' + m.foot);
  if (w === 1440) console.log('  → 截图 ' + (await page.shot('10-桌面-1440x900')));
}
wsUrl = null;
await page.shot('11-桌面-1280x800');
await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await sleep(500);
await page.shot('11-桌面-1280x800');

await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(150);
process.exit(0);
