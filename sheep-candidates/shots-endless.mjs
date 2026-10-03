/**
 * 新版视觉快照：无尽模式 + 桌面端
 * 用法: node shots-endless.mjs [url] [cdpPort]
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
    console.log('  shots-v2/' + name + '.png');
  }
  async viewport(w, h) {
    await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: w < 700 ? 2 : 1, mobile: w < 600 });
    await sleep(500);
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
await page.viewport(390, 844);
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(3200);
await page.ev(`localStorage.setItem('naiwa.progress.v1', JSON.stringify({unlocked:5, cleared:[1,2,3,4], best:{1:7,2:29,3:64,4:121}, stars:{1:3,2:2,3:1,4:1}, endlessBest:3, endlessTiles:270}))`);
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(3200);

await page.shot('20-选关界面-带无尽模式');

// 挑战关通关后的「难度飙升 · 无尽模式」过渡页
await page.ev(`(function(){ window.__NAIWA_START_ENDLESS__(1, true); return true; })()`);
await sleep(1200);
await page.ev(`(function(){ var b = document.querySelector('.nw-btn[data-act="levels"]'); if (b) b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
await sleep(600);
await page.ev(`(function(){
  // 直接调 ui 层的"难度飙升"过渡页：模拟第 4 关刚通关
  var api = window.__NAIWA__;
  return true;
})()`);
await page.ev(`window.__NAIWA_START_ENDLESS__(1, true)`);
await sleep(2400);
await page.shot('21-无尽模式第1塔-9格托盘');

// 清空第 1 塔：严格照求解器给的完整解法走
await page.ev(`window.__NAIWA_SOLVE__ = []`);
const plan = (await page.ev(`window.__NAIWA_HINT__()`)).seq;
console.log('   第 1 塔解法 ' + plan.length + ' 步');
for (let i = 0; i < plan.length; i++) {
  const ok = await page.ev(`(function(){
    var panel = document.querySelector('.nw-overlay');
    if (!panel.hidden) return false;
    var board = [].slice.call(document.querySelectorAll('.card')).filter(function(c){
      return !c.closest('div[w-295px]') && !/leave-active|leave-to/.test(c.className || '');
    });
    var key = ${JSON.stringify('PLACEHOLDER')};
    var el = null;
    board.forEach(function(c){ if (('id:' + c.__nwId) === key) el = c; });
    if (!el || el.querySelector('.mask')) return false;
    var r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  })()`.replace(JSON.stringify('PLACEHOLDER'), JSON.stringify(plan[i].key)));
  if (!ok) break;
  await sleep(200);
}
await sleep(800);
await page.shot('22-第1塔清空-下一塔更紧');

await sleep(4400);
await page.shot('23-无尽模式第2塔');

// 托盘告警（第 2 塔 9 格）
await page.ev(`(async function(){
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  for (var i = 0; i < 10; i++) {
    if (!document.querySelector('.nw-overlay').hidden) break;
    var tray = [].slice.call(document.querySelectorAll('div[w-295px] .card')).map(function(c){ return c.querySelector('img').alt; });
    var cards = [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]') && !c.querySelector('.mask'); });
    var ok = false;
    for (var k = 0; k < cards.length; k++) {
      var ty = cards[k].querySelector('img').alt;
      if (tray.indexOf(ty) >= 0) continue;
      var r = cards[k].getBoundingClientRect();
      var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      if (document.elementFromPoint(x, y).closest('.card') !== cards[k]) continue;
      cards[k].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
      cards[k].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      ok = true; break;
    }
    if (!ok) break;
    await sleep(300);
  }
  await sleep(1200);
  return true;
})()`);
await sleep(600);
await page.shot('24-挑战结束面板');

// 桌面端
await page.viewport(1440, 900);
await page.ev(`(function(){ var b = document.querySelector('.nw-btn[data-act="levels"]'); if (b) b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
await sleep(700);
await page.shot('25-桌面选关-与牌桌同宽');
await page.ev(`(function(){ var b = document.querySelector('.nw-lv[data-lv="5"]'); if (b) b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
await sleep(2600);
await page.shot('26-桌面无尽模式-牌堆自适应缩放');

console.log('done');
await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(150);
process.exit(0);
