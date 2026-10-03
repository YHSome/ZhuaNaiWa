/**
 * 把构建产物打包成「双击 index.html 即玩」的离线版本
 *
 * 为什么不能直接双击原 dist/index.html：
 *   它用 <script type="module" src="./assets/xxx.js">，file:// 下浏览器会以 CORS 为由拒绝加载模块文件。
 *   实测确认：内联的 <script type="module"> 在 file:// 下可以正常执行（不需要 fetch），
 *   因此这里把 JS/CSS 全部内联进 HTML，图片/音频仍按相对路径同目录引用（file:// 下可用）。
 *
 * 内联顺序（很重要）：
 *   1. 游戏构建产物 CSS
 *   2. 主题 CSS（theme-cute.css，麻将牌面/牌桌/托盘）
 *   3. UI CSS（ui-cute.css，选关界面/HUD/结算面板）
 *   4. 游戏构建产物 JS（module，先跑起来）
 *   5. 动效 JS（theme-cute.js，观察 DOM 加动画）
 *   6. UI JS（ui-cute.js，选关与结算；依赖游戏暴露的 window.__NAIWA__）
 *
 * 用法: node build-portable.mjs [源目录] [输出目录]
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2] || path.join(import.meta.dirname, 'xlegex-patched');
const OUT = process.argv[3] || path.join(import.meta.dirname, 'naiwa-portable');

const read = (p) => fs.readFileSync(p, 'utf8');
const JS_BUNDLE = fs.readdirSync(path.join(SRC, 'assets')).find((f) => /^index\..*\.js$/.test(f));
const CSS_BUNDLE = fs.readdirSync(path.join(SRC, 'assets')).find((f) => /^index\..*\.css$/.test(f));

const styles = [
  ['游戏样式（构建产物）', read(path.join(SRC, 'assets', CSS_BUNDLE))],
  ['奶蛙麻将风主题', read(path.join(SRC, 'theme-cute.css'))],
  ['选关与结算界面', read(path.join(SRC, 'ui-cute.css'))],
];
const scripts = [
  ['游戏逻辑（原本是外链 module，这里内联：file:// 下外链模块会被 CORS 拦掉）', read(path.join(SRC, 'assets', JS_BUNDLE))],
  ['动效层', read(path.join(SRC, 'theme-cute.js'))],
  ['UI 层（选关 / 结算 / 进度）', read(path.join(SRC, 'ui-cute.js'))],
];

/* 内联安全性：HTML 解析器遇到 </script 或 </style 会提前结束 */
const bad = [];
for (const [name, code] of scripts) if (/<\/script/i.test(code)) bad.push(name + ' 含 </script');
for (const [name, css] of styles) if (/<\/style/i.test(css)) bad.push(name + ' 含 </style');
if (bad.length) { console.error('❌ 不能直接内联：' + bad.join('；')); process.exit(1); }

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
<title>抓奶蛙</title>
<link rel="icon" type="image/svg+xml" href="./vite.svg" />
${styles.map(([name, css]) => `<!-- ${name} -->\n<style>\n${css}\n</style>`).join('\n')}
</head>
<body>
<div id="app"></div>

${scripts.map(([name, code], i) => `<!-- ${name} -->\n<script type="module">\n${code}\n</script>`).join('\n')}
</body>
</html>
`;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), html, 'utf8');

// 资源：图片与音频按相对路径同目录引用
// 牌面图只拷"运行时真的会请求到"的那些：asset-scan.mjs 跑一遍完整流程，用 CDP 的 Network
// 事件记录真实请求，结果落在 asset-usage.json。源 assets/ 里还留着原版游戏没用上的 6 张素材
// （10~15.png，约 70 KB），照着"代码里出现过"拷会一并带上。
const usageFile = path.join(import.meta.dirname, 'asset-usage.json');
const usage = fs.existsSync(usageFile) ? JSON.parse(fs.readFileSync(usageFile, 'utf8')) : null;
const keepImage = usage && Array.isArray(usage.used) ? new Set(usage.used) : null;

let skipped = [];
for (const dir of ['assets', 'audio']) {
  const from = path.join(SRC, dir);
  if (!fs.existsSync(from)) continue;
  const to = path.join(OUT, dir);
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from)) {
    if (dir === 'assets' && !/\.png$/i.test(f)) continue;      // 只要牌面图，不再需要打包后的 js/css
    if (dir === 'audio' && !/\.(wav|mp3|ogg|m4a)$/i.test(f)) continue;   // 只拷音频，波形图之类的调试产物不进游戏
    if (dir === 'assets' && keepImage && !keepImage.has(f)) { skipped.push(f); continue; }
    fs.copyFileSync(path.join(from, f), path.join(to, f));
  }
}
if (fs.existsSync(path.join(SRC, 'vite.svg'))) fs.copyFileSync(path.join(SRC, 'vite.svg'), path.join(OUT, 'vite.svg'));

const size = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0);
const walk = (d) => fs.readdirSync(d).reduce((n, f) => { const p = path.join(d, f); return n + (fs.statSync(p).isDirectory() ? walk(p) : fs.statSync(p).size); }, 0);
const deliverable = size(path.join(OUT, 'index.html')) + size(path.join(OUT, 'vite.svg'))
  + (fs.existsSync(path.join(OUT, 'assets')) ? walk(path.join(OUT, 'assets')) : 0)
  + (fs.existsSync(path.join(OUT, 'audio')) ? walk(path.join(OUT, 'audio')) : 0);

console.log('输出目录: ' + path.relative(process.cwd(), OUT));
console.log('  index.html  ' + (size(path.join(OUT, 'index.html')) / 1024).toFixed(1) + ' KB');
for (const [name, code] of styles) console.log('    内联 CSS · ' + name.padEnd(18) + (code.length / 1024).toFixed(1) + ' KB');
for (const [name, code] of scripts) console.log('    内联 JS  · ' + name.split('（')[0].padEnd(18) + (code.length / 1024).toFixed(1) + ' KB');
console.log('  assets/     ' + fs.readdirSync(path.join(OUT, 'assets')).length + ' 张牌面图'
  + (skipped.length ? '（按运行时用量跳过 ' + skipped.length + ' 张：' + skipped.join(', ') + '）' : '（源目录已无冗余图）'));
const audioFiles = fs.readdirSync(path.join(OUT, 'audio'));
const bgmSize = audioFiles.filter((f) => f === 'bgm.wav').map((f) => fs.statSync(path.join(OUT, 'audio', f)).size)[0] || 0;
console.log('  audio/      ' + audioFiles.length + ' 个音频（' + audioFiles.filter((f) => f !== 'bgm.wav').length
  + ' 个音效 + 1 首循环 BGM ' + (bgmSize / 1024).toFixed(0) + 'KB）');
console.log('离线包体积: ' + (deliverable / 1024).toFixed(0) + ' KB（index.html + assets + audio + favicon）');
