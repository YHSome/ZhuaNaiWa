/**
 * 宣传片"画面尺寸"实测：在多种窗口尺寸下量舞台包围盒到底有没有超出视口
 * 用法: node promo-fit-check.mjs [promoUrl] [cdpPort]
 */
const URL_TARGET = process.argv[2] || 'file:///C:/Users/YHSome/Projects/OtherProjects/ZhuaNaiWa/promo/index.html';
const CDP_PORT = Number(process.argv[3] || 9222);
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
await page.send('Page.navigate', { url: URL_TARGET });
await sleep(2000);

const sizes = [[1920, 1080], [1920, 940], [1600, 900], [1536, 864], [1440, 812], [1366, 768], [1280, 720], [1152, 700], [1024, 640], [900, 1400]];

async function sweep(label) {
  console.log('');
  console.log('【' + label + '】');
  console.log('窗口尺寸  | 缩放  | 舞台可视区（应完全落在窗口内）        | 溢出 | 文档滚动区');
  console.log('----------|-------|--------------------------------------|------|-----------');
  let bad = 0;
  for (const [w, h] of sizes) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const m = await page.ev(`(function(){
      var r = document.getElementById('stage').getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
        vw: window.innerWidth, vh: window.innerHeight,
        sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
        tag: (document.getElementById('scaleTag') || {}).textContent || '',
        clean: document.body.classList.contains('clean') };
    })()`);
    const overX = m.x < -0.5 || (m.x + m.w) > m.vw + 0.5;
    const overY = m.y < -0.5 || (m.y + m.h) > m.vh + 0.5;
    if (overX || overY) bad++;
    console.log(` ${String(w + 'x' + h).padEnd(9)} | ${(m.w / 1920).toFixed(2)}  | ${String(m.x + ',' + m.y).padEnd(10)} ${String(m.w + 'x' + m.h).padEnd(12)} | ${overX || overY ? '是 ✗' : '否'} | ${m.sw}×${m.sh}  ${m.tag}`);
  }
  return bad;
}

const bad1 = await sweep('控制条显示时');
// 播放时控制条会隐藏，画面应当再大一点但仍然装得下
await page.ev(`document.getElementById('btnClean').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
await sleep(400);
const bad2 = await sweep('控制条隐藏时（录制状态）');
const bad = bad1 + bad2;
console.log('');
console.log(bad ? `⚠ ${bad} 个尺寸下舞台超出了视口` : '✅ 两种状态下、所有尺寸的舞台都完整落在视口内');
console.log('（若这里全部正常，那"要缩到 80%"多半是窗口比 1920 窄、舞台上留了黑边让人以为被裁了）');
await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(150);
process.exit(0);
