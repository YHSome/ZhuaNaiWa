/** 采样：看素材里"落地阴影"到底是什么 RGBA，好定去阴影的判据 */
const CDP_PORT = Number(process.argv[2] || 9222);
const BASE = process.argv[3] || 'http://127.0.0.1:8123';
const NAME = process.argv[4] || '01-grape.png';

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
  async evaluate(x) {
    const r = await this.send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
}

const ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
const browser = await CDP.connect(ver.webSocketDebuggerUrl);
const { targetId } = await browser.send('Target.createTarget', { url: BASE + '/' });
await new Promise((r) => setTimeout(r, 2000));
const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = await CDP.connect(list.find((t) => t.id === targetId).webSocketDebuggerUrl);
await page.send('Runtime.enable');

const out = await page.evaluate(`(async () => {
  const bmp = await createImageBitmap(await (await fetch('/src/better/${NAME}')).blob());
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0);
  const d = x.getImageData(0, 0, bmp.width, bmp.height).data;
  const sat = (i) => {
    const r = d[i], g = d[i+1], b = d[i+2];
    const mx = Math.max(r,g,b), mn = Math.min(r,g,b);
    return mx === 0 ? 0 : (mx - mn) / mx;
  };
  // 按行统计：每行的不透明像素数与平均饱和度
  const rows = [];
  for (let y = 0; y < bmp.height; y += 16) {
    let n = 0, s = 0, alphaSum = 0, opaqueGray = 0;
    for (let px = 0; px < bmp.width; px++) {
      const i = (y * bmp.width + px) * 4;
      if (d[i+3] > 8) { n++; s += sat(i); alphaSum += d[i+3]; if (d[i+3] >= 250 && sat(i) < 0.20) opaqueGray++; }
    }
    rows.push({ y, opaque: n, avgSat: n ? +(s/n).toFixed(3) : null, avgAlpha: n ? Math.round(alphaSum/n) : null, opaqueGray });
  }
  // 底部 40 行里几个代表性像素
  const samples = [];
  for (const y of [420, 440, 460, 480, 500]) {
    for (const px of [160, 256, 350]) {
      const i = (y * bmp.width + px) * 4;
      samples.push({ x: px, y, rgba: [d[i], d[i+1], d[i+2], d[i+3]], sat: +sat(i).toFixed(3) });
    }
  }
  return { size: bmp.width + 'x' + bmp.height, rows, samples };
})()`);

console.log('素材:', NAME, out.size);
console.log('\n按行统计（每 16 行）：y | 不透明像素 | 平均饱和度 | 平均alpha | 完全不透明的灰色像素');
out.rows.filter((r) => r.opaque > 0).forEach((r) => {
  console.log(`  ${String(r.y).padStart(3)} | ${String(r.opaque).padStart(4)} | ${String(r.avgSat).padEnd(6)} | ${String(r.avgAlpha).padStart(3)} | ${r.opaqueGray}`);
});
console.log('\n底部代表性像素：');
out.samples.forEach((s) => console.log(`  (${s.x},${s.y}) rgba=[${s.rgba.join(',')}] sat=${s.sat}`));

await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
process.exit(0);
