/**
 * 抓奶蛙 · 背景音乐生成器（纯数学生成，无任何采样素材）
 *
 * 设计目标：**能长时间循环不烦**的休闲解谜 BGM
 *   · A 小调五声音阶（A C D E G）——东方、干净、不会有大跳带来的紧张感
 *   · 104 BPM，4/4，8 小节循环（约 18.5 秒），和弦走向 Am - F - C - G
 *   · 音色全部自己算：古筝/木琴感的拨弦、暖垫、轻拨低音、沙锤、高音铃
 *   · 织体留白：主旋律只占一半拍位，其余交给垫音与拨弦点缀 → 不抢戏、不疲劳
 *   · 循环点：所有音符在结尾自然衰减到接近 0，首尾各做极短淡入淡出，接缝无爆音
 *   · 音量刻意做得比音效小（游戏里 BGM 音量 0.34，音效是 1.0）
 *
 * 输出：bgm.wav（16bit / 22.05kHz / 单声道）+ 一张整段波形图便于核对结构
 *      默认写到构建源目录 sheep-candidates/xlegex-patched/audio/（和 5 个音效放在一起），
 *      build-portable.mjs 会把它一起拷到游戏根目录的 audio/ 里。
 *      ⚠ 别直接写到游戏根目录：打包脚本会先清空 audio/ 再重新拷贝，写在那儿会被删掉。
 *
 * 用法: node make-bgm.mjs [输出目录]
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] || path.join(import.meta.dirname, 'xlegex-patched', 'audio');
const SR = 22050;                       // 音乐用 22.05kHz：铃音最高 ~2.6kHz，余量够，体积减半
const BPM = 104;
const BEAT = 60 / BPM;                  // 一拍 0.5769s
const BAR = BEAT * 4;
const BARS = 8;
const LOOP_SEC = BAR * BARS;            // ≈ 18.46s
const TAU = Math.PI * 2;

/* ---------------- 基础合成工具（与 make-sfx.mjs 同一套做法） ---------------- */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const total = Math.round(LOOP_SEC * SR);
const out = new Float64Array(total);
const wrap = (i) => ((i % total) + total) % total;      // 环绕写入：越界的尾音自动绕到开头
let wrapped = 0;                                        // 统计有多少采样绕回了开头（用于说明循环点）

/** 把一段采样叠加进主缓冲；超出末尾的部分环绕到开头，保证循环无缝 */
function addAt(startSample, len, gen) {
  for (let i = 0; i < len; i++) {
    const idx = wrap(startSample + i);
    if (startSample + i >= total) wrapped++;
    out[idx] += gen(i / SR, i);
  }
}

/** 拨弦（古筝/木琴感）：快速起振 + 指数衰减 + 轻微滑音，带 2/3 次分音 */
function pluck(t0, freq, { gain = 0.5, dur = 1.2, decay = 0.34, glide = 1.03, odd = 0.22 } = {}) {
  const start = Math.round(t0 * SR);
  const len = Math.round(dur * SR);
  const rnd = mulberry32(Math.round(freq * 1000) % 99991);
  addAt(start, len, (t) => {
    const f = freq * (1 + (glide - 1) * Math.max(0, 1 - t / 0.025));
    const env = (1 - Math.exp(-t / 0.0035)) * Math.exp(-t / decay);
    let s = Math.sin(TAU * f * t) + 0.34 * Math.sin(TAU * f * 2 * t) + odd * Math.sin(TAU * f * 3 * t);
    s += (rnd() * 2 - 1) * 0.06 * Math.exp(-t / 0.006);            // 一点拨弦噪声
    return gain * s * env;
  });
}

/** 暖垫：慢起慢落的正弦叠置，音量很低，只做底色 */
function pad(t0, freqs, { gain = 0.06, dur = BAR * 2 - 0.25, atk = 0.5, rel = 0.7 } = {}) {
  const start = Math.round(t0 * SR);
  const len = Math.round(dur * SR);
  addAt(start, len, (t) => {
    let env = Math.min(1, t / atk) * Math.min(1, Math.max(0, (dur - t) / rel));
    env = env * env * (3 - 2 * env);
    let s = 0;
    freqs.forEach((f, i) => {
      s += Math.sin(TAU * f * t + i * 0.7) + 0.18 * Math.sin(TAU * f * 2 * t + i);
    });
    return gain * s * env / freqs.length;
  });
}

/** 低音：圆润的三角波短音 */
function bass(t0, freq, { gain = 0.3, dur = BEAT * 1.6, decay = 0.5 } = {}) {
  const start = Math.round(t0 * SR);
  const len = Math.round(dur * SR);
  addAt(start, len, (t) => {
    const tri = (2 / Math.PI) * Math.asin(Math.sin(TAU * freq * t));
    return gain * tri * (1 - Math.exp(-t / 0.01)) * Math.exp(-t / decay);
  });
}

/** 沙锤：高通噪声极短一击 */
function shaker(t0, gain = 0.05) {
  const start = Math.round(t0 * SR);
  const len = Math.round(0.05 * SR);
  const rnd = mulberry32(Math.round(t0 * 100000) % 99991);
  let last = 0;
  addAt(start, len, (t) => {
    const w = rnd() * 2 - 1;
    last += (w - last) * 0.6;
    const hp = w - last * 0.92;
    return gain * hp * Math.exp(-t / 0.012);
  });
}

/** 铃：高频正弦，尾巴长，用来点缀 */
function bell(t0, freq, gain = 0.12) {
  const start = Math.round(t0 * SR);
  const len = Math.round(1.6 * SR);
  addAt(start, len, (t) => {
    return gain * (Math.sin(TAU * freq * t) + 0.3 * Math.sin(TAU * freq * 2.76 * t)) * Math.exp(-t / 0.55) * (1 - Math.exp(-t / 0.004));
  });
}

/* ---------------- 乐谱 ---------------- */
const F = {
  A2: 110.00, F2: 87.31, C3: 130.81, G2: 98.00,
  A3: 220.00, C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.00, B4: 493.88,
  A4: 440.00, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99,
  F3: 174.61, G3: 196.00,
};
const A3 = 220, C4 = 261.63, D4 = 293.66, E4 = 329.63, G4 = 392, A4 = 440, C5 = 523.25, D5 = 587.33, E5 = 659.25, G5 = 783.99, B4 = 493.88, F4 = 349.23;

/** 每 2 小节一个和弦：Am F C G */
const CHORDS = [
  { pad: [F.A3, F.C4, F.E4], bass: F.A2 },
  { pad: [F.F3, F.A3, F.C4], bass: F.F2 },
  { pad: [F.C4, F.E4, F.G4], bass: F.C3 },
  { pad: [F.G3, F.B4 / 2, F.D4], bass: F.G2 },
];

/** 主旋律：[小节, 拍, 音高, 时值(拍)]，留白很多，不抢戏 */
const MELODY = [
  [0, 0, A4, 1.5], [0, 2, C5, 1], [0, 3, D5, 0.5],
  [1, 0, E5, 1], [1, 1.5, D5, 0.5], [1, 2, C5, 1.5], [1, 3.5, A4, 0.5],
  [2, 0, C5, 1.5], [2, 2, A4, 1], [2, 3, G4, 0.5],
  [3, 0, F4, 1], [3, 1, G4, 0.5], [3, 1.5, A4, 1], [3, 3, C5, 1],
  [4, 0, G4, 1.5], [4, 2, E5, 1], [4, 3, D5, 0.5],
  [5, 0, C5, 1], [5, 1, D5, 0.5], [5, 1.5, E5, 1.5], [5, 3.5, G5, 0.5],
  [6, 0, D5, 1.5], [6, 2, B4, 1], [6, 3, A4, 0.5],
  [7, 0, G4, 1], [7, 1, A4, 0.5], [7, 1.5, C5, 1], [7, 3, D5, 0.75],
];

/** 装饰音（古筝的"抹"）：主音前 70ms 加一个下方邻音 */
const GRACE = [1, 5, 11, 19, 24, 27];

/** 和声骨架 + 织体：ENERGY 控制每小节的"密度"，做出 4+4 的呼吸感
    （前 2 小节只留垫音和轻沙锤当引子，中段进旋律与低音，末小节收干净再回到引子） */
const ENERGY = [0.5, 0.62, 0.85, 0.92, 1.0, 1.0, 0.95, 0.74];
for (let bar = 0; bar < BARS; bar++) {
  const ch = CHORDS[Math.floor(bar / 2) % 4];
  const t0 = bar * BAR;
  const e = ENERGY[bar];
  pad(t0, ch.pad, { gain: 0.05 * (0.75 + 0.25 * e), dur: BAR * 2 - 0.2 });
  if (e >= 0.6) bass(t0, ch.bass, { gain: 0.3 * e });
  if (e >= 0.6) bass(t0 + BEAT * 2.5, ch.bass * 2, { gain: 0.16 * e, dur: BEAT * 0.8, decay: 0.3 });
  // 拨弦点缀（营造流动感，音量很低）
  pluck(t0 + BEAT * 1.5, ch.pad[1] * 2, { gain: 0.1 * e, decay: 0.22 });
  if (e >= 0.7) pluck(t0 + BEAT * 3.5, ch.pad[2] * 2, { gain: 0.075 * e, decay: 0.18, glide: 1.0 });
  // 沙锤：反拍轻点，1、3 拍稍重；引子只有一半密度
  const steps = e < 0.6 ? [0, 2] : [0, 0.5, 1, 1.5, 2, 2.5, 3];
  steps.forEach((b) => shaker(t0 + BEAT * b, (b % 1 === 0 ? 0.042 : 0.024) * Math.max(0.6, e)));
  // 高音铃：只在后半段点缀三处
  if (bar === 4 || bar === 6) bell(t0 + BEAT * 2, C5 * 2, 0.05);
  if (bar === 7) bell(t0 + BEAT * 3, A4 * 2, 0.055);
}

/** 主旋律（拨弦音色）：整体后移 1 小节，让第 1 小节空出来当引子；最后 1 小节只留尾音 */
MELODY.forEach(([bar, beat, freq, durBeats], i) => {
  const at = bar + 1;
  if (at >= BARS) return;
  const t = at * BAR + beat * BEAT;
  const e = ENERGY[at];
  pluck(t, freq, { gain: 0.38 * e, dur: Math.min(1.5, durBeats * BEAT + 0.5), decay: 0.3 - (durBeats < 0.6 ? 0.1 : 0) });
  if (GRACE.indexOf(i) >= 0) pluck(Math.max(0, t - 0.07), freq * 0.891, { gain: 0.14 * e, dur: 0.25, decay: 0.09 });
});

/* ---------------- 收尾：限幅 + 归一化 + 首尾微淡 ---------------- */
let peak = 0, sum = 0;
for (let i = 0; i < total; i++) {
  out[i] = Math.tanh(out[i] * 0.9);                 // 软限幅，避免叠音处爆掉
  peak = Math.max(peak, Math.abs(out[i]));
  sum += out[i] * out[i];
}
const k = peak > 0 ? 0.72 / peak : 1;               // 留足余量，游戏里还要混音效
for (let i = 0; i < total; i++) out[i] *= k;

const fadeIn = Math.round(0.006 * SR), fadeOut = Math.round(0.02 * SR);
for (let i = 0; i < fadeIn; i++) out[i] *= i / fadeIn;
for (let i = 0; i < fadeOut; i++) out[total - 1 - i] *= i / fadeOut;

/* ---------------- 写文件 ---------------- */
fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, 'bgm.wav');
const head = Buffer.alloc(44);
head.write('RIFF', 0); head.writeUInt32LE(36 + total * 2, 4); head.write('WAVE', 8);
head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
head.writeUInt32LE(SR, 24); head.writeUInt32LE(SR * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
head.write('data', 36); head.writeUInt32LE(total * 2, 40);
const pcm = Buffer.alloc(total * 2);
for (let i = 0; i < total; i++) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, out[i])) * 32767), i * 2);
fs.writeFileSync(file, Buffer.concat([head, pcm]));

/* ---------------- 统计（波形图与自检都要用） ---------------- */
const rms = Math.sqrt(out.reduce((a, v) => a + v * v, 0) / total);
let peakAfter = 0;
for (let i = 0; i < total; i++) peakAfter = Math.max(peakAfter, Math.abs(out[i]));
const head8 = Math.max(...Array.from(out.slice(0, 8)).map(Math.abs));
const tail8 = Math.max(...Array.from(out.slice(-8)).map(Math.abs));
let clicks = 0;                                  // 相邻采样最大跳变：判断有没有硬接缝/爆音
for (let i = 1; i < total; i++) clicks = Math.max(clicks, Math.abs(out[i] - out[i - 1]));

/* 结构波形图：每小节一条竖线，方便肉眼核对哪几小节有旋律 */
const W = 1400, H = 220;
const step = Math.max(1, Math.floor(total / (W - 40)));
const pts = [];
for (let x = 0; x < W - 40; x++) {
  let mn = 1, mx = -1;
  for (let j = 0; j < step; j++) {
    const v = out[x * step + j] || 0;
    mn = Math.min(mn, v); mx = Math.max(mx, v);
  }
  pts.push(`${20 + x},${(H / 2 - mx * 85).toFixed(1)} ${20 + x},${(H / 2 - mn * 85).toFixed(1)}`);
}
const svg = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + 40}" viewBox="0 0 ${W} ${H + 40}">
<rect width="100%" height="100%" fill="#16232b"/>
<style>text{font:12px system-ui,'Microsoft YaHei',sans-serif;fill:#cfe9f5} .g{stroke:#2b4150} .b{stroke:#3f6b7d;stroke-dasharray:3 3}</style>`,
  `<line class="g" x1="20" y1="${H / 2}" x2="${W - 20}" y2="${H / 2}"/>`];
for (let bar = 1; bar < BARS; bar++) {
  const x = 20 + Math.round((bar * BAR / LOOP_SEC) * (W - 40));
  svg.push(`<line class="b" x1="${x}" y1="16" x2="${x}" y2="${H - 6}"/>`);
  svg.push(`<text x="${x + 4}" y="14">${bar + 1}</text>`);
}
svg.push(`<path d="M ${pts.join(' L ')}" stroke="#67d6a8" stroke-width="1" fill="none"/>`);
svg.push(`<text x="20" y="${H + 26}">bgm.wav · ${LOOP_SEC.toFixed(2)}s 循环（8 小节 / ${BPM}BPM / Am-F-C-G 五声音阶） · 峰值 ${peakAfter.toFixed(2)} · RMS ${rms.toFixed(3)} · ${(fs.statSync(file).size / 1024).toFixed(0)}KB</text>`);
svg.push('</svg>');
fs.writeFileSync(path.join(OUT, 'bgm-waveform.svg'), svg.join('\n'), 'utf8');

/* ---------------- 自检输出 ---------------- */
console.log('输出:', path.relative(process.cwd(), file));
console.log(`  时长 ${LOOP_SEC.toFixed(3)}s（${BARS} 小节 × ${BAR.toFixed(3)}s，${BPM}BPM）| ${(fs.statSync(file).size / 1024).toFixed(0)}KB | ${SR}Hz 单声道 16bit`);
console.log(`  峰值 ${peakAfter.toFixed(3)}（留了余量给音效）| RMS ${rms.toFixed(3)}`);
console.log(`  循环点：开头 8 采样振幅 ${head8.toFixed(4)}，结尾 8 采样振幅 ${tail8.toFixed(4)}（越接近 0 越不会"咔"）`);
console.log(`  最大相邻跳变 ${clicks.toFixed(4)}（< 0.5 基本不会有爆音）| 环绕写入的采样数 ${wrapped}`);
console.log('  波形图:', path.relative(process.cwd(), path.join(OUT, 'bgm-waveform.svg')));

/* 编曲结构自检：逐小节算 RMS 与"起音次数"（用 5ms 包络的突增来数音符，而不是数采样过零） */
const barSamples = Math.round(BAR * SR);
const BLK = Math.round(0.005 * SR);
const envOf = (from, to) => {
  const env = [];
  for (let i = from; i < to; i += BLK) {
    let s = 0, n = 0;
    for (let j = i; j < Math.min(to, i + BLK); j++) { s += out[j] * out[j]; n++; }
    env.push(Math.sqrt(s / Math.max(1, n)));
  }
  return env;
};
const bars = [];
for (let b = 0; b < BARS; b++) {
  const from = b * barSamples, to = Math.min(total, from + barSamples);
  let sum2 = 0, pk = 0;
  for (let i = from; i < to; i++) { sum2 += out[i] * out[i]; pk = Math.max(pk, Math.abs(out[i])); }
  const env = envOf(from, to);
  let onsets = 0;
  for (let i = 1; i < env.length; i++) {
    if (env[i] > 0.02 && env[i] > env[i - 1] * 2.1) { onsets++; i += 6; }   // 起音后 30ms 内不再计
  }
  bars.push({ b: b + 1, rms: Math.sqrt(sum2 / (to - from)), peak: pk, onsets });
}
console.log('  逐小节：' + bars.map((r) => `#${r.b} RMS${r.rms.toFixed(2)}/${String(r.onsets).padStart(2)}起音`).join('  '));
const loudest = Math.max(...bars.map((r) => r.rms));
const quietest = Math.min(...bars.map((r) => r.rms));
console.log(`  动态范围：最响 ${loudest.toFixed(2)} / 最轻 ${quietest.toFixed(2)}（比值 ${(loudest / quietest).toFixed(2)}×，>1.3 说明有呼吸感）`);
console.log(`  结尾小节比最满的小节安静：${bars[BARS - 1].rms < loudest ? '是 ✓（循环点不会突然截断）' : '否（可能显得被切断）'}`);
