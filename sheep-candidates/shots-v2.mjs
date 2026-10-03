/**
 * 新版视觉快照：木槽 9 个槽位 / 危险告警 / 评星结算 / 选关星星 / 横屏
 * 用法: node shots-v2.mjs [url] [cdpPort]
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
  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64'));
    console.log('  shots-v2/' + name + '.png');
  }
  async viewport(w, h) {
    await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 600 });
    await sleep(450);
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
await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await page.viewport(390, 844);
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(3400);

// 带存档进选关界面（有星星 / 最快用时）
await page.ev(`localStorage.setItem('naiwa.progress.v1', JSON.stringify({unlocked:4, cleared:[1,2,3], best:{1:7,2:29,3:64}, stars:{1:3,2:2,3:1}}))`);
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(3200);
await page.shot('01-选关界面-带星星');

// 玩法说明
await page.ev(`(function(){ document.querySelector('[data-run="help"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
await sleep(500);
await page.shot('02-玩法说明');

// 第 4 关：抓 3 张（槽位点亮）
await page.ev(`(function(){ document.querySelector('[data-run="back-levels"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
await sleep(500);
await page.ev(`(function(){ document.querySelector('.nw-lv[data-lv="4"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
await sleep(2600);
async function tapDistinct(n) {
  for (let i = 0; i < n; i++) {
    await page.ev(`(function(){
      var trayEl = document.querySelector('div[w-295px]');
      var tray = [].slice.call(trayEl.querySelectorAll('.card')).map(function(c){ return c.querySelector('img').alt; });
      var cards = [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]') && !c.querySelector('.mask'); });
      for (var i = 0; i < cards.length; i++) {
        var ty = cards[i].querySelector('img').alt;
        if (tray.indexOf(ty) >= 0) continue;
        var r = cards[i].getBoundingClientRect();
        var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
        var hit = document.elementFromPoint(x, y);
        if (!hit || !hit.closest || hit.closest('.card') !== cards[i]) continue;
        cards[i].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: x, clientY: y }));
        cards[i].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      }
      return false;
    })()`);
    await sleep(300);
  }
}
await tapDistinct(3);
await page.shot('03-木质托盘-3格点亮');
await tapDistinct(4);
await sleep(500);
await page.shot('04-托盘告警-7格橙色');

// 结算面板（造一次过关：直接开第 1 关并快速通关）
await page.ev(`(function(){ document.querySelector('.nw-btn[data-act="levels"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
await sleep(400);
await page.ev(`(function(){ document.querySelector('.nw-lv[data-lv="1"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
await sleep(1400);
await page.ev(`(async function(){
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  for (var step = 0; step < 40; step++) {
    var free = [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]') && !c.querySelector('.mask'); });
    if (!free.length) break;
    var tray = [].slice.call(document.querySelectorAll('div[w-295px] .card')).map(function(c){ return c.querySelector('img').alt; });
    var cnt = {}; tray.forEach(function(t){ cnt[t] = (cnt[t] || 0) + 1; });
    var byType = {}; free.forEach(function(c){ var t = c.querySelector('img').alt; (byType[t] = byType[t] || []).push(c); });
    var pick = free.filter(function(c){ return cnt[c.querySelector('img').alt] === 2; })[0]
            || free.filter(function(c){ return (byType[c.querySelector('img').alt] || []).length >= 2; })[0] || free[0];
    pick.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    pick.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(170);
  }
  await sleep(600);
  return true;
})()`);
await sleep(1200);
await page.shot('05-过关评星');

// 难度飙升
await page.ev(`(function(){ var b = document.querySelector('.nw-panel [data-run="下一关 →"]'); if (b) b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
await sleep(700);
await page.shot('06-难度飙升');

// 横屏
await page.viewport(844, 390);
await sleep(600);
await page.shot('07-横屏选关');

await page.ev(`(function(){ document.querySelector('.nw-btn[data-act="levels"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
await sleep(600);
await page.shot('08-横屏面板');

console.log('JS 报错: ' + (page.errors.length ? page.errors.slice(0, 2).join(' | ') : 'none'));
await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(150);
process.exit(0);
