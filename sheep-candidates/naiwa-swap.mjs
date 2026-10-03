/**
 * 把 /src 里的「奶蛙」素材处理成游戏 tile（v2）
 *
 *  1. 浏览器 canvas 解码（jpg/png/webp 通吃，无需 magick/ffmpeg）
 *  2. 先在「原图比例」的画布上从真实边缘做洪泛抠底（仅对四边不透明的照片素材）
 *       判据：与背景平均色偏差 <= maxDev 且相邻像素跳变 <= stepTol 才继续扩散
 *       保护：若被抠掉 >90% 像素，判定为误吃，回滚
 *  3. 再 contain 缩放进 120x120 透明画布（原 tile 就是 ~120x120）
 *  4. 输出 PNG + 40px 游戏卡片样式的对照表 sheet.html
 *
 * 用法: node naiwa-swap.mjs [cdpPort] [baseUrl]
 */
import fs from 'node:fs';
import path from 'node:path';

const CDP_PORT = Number(process.argv[2] || 9222);
const BASE = process.argv[3] || 'http://127.0.0.1:8123';
const OUT = path.join(import.meta.dirname, 'naiwa-tiles');
const FILES = ['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.png', '6.webp', '7.webp', '8.png', '9.webp', '10.jpg', '11.jpg'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WS 连接失败: ' + url)), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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
await page.send('Page.navigate', { url: BASE + '/' });
await sleep(1200);

const raw = await page.evaluate(`(${async function (files) {
  const SIZE = 120;
  const CAP = 320;
  const out = {}, stats = {};

  /** 从四边洪泛抠底：返回抠掉的像素数（-1 表示误吃已回滚，0 表示无需/未执行） */
  function cutBackground(ctx, w, h) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const at = (x, y) => (y * w + x) * 4;

    // 1) 采样四边，判断是否不透明背景 + 求背景平均色
    let opaque = 0, sampled = 0, sr = 0, sg = 0, sb = 0;
    const xs = [], ys = [];
    for (let x = 0; x < w; x++) xs.push(x);
    for (let y = 0; y < h; y++) ys.push(y);
    const sample = (x, y) => {
      const i = at(x, y);
      sampled++;
      if (d[i + 3] > 200) { opaque++; sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; }
    };
    for (let x = 0; x < w; x += Math.max(1, (w / 24) | 0)) { sample(x, 0); sample(x, h - 1); }
    for (let y = 0; y < h; y += Math.max(1, (h / 24) | 0)) { sample(0, y); sample(w - 1, y); }
    if (opaque / sampled < 0.6) return 0;            // 已经是透明底，不用抠
    sr /= opaque; sg /= opaque; sb /= opaque;

    // 2) 洪泛（STEP_TOL 跟渐变、MAX_DEV 防止爬进主体）
    const STEP_TOL = 10, MAX_DEV = 82;
    const visited = new Uint8Array(w * h);
    const stack = [];
    for (let x = 0; x < w; x++) { stack.push(x, w * (h - 1) + x); }
    for (let y = 0; y < h; y++) { stack.push(w * y, w * y + w - 1); }
    let cleared = 0;
    while (stack.length) {
      const p = stack.pop();
      if (visited[p]) continue;
      visited[p] = 1;
      const i = p * 4;
      if (d[i + 3] > 0) {
        const dev = Math.sqrt((d[i] - sr) ** 2 + (d[i + 1] - sg) ** 2 + (d[i + 2] - sb) ** 2);
        if (dev > MAX_DEV) continue;                 // 认定为前景
        d[i + 3] = 0;
        cleared++;
      }
      const x = p % w, y = (p - x) / w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q < 0 || visited[q]) continue;
        const qi = q * 4;
        if (d[i + 3] !== 0 && d[qi + 3] !== 0) {
          const step = Math.sqrt((d[qi] - d[i]) ** 2 + (d[qi + 1] - d[i + 1]) ** 2 + (d[qi + 2] - d[i + 2]) ** 2);
          if (step > STEP_TOL) continue;
        }
        stack.push(q);
      }
    }
    if (cleared > w * h * 0.9) { ctx.putImageData(img, 0, 0); return -1; }   // 误吃，回滚
    ctx.putImageData(img, 0, 0);
    return cleared;
  }

  for (const name of files) {
    const res = await fetch('/src/' + name);
    if (!res.ok) { stats[name] = 'fetch ' + res.status; continue; }
    const bmp = await createImageBitmap(await res.blob());

    // 原图比例画布（上限 CAP），在上面抠底
    const s = Math.min(1, CAP / Math.max(bmp.width, bmp.height));
    const tw = Math.max(1, Math.round(bmp.width * s));
    const th = Math.max(1, Math.round(bmp.height * s));
    const tmp = document.createElement('canvas');
    tmp.width = tw; tmp.height = th;
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(bmp, 0, 0, tw, th);
    const cleared = cutBackground(tctx, tw, th);

    // 按 alpha 包围盒裁掉四周空白，让每张 tile 的视觉体积一致
    let sx = 0, sy = 0, sw = tw, sh = th;
    {
      const data = tctx.getImageData(0, 0, tw, th).data;
      let minX = tw, minY = th, maxX = -1, maxY = -1;
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          if (data[(y * tw + x) * 4 + 3] > 8) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX > minX && maxY > minY) { sx = minX; sy = minY; sw = maxX - minX + 1; sh = maxY - minY + 1; }
    }
    const crop = document.createElement('canvas');
    crop.width = sw; crop.height = sh;
    const cctx = crop.getContext('2d');
    cctx.imageSmoothingQuality = 'high';
    cctx.drawImage(tmp, sx, sy, sw, sh, 0, 0, sw, sh);

    // contain 进 120x120 透明画布
    const scale = Math.min((SIZE - 4) / sw, (SIZE - 4) / sh);
    const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
    const c = document.createElement('canvas');
    c.width = SIZE; c.height = SIZE;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(crop, Math.round((SIZE - w) / 2), Math.round((SIZE - h) / 2), w, h);

    out[name.replace(/\.[^.]+$/, '')] = c.toDataURL('image/png');
    stats[name] = { src: bmp.width + 'x' + bmp.height, drawn: w + 'x' + h, cleared, area: tw * th, crop: sw + 'x' + sh };
  }
  return { out, stats };
}.toString()})(${JSON.stringify(FILES)})`);

fs.mkdirSync(OUT, { recursive: true });
let n = 0;
for (const [name, dataUrl] of Object.entries(raw.out)) {
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
  n++;
}
for (const f of FILES) {
  const s = raw.stats[f];
  if (typeof s === 'string') { console.log(`${f.padEnd(9)} ${s}`); continue; }
  const pct = s.cleared > 0 ? ((s.cleared / s.area) * 100).toFixed(1) + '%' : (s.cleared === -1 ? '误吃已回滚' : '无需抠底');
  console.log(`${f.padEnd(9)} 原图 ${s.src.padEnd(10)} 裁白边 ${s.crop.padEnd(9)} -> 画布内 ${s.drawn.padEnd(8)} 抠底 ${pct}`);
}
console.log('\n已生成 ' + n + ' 张 tile -> ' + path.relative(process.cwd(), OUT));

const cells = Object.entries(raw.out)
  .sort((a, b) => Number(a[0]) - Number(b[0]))
  .map(([name, url]) => `<div class="wrap"><div class="card"><img src="${url}" width="40" height="40" alt="${name}"></div><span>${name}</span></div>`)
  .join('\n');

const sheet = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>奶蛙 tile 对照表</title>
<style>
  body{margin:0;padding:24px;background:#9ee06a;font-family:system-ui,"Microsoft YaHei",sans-serif}
  h1{font-size:20px;margin:0 0 4px}
  p{font-size:12px;color:#33501f;margin:0 0 18px}
  .grid{display:flex;flex-wrap:wrap;gap:18px}
  .wrap{display:flex;flex-direction:column;align-items:center;gap:6px}
  .wrap span{font-size:11px;color:#2b4419}
  .card{width:40px;height:40px;display:flex;align-items:center;justify-content:center;background:#f9f7e1;border:1px solid #000;border-radius:4px;box-shadow:1px 5px 5px -1px #000}
  h2{font-size:14px;margin:26px 0 10px}
  .big .card{width:96px;height:96px}
  .big img{width:96px;height:96px;border-radius:8px}
</style></head>
<body>
  <h1>奶蛙 tile 对照表</h1>
  <p>上：游戏内真实尺寸（40px 卡片，与 xlegex 的 card.vue 一致）　下：放大 96px 看抠底质量</p>
  <h2>游戏内尺寸 40px</h2>
  <div class="grid">${cells}</div>
  <h2>放大 96px</h2>
  <div class="grid big">${cells.replace(/width="40" height="40"/g, 'width="96" height="96"')}</div>
</body></html>`;
fs.writeFileSync(path.join(OUT, 'sheet.html'), sheet, 'utf8');
console.log('对照表 -> ' + path.relative(process.cwd(), path.join(OUT, 'sheet.html')));

await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(200);
process.exit(0);
