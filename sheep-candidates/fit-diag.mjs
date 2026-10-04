/**
 * 定位"小屏上牌堆被摆太低"的原因：把可用区(band)、宿主矩形、inline transform 全打出来
 * 用法: node fit-diag.mjs [url] [cdpPort] [w] [h]
 */
const URL_TARGET = process.argv[2] || 'file:///C:/Users/YHSome/Projects/OtherProjects/ZhuaNaiWa/index.html';
const CDP_PORT = Number(process.argv[3] || 9222);
const W = Number(process.argv[4] || 320);
const H = Number(process.argv[5] || 568);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
const browser = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(browser.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: URL_TARGET });
await sleep(3400);

const dump = `(function(){
  var px = function(v){ return Math.round(v*10)/10; };
  var bar = document.querySelector('.nw-progress').getBoundingClientRect();
  var row = document.querySelector('#app > div > div[h-50px][text-center]');
  var tray = document.querySelector('div[w-295px]');
  var host = document.querySelector('#app div[relative][flex-1]');
  var hr = host.getBoundingClientRect();
  var title = document.querySelector('#app > div > div[text-44px]');
  var board = [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]'); });
  var rs = board.map(function(c){ return c.getBoundingClientRect(); });
  return {
    视口: window.innerWidth + '×' + window.innerHeight,
    标题显示: title ? getComputedStyle(title).display : 'n/a',
    进度条底: px(bar.bottom),
    道具行顶: row ? px(row.getBoundingClientRect().top) : null,
    木槽顶: tray ? px(tray.getBoundingClientRect().top) : null,
    宿主: px(hr.top) + '~' + px(hr.bottom) + ' 高' + px(hr.height),
    inlineTransform: host.style.transform,
    计算后Transform: getComputedStyle(host).transform,
    origin: getComputedStyle(host).transformOrigin,
    牌数: board.length,
    牌堆: px(Math.min.apply(null, rs.map(function(r){return r.top;}))) + '~' + px(Math.max.apply(null, rs.map(function(r){return r.bottom;}))),
  };
})()`;
console.log('== ' + W + '×' + H + ' 开局第 1 关 ==');
console.log(await ev(dump));

await ev(`(function(){ var b = document.querySelector('.nw-lv[data-lv="4"]'); if (b) b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
await sleep(2500);
console.log('');
console.log('== 第 4 关（54 张）==');
console.log(await ev(dump));

ws.close();
process.exit(0);
