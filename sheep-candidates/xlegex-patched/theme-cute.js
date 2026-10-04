/* ==========================================================================
   奶蛙 · 动效层（theme-cute.js）
   纯外挂脚本，不改动 xlegex 构建产物，靠 DOM 事件 + MutationObserver + WAAPI 生效：

     1. 抓牌：在牌堆里点一张 → 新落进托盘的牌从「被点那张牌的位置」飞进槽位（不是瞬移）
     2. 回退/移出：牌从托盘飞回牌堆原位
     3. 消除：托盘闪光 + 飘出「+3 消除」
     4. 开局：整副牌按层错峰"落桌"入场
     5. 一切动画都遵守 prefers-reduced-motion

   实现要点：
     · 牌堆容器有 CSS transform: scale(1.18/1.24)，而 WAAPI 的 translate 作用在元素局部坐标系，
       所以屏幕位移要除以祖先缩放比（否则飞行距离会放大 1.2 倍）
     · 托盘牌自带 transform: scale(.94)，动画首帧用 scale(1) 才能和牌堆里的 40px 视觉尺寸对齐，
       末帧回到 scale(.94) 与 CSS 无缝衔接
     · Vue 复用/移动节点时 MutationObserver 也会报 add/remove，用 WeakSet 区分"真新增"与"被搬动"
   ========================================================================== */
(function () {
  'use strict';

  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var FLY_MS = 260;          // 飞入时长
  var PENDING_TTL = 700;     // 点击到落牌的匹配窗口(ms)
  var BRIDGE_MS = 200;       // 轻点兜底等待 click 的时间
  var TRAY_SEL = 'div[w-295px]';
  var SLOT_N = 9;            // 托盘槽位数（DOM 里画满 9 个）
  var DANGER_GAP = 2;        // 还剩几格时开始预警

  /** 当前容量：构建产物读 window.__NAIWA_CAP__（无尽模式会调小），这里保持一致 */
  function capNow() {
    var c = Number(window.__NAIWA_CAP__);
    return c >= 3 && c <= SLOT_N ? c : SLOT_N;
  }

  var seen = new WeakSet();      // 已登记过的牌元素
  var pending = null;            // { rect, alt, t } 最近一次点击的牌位
  var trayRemoved = [];          // 最近从托盘被移走的牌位（用于飞回）

  function q(sel, root) { return (root || document).querySelector(sel); }
  function rectOf(el) { try { return el.getBoundingClientRect(); } catch (e) { return null; } }

  /** 祖先缩放比（牌堆容器被整体 scale 过） */
  function ancestorScale(el) {
    try {
      var host = q('#app div[relative][flex-1]');
      if (!host) return 1;
      var t = getComputedStyle(host).transform;
      if (!t || t === 'none') return 1;
      var m = new DOMMatrixReadOnly(t);
      return m.a || 1;
    } catch (e) { return 1; }
  }

  /** 记录被点击的牌位（capture 阶段，先于 Vue 的 @click） */
  function record(ev) {
    try {
      var el = ev.target && ev.target.closest ? ev.target.closest('.card') : null;
      if (!el) return;
      var trayEl = q(TRAY_SEL);
      if (trayEl && trayEl.contains(el)) return;         // 托盘里的牌不算
      var r = rectOf(el);
      if (!r) return;
      pending = { rect: r, alt: (el.querySelector('img') || {}).alt || null, t: Date.now() };
      buzz(9);                                            // 抓牌轻震一下
    } catch (e) { /* 忽略 */ }
  }
  document.addEventListener('pointerdown', record, true);
  document.addEventListener('click', record, true);

  /** 从某处飞进最终位置 */
  function flyIn(el, srcRect) {
    if (REDUCED || !el.animate || !srcRect) return popIn(el);
    var dst = rectOf(el);
    if (!dst) return;
    var s = ancestorScale(el);
    var dx = (srcRect.left - dst.left) / s;
    var dy = (srcRect.top - dst.top) / s;
    // 首帧缩放按"牌堆里那张牌 / 托盘槽位"的真实尺寸比来定：
    // 牌堆在手机上会放大到 1.34~1.8，槽位只有 38px，不补偿就会看到"大牌突然变小小牌"
    var k0 = Math.max(0.6, Math.min(3, (srcRect.width / Math.max(1, dst.width)) / s));
    el.animate([
      { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + k0.toFixed(3) + ') rotate(-7deg)' },
      { transform: 'translate(' + dx * 0.45 + 'px,' + (dy * 0.45 - 20) + 'px) scale(' + (k0 * 0.8 + 0.2).toFixed(3) + ') rotate(3deg)', offset: 0.6 },
      { transform: 'translate(0,0) scale(.94) rotate(0deg)' },
    ], { duration: FLY_MS, easing: 'cubic-bezier(.22,.68,.3,1)' });
    return true;
  }

  /** 兜底：原地弹出（新关卡发牌、脚本点击等） */
  function popIn(el, delay) {
    if (REDUCED || !el.animate) return;
    el.animate([
      { transform: 'translate(0,-14px) scale(.86)', opacity: 0.2 },
      { transform: 'translate(0,0) scale(.94)', opacity: 1 },
    ], { duration: 220, delay: delay || 0, easing: 'cubic-bezier(.3,1.4,.5,1)' });
  }

  /** 回退：从托盘飞回牌堆 */
  function flyBack(el, srcRect) {
    if (REDUCED || !el.animate || !srcRect) return;
    var dst = rectOf(el);
    if (!dst) return;
    var s = ancestorScale(el);
    var dx = (srcRect.left - dst.left) / s;
    var dy = (srcRect.top - dst.top) / s;
    el.animate([
      { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.94) rotate(6deg)' },
      { transform: 'translate(0,0) scale(1) rotate(0deg)' },
    ], { duration: 240, easing: 'cubic-bezier(.3,.9,.3,1)' });
  }

  /* ------------------------------------------------------------------ *
   * 托盘槽位可视化：在木槽里画 9 个凹槽，占用越多越亮，≥7 格开始告警
   * 槽位盒是绝对定位的底板（z-index 低于牌），牌自己 z-index:1 盖在上面
   * ------------------------------------------------------------------ */
  function ensureSlots(trayEl) {
    var box = trayEl.querySelector(':scope > .nw-slots');
    if (box) return box;
    box = document.createElement('div');
    box.className = 'nw-slots';
    for (var i = 0; i < SLOT_N; i++) box.appendChild(document.createElement('i'));
    trayEl.insertBefore(box, trayEl.firstChild);
    return box;
  }

  function syncSlots(trayEl) {
    var box = ensureSlots(trayEl);
    var n = trayEl.querySelectorAll('.card').length;
    var cap = capNow();
    var pips = box.children;
    for (var i = 0; i < pips.length; i++) {
      pips[i].classList.toggle('is-full', i < n);
      pips[i].classList.toggle('is-blocked', i >= cap);      // 本局用不到的槽位（无尽模式会收窄）
    }
    var danger = n >= Math.max(1, cap - DANGER_GAP);
    trayEl.classList.toggle('is-danger', danger);
    trayEl.classList.toggle('is-critical', n >= cap - 1);
    trayEl.setAttribute('data-fill', String(n));
    trayEl.setAttribute('data-cap', String(cap));
    // 明确的文字告警：光靠颜色在高亮牌面上不够醒目
    var tag = trayEl.querySelector(':scope > .nw-slotwarn');
    if (danger) {
      if (!tag) {
        tag = document.createElement('div');
        tag.className = 'nw-slotwarn';
        tag.setAttribute('role', 'status');
        trayEl.appendChild(tag);
      }
      var left = cap - n;
      tag.textContent = left > 1 ? '只剩 ' + left + ' 格！' : left === 1 ? '最后一格！' : '没格子了！';
    } else if (tag) {
      tag.remove();
    }
    return n;
  }

  /** 触感反馈：手机上轻震，桌面端 navigator.vibrate 不存在会自动跳过 */
  function buzz(pattern) {
    try {
      if (localStorage.getItem('naiwa.haptics') === '0') return;
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (e) { /* 忽略 */ }
  }
  window.__NAIWA_BUZZ__ = buzz;

  /** 槽位告警：当占用跨过阈值时震一下（同一个状态只震一次） */
  function watchDanger(trayEl) {
    var last = 0;
    return function (n) {
      var cap = capNow();
      if (n >= Math.max(1, cap - DANGER_GAP) && last < Math.max(1, cap - DANGER_GAP)) buzz([14, 60, 14]);
      if (n >= cap - 1 && last < cap - 1) buzz([22, 50, 22]);
      last = n;
    };
  }

  /** 消除反馈：托盘闪一下 + 飘字 + 粒子 + 触感 */
  function matchFlash() {
    var trayEl = q(TRAY_SEL);
    if (!trayEl) return;
    trayEl.classList.remove('is-match');
    void trayEl.offsetWidth;                 // 强制重排以重放动画
    trayEl.classList.add('is-match');
    setTimeout(function () { trayEl.classList.remove('is-match'); }, 600);
    buzz([16, 40, 16]);
    if (REDUCED) return;
    var tag = document.createElement('div');
    tag.className = 'zw-float';
    tag.textContent = '+3 消除';
    trayEl.appendChild(tag);
    setTimeout(function () { tag.remove(); }, 950);
    burst(trayEl);
  }

  /** 星星粒子：从槽位中心往四周炸开（纯 DOM + WAAPI，无外部资源） */
  function burst(trayEl) {
    if (!trayEl.animate) return;
    var r = rectOf(trayEl);
    if (!r) return;
    var cx = r.width / 2, cy = r.height / 2;
    for (var i = 0; i < 10; i++) {
      var p = document.createElement('span');
      p.className = 'zw-spark';
      var ang = (Math.PI * 2 * i) / 10 + (i % 2 ? 0.3 : 0);
      var dist = 42 + (i % 3) * 22;
      p.style.left = cx + 'px';
      p.style.top = cy + 'px';
      trayEl.appendChild(p);
      p.animate([
        { transform: 'translate(-50%,-50%) scale(.4)', opacity: 1 },
        { transform: 'translate(calc(-50% + ' + Math.cos(ang) * dist + 'px), calc(-50% + ' + Math.sin(ang) * dist + 'px)) scale(1.15)', opacity: 0 },
      ], { duration: 620 + (i % 4) * 60, easing: 'cubic-bezier(.2,.7,.3,1)' }).onfinish = function () { this.effect.target.remove(); };
    }
  }

  function watchTray() {
    var trayEl = q(TRAY_SEL);
    if (!trayEl) return requestAnimationFrame(watchTray);
    var checkDanger = watchDanger(trayEl);
    syncSlots(trayEl);
    new MutationObserver(function (muts) {
      var added = [], removed = 0;
      muts.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes, function (n) {
          if (n.nodeType === 1 && n.classList && n.classList.contains('card')) added.push(n);
        });
        Array.prototype.forEach.call(m.removedNodes, function (n) {
          if (n.nodeType === 1 && n.classList && n.classList.contains('card')) {
            removed++;
            var r = rectOf(n);
            if (r) trayRemoved.push({ rect: r, t: Date.now() });
          }
        });
      });
      trayRemoved = trayRemoved.filter(function (it) { return Date.now() - it.t < 500; });

      added.forEach(function (el, i) {
        var isNew = !seen.has(el);
        seen.add(el);
        if (!isNew) return;                                    // 被 Vue 搬动的老牌，跳过
        var fresh = pending && Date.now() - pending.t < PENDING_TTL;
        var sameAlt = fresh && (!pending.alt || (el.querySelector('img') || {}).alt === pending.alt);
        if (sameAlt) {
          flyIn(el, pending.rect);
          pending = null;
        } else {
          popIn(el, i * 40);
        }
      });

      if (removed >= 3) matchFlash();
      checkDanger(syncSlots(trayEl));
    }).observe(trayEl, { childList: true });
  }

  function watchBoard() {
    var host = q('#app div[relative][flex-1]');
    if (!host) return requestAnimationFrame(watchBoard);
    new MutationObserver(function (muts) {
      var added = [];
      muts.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes, function (n) {
          if (n.nodeType === 1 && n.classList && n.classList.contains('card')) added.push(n);
        });
      });
      var fresh = trayRemoved.filter(function (it) { return Date.now() - it.t < 500; });
      var bulk = added.filter(function (el) { return !seen.has(el); }).length + added.length >= 4;
      added.forEach(function (el, i) {
        var isNew = !seen.has(el);
        seen.add(el);
        if (!isNew) return;
        if (i < fresh.length) flyBack(el, fresh[i].rect);       // 从托盘飞回
        else if (bulk) popIn(el, Math.min(i, 24) * 14);         // 开局发牌：错峰落下
        else popIn(el, i * 40);
      });
      if (fresh.length) trayRemoved = [];
    }).observe(host, { childList: true });
  }

  function start() {
    window.__NAIWA_FX__ = 'on';               // 启动自检标记
    installTapBridge();
    watchTray();
    watchBoard();
  }

  /* ------------------------------------------------------------------ *
   * 手机端"轻点 → click"兜底桥接
   *
   * 背景：游戏只监听 click。某些移动浏览器会把轻点吞掉——
   *   · iOS Safari：元素带 :hover 样式时，第一次轻点只触发 hover，要点第二次才 click
   *     （已在 CSS 里用 @media (hover:hover) and (pointer:fine) 规避）
   *   · 部分安卓 WebView / 小程序容器：touchend 后不补 click
   *   · 图片长按弹系统菜单，反而"长按能选中"
   * 所以这里再兜一层：触摸抬起后若 200ms 内没等到 click，就自己补发一个，
   * 并给补发过的元素打时间戳；真 click 若姗姗来迟则丢弃，保证一次轻点只抓一张牌。
   * ------------------------------------------------------------------ */
  function installTapBridge() {
    if (!window.PointerEvent) return;
    window.__NAIWA_TAPBRIDGE__ = 'on';        // 启动自检标记
    var pending = null;

    function tapTarget(node) {
      if (!node || !node.closest) return null;
      return node.closest('.card, button, [data-act], [data-lv], [data-run], a, .icon-btn');
    }

    function tapLog(msg) { if (window.__NAIWA_TAPLOG__) window.__NAIWA_TAPLOG__.push(msg); }

    document.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse') return;                 // 鼠标不需要兜底
      clearPending();
      pending = { x: e.clientX, y: e.clientY, el: tapTarget(e.target), timer: 0 };
      tapLog('down type=' + e.pointerType + ' target=' + (e.target && e.target.tagName) + ' el=' + (pending.el ? pending.el.className : 'null'));
    }, true);

    document.addEventListener('pointerup', function (e) {
      if (e.pointerType === 'mouse' || !pending || !pending.el) { tapLog('up skipped type=' + e.pointerType + ' pending=' + !!pending + ' el=' + !!(pending && pending.el)); return; }
      var moved = Math.sqrt(Math.pow(e.clientX - pending.x, 2) + Math.pow(e.clientY - pending.y, 2));
      tapLog('up moved=' + Math.round(moved));
      if (moved > 12) { clearPending(); return; }             // 划动/滚动不补发
      var el = pending.el;
      pending.timer = setTimeout(function () {
        pending = null;
        if (!el.isConnected) { tapLog('timer fired 但元素已不在文档里'); return; }
        var ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
        // ★ 必须给事件实例直接挂标记：MouseEvent 的初始化字典会忽略未知字段，
        //   用 { __naiwaSynthetic: true } 传给构造函数是无效的，
        //   会导致下面那个"丢弃迟到 click"的监听器把补发的 click 也一起拦掉
        ev.__naiwaSynthetic = true;
        el.__naiwaBridgedAt = Date.now();
        el.dispatchEvent(ev);
        tapLog('synthetic click dispatched');
      }, BRIDGE_MS);
    }, true);

    document.addEventListener('pointercancel', function () { tapLog('pointercancel'); clearPending(); }, true);

    // 真 click 到达：取消待补发；若这个元素刚被补发过，就把迟到的 click 丢掉，避免抓两张
    document.addEventListener('click', function (e) {
      clearPending();
      if (e.__naiwaSynthetic) return;
      var el = tapTarget(e.target);
      if (el && el.__naiwaBridgedAt && Date.now() - el.__naiwaBridgedAt < 900) {
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    }, true);

    function clearPending() {
      if (pending && pending.timer) clearTimeout(pending.timer);
      pending = null;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
