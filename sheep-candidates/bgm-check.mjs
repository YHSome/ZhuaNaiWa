/**
 * 背景音乐实测：起播 / 循环 / 音量 / 静音联动 / 后台暂停 / 过关让路
 * 用法: node bgm-check.mjs [url] [cdpPort]
 */
const URL_TARGET = process.argv[2] || 'file:///C:/Users/YHSome/Projects/OtherProjects/ZhuaNaiWa/index.html';
const CDP_PORT = Number(process.argv[3] || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = []; this.reqs = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { resolve } = this.pending.get(m.id); this.pending.delete(m.id); resolve(m.result); return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.errors.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
      }
      if (m.method === 'Network.responseReceived') this.reqs.push({ url: m.params.response.url, status: m.params.response.status, type: m.params.type });
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
await page.send('Network.enable');
await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(3500);

const meta = await page.ev(`(function(){
  var a = document.querySelector('audio[data-el="bgm"]');
  return { exists: !!a, src: a ? a.getAttribute('src') : '', loop: a ? a.loop : null,
    preload: a ? a.preload : '', vol: a ? a.volume : null, paused: a ? a.paused : null };
})()`);
check('游戏里有独立的 BGM 元素（loop 循环）',
  meta.exists && /bgm\.wav$/.test(meta.src) && meta.loop === true,
  `src=${meta.src} loop=${meta.loop} 初始音量=${meta.vol} 初始暂停=${meta.paused}`);

// 等元数据拿到时长，核对是不是设计好的 18.46s 循环
await sleep(1500);
const dur = await page.ev(`(function(){
  var a = document.querySelector('audio[data-el="bgm"]');
  return { dur: a.duration, err: a.error ? a.error.code : null, ready: a.readyState };
})()`);
check('BGM 时长与设计一致（8 小节 104BPM ≈ 18.46s）',
  Math.abs(dur.dur - 18.462) < 0.05,
  `duration=${dur.dur}s readyState=${dur.ready} 错误=${dur.err}`);

// 模拟第一次用户手势 → 应当起播并淡入到 0.34
await page.ev(`document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))`);
await sleep(2600);
const playing = await page.ev(`(function(){
  var a = document.querySelector('audio[data-el="bgm"]');
  return { paused: a.paused, vol: Math.round(a.volume * 100) / 100, t: Math.round(a.currentTime * 100) / 100, muted: a.muted };
})()`);
check('首次交互后自动起播并淡入到 0.34',
  playing.paused === false && Math.abs(playing.vol - 0.34) < 0.03,
  `paused=${playing.paused} 音量=${playing.vol} 播放到 ${playing.t}s muted=${playing.muted}`);

check('音量压在音效之下（BGM 0.34 / 音效 1.0）', playing.vol <= 0.4,
  `BGM 音量 ${playing.vol}，音效元素 volume 保持 1.0（默认）`);

// 切换静音：应当淡出并暂停；再切回来应当继续
await page.ev(`document.querySelector('[data-act="mute"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))`);
await sleep(2400);
const mutedState = await page.ev(`(function(){
  var a = document.querySelector('audio[data-el="bgm"]');
  return { paused: a.paused, vol: Math.round(a.volume * 100) / 100,
    icon: document.querySelector('[data-act="mute"]').textContent,
    othersMuted: [].slice.call(document.querySelectorAll('audio:not([data-el="bgm"])')).every(function(x){ return x.muted; }) };
})()`);
check('🔊 一键静音：BGM 淡出并暂停，音效元素同时静音',
  mutedState.paused === true && mutedState.vol < 0.02 && mutedState.othersMuted && mutedState.icon === '🔇',
  `BGM paused=${mutedState.paused} 音量=${mutedState.vol} 图标=${mutedState.icon} 音效已静音=${mutedState.othersMuted}`);

await page.ev(`document.querySelector('[data-act="mute"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))`);
await sleep(2200);
const unmuted = await page.ev(`(function(){
  var a = document.querySelector('audio[data-el="bgm"]');
  return { paused: a.paused, vol: Math.round(a.volume * 100) / 100, icon: document.querySelector('[data-act="mute"]').textContent };
})()`);
check('再点一次恢复播放并淡回 0.34',
  unmuted.paused === false && unmuted.vol > 0.3 && unmuted.icon === '🔊',
  `paused=${unmuted.paused} 音量=${unmuted.vol} 图标=${unmuted.icon}`);

// 过关让路（duck）：开第 1 关并快速清空，音量应短暂降到 ~0.1
await page.ev(`(function(){ var b = document.querySelector('.nw-lv[data-lv="1"]'); if (b) b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; })()`);
await sleep(1200);
await page.ev(`window.__NAIWA__.start(1)`);
await sleep(800);
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
  await sleep(300);
  return true;
})()`);
await sleep(500);
const ducked = await page.ev(`(function(){
  var a = document.querySelector('audio[data-el="bgm"]');
  var panel = document.querySelector('.nw-panel');
  return { vol: Math.round(a.volume * 100) / 100, title: (panel.querySelector('.nw-title')||{}).textContent || '' };
})()`);
check('过关时 BGM 让路（音量临时压低，不盖住音效）',
  ducked.vol < 0.3,
  `过关面板「${ducked.title}」时 BGM 音量 ${ducked.vol}（正常 0.34）`);
await sleep(2500);
const back = await page.ev(`document.querySelector('audio[data-el="bgm"]').volume`);
check('让路结束后音量回到 0.34', Math.abs(back - 0.34) < 0.03, `恢复后音量 ${Math.round(back * 100) / 100}`);

// 后台暂停
await page.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
await page.ev(`Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange'));`);
await sleep(2400);
const hidden = await page.ev(`document.querySelector('audio[data-el="bgm"]').paused`);
await page.ev(`Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange'));`);
await sleep(1500);
const visible = await page.ev(`document.querySelector('audio[data-el="bgm"]').paused`);
check('切到后台自动暂停、切回来续播', hidden === true && visible === false, `隐藏时 paused=${hidden}，回来时 paused=${visible}`);

// 循环：把 currentTime 推到接近结尾，确认它会绕回而不是停
await page.ev(`(function(){ var a = document.querySelector('audio[data-el="bgm"]'); a.currentTime = a.duration - 0.35; return true; })()`);
await sleep(1600);
const looped = await page.ev(`(function(){ var a = document.querySelector('audio[data-el="bgm"]'); return { t: a.currentTime, paused: a.paused, loop: a.loop }; })()`);
check('播到结尾自动无缝循环（不会停）', looped.paused === false && looped.t < 3, `绕回后 currentTime=${Math.round(looped.t * 100) / 100}s paused=${looped.paused}`);

const bgmReq = page.reqs.filter((r) => /bgm\.wav/.test(r.url));
check('bgm.wav 正常加载（HTTP 200 / 本地 file 也读得到）',
  bgmReq.length > 0 && bgmReq.every((r) => r.status === 200 || r.status === 0),
  bgmReq.map((r) => r.status + ' ' + r.url.split('/').pop()).join(' | ') || '（file:// 下无 Network 事件）');

const realErrors = page.errors.filter((e) => !/NotAllowedError|play\(\)|AudioContext/i.test(e));
check('无 JS 异常', realErrors.length === 0, realErrors.length ? realErrors.slice(0, 2).join(' | ') : '0 条');

const bad = results.filter((r) => !r.ok);
console.log('');
console.log('==== 背景音乐验证：' + (results.length - bad.length) + '/' + results.length + ' 通过 ====');
if (bad.length) console.log('未通过: ' + bad.map((b) => b.name).join('；'));
await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(150);
process.exit(bad.length ? 1 : 0);
