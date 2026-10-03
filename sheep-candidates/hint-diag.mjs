/**
 * 提示器 vs 真实牌面 一致性诊断
 *
 * 目的：找出"求解器说能通、实际照着走却走死"的分歧点。
 * 每步记录：模型里的可点牌数 / 真实 DOM 里没 mask 的牌数 / 模型牌数 / DOM 牌数 /
 *           托盘(模型=DOM) / 这一步用的是计划里的第几步。
 *
 * 用法: node hint-diag.mjs [url] [cdpPort] [layer] [maxSteps]
 */
const URL_TARGET = process.argv[2] || 'file:///C:/Users/YHSome/Projects/OtherProjects/ZhuaNaiWa/index.html';
const CDP_PORT = Number(process.argv[3] || 9222);
const LAYER = Number(process.argv[4] || 2);
const MAX_STEPS = Number(process.argv[5] || 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
const browser = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(browser.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send('Page.navigate', { url: URL_TARGET });
await sleep(3000);
await ev(`localStorage.setItem('naiwa.progress.v1', JSON.stringify({unlocked:5, cleared:[1,2,3,4], best:{}, stars:{}}))`);
await send('Page.navigate', { url: URL_TARGET });
await sleep(3000);
await ev(`(function(){ window.__NAIWA_LAYER_OVERRIDE__ = ${LAYER}; window.__NAIWA_START_ENDLESS__(1, true); delete window.__NAIWA_LAYER_OVERRIDE__; return true; })()`);
await sleep(2400);

const rows = [];
for (let step = 0; step < MAX_STEPS; step++) {
  const row = await ev(`(function(){
    var panel = document.querySelector('.nw-overlay');
    if (!panel.hidden) return { kind: 'panel' };
    var board = [].slice.call(document.querySelectorAll('.card')).filter(function(c){ return !c.closest('div[w-295px]'); });
    if (!board.length) return { kind: 'empty' };
    var trayEl = document.querySelector('div[w-295px]');
    var tray = [].slice.call(trayEl.querySelectorAll('.card')).map(function(c){ return c.querySelector('img').alt; });
    var domFree = board.filter(function(c){ return !c.querySelector('.mask') && !/leave-active|leave-to/.test(c.className||''); }).length;
    var hint = window.__NAIWA_HINT__();
    var clickable = {}, covered = [];
    board.forEach(function(c){
      if (c.querySelector('.mask')) return;
      var r = c.getBoundingClientRect();
      var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      var hit = document.elementFromPoint(x, y);
      var isSelf = hit && hit.closest && hit.closest('.card') === c;
      if (isSelf) clickable[c.getAttribute('style') || ''] = c; else covered.push(c.querySelector('img').alt);
    });
    var pick = null, planStep = -1;
    for (var k = 0; k < hint.seq.length && !pick; k++) { pick = clickable[hint.seq[k].key] || null; if (pick) planStep = k; }
    var info = {
      kind: 'step', board: board.length, domFree: domFree, modelTiles: hint.tiles, modelFree: hint.free,
      tray: tray.length, ok: hint.ok, planStep: planStep, clickable: Object.keys(clickable).length,
      covered: covered.length, reason: hint.reason || '', seqLen: hint.seq.length,
      seqTypes: hint.seq.slice(0, 6).map(function(e){ return e.type; }).join('')
    };
    if (!pick) { info.kind = 'nopick'; return info; }
    var r2 = pick.getBoundingClientRect();
    pick.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: Math.round(r2.left + r2.width/2), clientY: Math.round(r2.top + r2.height/2) }));
    pick.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return info;
  })()`);
  rows.push(row);
  if (row.kind !== 'step') { console.log('中断于第 ' + (step + 1) + ' 步: ' + JSON.stringify(row)); break; }
  await sleep(230);
}

console.log('');
console.log('牌面/模型一致性（层数 ' + LAYER + '，每行一步）');
console.log(' 步 | DOM牌 | 模型牌 | DOM可点 | 模型可点 | 托盘 | 计划第几步 | 可点(真实命中) | 被牌压住 | 计划可用 | 结果');
console.log('----|-------|--------|---------|----------|------|------------|----------------|----------|----------|------');
rows.forEach((r, i) => {
  if (r.kind !== 'step') { console.log(`  ${i + 1} | ${JSON.stringify(r)}`); return; }
  console.log(` ${String(i + 1).padStart(2)} | ${String(r.board).padStart(5)} | ${String(r.modelTiles).padStart(6)} | ${String(r.domFree).padStart(7)} | ${String(r.modelFree).padStart(8)} | ${String(r.tray).padStart(4)} | ${String(r.planStep).padStart(10)} | ${String(r.clickable).padStart(14)} | ${String(r.covered).padStart(8)} | ${String(r.ok ? '是' : '否(' + r.reason + ')').padStart(8)} | ${r.seqTypes}`);
});
ws.close();
process.exit(0);
