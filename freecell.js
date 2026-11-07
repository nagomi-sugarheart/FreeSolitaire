(function () {
  'use strict';
  var C = window.Common, F = window.FreeCellSolver;
  var SUITS = C.SUITS;
  var GEN_NODES = 50000, HINT_NODES = 80000;
  var load = C.load, save = C.save, toast = C.toast, fmtTime = C.fmtTime, setPos = C.setPos;
  var $ = function (id) { return document.getElementById(id); };
  var board = $('board');
  var rankOf = F.rankOf, suitOf = F.suitOf;

  var solver = new C.SolverClient('fc-solver.js?v=5', function (msg) {
    return msg.cmd === 'find' ? F.findWinnable(msg.seed, msg.maxNodes, msg.maxTries) : F.solve(msg.state, msg.maxNodes);
  });
  function findDeal(seed) { return solver.run({ cmd: 'find', seed: seed, maxNodes: GEN_NODES, maxTries: 200 }); }
  var prefetch = null;
  function doPrefetch() { if (!prefetch) prefetch = findDeal(C.randomSeed()); }

  // ---------- state ----------
  var stats = load('fc.stats', { played: 0, won: 0, streak: 0, best: 0, bestTime: null, bestMoves: null });
  var game = null, history = [], elapsed = 0, timerOn = false, lastTick = 0;
  var started = false, finished = false, busy = false, autoFinishing = false;

  function persist() {
    if (!game) return;
    save('fc.current', { game: game, history: history.slice(-300), elapsed: elapsed, started: started });
  }

  // ---------- layout ----------
  var L = {};
  function layout() {
    var W = Math.min(window.innerWidth, 1200);
    var gap = Math.max(6, Math.round(W * 0.011));
    var cw = Math.min(110, Math.floor((W - 32 - gap * 7) / 8));
    var ch = Math.round(cw * 1.4);
    L.cw = cw; L.ch = ch; L.gap = gap;
    L.width = cw * 8 + gap * 7;
    L.x = function (i) { return i * (cw + gap); };
    L.tabTop = ch + Math.round(gap * 2);
    var top = board.getBoundingClientRect().top + window.scrollY;
    L.availH = Math.max(ch * 3, window.innerHeight - top - 32);
    document.documentElement.style.setProperty('--cw', cw + 'px');
    document.documentElement.style.setProperty('--ch', ch + 'px');
    board.style.width = L.width + 'px';
    board.style.marginTop = '16px';
  }

  var cardEls = [], slots = {};
  function makeSlot(cls, text) {
    var el = document.createElement('div');
    el.className = 'slot ' + cls;
    if (text) el.textContent = text;
    board.appendChild(el);
    return el;
  }
  function buildDom() {
    slots.cell = []; slots.fnd = []; slots.col = [];
    for (var i = 0; i < 4; i++) slots.cell.push(makeSlot('cell'));
    for (i = 0; i < 4; i++) slots.fnd.push(makeSlot('fnd', SUITS[i]));
    for (i = 0; i < 8; i++) slots.col.push(makeSlot('tab'));
    for (i = 0; i < 52; i++) { cardEls[i] = C.makeCard(i); board.appendChild(cardEls[i]); }
  }

  var where = [], pos = [];
  function place(c, x, y, z) {
    pos[c] = [x, y, z];
    if (cardEls[c].classList.contains('dragging')) return;
    setPos(cardEls[c], x, y, z);
  }

  function render() {
    var i, j, c;
    for (i = 0; i < 4; i++) { setPos(slots.cell[i], L.x(i), 0, 0); setPos(slots.fnd[i], L.x(4 + i), 0, 0); }
    for (i = 0; i < 4; i++) {
      c = game.cells[i];
      if (c >= 0) { where[c] = { type: 'cell', cell: i }; place(c, L.x(i), 0, 1); }
      for (j = 1; j <= game.fnd[i]; j++) {
        c = i * 13 + j - 1;
        where[c] = { type: 'fnd', suit: i, top: j === game.fnd[i] };
        place(c, L.x(4 + i), 0, j);
      }
    }
    var maxBottom = L.tabTop + L.ch;
    for (i = 0; i < 8; i++) {
      var col = game.cols[i];
      setPos(slots.col[i], L.x(i), L.tabTop, 0);
      var up = L.ch * 0.27;
      if (col.length > 1) up = Math.max(L.ch * 0.12, Math.min(up, (L.availH - L.tabTop - L.ch) / (col.length - 1)));
      for (j = 0; j < col.length; j++) {
        c = col[j];
        where[c] = { type: 'col', col: i, idx: j };
        place(c, L.x(i), Math.round(L.tabTop + j * up), 1 + j);
      }
      if (col.length) maxBottom = Math.max(maxBottom, Math.round(L.tabTop + (col.length - 1) * up) + L.ch);
    }
    board.style.height = (maxBottom + 8) + 'px';
    for (c = 0; c < 52; c++) cardEls[c].classList.toggle('movable', !!sourceOf(c));
    updateInfo();
  }

  function updateInfo() {
    $('dealNo').textContent = 'フリーセル #' + game.seed;
    $('moves').textContent = game.moves;
    $('time').textContent = fmtTime(elapsed);
    $('btnUndo').disabled = !history.length || finished;
  }

  // ---------- timer ----------
  setInterval(function () {
    if (timerOn && !document.hidden) {
      var now = Date.now(); elapsed += (now - lastTick) / 1000; lastTick = now;
      $('time').textContent = fmtTime(elapsed);
    }
  }, 250);
  document.addEventListener('visibilitychange', function () { lastTick = Date.now(); if (document.hidden) persist(); });
  window.addEventListener('beforeunload', persist);

  function startTimerIfNeeded() {
    if (!started) { started = true; stats.played++; save('fc.stats', stats); }
    if (!timerOn && !finished) { timerOn = true; lastTick = Date.now(); }
  }

  // ---------- rules on the game state ----------
  // a draggable source for card c, or null
  function sourceOf(c) {
    var w = where[c];
    if (!w) return null;
    if (w.type === 'cell') return { type: 'cell', cell: w.cell };
    if (w.type === 'col') {
      var col = game.cols[w.col];
      for (var k = w.idx + 1; k < col.length; k++) if (!F.canStack(col[k], col[k - 1])) return null;
      return { type: 'col', col: w.col, idx: w.idx };
    }
    return null;
  }
  function cardsOf(src) { return src.type === 'cell' ? [game.cells[src.cell]] : game.cols[src.col].slice(src.idx); }

  // returns '' if OK, otherwise a reason string (or 'x' for silently invalid)
  function checkMove(src, dst) {
    var cards = cardsOf(src);
    if (!cards.length || cards[0] < 0) return 'x';
    var c = cards[0];
    if (dst.type === 'fnd') return cards.length === 1 && F.canFound(game, c) ? '' : 'x';
    if (dst.type === 'cell') {
      if (cards.length !== 1) return 'x';
      if (src.type === 'cell') return 'x';
      return game.cells[dst.cell] < 0 ? '' : 'x';
    }
    if (src.type === 'col' && src.col === dst.col) return 'x';
    var d = game.cols[dst.col];
    if (d.length && !F.canStack(c, d[d.length - 1])) return 'x';
    var cap = F.capacity(game, !d.length);
    if (cards.length > cap) return '一度に動かせるのは' + cap + '枚までです（空きセルや空き列を増やすと増えます）';
    return '';
  }

  function applyMove(src, dst) {
    var cards;
    if (src.type === 'cell') { cards = [game.cells[src.cell]]; game.cells[src.cell] = -1; }
    else cards = game.cols[src.col].splice(src.idx);
    if (dst.type === 'fnd') game.fnd[suitOf(cards[0])]++;
    else if (dst.type === 'cell') game.cells[dst.cell] = cards[0];
    else for (var i = 0; i < cards.length; i++) game.cols[dst.col].push(cards[i]);
    game.moves++;
  }

  // ---------- automatic moves to the foundations (one card at a time) ----------
  var AUTO_STEP_MS = 260;   // pause between automatic moves
  var autoTimer = null;

  // the next card that can safely go to a foundation, or null
  function nextSafe() {
    for (var i = 0; i < 4; i++) {
      var c = game.cells[i];
      if (c >= 0 && F.canFound(game, c) && F.isSafe(game, c)) return { type: 'cell', cell: i, card: c };
    }
    for (i = 0; i < 8; i++) {
      var col = game.cols[i];
      if (col.length && F.canFound(game, col[col.length - 1]) && F.isSafe(game, col[col.length - 1])) return { type: 'col', col: i, idx: col.length - 1, card: col[col.length - 1] };
    }
    return null;
  }
  function toFoundation(src) {
    if (src.type === 'cell') game.cells[src.cell] = -1; else game.cols[src.col].pop();
    game.fnd[suitOf(src.card)]++;
  }
  function glide(c) {
    var el = cardEls[c];
    el.classList.add('slow');
    setTimeout(function () { el.classList.remove('slow'); }, 600);
  }
  // after automatic moves are done: win / auto finish / save
  function afterAuto() {
    render();
    if (F.isWon(game)) onWin();
    else if (allOrdered() && !autoFinishing) autoFinish();
    persist();
  }
  function runAutoSafe() {
    if (autoTimer) return;
    if (!nextSafe()) return afterAuto();
    autoTimer = setTimeout(function step() {
      var src = nextSafe();
      if (!src) { autoTimer = null; return afterAuto(); }
      toFoundation(src);
      glide(src.card);
      render();
      autoTimer = setTimeout(step, AUTO_STEP_MS);
    }, AUTO_STEP_MS * 0.6);
  }
  // the player acts while automatic moves are pending: finish them instantly
  function flushAuto() {
    if (!autoTimer) return;
    clearTimeout(autoTimer); autoTimer = null;
    var src;
    while ((src = nextSafe())) toFoundation(src);
    afterAuto();
  }
  function cancelAuto() { if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; } }

  // every column is an ordered run -> the rest can be finished automatically
  function allOrdered() {
    for (var i = 0; i < 8; i++) {
      var col = game.cols[i];
      for (var k = 1; k < col.length; k++) if (!F.canStack(col[k], col[k - 1])) return false;
    }
    return true;
  }

  function snapshot() { history.push(F.clone(game)); history[history.length - 1].seed = game.seed; history[history.length - 1].moves = game.moves; if (history.length > 1000) history.shift(); }

  function tryMove(src, dst) {
    var why = checkMove(src, dst);
    if (why) { if (why !== 'x') toast(why, 3200); return false; }
    snapshot();
    applyMove(src, dst);
    clearHint();
    startTimerIfNeeded();
    render();
    persist();
    runAutoSafe();
    return true;
  }

  function autoFinish() {
    autoFinishing = true;
    timerOn = false;              // the clock stops: the rest is automatic
    var movesAt = game.moves;     // automatic moves are not counted
    (function step() {
      if (!autoFinishing) return;
      var best = null, br = 99;
      for (var i = 0; i < 4; i++) { var c = game.cells[i]; if (c >= 0 && F.canFound(game, c) && rankOf(c) < br) { br = rankOf(c); best = { type: 'cell', cell: i }; } }
      for (i = 0; i < 8; i++) {
        var col = game.cols[i];
        if (col.length && F.canFound(game, col[col.length - 1]) && rankOf(col[col.length - 1]) < br) { br = rankOf(col[col.length - 1]); best = { type: 'col', col: i, idx: col.length - 1 }; }
      }
      if (!best) { autoFinishing = false; return; }
      var card = best.type === 'cell' ? game.cells[best.cell] : game.cols[best.col][best.idx];
      applyMove(best, { type: 'fnd' });
      game.moves = movesAt;
      glide(card);
      render();
      if (F.isWon(game)) { autoFinishing = false; return onWin(); }
      setTimeout(step, AUTO_STEP_MS * 0.7);
    })();
  }

  function onWin() {
    finished = true; timerOn = false;
    stats.won++; stats.streak++;
    stats.best = Math.max(stats.best, stats.streak);
    var t = Math.floor(elapsed);
    var newBest = stats.bestTime === null || t < stats.bestTime;
    if (newBest) stats.bestTime = t;
    if (stats.bestMoves === null || game.moves < stats.bestMoves) stats.bestMoves = game.moves;
    save('fc.stats', stats);
    save('fc.current', null);
    render();
    C.showWin('fc', game.moves, t, stats, newBest);
    save('fc.stats', stats);
    C.startFx();
    setTimeout(function () { C.showDialog('winDlg'); }, 900);
  }

  function undo() {
    if (!history.length || finished || autoFinishing) return;
    cancelAuto();
    game = history.pop();
    clearHint(); render(); persist();
  }

  // ---------- game flow ----------
  function startGame(seed) {
    C.stopFx();
    cancelAuto();
    var d = F.deal(seed);
    game = { seed: seed >>> 0, cols: d.cols, cells: d.cells, fnd: d.fnd, moves: 0 };
    history = []; elapsed = 0; timerOn = false; started = false; finished = false; autoFinishing = false;
    clearHint();
    for (var c = 0; c < 52; c++) { cardEls[c].classList.add('anim-off'); setPos(cardEls[c], L.width / 2 - L.cw / 2, -L.ch, c); }
    void board.offsetWidth;
    for (c = 0; c < 52; c++) cardEls[c].classList.remove('anim-off');
    render();
    persist();
  }

  function abandonCurrent() {
    if (game && started && !finished) { stats.streak = 0; save('fc.stats', stats); }
  }

  function newGame(opts) {
    if (busy) return;
    opts = opts || {};
    busy = true;
    $('dealNo').textContent = '配置を生成中…';
    var p;
    if (opts.seed !== undefined) p = findDeal(opts.seed);
    else { doPrefetch(); p = prefetch; prefetch = null; }
    p.then(function (res) {
      busy = false;
      if (!res) { toast('配置の生成に失敗しました。もう一度お試しください。'); if (game) updateInfo(); return; }
      abandonCurrent();
      startGame(res.seed);
      if (opts.seed !== undefined && res.seed !== (opts.seed >>> 0)) {
        toast('#' + opts.seed + ' はクリアできることを確認できなかったため、#' + res.seed + ' を配りました', 4500);
      }
      doPrefetch();
    });
  }

  function restart() {
    if (busy) return;
    if (started && !finished && game.moves > 0) abandonCurrent();
    startGame(game.seed);
  }

  // ---------- click: move somewhere sensible ----------
  function autoMove(src) {
    var cards = cardsOf(src);
    if (cards.length === 1 && !checkMove(src, { type: 'fnd' })) return tryMove(src, { type: 'fnd' });
    var start = src.type === 'col' ? src.col : -1, empty = -1, i;
    for (var k = 1; k <= 8; k++) {
      i = (start + k + 8) % 8;
      if (i === start) continue;
      if (!game.cols[i].length) { if (empty < 0) empty = i; continue; }
      if (!checkMove(src, { type: 'col', col: i })) return tryMove(src, { type: 'col', col: i });
    }
    var tooMany = false;
    if (empty >= 0 && !(src.type === 'col' && src.idx === 0)) {
      var why = checkMove(src, { type: 'col', col: empty });
      if (!why) return tryMove(src, { type: 'col', col: empty });
      if (why !== 'x') tooMany = why;
    }
    if (cards.length === 1 && src.type === 'col') {
      for (i = 0; i < 4; i++) if (game.cells[i] < 0) return tryMove(src, { type: 'cell', cell: i });
    }
    if (tooMany) toast(tooMany, 3200);
    return false;
  }

  // ---------- drag ----------
  var drag = null;
  board.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || finished || autoFinishing || !game) return;
    flushAuto();
    if (finished || autoFinishing) return;
    var el = e.target.closest('.card');
    if (!el) return;
    var c = +el.dataset.id, src = sourceOf(c);
    if (!src) return;
    drag = { src: src, cards: cardsOf(src), x0: e.clientX, y0: e.clientY, moved: false, pid: e.pointerId, dx: 0, dy: 0 };
    board.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  board.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.pid) return;
    var dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.moved) {
      if (Math.abs(dx) + Math.abs(dy) < 5) return;
      drag.moved = true;
      clearHint();
      drag.cards.forEach(function (c, i) { cardEls[c].classList.add('dragging', 'anim-off'); cardEls[c].style.zIndex = 1000 + i; });
    }
    drag.dx = dx; drag.dy = dy;
    drag.cards.forEach(function (c) { cardEls[c].style.transform = 'translate(' + (pos[c][0] + dx) + 'px,' + (pos[c][1] + dy) + 'px)'; });
  });
  function endDrag(e, cancel) {
    if (!drag || e.pointerId !== drag.pid) return;
    var d = drag; drag = null;
    if (!d.moved) {
      if (!cancel && !autoMove(d.src)) C.shake(d.cards.map(function (c) { return cardEls[c]; }));
      return;
    }
    d.cards.forEach(function (c) { cardEls[c].classList.remove('dragging', 'anim-off'); });
    if (cancel) { render(); return; }
    var lead = pos[d.cards[0]], rx = lead[0] + d.dx, ry = lead[1] + d.dy;
    var targets = [], i;
    for (i = 0; i < 4; i++) targets.push({ dst: { type: 'cell', cell: i }, x: L.x(i), y: 0, h: L.ch });
    for (i = 0; i < 4; i++) targets.push({ dst: { type: 'fnd' }, x: L.x(4 + i), y: 0, h: L.ch });
    for (i = 0; i < 8; i++) {
      var col = game.cols[i];
      var top = col.length ? pos[col[col.length - 1]][1] : L.tabTop;
      targets.push({ dst: { type: 'col', col: i }, x: L.x(i), y: L.tabTop, h: top - L.tabTop + L.ch });
    }
    var best = null, bestA = 0, reason = '';
    targets.forEach(function (t) {
      var ox = Math.min(rx + L.cw, t.x + L.cw) - Math.max(rx, t.x);
      var oy = Math.min(ry + L.ch, t.y + t.h) - Math.max(ry, t.y);
      if (ox <= 0 || oy <= 0) return;
      var a = ox * Math.min(oy, L.ch);
      var why = checkMove(d.src, t.dst);
      if (why) { if (why !== 'x' && a > bestA) reason = why; return; }
      if (a > bestA) { bestA = a; best = t; }
    });
    if (!best || !tryMove(d.src, best.dst)) { if (!best && reason) toast(reason, 3200); render(); }
  }
  board.addEventListener('pointerup', function (e) { endDrag(e, false); });
  board.addEventListener('pointercancel', function (e) { endDrag(e, true); });

  // ---------- hint ----------
  var hintEls = [], hinting = false;
  function clearHint() { hintEls.forEach(function (el) { el.classList.remove('hint'); delete el.dataset.hint; }); hintEls = []; }
  function addHint(el) { el.classList.add('hint'); el.dataset.hint = hintEls.length ? 'dst' : 'src'; hintEls.push(el); }

  function hint() {
    flushAuto();
    if (finished || autoFinishing || hinting) return;
    clearHint();
    hinting = true;
    var at = game.moves;
    solver.run({ cmd: 'solve', state: { cols: game.cols, cells: game.cells, fnd: game.fnd }, maxNodes: HINT_NODES }).then(function (r) {
      hinting = false;
      if (game.moves !== at || finished) return;
      if (!r || r.status !== 'win') {
        toast(r && r.status === 'fail' ? 'この局面からはクリアできません。「戻す」で前の局面に戻してみてください。' : '有効な手が見つかりませんでした。「戻す」で戻ってみてください。', 4000);
        return;
      }
      var m = r.moves[0];
      if (!m) return;
      addHint(cardEls[m.card]);
      if (m.t === 'cf' || m.t === 'xf') {
        var s = suitOf(m.card);
        addHint(game.fnd[s] ? cardEls[s * 13 + game.fnd[s] - 1] : slots.fnd[s]);
      } else if (m.t === 'cx') {
        var fc = 0; while (game.cells[fc] >= 0) fc++;
        addHint(slots.cell[fc]);
      } else {
        var col = game.cols[m.to];
        addHint(col.length ? cardEls[col[col.length - 1]] : slots.col[m.to]);
      }
    });
  }

  // ---------- menu ----------
  function renderStats() {
    var s = stats;
    var row = function (label, v) { return '<tr><td>' + label + '</td><td>' + v + '</td></tr>'; };
    $('statsBody').innerHTML =
      row('プレイ数', s.played) + row('勝利数', s.won) +
      row('勝率', s.played ? Math.round(s.won / s.played * 100) + '%' : '-') +
      row('現在の連勝', s.streak) + row('最高連勝', s.best) +
      row('ベストタイム', s.bestTime === null ? '-' : fmtTime(s.bestTime)) +
      row('最少手数', s.bestMoves === null ? '-' : s.bestMoves) +
      row('ベストスコア', s.bestScore ? s.bestScore.toLocaleString() + '（' + C.titleOf(s.bestScore).name + '）' : '-');
  }

  $('btnNew').onclick = function () { newGame(); };
  $('btnRestart').onclick = restart;
  $('btnUndo').onclick = undo;
  $('btnHint').onclick = hint;
  $('btnMenu').onclick = function () { renderStats(); $('menu').showModal(); };
  $('btnCloseMenu').onclick = function () { $('menu').close(); };
  $('btnResetStats').onclick = function () {
    if (confirm('成績をすべてリセットしますか？')) {
      stats = { played: 0, won: 0, streak: 0, best: 0, bestTime: null, bestMoves: null };
      save('fc.stats', stats); renderStats();
    }
  };
  $('btnSeed').onclick = function () {
    var v = $('seedInput').value.trim(), n = Number(v);
    if (v === '' || !isFinite(n) || n < 0 || n > 4294967295 || Math.floor(n) !== n) { toast('0〜4294967295 の整数を入力してください'); return; }
    $('menu').close();
    newGame({ seed: n });
  };
  $('btnWinNew').onclick = function () { $('winDlg').close(); newGame(); };

  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || document.querySelector('dialog[open]')) return;
    var k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); undo(); }
    else if (e.ctrlKey || e.metaKey || e.altKey) return;
    else if (k === 'backspace' || k === 'u') { e.preventDefault(); undo(); }
    else if (k === 'n') newGame();
    else if (k === 'h') hint();
  });

  var resizeT;
  window.addEventListener('resize', function () {
    clearTimeout(resizeT);
    resizeT = setTimeout(function () { layout(); if (game) render(); }, 60);
  });

  // ---------- idle glow ----------
  function movableEls() {
    if (!game || finished || autoFinishing || busy || autoTimer) return [];
    var out = [], i, j;
    var useful = function (src) {
      if (cardsOf(src).length === 1 && !checkMove(src, { type: 'fnd' })) return true;
      for (var k = 0; k < 8; k++) {
        if (src.type === 'col' && (k === src.col || (!game.cols[k].length && src.idx === 0))) continue;
        if (!checkMove(src, { type: 'col', col: k })) return true;
      }
      return false;
    };
    for (i = 0; i < 4; i++) if (game.cells[i] >= 0 && useful({ type: 'cell', cell: i })) out.push(cardEls[game.cells[i]]);
    for (i = 0; i < 8; i++) {
      var col = game.cols[i];
      for (j = 0; j < col.length; j++) {
        var c = col[j], src = sourceOf(c);
        if (src && useful(src)) { out.push(cardEls[c]); break; }
      }
    }
    return out;
  }
  var idle = new C.IdleGlow(movableEls);

  // ---------- boot ----------
  layout();
  buildDom();
  var saved = load('fc.current', null);
  if (saved && saved.game && saved.game.cols && !F.isWon(saved.game)) {
    game = saved.game; history = saved.history || []; elapsed = saved.elapsed || 0;
    started = !!saved.started;
    if (started) { timerOn = true; lastTick = Date.now(); }
    render();
    runAutoSafe();
    doPrefetch();
  } else {
    newGame();
  }
})();
