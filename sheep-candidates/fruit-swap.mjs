/**
 * 用 src/better 的图标替换游戏 tile（v2 流程，专门针对"已经抠好底"的素材）
 *
 * 与上一版的区别：**不做洪泛抠底**（上一批是照片，才需要抠；这批自带透明通道，
 * 抠底只会带来白边和破洞），改为：
 *   1. 浏览器 canvas 解码（png/webp 都能读）
 *   2. 计算 alpha 包围盒 → 裁掉四周空白（保证每张牌视觉体积一致，40px 下才好认）
 *   3. **分级降采样**（512 → 256 → 128 → 112）：一次性缩到 1/4 会丢细节、发灰
 *   4. 输出 120x120 透明 PNG + 麻将卡片样式的对照表
 *
 * 用法: node fruit-swap.mjs [cdpPort] [baseUrl]
 */
import fs from 'node:fs';
import path from 'node:path';

const CDP_PORT = Number(process.argv[2] || 9222);
const BASE = process.argv[3] || 'http://127.0.0.1:8123';
const SRC_DIR = '/src/better';
const OUT = path.join(import.meta.dirname, 'fruit-tiles');
const FILES = [
  // 已按需求去掉 02-cherry（与 01 太像）和 11-watermelon（半透明发光体，辨识度低）
  // 剩下的 9 张会依次输出成 1.png ~ 9.png，正好对应游戏里的图案编号 1~9
  '01-grape.png', '03-orange.png', '04-lemon.png', '05-kiwi.png', '06-tomato.png',
  '07-peach.png', '08-pineapple.png', '09-coconut.png', '10-halfmelon.png',
];

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
      ws.addEventListener('error', () => rej(new Error('WS 连接失败')), { once: true });
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

const raw = await page.evaluate(`(${async function (files, dir) {
  const SIZE = 120;        // 输出画布
  const FILL = 112;        // 主体最长边占比（留 4px 呼吸位）
  const out = {}, stats = {};

  /** 分级降采样：每次最多缩一半，避免一次性大比例缩小发灰发糊 */
  function stepDown(src, dstW, dstH) {
    let cur = src;
    let w = src.width, h = src.height;
    while (w > dstW * 2 && h > dstH * 2) {
      const nw = Math.max(dstW, Math.round(w / 2));
      const nh = Math.max(dstH, Math.round(h / 2));
      const c = document.createElement('canvas');
      c.width = nw; c.height = nh;
      const cx = c.getContext('2d');
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(cur, 0, 0, w, h, 0, 0, nw, nh);
      cur = c; w = nw; h = nh;
    }
    const done = document.createElement('canvas');
    done.width = dstW; done.height = dstH;
    const dx = done.getContext('2d');
    dx.imageSmoothingEnabled = true;
    dx.imageSmoothingQuality = 'high';
    dx.drawImage(cur, 0, 0, w, h, 0, 0, dstW, dstH);
    return done;
  }

  /** 从底边洪泛清除"落地阴影"。
   *  采样数据：阴影是【完全不透明】的灰褐 rgba(138,131,112,255)、饱和度 0.19~0.23、max(RGB)≈138；
   *  而角色底部是饱和 0.63~0.75 的深棕、偏白的主体 max(RGB)>210 —— 都能被规则挡住。
   *  安全阀：单次清理若删掉超过 25% 的实体像素，判定误伤，整体回滚。 */
  function clearCastShadow(ctx, w, h) {
    const before = ctx.getImageData(0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    let opaqueBefore = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) opaqueBefore++;

    const satOf = (i) => {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      return mx === 0 ? 0 : (mx - mn) / mx;
    };
    const shadowLike = (i) => {
      if (d[i + 3] <= 8) return false;
      const mx = Math.max(d[i], d[i + 1], d[i + 2]);
      return satOf(i) < 0.30 && mx < 210;      // 灰褐 + 不亮 → 只可能是投影
    };
    const visited = new Uint8Array(w * h);
    const stack = [];
    for (let y = Math.floor(h * 0.92); y < h; y++) {           // 只从最底 8% 起步
      for (let x = 0; x < w; x++) if (shadowLike((y * w + x) * 4)) stack.push(y * w + x);
    }
    let removed = 0;
    while (stack.length) {
      const p = stack.pop();
      if (visited[p]) continue;
      visited[p] = 1;
      const i = p * 4;
      if (!shadowLike(i)) continue;
      d[i + 3] = 0;
      removed++;
      const x = p % w, y = (p - x) / w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q < 0 || visited[q]) continue;
        const qi = q * 4;
        if (!shadowLike(qi)) continue;
        const step = Math.abs(d[qi] - d[i]) + Math.abs(d[qi + 1] - d[i + 1]) + Math.abs(d[qi + 2] - d[i + 2]);
        if (step > 90) continue;
        stack.push(q);
      }
    }
    if (opaqueBefore && removed / opaqueBefore > 0.25) {        // 误伤保护
      ctx.putImageData(before, 0, 0);
      return -1;
    }
    ctx.putImageData(img, 0, 0);
    return removed;
  }

  for (const name of files) {
    const res = await fetch(dir + '/' + name);
    if (!res.ok) { stats[name] = 'fetch ' + res.status; continue; }
    const bmp = await createImageBitmap(await res.blob());

    // 原图完整画布，用于取 alpha 包围盒
    const full = document.createElement('canvas');
    full.width = bmp.width; full.height = bmp.height;
    const fx = full.getContext('2d', { willReadFrequently: true });
    fx.drawImage(bmp, 0, 0);
    const imgData = fx.getImageData(0, 0, bmp.width, bmp.height);
    const data = imgData.data;

    /* 不做"去光晕"那一步：上一版用 sat<0.16 置透明，会把白色/浅色主体（白翅膀、浅毛兔子）
       一起啃掉，实测 #9/#11 直接变成鬼影。素材自带的那点边缘光晕在奶白牌面上几乎看不见。 */

    /* 只从底边洪泛清掉"完全不透明"的落地阴影（带误伤回滚） */
    const castCleared = clearCastShadow(fx, bmp.width, bmp.height);

    /* alpha 包围盒 —— 必须重新取像素 */
    const clean = fx.getImageData(0, 0, bmp.width, bmp.height).data;
    let minX = bmp.width, minY = bmp.height, maxX = -1, maxY = -1, opaque = 0;
    for (let y = 0; y < bmp.height; y++) {
      for (let x = 0; x < bmp.width; x++) {
        if (clean[(y * bmp.width + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          opaque++;
        }
      }
    }
    if (maxX < 0) { stats[name] = '整张全透明'; continue; }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;

    // 裁到包围盒 → 等比缩到 FILL → 居中放进 120x120
    const scale = FILL / Math.max(bw, bh);
    const tw = Math.max(1, Math.round(bw * scale));
    const th = Math.max(1, Math.round(bh * scale));
    const cropped = stepDown(full, Math.max(1, Math.round(bw * scale)), Math.max(1, Math.round(bh * scale)));
    const canvas = document.createElement('canvas');
    canvas.width = SIZE; canvas.height = SIZE;
    const cx2 = canvas.getContext('2d');
    cx2.imageSmoothingEnabled = true;
    cx2.imageSmoothingQuality = 'high';
    cx2.drawImage(cropped, Math.round((SIZE - tw) / 2), Math.round((SIZE - th) / 2));

    out[name.replace(/\.(png|webp)$/i, '')] = canvas.toDataURL('image/png');
    stats[name] = {
      src: bmp.width + 'x' + bmp.height,
      alphaBox: bw + 'x' + bh,
      castCleared: castCleared,
      fillRatio: Math.round((opaque / (bw * bh)) * 100),
      drawn: tw + 'x' + th,
    };
  }
  return { out, stats };
}.toString()})(${JSON.stringify(FILES)}, ${JSON.stringify(SRC_DIR)})`);

fs.mkdirSync(OUT, { recursive: true });
const keys = Object.keys(raw.out).sort();
keys.forEach((k, i) => {
  fs.writeFileSync(path.join(OUT, (i + 1) + '.png'), Buffer.from(raw.out[k].split(',')[1], 'base64'));
});
console.log('素材 -> 输出（序号 = 游戏里的图案编号）');
keys.forEach((k, i) => {
  const s = raw.stats[k + '.png'] || raw.stats[k + '.webp'] || {};
  const cast = s.castCleared === -1 ? '跳过(误伤回滚)' : s.castCleared + 'px';
  console.log(`  ${String(i + 1).padStart(2)}  ${k.padEnd(14)} 去落地影 ${String(cast).padStart(14)}  纯轮廓 ${String(s.alphaBox).padEnd(9)} 实体占比 ${s.fillRatio}%  画布内 ${s.drawn}`);
});
console.log('\n已输出 ' + keys.length + ' 张 tile -> ' + path.relative(process.cwd(), OUT));

/* 对照表：40px（游戏内真实尺寸）+ 96px（看边缘质量） */
const cells = keys.map((k, i) => `<div class="wrap"><div class="card"><img src="${raw.out[k]}" width="40" height="40" alt="${i + 1}"></div><span>${i + 1} ${k.replace(/^\d+-/, '')}</span></div>`).join('\n');
const sheet = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>水果 tile 对照表</title>
<style>
  body{margin:0;padding:24px;background:#4f9f46;font-family:system-ui,"Microsoft YaHei",sans-serif}
  h1{font-size:20px;margin:0 0 4px;color:#fff}
  p{font-size:12px;color:rgba(255,255,255,.8);margin:0 0 18px}
  .grid{display:flex;flex-wrap:wrap;gap:20px}
  .wrap{display:flex;flex-direction:column;align-items:center;gap:6px}
  .wrap span{font-size:11px;color:rgba(255,255,255,.85)}
  .card{width:40px;height:40px;display:flex;align-items:center;justify-content:center;box-sizing:border-box;border:2px solid #3a2914;border-radius:7px;background:linear-gradient(180deg,#fffdf6,#f7eed6 58%,#e8dab6);box-shadow:0 3px 0 #c69a5c,0 5px 0 #3a2914,0 7px 9px rgba(14,34,10,.45),inset 0 2px 0 rgba(255,255,255,.95)}
  .card img{width:30px;height:30px}
  h2{font-size:14px;margin:26px 0 10px;color:#fff}
  .big .card{width:96px;height:96px;border-radius:12px}
  .big .card img{width:76px;height:76px}
  .xl .card{width:160px;height:160px;border-radius:18px;border-width:3px}
  .xl .card img{width:126px;height:126px}
  .xl .wrap span{font-size:13px}
</style></head>
<body>
  <h1>水果 tile 对照表</h1>
  <p>上：游戏内真实尺寸（40px 麻将牌面）　下：放大看边缘与降采样质量</p>
  <h2>游戏内 40px</h2><div class="grid">${cells}</div>
  <h2>放大 96px</h2><div class="grid big">${cells}</div>
  <h2>放大 160px（看边缘残留）</h2><div class="grid xl">${cells}</div>
</body></html>`;
fs.writeFileSync(path.join(OUT, 'sheet.html'), sheet, 'utf8');
console.log('对照表 -> ' + path.relative(process.cwd(), path.join(OUT, 'sheet.html')));

await browser.send('Target.closeTarget', { targetId });
browser.ws.close(); page.ws.close();
await sleep(200);
process.exit(0);
