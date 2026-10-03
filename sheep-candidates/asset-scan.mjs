/**
 * 牌面图"实际用量"扫描：跑一遍完整的游戏流程，看浏览器到底请求了哪些 png
 *
 * 背景：源 dist 的 assets/ 里躺着原版游戏的全部素材（含本轮用不到的 6 张），
 * 打包时如果照着"代码里出现过"来拷，会把它们一起带上。
 * 这里用 CDP 的 Network 事件记录真实请求，输出 asset-usage.json 给 build-portable.mjs 用。
 *
 * 用法: node asset-scan.mjs [url] [cdpPort]
 */
import fs from 'node:fs';
import path from 'node:path';

const URL_TARGET = process.argv[2] || 'file:///C:/Users/YHSome/Projects/OtherProjects/ZhuaNaiWa/index.html';
const CDP_PORT = Number(process.argv[3] || 9222);
const OUT = path.join(import.meta.dirname, 'asset-usage.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.urls = new Set();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { resolve } = this.pending.get(m.id); this.pending.delete(m.id); resolve(m.result); return; }
      if (m.method === 'Network.requestWillBeSent') {
        const u = decodeURIComponent(m.params.request.url);
        if (/\.(png|jpg|jpeg|webp|svg|wav|mp3)(\?|$)/i.test(u)) this.urls.add(u.split('/').pop().split('?')[0]);
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
await page.send('Network.enable');
await page.send('Network.setCacheDisabled', { cacheDisabled: true });
await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

await page.send('Page.navigate', { url: URL_TARGET });
await sleep(3000);                                   // 开局自动发第 1 关
await page.ev(`(function(){ var b = document.querySelector('.nw-lv[data-lv="1"]'); if (b) b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
await sleep(1200);
// 抓几张牌（触发点击音效 + 托盘落牌）
for (let i = 0; i < 4; i++) {
  await page.ev(`(function(){
    var cards = [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]') && !c.querySelector('.mask'); });
    if (!cards.length) return false;
    cards[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    cards[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(320);
}
// 第 4 关（9 种图案，确保 9 张牌面图都被请求到）+ 选关面板 + 玩法说明
await page.ev(`localStorage.setItem('naiwa.progress.v1', JSON.stringify({unlocked:4, cleared:[1,2,3], best:{1:9,2:31,3:58}, stars:{1:3,2:3,3:1}}))`);
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(3000);
await page.ev(`(function(){
  var b = document.querySelector('.nw-lv[data-lv="4"]');
  if (b && !b.disabled) b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
  return true;
})()`);
await sleep(2500);
await page.ev(`(function(){ var h = document.querySelector('[data-run="help"]'); if (h) h.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
await sleep(600);
// 判负/过关面板（音效 win/lose）
await page.ev(`(function(){ var p = document.querySelector('.nw-overlay'); if (p) p.hidden = true; document.querySelectorAll('audio').forEach(function(a){ a.play && a.play().catch(function(){}); }); return true; })()`);
await sleep(1200);

const used = [...page.urls].sort();
const all = fs.readdirSync(path.join(import.meta.dirname, 'xlegex-patched', 'assets')).filter((f) => /\.png$/i.test(f));
const unused = all.filter((f) => !used.includes(f));
fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), used, unusedImages: unused }, null, 2) + '\n', 'utf8');

console.log('运行时实际请求到的资源（' + used.length + '）:');
console.log('  ' + used.join('\n  '));
console.log('');
console.log('源目录里没被请求的图片（' + unused.length + '）: ' + (unused.join(', ') || '无'));
console.log('已写入 ' + path.relative(process.cwd(), OUT));

await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(150);
process.exit(0);
