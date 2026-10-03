/**
 * 构建产物补丁（幂等，可反复跑）
 *
 * 为什么要打补丁：游戏源码编译后的 dist 里有些东西只能改字符串——
 *   1. 大标题还叫「蛙了个蛙」→ 统一成「抓奶蛙」
 *   2. 托盘容量硬编码 9（`length===9` 两处：抓牌闸门 + 判负）
 *   3. 只认识 4 个关卡的配置数组 → 需要多一个"自定义牌局"入口给无尽模式用
 *      （无尽模式的塔越爬越大，配置要运行时算，不能再写死在那张表里）
 *
 * 每一项都会打印"改了几处"，跑第二遍应该是 0 处（已应用）。
 *
 * 用法: node patch-dist.mjs [dist目录]
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2] || path.join(import.meta.dirname, 'xlegex-patched');
const JS = path.join(SRC, 'assets', fs.readdirSync(path.join(SRC, 'assets')).find((f) => /^index\..*\.js$/.test(f)));
let code = fs.readFileSync(JS, 'utf8');
const log = [];

function swap(label, from, to, expect) {
  const n = code.split(from).length - 1;
  if (n) code = code.split(from).join(to);
  log.push(`${label}: 改 ${n} 处${expect !== undefined && n && n !== expect ? '（⚠ 期望 ' + expect + ' 处）' : ''}`);
  return n;
}

/* 1. 大标题（打包后是 \uXXXX 转义） */
swap('大标题 蛙了个蛙 → 抓奶蛙', '\\u86D9\\u4E86\\u4E2A\\u86D9', '\\u6293\\u5976\\u86D9', 1);

/* 2. 托盘容量：从写死的 9 改成可运行时配置（无尽模式靠"槽位变少"真正拉高难度）
      注入的是 (length>=(window.__NAIWA_CAP__||9))，括号必须包住 || ，
      否则 a.length>=cap||9 会被解析成 (a.length>=cap)||9 —— 恒真，游戏就永远不判负了 */
const CAP_OLD = 'length===9';
const CAP_NEW = 'length>=(window.__NAIWA_CAP__||9)';
{
  const before = code.split(CAP_OLD).length - 1;
  const already = code.split(CAP_NEW).length - 1;
  if (before) code = code.split(CAP_OLD).join(CAP_NEW);
  log.push(`托盘容量 length===9 → 可配置: 改 ${before} 处（已应用 ${already} 处）`);
}

/* 3. 给 __NAIWA__ 增加"自定义牌局"入口：无尽模式每一塔的配置都是算出来的 */
const ENDLESS_ANCHOR = 'start:function(n){var i=Math.max(1,Math.min(a.length,n));l.value=i;if(i===1){Q()}else{Q(a[i-1])}}}';
const ENDLESS_NEW = 'start:function(n){var i=Math.max(1,Math.min(a.length,n));l.value=i;if(i===1){Q()}else{Q(a[i-1])}},'
  + 'startEndless:function(c,ly){l.value=5;Q({cardNum:c,layerNum:ly,trap:!1})}}';
if (code.includes('startEndless')) {
  log.push('无尽模式入口 startEndless: 已存在');
} else {
  const n = swap('无尽模式入口 startEndless', ENDLESS_ANCHOR, ENDLESS_NEW, 1);
  if (!n) log.push('⚠ 没有匹配到 __NAIWA__ 注入点，startEndless 未注入');
}

fs.writeFileSync(JS, code, 'utf8');
console.log('补丁目标: ' + path.relative(process.cwd(), JS));
for (const l of log) console.log('  ' + l);
console.log('（改 0 处 = 该项已经应用过，属于正常）');
