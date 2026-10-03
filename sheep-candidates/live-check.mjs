/**
 * 线上（GitHub Pages）实测：真机上跑一遍关键路径
 *   · 首页能开、能开局、牌面图不裂
 *   · 排行榜能从 https 源读到实时数据（跨域 + HTTPS 混合内容都没问题）
 *   · 宣传片能加载、能播
 * 用法: node live-check.mjs [baseUrl] [cdpPort]
 */
const BASE = process.argv[2] || 'https://yhsome.github.io/ZhuaNaiWa/';
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
      if (m.method === 'Network.responseReceived') {
        const url = m.params.response.url;
        if (/\.(png|wav|js|css)$/.test(url) || /tinywebdb/.test(url)) this.reqs.push({ url: url, status: m.params.response.status });
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
await page.send('Page.navigate', { url: BASE });
await sleep(5000);

const boot = await page.ev(`(function(){
  var imgs = [].slice.call(document.querySelectorAll('img'));
  return { title: document.title, ui: !!document.getElementById('nw-ui'), fx: window.__NAIWA_FX__,
    tiles: [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]'); }).length,
    broken: imgs.filter(function(i){ return !(i.complete && i.naturalWidth > 0); }).length,
    proto: location.protocol };
})()`);
check('线上首页能开、游戏起来了', boot.ui && boot.fx === 'on' && boot.tiles === 9 && boot.broken === 0,
  `${boot.proto} | 标题「${boot.title}」| 盘面 ${boot.tiles} 张 | 裂图 ${boot.broken} 张`);

// 排行榜：从 https 源读实时数据
await page.ev(`document.querySelector('[data-act="leaderboard"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))`);
await sleep(4000);
const lb = await page.ev(`(function(){
  var p = document.querySelector('.nw-panel');
  return { sub: (p.querySelector('[data-el="lbsub"]')||{}).textContent, rows: p.querySelectorAll('.nw-lb__row').length,
    first: (p.querySelector('.nw-lb__row')||{}).textContent || '（空榜）' };
})()`);
check('线上能读到排行榜（HTTPS 跨域 OK）', /实时数据/.test(lb.sub || ''),
  `${lb.sub} | ${lb.rows} 行 | ${lb.first.replace(/\s+/g, ' ').trim()}`);

const dbReq = page.reqs.filter((r) => /tinywebdb/.test(r.url));
check('排行榜请求真的发出去了', dbReq.length > 0, dbReq.map((r) => r.status + ' ' + r.url).join(' | '));

const staticReq = page.reqs.filter((r) => /\.(png|wav)$/.test(r.url));
const bad = staticReq.filter((r) => r.status >= 400);
check('静态资源全部 200', staticReq.length >= 5 && bad.length === 0,
  `${staticReq.length} 个资源（图/音效），失败 ${bad.length} 个`);

// 宣传片
await page.send('Page.navigate', { url: BASE + 'promo/' });
await sleep(3500);
const promo = await page.ev(`(function(){
  return { tiles: document.querySelectorAll('.tile').length, url: document.getElementById('endUrl').textContent,
    btn: !!document.getElementById('btnStart'), title: document.title };
})()`);
check('线上宣传片能加载', promo.tiles > 0 && promo.btn,
  `演示牌 ${promo.tiles} 张 | 结尾网址「${promo.url}」`);

const realErrors = page.errors.filter((e) => !/NotAllowedError|play\(\)|AudioContext/i.test(e));
check('无 JS 异常', realErrors.length === 0, realErrors.length ? realErrors.slice(0, 2).join(' | ') : '0 条');

const fail = results.filter((r) => !r.ok);
console.log('');
console.log('==== 线上实测：' + (results.length - fail.length) + '/' + results.length + ' 通过 ====');
if (fail.length) console.log('未通过: ' + fail.map((f) => f.name).join('；'));
await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(150);
process.exit(fail.length ? 1 : 0);
