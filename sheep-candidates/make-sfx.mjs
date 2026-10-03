/**
 * 抓奶蛙 · 原创音效生成器（纯数学生成，不用任何采样素材）
 *
 * 五种音效，围绕"麻将牌"的木质手感设计：
 *   click   抓牌：极短木质轻响（噪声瞬态 + 几个共振分音）
 *   drop    落牌/消除：牌撞牌的一声"咔"，带一点闷响
 *   win     过关：上行琶音 + 铃音泛音
 *   lose    失败：下行三音 + 低闷音
 *   welcome 开局：三声木质招呼音（马林巴感）
 *
 * 输出 16bit / 32kHz / 单声道 WAV，附带一张波形对照图（SVG），方便肉眼核对包络是否合理。
 *
 * 用法: node make-sfx.mjs [输出目录]
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] || path.join(import.meta.dirname, 'sfx');
const SR = 32000;                 // 采样率：音效够用，体积也小
const TAU = Math.PI * 2;

/* ---------------- 基础工具 ---------------- */

/** 确定性随机（保证每次生成结果一致，便于复现/对比） */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const buf = (sec) => new Float64Array(Math.ceil(sec * SR));

/** 叠加一个带包络的分音（可带起始滑音，模拟敲击的瞬态） */
function partial(out, { freq, gain = 1, start = 0, dur = 0.2, decay = null, glide = 1, type = 'sine' }) {
  const i0 = Math.floor(start * SR);
  const n = Math.floor(Math.min(dur, out.length / SR - start) * SR);
  const d = decay ?? dur / 3.5;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const p = i / n;
    const f = freq * (1 + (glide - 1) * Math.max(0, 1 - t / 0.03));   // 30ms 内从上滑到下
    let s = Math.sin(TAU * f * t);
    if (type === 'tri') s = (2 / Math.PI) * Math.asin(Math.sin(TAU * f * t));
    if (type === 'odd') {                                            // 1/3/5 次谐波，木管感
      s = Math.sin(TAU * f * t) + Math.sin(TAU * f * 3 * t) / 9 + Math.sin(TAU * f * 5 * t) / 25;
    }
    out[i0 + i] += gain * s * Math.exp(-t / d) * (1 - Math.exp(-t / 0.004)) * (1 - p * 0.02);
  }
}

/** 叠加一段低通噪声（模拟"咔"的起振） */
function noise(out, { gain = 0.3, start = 0, dur = 0.01, decay = 0.004, lp = 0.35, seed = 1 }) {
  const rnd = mulberry32(seed);
  const i0 = Math.floor(start * SR);
  const n = Math.floor(dur * SR);
  let last = 0;
  for (let i = 0; i < n && i0 + i < out.length; i++) {
    const t = i / SR;
    const white = rnd() * 2 - 1;
    last += (white - last) * lp;                                     // 一阶低通
    out[i0 + i] += gain * last * Math.exp(-t / decay);
  }
}

/** 归一化 + 首尾淡入淡出，避免爆音 */
function finish(out, { peak = 0.85, fade = 0.003 } = {}) {
  let mx = 0;
  for (let i = 0; i < out.length; i++) mx = Math.max(mx, Math.abs(out[i]));
  const k = mx > 0 ? peak / mx : 1;
  const f = Math.floor(fade * SR);
  for (let i = 0; i < out.length; i++) out[i] *= k;
  for (let i = 0; i < f && i < out.length; i++) {
    const w = i / f;
    out[i] *= w;
    out[out.length - 1 - i] *= w;
  }
  return out;
}

/** 16bit PCM WAV 写入 */
function writeWav(file, data) {
  const n = data.length;
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + n * 2, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);          // PCM
  head.writeUInt16LE(1, 22);          // 单声道
  head.writeUInt32LE(SR, 24);
  head.writeUInt32LE(SR * 2, 28);     // 字节率
  head.writeUInt16LE(2, 32);          // 块对齐
  head.writeUInt16LE(16, 34);         // 位深
  head.write('data', 36);
  head.writeUInt32LE(n * 2, 40);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, data[i]));
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  fs.writeFileSync(file, Buffer.concat([head, pcm]));
}

/* ---------------- 五种音效 ---------------- */

const N = { C4: 261.63, D4: 293.66, E4: 329.63, G4: 392.0, A4: 440.0, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, C6: 1046.5 };

const SFX = {
  /** 抓牌：木质轻响，约 0.10s */
  click() {
    const b = buf(0.10);
    noise(b, { gain: 0.5, dur: 0.012, decay: 0.0035, lp: 0.45, seed: 7 });
    partial(b, { freq: 900, gain: 0.55, dur: 0.085, decay: 0.022, glide: 1.07 });
    partial(b, { freq: 1340, gain: 0.30, dur: 0.06, decay: 0.014, glide: 1.05 });
    partial(b, { freq: 2150, gain: 0.16, dur: 0.04, decay: 0.009 });
    return finish(b, { peak: 0.8 });
  },

  /** 落牌/消除：牌撞牌的一声"咔"，约 0.24s */
  drop() {
    const b = buf(0.24);
    noise(b, { gain: 0.42, dur: 0.018, decay: 0.006, lp: 0.3, seed: 11 });
    partial(b, { freq: 470, gain: 0.7, dur: 0.2, decay: 0.055 });
    partial(b, { freq: 820, gain: 0.42, dur: 0.15, decay: 0.04, glide: 1.04 });
    partial(b, { freq: 1290, gain: 0.24, dur: 0.1, decay: 0.026 });
    partial(b, { freq: 1980, gain: 0.12, dur: 0.07, decay: 0.016 });
    partial(b, { freq: 128, gain: 0.34, dur: 0.18, decay: 0.05 });      // 一点闷响，落牌有分量
    return finish(b, { peak: 0.86 });
  },

  /** 过关：上行琶音 + 铃音泛音，约 1.05s */
  win() {
    const b = buf(1.05);
    const seq = [N.C5, N.E5, N.G5, N.C6];
    seq.forEach((f, i) => {
      const t = i * 0.105;
      partial(b, { freq: f, gain: 0.6, start: t, dur: 0.75, decay: 0.26 });
      partial(b, { freq: f * 2.01, gain: 0.22, start: t, dur: 0.42, decay: 0.1 });
      partial(b, { freq: f * 3.0, gain: 0.1, start: t, dur: 0.26, decay: 0.055 });
    });
    partial(b, { freq: N.C6 * 2, gain: 0.14, start: 0.52, dur: 0.5, decay: 0.16 });   // 收尾的一点亮光
    partial(b, { freq: N.C4, gain: 0.2, start: 0.0, dur: 0.9, decay: 0.4 });          // 底音托住
    return finish(b, { peak: 0.82 });
  },

  /** 失败：下行三音 + 低闷音，约 0.95s */
  lose() {
    const b = buf(0.95);
    const seq = [N.A4, 349.23, N.D4 * 1.5];      // A4 → F4 → D5? 这里用下行：A4、F4、D4
    const down = [N.A4, 349.23, N.D4];
    down.forEach((f, i) => {
      const t = i * 0.19;
      partial(b, { freq: f, gain: 0.62, start: t, dur: 0.5, decay: 0.2, type: 'odd' });
      partial(b, { freq: f * 0.5, gain: 0.18, start: t, dur: 0.55, decay: 0.24 });
    });
    partial(b, { freq: 73.4, gain: 0.3, start: 0.36, dur: 0.5, decay: 0.22 });        // 低闷音
    noise(b, { gain: 0.08, start: 0.36, dur: 0.05, decay: 0.03, lp: 0.15, seed: 23 });
    return finish(b, { peak: 0.8 });
  },

  /** 开局：三声木质招呼音（马林巴感），约 1.2s */
  welcome() {
    const b = buf(1.2);
    const notes = [N.G4, N.C5, N.E5];
    notes.forEach((f, i) => {
      const t = i * 0.16;
      partial(b, { freq: f, gain: 0.6, start: t, dur: 0.7, decay: 0.22 });
      partial(b, { freq: f * 4, gain: 0.13, start: t, dur: 0.18, decay: 0.035 });     // 马林巴的高次分音
    });
    noise(b, { gain: 0.1, dur: 0.05, decay: 0.02, lp: 0.2, seed: 31 });               // 起手一点气息
    partial(b, { freq: N.C4, gain: 0.16, start: 0.32, dur: 0.8, decay: 0.3 });
    return finish(b, { peak: 0.8 });
  },
};

/* ---------------- 生成 + 波形对照图 ---------------- */

fs.mkdirSync(OUT, { recursive: true });
const rows = [];
for (const [name, gen] of Object.entries(SFX)) {
  const data = gen();
  const file = path.join(OUT, name + '.wav');
  writeWav(file, data);
  let peak = 0, sum = 0;
  for (const v of data) { peak = Math.max(peak, Math.abs(v)); sum += v * v; }
  rows.push({ name, data, dur: data.length / SR, peak, rms: Math.sqrt(sum / data.length), bytes: fs.statSync(file).size });
}

const W = 1000, ROW = 110, PAD = 46;
const svg = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${PAD + rows.length * ROW + 20}" viewBox="0 0 ${W} ${PAD + rows.length * ROW + 20}">
<rect width="100%" height="100%" fill="#16232b"/>
<style>text{font:13px system-ui,'Microsoft YaHei',sans-serif;fill:#cfe9f5} .dim{fill:#7fa6b8;font-size:11px}</style>`];
rows.forEach((r, i) => {
  const y0 = PAD + i * ROW;
  const mid = y0 + ROW / 2 - 6;
  const step = Math.max(1, Math.floor(r.data.length / (W - 40)));
  const pts = [];
  for (let x = 0; x < W - 40; x++) {
    let mn = 1, mx = -1;
    for (let k = 0; k < step; k++) {
      const v = r.data[x * step + k] || 0;
      mn = Math.min(mn, v); mx = Math.max(mx, v);
    }
    pts.push(`${20 + x},${(mid - mx * 44).toFixed(1)} ${20 + x},${(mid - mn * 44).toFixed(1)}`);
  }
  svg.push(`<line x1="20" y1="${mid}" x2="${W - 20}" y2="${mid}" stroke="#2b4150"/>`);
  svg.push(`<path d="M ${pts.join(' L ')}" stroke="#67d6a8" stroke-width="1" fill="none"/>`);
  svg.push(`<text x="20" y="${y0 + 20}">${r.name}.wav</text>`);
  svg.push(`<text class="dim" x="140" y="${y0 + 20}">${r.dur.toFixed(2)}s · 峰值 ${r.peak.toFixed(2)} · RMS ${r.rms.toFixed(3)} · ${(r.bytes / 1024).toFixed(1)}KB</text>`);
});
svg.push('</svg>');
fs.writeFileSync(path.join(OUT, 'waveform.svg'), svg.join('\n'), 'utf8');

console.log('输出目录:', path.relative(process.cwd(), OUT));
console.log('文件            时长     峰值   RMS    大小');
for (const r of rows) {
  console.log(`${(r.name + '.wav').padEnd(15)} ${r.dur.toFixed(2)}s  ${r.peak.toFixed(2)}  ${r.rms.toFixed(3)}  ${(r.bytes / 1024).toFixed(1)}KB`);
}
console.log('波形对照图: ' + path.join(path.relative(process.cwd(), OUT), 'waveform.svg'));
console.log('合计 ' + (rows.reduce((n, r) => n + r.bytes, 0) / 1024).toFixed(1) + ' KB');
