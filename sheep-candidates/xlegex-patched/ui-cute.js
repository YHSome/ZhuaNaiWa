/* ==========================================================================
   抓奶蛙 · UI 层（选关界面 / HUD / 结算面板 / 进度存档 / 音效开关）
   纯外挂脚本：不改游戏逻辑，只通过 window.__NAIWA__（由构建产物里注入的小接口）
   按编号开某一关；胜负则靠观察牌堆与托盘 DOM，以及劫持原生 alert 判定。
   ========================================================================== */
(function () {
  'use strict';

  var KEY_PROGRESS = 'naiwa.progress.v1';
  var KEY_MUTED = 'naiwa.muted';
  var TRAY_CAP = 9;                       // 托盘容量（与游戏内一致）

  /* 关卡表：与构建产物里的 LevelConfig 对应（3/1、4/2、6/2、9/2 → 9/24/36/54 张）
     star : [三星上限秒数, 二星上限秒数]，超过二星线只有一星
     第 5 项是无尽模式：塔一层层加高，配置在运行时算，不在那 4 条的配置表里 */
  var LEVELS = [
    { n: 1, name: '教程关', types: 3, tiles: 9,  stars: 1, star: [8, 16],   tip: '只有 3 种图案，怎么点都不会输' },
    { n: 2, name: '轻松关', types: 4, tiles: 24, stars: 2, star: [22, 42],  tip: '4 种图案，随便点点也能过' },
    { n: 3, name: '进阶关', types: 6, tiles: 36, stars: 4, star: [45, 80],  tip: '6 种图案，得看清被压住的方块了' },
    { n: 4, name: '挑战关', types: 9, tiles: 54, stars: 5, star: [75, 140], tip: '9 种图案全上，托盘很容易塞满，先用「移出前三个」救急' },
    { n: 5, name: '无尽模式', types: 9, tiles: 0, stars: 5, star: [0, 0], endless: true,
      tip: '一座塔清空马上起下一座，每塔再高一层；托盘满一次挑战就结束' },
  ];
  var ENDLESS = 5;                       // 无尽模式的"关卡号"
  var ENDLESS_MAX_LAYER = 6;             // 塔最高几层（小屏会自动降到 4~5 层，见 endlessMaxLayer）
  /** 小屏放不下 6 层：塔是环绕牌桌中心长的，屏越矮能放的层越少 */
  function endlessMaxLayer() {
    if (window.innerHeight < 620) return 4;
    if (window.innerHeight < 720) return 5;
    return ENDLESS_MAX_LAYER;
  }
  /* 无尽模式的难度曲线：塔变高 + 槽位变少。
     实测（endless-scale.mjs，用同一副牌换托盘容量 + 修正过遮挡方向的求解器）：
       · 9 格：2~6 层可解率 83%~100%，最优解峰值 7.2~7.7（9 格托盘已经只剩 1~2 格余量）
       · 8 格：可解率掉到 33%~50%
       · 7 格：0%~17%（基本靠运气，所以不做）
       · 层数本身也有影响：3 层峰值 7.7 > 2 层 7.4（同容量下更高的塔更紧）
     所以曲线是：第 1~2 塔给 9 格但塔比挑战关高一半，第 3 塔起收到 8 格（这时求解器都要重发一半才找得到通路）。 */
  var ENDLESS_MIN_CAP = 8;
  function endlessCap(tower) {
    if (tower <= 2) return 9;
    return ENDLESS_MIN_CAP;
  }
  function endlessTower(tower) {
    var layer = Math.min(2 + tower, endlessMaxLayer());
    var cap = endlessCap(tower);
    if (window.__NAIWA_LAYER_OVERRIDE__) layer = window.__NAIWA_LAYER_OVERRIDE__;   // 只给自动化测试用
    return { cardNum: 9, layer: layer, cap: cap, tiles: 27 * layer };
  }
  /** 按用时评星：3★ / 2★ / 1★ */
  function starFor(n, sec) {
    var t = info(n).star;
    if (sec <= t[0]) return 3;
    if (sec <= t[1]) return 2;
    return 1;
  }
  function starRow(k) {
    var s = '';
    for (var i = 0; i < 3; i++) s += (i < k ? '★' : '☆');
    return s;
  }

  /* ---------------- 存档 ---------------- */
  function loadProgress() {
    try {
      var p = JSON.parse(localStorage.getItem(KEY_PROGRESS) || '{}');
      return {
        unlocked: Math.max(1, Math.min(LEVELS.length, p.unlocked || 1)),
        cleared: Array.isArray(p.cleared) ? p.cleared : [],
        best: p.best && typeof p.best === 'object' ? p.best : {},
        stars: p.stars && typeof p.stars === 'object' ? p.stars : {},
        endlessBest: p.endlessBest || 0,        // 无尽模式最高爬到的塔数
        endlessTiles: p.endlessTiles || 0,      // 单次挑战最多清掉多少张
      };
    } catch (e) { return { unlocked: 1, cleared: [], best: {}, stars: {}, endlessBest: 0, endlessTiles: 0 }; }
  }
  function saveProgress() {
    try { localStorage.setItem(KEY_PROGRESS, JSON.stringify(progress)); } catch (e) { /* 忽略 */ }
  }
  var progress = loadProgress();
  var muted = localStorage.getItem(KEY_MUTED) === '1';

  /* ---------------- 运行时状态 ---------------- */
  var cur = progress.unlocked;      // 玩家当前选的关
  var playing = false;              // 是否处于"这一关进行中"（用于判定胜负）
  var pendingStart = false;
  var startAt = 0;
  var pausedAt = 0;
  var lastSeen = { left: 0, tray: 0 };   // 最近一次非空场面（失败瞬间游戏会立刻清空牌堆，得先记住）
  var dealTotal = 0;                     // 本关发牌总张数（用于进度条，从场面里量出来）
  var endless = { on: false, tower: 0, tiles: 0, startedAt: 0 };   // 无尽模式运行时状态

  /** 闸门：挡住游戏自带的"过关/失败后自动切关"定时器，避免覆盖玩家在面板里选的关卡 */
  function setHold(v) { window.__NAIWA_HOLD__ = !!v; }

  /* ---------------- DOM 骨架 ---------------- */
  var ui = document.createElement('div');
  ui.id = 'nw-ui';
  ui.innerHTML = [
    '<div class="nw-hud">',
    '  <button class="nw-btn nw-btn--ghost" data-act="levels">☰ 选关</button>',
    '  <span class="nw-chip" data-el="level">第 1 关</span>',
    '  <span class="nw-hud__spacer"></span>',
    '  <span class="nw-chip" data-el="left">剩余 <b>0</b></span>',
    '  <span class="nw-chip" data-el="time">00:00</span>',
    '  <button class="nw-btn nw-btn--ghost" data-act="mute" title="音效开关">🔊</button>',
    '</div>',
    '<div class="nw-progress" data-el="barwrap" role="progressbar" aria-label="本关进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">',
    '  <i data-el="bar"></i>',
    '</div>',
    '<div class="nw-overlay" data-el="overlay" hidden>',
    '  <div class="nw-panel" data-el="panel"></div>',
    '</div>',
  ].join('');
  document.body.appendChild(ui);

  var el = {};
  ['level', 'left', 'time', 'overlay', 'panel', 'barwrap', 'bar'].forEach(function (k) { el[k] = ui.querySelector('[data-el="' + k + '"]'); });
  var muteBtn = ui.querySelector('[data-act="mute"]');

  /* ---------------- 小工具 ---------------- */
  function fmtTime(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  function info(n) { return LEVELS[Math.min(LEVELS.length, Math.max(1, n)) - 1]; }
  function boardCards() { return [].slice.call(document.querySelectorAll('.card')).filter(function (c) { return !c.closest('div[w-295px]'); }); }
  function trayCards() { var t = document.querySelector('div[w-295px]'); return t ? [].slice.call(t.querySelectorAll('.card')) : []; }
  function actionBtn(label, cls, fn) {
    return '<button class="nw-btn ' + (cls || '') + '" data-run="' + label + '">' + label + '</button>';
  }

  /* ---------------- 提示条 ---------------- */
  function flash(text) {
    var d = document.createElement('div');
    d.className = 'nw-flash';
    d.setAttribute('role', 'status');
    d.setAttribute('aria-live', 'polite');
    d.textContent = text;
    ui.appendChild(d);
    setTimeout(function () { d.remove(); }, 1200);
  }

  /* ------------------------------------------------------------------ *
   * 牌堆自适应缩放
   *
   * 背景：塔的层数越多，牌堆以"牌桌中心"为圆心向四周长。无尽模式最高 6 层（162 张）时
   * 上沿会顶到 HUD 的按钮、下沿会压到道具行——顶到按钮的那几张会点不动（按钮吃掉了点击）。
   * 这里在每次发牌后量一次牌堆的实际包围盒，按"允许的纵向区间"反解出合适的缩放比。
   * ------------------------------------------------------------------ */
  function boardHost() { return document.querySelector('#app div[relative][flex-1]'); }

  function boardBand() {
    var bar = el.barwrap.getBoundingClientRect();
    var row = document.querySelector('#app > div > div[h-50px][text-center]');
    var bottom = row ? row.getBoundingClientRect().top - 8 : window.innerHeight - 200;
    return { top: bar.bottom + 10, bottom: bottom };
  }

  function fitBoard() {
    var host = boardHost();
    if (!host) return null;
    var board = boardCards();
    if (board.length < 6) return null;                       // 小牌堆不用管
    var wide = window.innerWidth >= 620;
    var base = wide ? 1.32 : 1.18;
    var oy = wide ? 0.46 : 0.44;
    host.style.transformOrigin = '50% ' + oy * 100 + '%';
    host.style.transform = 'scale(' + base + ')';
    var rect = host.getBoundingClientRect();
    var H = host.offsetHeight;
    var o = oy * H;                                          // 本地坐标里的锚点
    // 反推"没缩放时"牌堆容器的顶边
    var T = rect.top - o * (1 - base);
    var rs = board.map(function (c) { return c.getBoundingClientRect(); });
    var vTop = Math.min.apply(null, rs.map(function (r) { return r.top; }));
    var vBottom = Math.max.apply(null, rs.map(function (r) { return r.bottom; }));
    var localTop = o + (vTop - T - o) / base;
    var localBottom = o + (vBottom - T - o) / base;
    var band = boardBand();
    var sTop = (band.top - T - o) / (localTop - o);
    var sBottom = (band.bottom - T - o) / (localBottom - o);
    var s = Math.max(0.5, Math.min(base, sTop, sBottom));
    host.style.transform = 'scale(' + (Math.round(s * 1000) / 1000) + ')';
    return s;
  }


  function setBar(p) {
    p = Math.max(0, Math.min(1, p || 0));
    el.bar.style.transform = 'scaleX(' + p.toFixed(4) + ')';
    el.barwrap.setAttribute('aria-valuenow', String(Math.round(p * 100)));
  }

  function updateHud() {
    var i = info(cur);
    if (cur === ENDLESS && endless.on) {
      el.level.innerHTML = '无尽 <small>第 ' + endless.tower + ' 塔</small>';
    } else {
      el.level.innerHTML = '第 ' + cur + ' 关 <small>' + i.name + '</small>';
    }
    var left = boardCards().length + trayCards().length;
    el.left.innerHTML = '剩余 <b>' + left + '</b>';
    if (!playing) el.time.textContent = startAt ? fmtTime(performance.now() - startAt) : '00:00';
  }

  /* ---------------- 开关选关 / 结算面板 ---------------- */
  function openOverlay() { el.overlay.hidden = false; }
  function closeOverlay() { el.overlay.hidden = true; }

  function showLevels() {
    clearAuto();                                         // 防止"难度飙升"的倒计时在选关后把牌局带跑
    var resumable = boardCards().length > 0 || trayCards().length > 0;   // 桌面上还有牌 = 有一关正在进行
    if (playing) { pausedAt = performance.now(); }
    playing = false;                                     // 面板打开期间不做胜负判定
    var total = LEVELS.length;
    var done = progress.cleared.length;
    var starSum = LEVELS.reduce(function (a, lv) { return a + (progress.stars[lv.n] || 0); }, 0);
    var cells = LEVELS.map(function (lv) {
      var locked = lv.n > progress.unlocked;
      var cleared = progress.cleared.indexOf(lv.n) >= 0;
      var best = progress.best[lv.n];
      var st = progress.stars[lv.n] || 0;
      var meta = lv.endless
        ? (progress.endlessBest ? '<em>9 种 · 最高 ' + progress.endlessBest + ' 塔</em>' : '<em>9 种 · 越爬越高</em>')
        : '<em>' + lv.types + ' 种 · ' + lv.tiles + ' 张</em>';
      var sub = lv.endless
        ? '<span class="nw-lv__stars has">🔥</span>'
        : '<span class="nw-lv__stars' + (st ? ' has' : '') + '">' + starRow(st) + '</span>';
      return [
        '<button class="nw-lv' + (locked ? ' is-locked' : '') + (cleared ? ' is-cleared' : '') + (lv.endless ? ' nw-lv--endless' : '') + '"',
        locked ? ' disabled' : '', ' data-lv="' + lv.n + '"',
        ' aria-label="第 ' + lv.n + ' 关 ' + lv.name + (locked ? '（未解锁）' : cleared ? '（已通关，' + st + ' 星）' : '') + '">',
        '<i>' + (locked ? '🔒' : lv.endless ? '🔥' : lv.n) + '</i>',
        '<b>' + lv.name + '</b>',
        meta,
        sub,
        best ? '<span class="nw-lv__time">最快 ' + best + 's</span>' : '',
        '</button>',
      ].join('');
    }).join('');

    var contLabel = '开始第 ' + progress.unlocked + ' 关';
    if (progress.unlocked === 1 && done === 0) contLabel = '开始教程关';
    if (progress.unlocked === ENDLESS) contLabel = '进入无尽模式 🔥';

    el.panel.innerHTML = [
      '<h2 class="nw-title">抓奶蛙</h2>',
      '<p class="nw-sub">堆叠三消 · 共 ' + total + ' 关 · 已通关 ' + done + ' 关 · 星星 ' + starSum + ' / ' + ((total - 1) * 3) + '</p>',
      '<div class="nw-grid">' + cells + '</div>',
      '<div class="nw-actions">',
      resumable ? '<button class="nw-btn nw-btn--lg" data-run="resume">继续游戏</button>' : '',
      '<button class="nw-btn ' + (resumable ? '' : 'nw-btn--lg') + '" data-run="continue">' + contLabel + '</button>',
      '<button class="nw-btn" data-act="leaderboard">🏆 排行榜</button>',
      '<button class="nw-btn" data-run="help">玩法说明</button>',
      '<button class="nw-btn nw-btn--ghost" data-run="reset">重置进度</button>',
      '</div>',
      '<p class="nw-tip">点方块把它抓进托盘，凑齐 <b>3 只相同</b> 自动消除；托盘 <b>9 格</b>全满就失败。' +
      '被压住的方块会变暗，点不动。</p>',
    ].join('');
    openOverlay();
    updateHud();
  }

  /** 中途点"继续游戏"：关面板、恢复计时、不动牌局 */
  function continueGame() {
    closeOverlay();
    if (pausedAt) { startAt += performance.now() - pausedAt; pausedAt = 0; }   // 菜单时间不计入用时
    playing = true;
    updateHud();
  }

  function showHelp() {
    playing = false;
    el.panel.innerHTML = [
      '<h2 class="nw-title">玩法说明</h2>',
      '<p class="nw-sub">抓奶蛙 · 堆叠三消</p>',
      '<ul class="nw-help">',
      '<li><b>点方块</b>：抓进底部木槽，凑齐 3 只相同自动消除</li>',
      '<li><b>被压住</b>的方块会变暗、点不动，先把上面的抓走</li>',
      '<li>木槽共 <b>9 格</b>，塞满且无法消除即失败</li>',
      '<li><b>移出前三个</b>：把木槽最前面三张退回牌堆，救急用</li>',
      '<li><b>回退</b>：撤销上一步（把刚抓的那张还回去）</li>',
      '<li>牌堆布局每一局都是随机的，同一种图案可能被压在下面</li>',
      '<li><b>音乐</b>：背景音乐是循环播放的，右上角 🔊 一键静音（音效 + 音乐）</li>',
      '</ul>',
      '<div class="nw-actions">',
      '<button class="nw-btn nw-btn--lg" data-run="back-levels">回到选关</button>',
      '</div>',
    ].join('');
    openOverlay();
  }

  function showResult(kind, data) {
    playing = false;
    setHold(true);                     // 挡住游戏自带的自动切关，交给玩家点按钮
    var starBlock = data.stars
      ? '<div class="nw-stars" aria-label="获得 ' + data.stars + ' 星">' + starRow(data.stars)
        + '<small>' + (data.starTip || '') + '</small></div>'
      : '';
    el.panel.innerHTML = [
      '<h2 class="nw-title">' + data.title + '</h2>',
      '<p class="nw-sub">' + (data.sub || '') + '</p>',
      starBlock,
      '<div class="nw-stats">' + data.stats.map(function (s) {
        return '<div class="nw-stat"><b>' + s[1] + '</b><span>' + s[0] + '</span></div>';
      }).join('') + '</div>',
      data.tip ? '<p class="nw-tip">' + data.tip + '</p>' : '',
      '<div class="nw-actions">' + data.actions.map(function (a) {
        return '<button class="nw-btn ' + (a.cls === 'primary' ? 'nw-btn--lg' : a.cls === 'ghost' ? 'nw-btn--ghost' : '') + '" data-run="' + a.label + '">' + a.label + '</button>';
      }).join('') + '</div>',
    ].join('');
    data.actions.forEach(function (a) { actions[a.label] = a.fn; });
    openOverlay();
  }

  /* ------------------------------------------------------------------ *
   * 关卡可解性验证：发牌后自动检查，不可解就重发
   *
   * 做法：
   *   1. 从 DOM 读出每张牌的类型 / 坐标 / 层号（z-index）
   *   2. 重建依赖图 —— 与游戏规则一致：上一层里 |Δtop|≤40 且 |Δleft|≤40 的牌算压住它
   *   3. 用多个贪心策略模拟通关（能凑三就凑三 → 能连拿三张的类型 → 随机兜底）
   *   4. 只要有一种策略能清空就认为可解；否则重发，最多 6 次
   * 同时统计"原始发牌不可解率"，用来量化这项优化的价值。
   * ------------------------------------------------------------------ */
  var TRAY_CAP = 9;
  /** 当前托盘容量：构建产物里已改成读 window.__NAIWA_CAP__，无尽模式靠调小它拉高难度 */
  function currentCap() {
    var c = Number(window.__NAIWA_CAP__);
    return c >= 3 && c <= 9 ? c : TRAY_CAP;
  }
  var MAX_REROLL = 6;
  /* 发牌"刁度"门槛：最优解路线占用的托盘格数上限。
     实测（endless-scale.mjs，遮挡方向修正后）：9 种图案下 54 张的第 4 关，
     最优解峰值均值就有 7.4/9，可解率 83%——也就是说"按刁度重发"会把本来能打通、
     只是走得紧的牌换掉，反而变简单。这里只保留"求解器完全找不到通路"这一条重发理由。 */
  var TIGHT_MAX = { 1: 9, 2: 9, 3: 9, 4: 9, 5: 9 };
  function tightMax(lv) { return TIGHT_MAX[lv] || 8; }
  var validatePending = null;
  var lastBoardCount = -1;
  window.__NAIWA_SOLVE__ = [];
  window.__NAIWA_STATS__ = { judged: 0, unsolvableAtFirstTry: 0, tooTightAtFirstTry: 0, rerolls: 0, acceptedTight: 0 };

  /** 正在播"离场动画"的牌：Vue 的 <transition> 会让已抓走的牌在 DOM 里多留 200ms，
      读盘面时必须剔掉，否则同一张牌会被当成"还在牌堆里"（总数对不上，求解器就会算成死局） */
  function isLeaving(el) {
    var cn = el.className || '';
    return /leave-active|leave-to/.test(cn);
  }

  /** 每张牌一个稳定 id：同一层里可能有两张牌算出的 top/left 完全相同（游戏的 i→(row,column)
      映射不是单射），只靠 inline style 认牌会认错，所以第一次读到时就打上标记。 */
  var nwIdSeq = 0;
  function cardKey(c) {
    if (!c.__nwId) c.__nwId = ++nwIdSeq;
    return 'id:' + c.__nwId;
  }

  function readBoardGraph() {
    var out = [];
    [].slice.call(document.querySelectorAll('.card')).forEach(function (c) {
      if (c.closest('div[w-295px]')) return;                       // 托盘里的不算
      if (isLeaving(c)) return;                                    // 刚被抓走、还在离场动画里的不算
      var st = c.getAttribute('style') || '';
      var img = c.querySelector('img');
      if (!img) return;
      var top = parseFloat((/top:\s*(-?[\d.]+)px/.exec(st) || [])[1]);
      var left = parseFloat((/left:\s*(-?[\d.]+)px/.exec(st) || [])[1]);
      var z = parseInt((/z-?index:\s*(-?\d+)/.exec(st) || [])[1], 10);
      if (!isFinite(top) || !isFinite(left)) return;
      out.push({ type: img.getAttribute('alt'), top: top, left: left, layer: isFinite(z) ? z : 0, blockers: [], key: cardKey(c) });
    });
    out.forEach(function (n, i) { n.i = i; });
    out.forEach(function (n, ni) {
      out.forEach(function (p, pi) {
        // 与游戏一致：**高一层**的牌压住它（useGame 里 e.parents.push(node)：
        // perFloorNodes 是下一层(index-1)，被 push 的 node 是上一层(index)，z-index 更大、画在上面）
        if (p.layer === n.layer + 1 && Math.abs(p.top - n.top) <= 40 && Math.abs(p.left - n.left) <= 40) {
          n.blockers.push(p.i);
          return;
        }
        // 隔层压心：游戏的状态只看"上一层"，但更高的牌正好盖住这张牌的中心时，
        // 点击会被上层那张接走 → 物理上就是点不到，必须一起算进前置条件
        if (p.layer > n.layer && Math.abs(p.top - n.top) <= 20 && Math.abs(p.left - n.left) <= 20) {
          n.blockers.push(p.i);
          return;
        }
        // 同一层里 top/left 完全重合：DOM 顺序靠后的画在上面（游戏算行列时不是单射，会撞位）
        if (p.layer === n.layer && p.top === n.top && p.left === n.left && pi > ni) n.blockers.push(p.i);
      });
    });
    return out;
  }

  function mulberry(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  var solveFirst = null;          // 本轮试算的第一步（给"提示/自动测试"用）
  var solveSeq = [];              // 本轮的取牌顺序（牌可能被上层别的牌压住点不到，提示时按顺序找可点的）

  function trySolve(nodes, seed, cap, initTray) {
    var CAP = cap || TRAY_CAP;
    var removed = new Uint8Array(nodes.length);
    var left = nodes.length;
    var tray = (initTray || []).slice();
    var maxTray = 0;
    var rnd = mulberry(seed);
    var guard = 0;
    solveFirst = null;
    solveSeq = [];
    while (left > 0 || tray.length) {
      if (guard++ > nodes.length * 4 + 100) return { ok: false, maxTray: maxTray, reason: 'loop' };
      var free = [];
      for (var i = 0; i < nodes.length; i++) {
        if (removed[i]) continue;
        var n = nodes[i], canPick = true;
        for (var b = 0; b < n.blockers.length; b++) if (!removed[n.blockers[b]]) { canPick = false; break; }
        if (canPick) free.push(n);
      }
      if (!free.length) return { ok: false, maxTray: maxTray, reason: 'deadlock' };
      var counts = {}, byType = {};
      tray.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
      free.forEach(function (n) { (byType[n.type] = byType[n.type] || []).push(n); });
      var types = Object.keys(byType);
      var pick = null, k;
      for (k = 0; k < types.length && !pick; k++) if ((counts[types[k]] || 0) === 2) pick = byType[types[k]][0];          // 立刻凑三
      for (k = 0; k < types.length && !pick; k++) if ((counts[types[k]] || 0) === 1 && byType[types[k]].length >= 2) pick = byType[types[k]][0];
      for (k = 0; k < types.length && !pick; k++) if (!counts[types[k]] && byType[types[k]].length >= 3) pick = byType[types[k]][0];
      if (!pick) pick = free[Math.floor(rnd() * free.length)];    // 不同种子 = 不同试法，降低误判
      if (solveFirst === null) solveFirst = pick.type;
      if (solveSeq.length < 400) solveSeq.push({ type: pick.type, key: pick.key });
      tray.push(pick.type);
      removed[pick.i] = 1; left--;
      var same = 0;
      for (k = 0; k < tray.length; k++) if (tray[k] === pick.type) same++;
      if (same >= 3) {
        var need = 3, rest = [];
        for (k = 0; k < tray.length; k++) {
          if (tray[k] === pick.type && need > 0) { need--; continue; }
          rest.push(tray[k]);
        }
        tray = rest;
      }
      if (tray.length > maxTray) maxTray = tray.length;
      // 与游戏一致：托盘塞到上限且这一手没消掉 → 判负
      if (tray.length >= CAP) return { ok: false, maxTray: maxTray, reason: 'tray-full' };
    }
    return { ok: true, maxTray: maxTray, first: solveFirst, seq: solveSeq.slice(0) };
  }

  /** 多种策略里只要有一种能通就算可解；可解时取"峰值最省"的那条线当刁度指标 */
  function judgeLevel(nodes, cap, initTray) {
    var bestFail = { ok: false, maxTray: 0, reason: 'none' };
    var bestOk = null;
    for (var s = 0; s < 6; s++) {
      var r = trySolve(nodes, s * 7919 + 13, cap, initTray);
      if (r.ok) { if (!bestOk || r.maxTray < bestOk.maxTray) bestOk = r; }
      else if (r.maxTray > bestFail.maxTray) bestFail = r;
    }
    return bestOk || bestFail;
  }

  /** 牌堆指纹：用来判断"重发之后是否真的换了一副新牌" */
  function boardSig() {
    var cards = [].slice.call(document.querySelectorAll('.card')).filter(function (c) { return !c.closest('div[w-295px]'); });
    return cards.slice(0, 4).map(function (c) {
      var img = c.querySelector('img');
      return (c.getAttribute('style') || '') + (img ? img.getAttribute('alt') : '');
    }).join('|');
  }

  /** 给某一关挂上"待验证"标记；发牌稳定后由 tick 驱动验证 */
  function armValidation(level, redeal, budgetMs) {
    validatePending = {
      level: level, tries: 0, stable: 0, awaitSig: null, dealCount: 0,
      redeal: redeal || null,
      // 重发只在开局这几秒内做：真发牌后玩家开始点了就不再动牌面（moved 判定兜底）
      deadline: performance.now() + (budgetMs || 2600),
    };
    lastBoardCount = -1;
  }

  /** 由 tick 驱动：牌堆稳定后验证，必要时重发 */
  function runValidator(api) {
    if (!validatePending) return;
    if (el.overlay && !el.overlay.hidden) return;      // 结算/选关面板开着时不算"在玩"，不验证也不重发
    if (boardCards().length === 0) return;
    // 重发之后必须等到"牌堆指纹变了"再验，避免拿旧牌堆反复验
    var sig = boardSig();
    if (validatePending.awaitSig && sig === validatePending.awaitSig) return;
    validatePending.awaitSig = null;

    // 等牌堆连续两次数量不变，确认发牌结束
    if (boardCards().length === lastBoardCount) validatePending.stable = (validatePending.stable || 0) + 1;
    else validatePending.stable = 0;
    if (validatePending.stable < 2) return;

    var nodes = readBoardGraph();
    if (!nodes.length) return;
    if (!validatePending.dealCount) validatePending.dealCount = nodes.length;
    var res = judgeLevel(nodes, currentCap());
    var cap = tightMax(validatePending.level);
    var tooTight = res.ok && res.maxTray > cap;        // 能通，但容错太窄
    validatePending.tries++;
    if (validatePending.tries === 1) {
      window.__NAIWA_STATS__.judged++;
      if (!res.ok) window.__NAIWA_STATS__.unsolvableAtFirstTry++;
      else if (tooTight) window.__NAIWA_STATS__.tooTightAtFirstTry++;
    }
    window.__NAIWA_SOLVE__.push({
      level: validatePending.level, try: validatePending.tries, ok: res.ok,
      maxTray: res.maxTray, cap: cap, reason: res.reason || '', tiles: nodes.length,
      t: Math.round(performance.now()),
    });

    // 玩家已经动过手了（拿过牌 / 托盘里有牌）→ 即便判定为"难"也不再重发，
    // 否则会把玩家正在下的棋直接抹掉。
    var moved = trayCards().length > 0 || boardCards().length < validatePending.dealCount;

    var inBudget = performance.now() < (validatePending.deadline || 0);
    var maxReroll = validatePending.level === ENDLESS ? 8 : MAX_REROLL;   // 无尽模式一条命，宁可多发几副
    if ((!res.ok || tooTight) && !moved && inBudget && validatePending.tries < maxReroll) {
      if (window.__NAIWA_STATS__.rerolls === 0) flash('重新发牌…');
      window.__NAIWA_STATS__.rerolls++;
      validatePending.awaitSig = sig;        // 记下这副"不合格"的指纹
      validatePending.stable = 0;
      // 重发要认模式：无尽模式第 5 关不能用 api.start(5)（那张配置表只有 4 关）
      if (validatePending.redeal) validatePending.redeal();
      else if (api) api.start(validatePending.level);
      return;
    }
    if (!res.ok) { window.__NAIWA_STATS__.acceptedTight++; flash('这关有点难，稳住！'); }   // 试满仍判不可解 → 保留并提示
    else if (tooTight) window.__NAIWA_STATS__.acceptedTight++;
    validatePending = null;
  }

  var actions = {};

  /* "难度飙升"过渡页：过关后不直接切关，先亮出下一关的难度对比，再（倒计时或点按钮）开战 */
  var autoTimer = 0, autoTick = 0;
  function clearAuto() {
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = 0; }
    if (autoTick) { clearInterval(autoTick); autoTick = 0; }
  }

  function dots(n) {
    var s = '<span class="nw-dots">';
    for (var i = 1; i <= 5; i++) s += '<span class="' + (i <= n ? 'on' : '') + '"></span>';
    return s + '</span>';
  }

  /** 倒计时 + 自动开始：文字更新只在 interval 里做，自动开跑交给 timeout（同一时刻两边都动手会互相清掉） */
  function attachAuto(sec, fn, suffix) {
    clearAuto();
    var d = el.panel.querySelector('[data-el="auto"]');
    var tail = suffix || ' 秒后自动开始…';
    var left = sec;
    autoTick = setInterval(function () {
      left--;
      if (left > 0) { if (d) d.textContent = left + tail; return; }
      if (autoTick) { clearInterval(autoTick); autoTick = 0; }
      if (d) d.textContent = '开始！';
    }, 1000);
    autoTimer = setTimeout(function () { clearAuto(); fn(); }, sec * 1000);
  }

  function showNextIntro(nextN) {
    clearAuto();
    playing = false;
    setHold(true);                          // 过渡期间也别让游戏自己切关
    // 挑战关之后的下一站是无尽模式：没有"张数对比"，改成讲规则
    if (nextN === ENDLESS) {
      var cfg1 = endlessTower(1);
      el.panel.innerHTML = [
        '<div class="nw-center"><div class="nw-spike">🔥 无尽模式</div></div>',
        '<h2 class="nw-title nw-title--sm">难度大幅上升</h2>',
        '<p class="nw-sub">清空「挑战关」之后，真正的考验才开始</p>',
        '<div class="nw-compare">',
        '<div class="nw-row"><span>第 1 塔</span><span><b class="up">' + cfg1.layer + ' 层</b><i>·</i><b class="up">' + cfg1.tiles + ' 张</b><i>·</i><b class="up">' + cfg1.cap + ' 格托盘</b></span></div>',
        '<div class="nw-row"><span>每清一塔</span><span><b class="up">再高一层</b>，第 2 塔起托盘收到 ' + endlessTower(2).cap + ' 格</span></div>',
        '<div class="nw-row"><span>容错</span><span><b class="up">托盘满一次即结束</b></span></div>',
        '</div>',
        '<div class="nw-diff"><span>难度</span>' + dots(5) + '</div>',
        '<p class="nw-tip">没有重来，也不能某一塔重新开始；时间一路累计。最高塔数记在选关界面。</p>',
        '<div class="nw-actions">',
        '<button class="nw-btn nw-btn--lg" data-run="开战！">开战！</button>',
        '<button class="nw-btn nw-btn--ghost" data-run="选关">选关</button>',
        '</div>',
        '<p class="nw-auto" data-el="auto">3 秒后自动开始…</p>',
      ].join('');
      actions = {
        '开战！': function () { clearAuto(); startEndless(1, true); },
        '选关': function () { clearAuto(); showLevels(); },
      };
      openOverlay();
      attachAuto(3, function () { startEndless(1, true); });
      return;
    }
    var a = info(cur), b = info(nextN);
    var same = function (x, y) { return '<b>' + x + '</b><i>→</i><b' + (String(x) !== String(y) ? ' class="up"' : '') + '>' + y + '</b>'; };
    el.panel.innerHTML = [
      '<div class="nw-center"><div class="nw-spike">⚡ 难度飙升</div></div>',
      '<h2 class="nw-title nw-title--sm">第 ' + nextN + ' 关 · ' + b.name + '</h2>',
      '<p class="nw-sub">比「' + a.name + '」更难了，准备开战</p>',
      '<div class="nw-compare">',
      '<div class="nw-row"><span>图案种类</span><span>' + same(a.types + ' 种', b.types + ' 种') + '</span></div>',
      '<div class="nw-row"><span>方块总数</span><span>' + same(a.tiles + ' 张', b.tiles + ' 张') + '</span></div>',
      '<div class="nw-row"><span>托盘容量</span><span>' + same('9 格', '9 格') + '</span></div>',
      '</div>',
      '<div class="nw-diff"><span>难度</span>' + dots(b.stars) + '</div>',
      '<p class="nw-tip">' + b.tip + '</p>',
      '<div class="nw-actions">',
      '<button class="nw-btn nw-btn--lg" data-run="开战！">开战！</button>',
      '<button class="nw-btn nw-btn--ghost" data-run="选关">选关</button>',
      '</div>',
      '<p class="nw-auto" data-el="auto">3 秒后自动开始…</p>',
    ].join('');
    actions = {
      '开战！': function () { clearAuto(); startLevel(nextN); },
      '选关': function () { clearAuto(); showLevels(); },
    };
    openOverlay();
    attachAuto(3, function () { startLevel(nextN); });
  }

  /* ---------------- 关卡控制 ---------------- */
  /** 无尽模式：开第 tower 座塔（一座比一座高；托盘满一次就结束） */
  function startEndless(tower, fresh) {
    var api = window.__NAIWA__;
    if (!api || !api.startEndless) { setTimeout(function () { startEndless(tower, fresh); }, 150); return; }
    var cfg = endlessTower(tower);
    cur = ENDLESS;
    endless.on = true;
    endless.tower = tower;
    if (fresh) { endless.tiles = 0; endless.startedAt = performance.now(); }
    if (!endless.startedAt) endless.startedAt = performance.now();
    actions = {};
    clearAuto();
    if (window.__NAIWA_ADV__) { clearTimeout(window.__NAIWA_ADV__); window.__NAIWA_ADV__ = null; }
    setHold(false);
    closeOverlay();
    window.__NAIWA_CAP__ = cfg.cap;         // 槽位变少 = 真正的难度（构建产物已改成读这个值）
    api.startEndless(cfg.cardNum, cfg.layer);
    pendingStart = true;
    playing = false;
    pausedAt = 0;
    startAt = performance.now();
    lastSeen = { left: 0, tray: 0 };
    dealTotal = 0;
    setBar(0);
    // 无尽模式只挡"无解"的牌，不按刁度重发（否则越爬越高的塔就白爬了）；
    // 一条命模式多给点重发预算：3 秒内最多换 8 副牌
    armValidation(ENDLESS, function () { api.startEndless(cfg.cardNum, cfg.layer); }, 5000);
    updateHud();
    flash('无尽模式 · 第 ' + tower + ' 塔 · ' + cfg.tiles + ' 张 · 托盘 ' + cfg.cap + ' 格');
    window.__NAIWA_ENDLESS__ = { tower: tower, layer: cfg.layer, tiles: cfg.tiles, cap: cfg.cap, on: true };
  }

  /** 一座塔清空：记成绩 → 弹过渡面板 → 3 秒后自动开下一座 */
  function onTowerClear() {
    var tower = endless.tower;
    endless.tiles += dealTotal || 0;
    if (tower > (progress.endlessBest || 0)) { progress.endlessBest = tower; saveProgress(); }
    if (endless.tiles > (progress.endlessTiles || 0)) { progress.endlessTiles = endless.tiles; saveProgress(); }
    var next = endlessTower(tower + 1);
    setHold(true);
    setBar(1);
    el.panel.innerHTML = [
      '<div class="nw-center"><div class="nw-spike">🔥 第 ' + tower + ' 塔 清空</div></div>',
      '<h2 class="nw-title nw-title--sm">无尽模式</h2>',
      '<p class="nw-sub">累计 ' + fmtTime(performance.now() - endless.startedAt) + ' · 已清 ' + endless.tiles + ' 张</p>',
      '<div class="nw-compare">',
      '<div class="nw-row"><span>本塔规模</span><span><b>' + Math.min(2 + tower, ENDLESS_MAX_LAYER) + ' 层</b><i>·</i><b>' + (27 * Math.min(2 + tower, ENDLESS_MAX_LAYER)) + ' 张</b><i>·</i><b>' + endlessCap(tower) + ' 格</b></span></div>',
      '<div class="nw-row"><span>下一塔规模</span><span><b class="up">' + next.layer + ' 层</b><i>·</i><b class="up">' + next.tiles + ' 张</b><i>·</i><b class="up">' + next.cap + ' 格托盘</b></span></div>',
      '<div class="nw-row"><span>最高纪录</span><span><b>' + (progress.endlessBest || 0) + ' 塔</b></span></div>',
      '</div>',
      '<p class="nw-tip">' + (next.cap < endlessCap(tower)
        ? '下一塔的托盘更紧（' + next.cap + ' 格）。托盘满一次挑战就结束——没有重来，也不能把某一塔重新开始。'
        : '下一塔更高一层（' + next.layer + ' 层 / ' + next.tiles + ' 张）。托盘满一次挑战就结束——没有重来。') + '</p>',
      '<div class="nw-actions">',
      '<button class="nw-btn nw-btn--lg" data-run="继续爬塔">继续爬塔 →</button>',
      '<button class="nw-btn nw-btn--ghost" data-run="结束挑战">结束挑战</button>',
      '</div>',
      '<p class="nw-auto" data-el="auto">4 秒后自动接着爬…</p>',
    ].join('');
    actions = {
      '继续爬塔': function () { clearAuto(); startEndless(tower + 1); },
      '结束挑战': function () { clearAuto(); endEndless(); },
    };
    openOverlay();
    attachAuto(4, function () { startEndless(tower + 1); }, ' 秒后自动接着爬…');
  }

  /** 主动结束挑战 / 挑战失败后的收尾 */
  function endEndless() {
    endless.on = false;
    window.__NAIWA_ENDLESS__ = { tower: endless.tower, on: false };
    showLevels();
  }

  function startLevel(n) {
    var api = window.__NAIWA__;
    if (!api) { setTimeout(function () { startLevel(n); }, 150); return; }
    if (n === ENDLESS) { startEndless(1, true); return; }
    endless.on = false;
    window.__NAIWA_CAP__ = TRAY_CAP;        // 普通关卡恢复 9 格
    cur = Math.max(1, Math.min(Math.min(api.levelCount, 4), n));
    actions = {};
    clearAuto();
    // 关键：游戏在过关/失败后 2s 会自己切关（哪怕玩家已经在面板里选好了），
    // 所以这里把那个待触发的定时器直接掐掉，再放行闸门
    if (window.__NAIWA_ADV__) { clearTimeout(window.__NAIWA_ADV__); window.__NAIWA_ADV__ = null; }
    setHold(false);
    closeOverlay();
    api.start(cur);
    pendingStart = true;
    playing = false;
    pausedAt = 0;
    startAt = performance.now();
    lastSeen = { left: 0, tray: 0 };
    dealTotal = 0;                                          // 进度条重新算
    setBar(0);
    armValidation(cur);                                     // 发牌后做可解性验证
    updateHud();
    flash('第 ' + cur + ' 关 · ' + info(cur).name);
  }

  function onWin() {
    bgmDuck(1500);                                         // 让音效站到前面
    if (endless.on) { onTowerClear(); return; }     // 无尽模式：清空一座塔 → 换下一座
    var sec = Math.round((performance.now() - startAt) / 1000);
    setBar(1);                                             // 收尾把进度条拉满
    if (progress.cleared.indexOf(cur) < 0) progress.cleared.push(cur);
    progress.unlocked = Math.max(progress.unlocked, Math.min(cur + 1, LEVELS.length));
    if (!progress.best[cur] || sec < progress.best[cur]) progress.best[cur] = sec;
    var got = starFor(cur, sec);
    var prev = progress.stars[cur] || 0;
    if (got > prev) progress.stars[cur] = got;
    saveProgress();
    var last = cur >= 4;                      // 第 4 关（挑战关）是"主线"的最后一关
    var acts = last
      ? [{ label: '无尽模式 🔥', fn: function () { showNextIntro(ENDLESS); }, cls: 'primary' },
         { label: '重玩本关', fn: function () { startLevel(cur); }, cls: 'ghost' },
         { label: '选关', fn: function () { showLevels(); }, cls: 'ghost' }]
      : [{ label: '下一关 →', fn: function () { showNextIntro(cur + 1); }, cls: 'primary' },
         { label: '重玩本关', fn: function () { startLevel(cur); }, cls: 'ghost' },
         { label: '选关', fn: showLevels, cls: 'ghost' }];
    var t = info(cur).star;
    var starTip = got >= 3 ? '三星！' + t[0] + 's 内通关真快'
      : got === 2 ? '再快一点（' + t[0] + 's 内）就是三星'
      : '试试 ' + t[1] + 's 内通关拿两星';
    showResult('win', {
      title: last ? '4 关全部通关！🏆' : '过关！🎉',
      sub: last ? '挑战关也清空了 —— 该试试无尽模式了' : '第 ' + cur + ' 关 · ' + info(cur).name + ' 已清空',
      stars: got,
      starTip: starTip,
      stats: [['用时', sec + 's'], ['剩余', '0 张'], ['已解锁', progress.unlocked + ' / ' + LEVELS.length]],
      tip: last ? '试试刷新最快通关时间？' : info(cur + 1).tip,
      actions: acts,
    });
  }

  function onLose() {
    playing = false;
    bgmDuck(1600);
    if (endless.on) {
      // 无尽模式：托盘满 = 挑战结束（记最高塔数）
      endless.on = false;
      window.__NAIWA_ENDLESS__ = { tower: endless.tower, on: false };
      if (endless.tower > (progress.endlessBest || 0)) { progress.endlessBest = endless.tower; }
      if (endless.tiles > (progress.endlessTiles || 0)) { progress.endlessTiles = endless.tiles; }
      saveProgress();
      var total = fmtTime(performance.now() - endless.startedAt);
      setHold(true);
      showResult('lose', {
        title: '挑战结束 🔥',
        sub: '无尽模式 · 止步第 ' + endless.tower + ' 塔',
        stats: [['爬塔', endless.tower + ' 塔'], ['清除', endless.tiles + ' 张'], ['总用时', total]],
        tip: '最高纪录 ' + (progress.endlessBest || 0) + ' 塔。下一塔只会更高，早点攒同种图案再下手。',
        actions: [{ label: '上榜', fn: showSubmit, cls: 'primary' },
                  { label: '再爬一次', fn: function () { startEndless(1, true); } },
                  { label: '排行榜', fn: function () { showLeaderboard(true); }, cls: 'ghost' },
                  { label: '选关', fn: showLevels, cls: 'ghost' }],
      });
      return;
    }
    // 游戏失败时会立刻清空牌堆与托盘，所以用"失败前最后一次看到的场面"来报数
    var left = (lastSeen.left + lastSeen.tray) || 0;
    showResult('lose', {
      title: '托盘满了 😵',
      sub: '第 ' + cur + ' 关 · ' + info(cur).name,
      stats: [['剩余', left + ' 张'], ['托盘', currentCap() + ' / ' + currentCap()], ['用时', fmtTime(performance.now() - startAt)]],
      tip: '尽量连着抓同一种图案；实在不行用「移出前三个」或「回退」救一下。失败不会扣进度，重来即可。',
      actions: [{ label: '重玩本关', fn: function () { startLevel(cur); }, cls: 'primary' },
                { label: '选关', fn: showLevels, cls: 'ghost' }],
    });
  }

  /* ------------------------------------------------------------------ *
   * 背景音乐
   *   · 18.5 秒无缝循环（audio/bgm.wav，8 小节 104BPM，A 小调五声，见 make-bgm.mjs）
   *   · 首次用户手势才起播（浏览器自动播放策略），之后一直循环
   *   · 音量 0.34 压在音效之下；过关/失败时短暂"让路"（duck），不盖住音效
   *   · 与音效共用一个 🔊 开关；切到后台自动暂停，回来接着放
   * ------------------------------------------------------------------ */
  var BGM_SRC = './audio/bgm.wav';
  var BGM_VOL = 0.34, BGM_DUCK = 0.1;
  var bgm = null, bgmTarget = 0, bgmArmed = false, duckTimer = 0;

  function bgmEl() {
    if (bgm) return bgm;
    try {
      bgm = new Audio(BGM_SRC);
      bgm.loop = true;
      bgm.preload = 'auto';
      bgm.volume = 0;                 // 从 0 淡入，别突然炸响
      bgm.setAttribute('data-el', 'bgm');
      document.body.appendChild(bgm);
    } catch (e) { bgm = null; }
    return bgm;
  }
  function bgmPlay() {
    var a = bgmEl();
    if (!a || muted) return;
    if (duckTimer) { clearTimeout(duckTimer); duckTimer = 0; }
    bgmTarget = BGM_VOL;
    if (a.paused) {
      var p = a.play();
      if (p && p.catch) p.catch(function () { /* 还没拿到手势，等下一次 */ });
    }
  }
  function bgmStop() {
    // 只把目标音量降到 0，真正的 pause 交给 bgmFadeTick——淡到 0 再停，不会"啪"地截断
    if (!bgmEl()) return;
    bgmTarget = 0;
  }
  /** 过关/失败时把音乐压低一点，让音效站到前面 */
  function bgmDuck(ms) {
    if (!bgm || muted) return;
    bgmTarget = BGM_DUCK;
    if (duckTimer) clearTimeout(duckTimer);
    duckTimer = setTimeout(function () { duckTimer = 0; if (!muted) bgmTarget = BGM_VOL; }, ms || 1400);
  }
  /** 由 tick 驱动的音量渐变（每 200ms 一步）：淡入 ~1.5s、淡出 ~1.2s，到 0 就暂停 */
  function bgmFadeTick() {
    if (!bgm) return;
    var d = bgmTarget - bgm.volume;
    if (Math.abs(d) < 0.006) {
      bgm.volume = bgmTarget;
      if (bgmTarget === 0 && !bgm.paused) { try { bgm.pause(); } catch (e) { /* 忽略 */ } }
      return;
    }
    bgm.volume = Math.max(0, Math.min(1, bgm.volume + (d > 0 ? 0.045 : -0.07)));
  }

  /* ---------------- 音效开关 ---------------- */
  function applyMute() {
    [].slice.call(document.querySelectorAll('audio')).forEach(function (a) { a.muted = muted; });
    muteBtn.textContent = muted ? '🔇' : '🔊';
    muteBtn.setAttribute('aria-label', muted ? '音效与音乐已关闭，点击开启' : '音效与音乐已开启，点击关闭');
    muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
  }
  function toggleMute() {
    muted = !muted;
    localStorage.setItem(KEY_MUTED, muted ? '1' : '0');
    applyMute();
    if (muted) bgmStop(); else bgmPlay();
  }

  /* ---------------- 事件 ---------------- */
  ui.addEventListener('click', function (ev) {
    var t = ev.target;
    var act = t.closest && t.closest('[data-act]');
    if (act && act.dataset.act === 'levels') { showLevels(); return; }
    if (act && act.dataset.act === 'mute') { toggleMute(); return; }
    if (act && act.dataset.act === 'leaderboard') { showLeaderboard(true); return; }
    var lb = t.closest && t.closest('[data-lb]');
    if (lb) {
      if (lb.dataset.lb === 'refresh') refreshLb();
      else if (lb.dataset.lb === 'send') lbSend();
      else if (lb.dataset.lb === 'skip') showLeaderboard(false);
      else { lbSort = lb.dataset.lb; showLeaderboard(false); }
      return;
    }
    var lv = t.closest && t.closest('[data-lv]');
    if (lv && !lv.disabled) { startLevel(Number(lv.dataset.lv)); return; }
    var run = t.closest && t.closest('[data-run]');
    if (!run) return;
    var label = run.dataset.run;
    if (label === 'continue') { startLevel(progress.unlocked); return; }
    if (label === 'resume') { continueGame(); return; }
    if (label === 'help') { showHelp(); return; }
    if (label === 'back-levels') { showLevels(); return; }
    if (label === 'reset') {
      if (window.confirm('确定要清空进度吗？（各关最快时间与解锁记录都会重置）')) {
        progress = { unlocked: 1, cleared: [], best: {}, stars: {} };
        saveProgress();
        showLevels();
      }
      return;
    }
    if (actions[label]) { var fn = actions[label]; actions = {}; fn(); }
  });

  // 劫持原生 alert：游戏失败时弹的就是它，换成自己的面板
  var nativeAlert = window.alert;
  window.alert = function (msg) {
    if (/槽位已满|再接再厉/.test(String(msg || ''))) { onLose(); return; }
    return nativeAlert.apply(window, arguments);
  };

  /* ------------------------------------------------------------------ *
   * 无尽模式排行榜（TinyWebDB）
   *   · 提交：action=update，tag = naiwa-<epoch秒>-<随机>，value = 塔|张|秒|昵称
   *   · 读取：action=search，tag=naiwa&count=100，返回 {tag: value}
   *   · 服务端带 Access-Control-Allow-Origin: *，所以 file:// 双击打开也能读
   *   · 读不到（断网/服务器挂了）就显示本地缓存的上一次结果，并标注"离线缓存"
   * ------------------------------------------------------------------ */
  var LB_API = 'https://tinywebdb.appinventor.space/api';
  var LB_USER = 'zhuadae';
  var LB_SECRET = '9c0ba660';
  var KEY_LB = 'naiwa.leaderboard.v1';
  var KEY_NICK = 'naiwa.nick';
  var KEY_MINE = 'naiwa.mytags';
  var lbState = { loading: false, from: 'cache', at: 0 };
  var lbSort = 'new';        // new = 按提交时间倒序；top = 按塔数

  function lbPost(params, timeoutMs) {
    var body = 'user=' + encodeURIComponent(LB_USER) + '&secret=' + encodeURIComponent(LB_SECRET)
      + '&action=' + encodeURIComponent(params.action)
      + Object.keys(params).filter(function (k) { return k !== 'action'; })
        .map(function (k) { return '&' + k + '=' + encodeURIComponent(params[k]); }).join('');
    var opt = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body };
    if (window.AbortController) {
      var ac = new AbortController();
      opt.signal = ac.signal;
      setTimeout(function () { try { ac.abort(); } catch (e) { /* 忽略 */ } }, timeoutMs || 8000);
    }
    return fetch(LB_API, opt).then(function (r) { return r.text(); });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function lbDecode(obj) {
    var out = [];
    Object.keys(obj || {}).forEach(function (tag) {
      if (tag.indexOf('naiwa') !== 0) return;
      var parts = String(obj[tag]).split('|');
      var m = /^naiwa-(\d{10,})-/.exec(tag);
      var e = {
        tag: tag,
        tower: Math.max(0, parseInt(parts[0], 10) || 0),
        tiles: Math.max(0, parseInt(parts[1], 10) || 0),
        sec: Math.max(0, parseInt(parts[2], 10) || 0),
        nick: (parts[3] || '匿名奶蛙').slice(0, 16),
        ts: m ? Number(m[1]) * 1000 : 0,
      };
      if (e.tower > 0) out.push(e);
    });
    out.sort(function (a, b) { return b.ts - a.ts; });
    return out;
  }

  function lbFetch() {
    lbState.loading = true;
    return lbPost({ action: 'search', no: 1, count: 100, tag: 'naiwa' }, 9000).then(function (txt) {
      var list = lbDecode(JSON.parse(txt));
      try { localStorage.setItem(KEY_LB, JSON.stringify({ at: Date.now(), list: list })); } catch (e) { /* 忽略 */ }
      lbState.from = 'net';
      lbState.at = Date.now();
      lbState.loading = false;
      return list;
    });
  }

  function lbCache() {
    try {
      var d = JSON.parse(localStorage.getItem(KEY_LB) || '{}');
      return { at: d.at || 0, list: Array.isArray(d.list) ? d.list : [] };
    } catch (e) { return { at: 0, list: [] }; }
  }

  function lbNick() { return localStorage.getItem(KEY_NICK) || '奶蛙玩家'; }
  function lbSetNick(n) {
    n = String(n || '').replace(/[|\r\n\t]/g, ' ').trim().slice(0, 12) || '奶蛙玩家';
    try { localStorage.setItem(KEY_NICK, n); } catch (e) { /* 忽略 */ }
    return n;
  }
  function lbMine() {
    try { return JSON.parse(localStorage.getItem(KEY_MINE) || '[]'); } catch (e) { return []; }
  }
  function lbAddMine(tag) {
    var m = lbMine();
    m.push(tag);
    try { localStorage.setItem(KEY_MINE, JSON.stringify(m.slice(-30))); } catch (e) { /* 忽略 */ }
  }

  function fmtAgo(ms) {
    if (!ms) return '未知时间';
    var d = Math.max(0, Date.now() - ms) / 1000;
    if (d < 60) return '刚刚';
    if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
    if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
    return Math.floor(d / 86400) + ' 天前';
  }

  function lbRows(list, limit) {
    var mine = lbMine();
    var byTower = list.slice().sort(function (a, b) { return b.tower - a.tower || a.sec - b.sec || b.ts - a.ts; });
    var rankOf = {};
    byTower.forEach(function (e, i) { rankOf[e.tag] = i + 1; });
    var show = (lbSort === 'top' ? byTower : list).slice(0, limit || 20);
    if (!show.length) return '<p class="nw-tip" data-el="lbbox">榜上还没有成绩，做第一个爬塔的人吧 🐸</p>';
    return '<div class="nw-lb" data-el="lbbox">' + show.map(function (e) {
      var r = rankOf[e.tag];
      var medal = r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : '#' + r;
      return '<div class="nw-lb__row' + (mine.indexOf(e.tag) >= 0 ? ' is-mine' : '') + '">'
        + '<span class="nw-lb__rank">' + medal + '</span>'
        + '<b class="nw-lb__tower">' + e.tower + ' 塔</b>'
        + '<span class="nw-lb__meta">' + e.tiles + ' 张 · ' + fmtTime(e.sec * 1000) + '</span>'
        + '<span class="nw-lb__nick">' + esc(e.nick) + '</span>'
        + '<span class="nw-lb__time">' + fmtAgo(e.ts) + '</span>'
        + '</div>';
    }).join('') + '</div>';
  }

  /** 排行榜面板；fetchFirst=true 时先拉网再画（否则先画缓存） */
  function showLeaderboard(fetchFirst) {
    playing = false;
    setHold(true);
    var cache = lbCache();
    var when = lbState.from === 'net' && lbState.at
      ? 'TinyWebDB 实时数据 · 更新于 ' + new Date(lbState.at).toLocaleTimeString()
      : (cache.at ? '离线缓存 · ' + fmtAgo(cache.at) + '（上次连上服务器的时间）' : '正在读取…');
    el.panel.innerHTML = [
      '<h2 class="nw-title nw-title--sm">🏆 无尽模式排行榜</h2>',
      '<p class="nw-sub" data-el="lbsub">' + when + '</p>',
      '<div class="nw-seg">',
      '<button class="nw-seg__btn' + (lbSort === 'new' ? ' is-on' : '') + '" data-lb="new">最新 20 条</button>',
      '<button class="nw-seg__btn' + (lbSort === 'top' ? ' is-on' : '') + '" data-lb="top">最强者</button>',
      '</div>',
      lbRows(cache.list, 20),
      '<div class="nw-actions">',
      '<button class="nw-btn" data-lb="refresh">刷新</button>',
      '<button class="nw-btn nw-btn--ghost" data-run="back-levels">回到选关</button>',
      '</div>',
      '<p class="nw-tip">成绩由玩家自己提交（无尽模式结束后点「上榜」）；昵称存在本机，随时可改。</p>',
    ].join('');
    openOverlay();
    if (fetchFirst) refreshLb();
  }

  function refreshLb() {
    var btn = el.panel.querySelector('[data-lb="refresh"]');
    if (btn) { btn.textContent = '读取中…'; btn.disabled = true; }
    lbFetch().then(function (list) {
      var box = el.panel.querySelector('[data-el="lbbox"]');
      if (box) {
        var tmp = document.createElement('div');
        tmp.innerHTML = lbRows(list, 20);
        box.parentNode.replaceChild(tmp.firstChild, box);
      }
      var sub = el.panel.querySelector('[data-el="lbsub"]');
      if (sub) sub.textContent = 'TinyWebDB 实时数据 · 更新于 ' + new Date().toLocaleTimeString();
      if (btn) { btn.textContent = '刷新'; btn.disabled = false; }
    }).catch(function () {
      lbState.loading = false;
      if (btn) { btn.textContent = '重试'; btn.disabled = false; }
      var sub = el.panel.querySelector('[data-el="lbsub"]');
      if (sub) sub.textContent = '连不上排行榜服务器 · 下面是本机上次看到的数据';
    });
  }

  /** 上榜表单（无尽模式结束后用） */
  function showSubmit() {
    var tower = endless.tower, tiles = endless.tiles;
    var sec = Math.round((performance.now() - endless.startedAt) / 1000);
    playing = false;
    setHold(true);
    el.panel.innerHTML = [
      '<div class="nw-center"><div class="nw-spike">🔥 上榜</div></div>',
      '<h2 class="nw-title nw-title--sm">提交你的爬塔成绩</h2>',
      '<p class="nw-sub">止步第 ' + tower + ' 塔 · 清除 ' + tiles + ' 张 · 总用时 ' + fmtTime(sec * 1000) + '</p>',
      '<div class="nw-form">',
      '<label class="nw-form__row"><span>昵称</span><input class="nw-input" data-el="nick" maxlength="12" value="' + esc(lbNick()) + '" placeholder="最多 12 字" /></label>',
      '</div>',
      '<p class="nw-tip">只上传「塔数 / 清除张数 / 用时 / 昵称」四项，服务器是 TinyWebDB 免费实例。</p>',
      '<div class="nw-actions">',
      '<button class="nw-btn nw-btn--lg" data-lb="send">提交到排行榜</button>',
      '<button class="nw-btn nw-btn--ghost" data-lb="skip">先不提交</button>',
      '</div>',
    ].join('');
    openOverlay();
  }

  function lbSend() {
    var input = el.panel.querySelector('[data-el="nick"]');
    var nick = lbSetNick(input ? input.value : '');
    var tower = endless.tower, tiles = endless.tiles;
    var sec = Math.round((performance.now() - endless.startedAt) / 1000);
    var tag = 'naiwa-' + Math.floor(Date.now() / 1000) + '-' + Math.floor(Math.random() * 9000 + 1000);
    var btn = el.panel.querySelector('[data-lb="send"]');
    if (btn) { btn.textContent = '提交中…'; btn.disabled = true; }
    lbPost({ action: 'update', tag: tag, value: tower + '|' + tiles + '|' + sec + '|' + nick }, 9000)
      .then(function () {
        lbAddMine(tag);
        flash('已上榜：' + tower + ' 塔');
        showLeaderboard(true);
      })
      .catch(function () {
        if (btn) { btn.textContent = '提交失败，点我重试'; btn.disabled = false; }
        flash('提交失败：检查一下网络');
      });
  }

  /* ---------------- 主循环（轻量轮询） ---------------- */
  function tick() {
    applyMuteOnce();
    var api = window.__NAIWA__;
    if (api && el.overlay.hidden) {
      // 游戏自己切关（过关/失败后自动前进）时，把 cur 同步过来并重新挂上验证；
      // 面板开着时不同步——失败后游戏会自己在背后重开第 1 关，别让顶栏跟着乱跳
      var live = api.current();
      if (live >= 1 && live !== cur) { cur = live; armValidation(live); }
    }
    var b = boardCards().length, t = trayCards().length;
    if (b + t > 0) lastSeen = { left: b, tray: t };          // 记住场面，失败时用来报数
    // 本关总牌数只在"托盘为空"时采样：落牌动画期间离场的牌还留在 DOM 里，
    // 直接取 max(b+t) 会把同一张牌数两遍（实测会算出 10 张）
    if (t === 0 && b > dealTotal) {
      dealTotal = b;
      fitBoard();          // 发牌这一刻牌堆最"胖"，此时定缩放比（塔高了也不会顶到 HUD）
    }
    el.left.innerHTML = '剩余 <b>' + (b + t) + '</b>';
    setBar(dealTotal ? (dealTotal - b - t) / dealTotal : 0);
    if (pendingStart && b > 0) { playing = true; pendingStart = false; }
    if (playing) {
      el.time.textContent = fmtTime(performance.now() - startAt);
      if (b === 0 && t === 0) { playing = false; onWin(); }
    }
    runValidator(api);                                       // 发牌后验证可解性，不可解则重发
    lastBoardCount = boardCards().length;
    bgmFadeTick();                                           // 背景音乐音量渐变
  }
  var muteApplied = false;
  function applyMuteOnce() { if (!muteApplied) { muteApplied = true; applyMute(); } }

  function boot() {
    applyMute();
    updateHud();
    showLevels();
    armValidation(cur);            // 游戏自己会先发第 1 关，这里也要验
    bgmEl();                       // 先把 BGM 元素建出来（后台预加载），等第一次交互再放
    setInterval(tick, 200);
    // 第一次真实交互后再起播 BGM（自动播放策略）；切后台暂停、回来续播
    var armBgm = function () {
      if (bgmArmed) return;
      bgmArmed = true;
      bgmPlay();
    };
    document.addEventListener('pointerdown', armBgm, true);
    document.addEventListener('keydown', armBgm, true);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) bgmStop();
      else if (bgmArmed) bgmPlay();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 自动化测试入口（回归脚本要能直接开指定规模的塔、按任意槽位容量判一次可解性）
  window.__NAIWA_START_ENDLESS__ = startEndless;
  window.__NAIWA_JUDGE__ = function (cap) {
    var nodes = readBoardGraph();
    var tray = trayCards().map(function (c) { var i = c.querySelector('img'); return i ? i.getAttribute('alt') : null; }).filter(Boolean);
    var res = judgeLevel(nodes, cap || currentCap(), tray);
    return { tiles: nodes.length, cap: cap || currentCap(), ok: res.ok, maxTray: res.maxTray, reason: res.reason || '' };
  };
  /** 提示：当前局面下"按最优线走"接下来该抓哪几种图案（给玩法提示与自动化测试用）
      返回一整段顺序，而不是单一步：牌堆里有些"可点"的牌会被上两层的牌压住看不见，
      照着顺序找第一张真正点得到的即可。 */
  window.__NAIWA_HINT__ = function () {
    var nodes = readBoardGraph();
    if (!nodes.length) return { ok: false, seq: [], tiles: 0, free: 0 };
    var tray = trayCards().map(function (c) { var i = c.querySelector('img'); return i ? i.getAttribute('alt') : null; }).filter(Boolean);
    var free = nodes.filter(function (n) { return !n.blockers.length; }).length;
    var res = judgeLevel(nodes, currentCap(), tray);
    return {
      ok: res.ok, type: res.ok ? res.first : null, seq: res.ok ? res.seq : [],
      tiles: nodes.length, free: free, tray: tray.length, maxTray: res.maxTray, reason: res.reason || '',
    };
  };
  window.__NAIWA_STATE__ = function () {
    return {
      cur: cur, cap: currentCap(),
      endless: { on: endless.on, tower: endless.tower, tiles: endless.tiles },
      best: progress.endlessBest || 0, unlocked: progress.unlocked,
    };
  };
})();
