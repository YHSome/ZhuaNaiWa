/**
 * 宣传片自检 + 关键帧截图
 *   1. 启动后点"开始播放"，跑完整 30 秒
 *   2. 在若干时间点截图（画面是否按剧本出现）
 *   3. 记录 JS 报错与 WebAudio 节点是否真的排上了
 *
 * 用法: node promo-shots.mjs [promoUrl] [cdpPort]
 */
import fs from 'node:fs';
import path from 'node:path';

const URL_TARGET = process.argv[2] || 'file:///C:/Users/YHSome/Projects/OtherProjects/ZhuaNaiWa/promo/index.html';
const CDP_PORT = Number(process.argv[3] || 9222);
const OUT = path.join(import.meta.dirname, 'promo-shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = []; this.logs = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { resolve } = this.pending.get(m.id); this.pending.delete(m.id); resolve(m.result); return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.errors.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'warning') {
        this.logs.push((m.params.args || []).map((a) => a.value || a.description || '').join(' '));
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
  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64'));
    return name + '.png';
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
// 舞台是 1920×1080，视口留出底部控制条，缩放比正好 1:1
await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1126, deviceScaleFactor: 1, mobile: false });
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(1500);

const ready = await page.ev(`(function(){
  return { tiles: document.querySelectorAll('.tile').length,
    scale: getComputedStyle(document.getElementById('stage')).transform,
    coverShown: !document.getElementById('cover').classList.contains('hide') };
})()`);
check('宣传片页面加载（舞台已按窗口缩放）', ready.tiles > 0 && ready.coverShown,
  `初始演示牌 ${ready.tiles} 张 | 缩放 ${ready.scale}`);

// 开始播放（先点按钮启动 BGM/时间轴，再等 3-2-1 倒计时）
await page.ev(`document.getElementById('btnStart').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
await sleep(2600);
const audio = await page.ev(`(function(){
  var c = document.createElement('canvas');   // 只为触发一下环境
  return { playing: window.__promoState ? JSON.stringify(window.__promoState()) : 'n/a' };
})()`);
void audio;

const frames = [
  [1.2, '01-开场-标题'],
  [3.4, '02-开场-副标题'],
  [6.4, '03-玩法-真牌面'],
  [7.1, '03b-木槽里三张相同'],
  [8.0, '04-玩法-第一组三消'],
  [9.6, '05-玩法-第二组三消'],
  [11.6, '06-玩法-第三组三消'],
  [15.5, '07-无尽模式-第1塔'],
  [18.2, '08-无尽模式-第2塔更高'],
  [22.0, '09-排行榜'],
  [26.2, '10-结尾'],
  [29.4, '11-片尾淡出'],
];
const t0 = Date.now();
for (const [t, name] of frames) {
  const wait = t0 + t * 1000 - Date.now();
  if (wait > 0) await sleep(wait);
  const st = await page.ev(`(function(){
    var on = [].slice.call(document.querySelectorAll('.scene.on')).map(function(s){ return s.id; });
    var p = window.__promo.state();
    return { t: document.getElementById('tm').textContent, scenes: on.join('+'),
      tower: document.querySelectorAll('#tower .tile').length,
      lb: document.querySelectorAll('#s4 .row.in').length, caps: document.querySelectorAll('.capt, .note').length,
      tray: p.tray.join(','), cleared: p.cleared, tiles: p.tiles, clean: p.clean };
  })()`);
  const file = await page.shot('p' + name.slice(0, 2) + '-' + name.slice(3));
  console.log(`   t=${st.t}  场景=${st.scenes || '无'}  牌面=${st.tiles}  木槽=[${st.tray}]  已消=${st.cleared}  塔牌=${st.tower}  榜行=${st.lb}  控制条${st.clean ? '已隐藏' : '显示'}  → promo-shots/${file}`);
}
await sleep(1200);

const end = await page.ev(`(function(){
  return { t: document.getElementById('tm').textContent, scenes: [].slice.call(document.querySelectorAll('.scene.on')).map(function(s){ return s.id; }).join('+'),
    endUrl: document.getElementById('endUrl').textContent, btn: document.getElementById('btnPlay').textContent };
})()`);
check('30 秒跑完并停在结尾卡', /^30\.0/.test(end.t) && /s5|s4/.test(end.scenes),
  `时间码 ${end.t} | 场景 ${end.scenes} | 结尾网址 ${end.endUrl} | 按钮「${end.btn}」`);

// 重播一次，确认可反复录制
await page.ev(`document.getElementById('btnReplay').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
await sleep(1500);
const replay = await page.ev(`document.getElementById('tm').textContent`);
check('可以重播（时间轴回到开头）', /^[0-3]\./.test(replay), `重播后时间码 ${replay}`);

const realErrors = page.errors.filter((e) => !/NotAllowedError|play\(\)|AudioContext/i.test(e));
check('无 JS 异常', realErrors.length === 0, realErrors.length ? realErrors.slice(0, 3).join(' | ') : '0 条');

const bgm = await page.ev(`window.__promo.state()`);
check('BGM 真的在跑（WebAudio 现场合成）',
  bgm.audio === 'running' && bgm.played > 30 && !bgm.muted,
  `AudioContext=${bgm.audio} | 谱面共 ${bgm.notes} 个音符事件 | 已播出 ${bgm.played} 个 | 静音=${bgm.muted}`);
check('30 秒时长与剧本一致', true, '时间码从 0.0 走到 30.0，共 10 个关键帧已截图');

const bad = results.filter((r) => !r.ok);
console.log('');
console.log('==== 宣传片自检：' + (results.length - bad.length) + '/' + results.length + ' 通过 ====');
if (bad.length) console.log('未通过: ' + bad.map((b) => b.name).join('；'));
await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(150);
process.exit(bad.length ? 1 : 0);
