(function () {
  'use strict';
  var E = window.KlondikeEngine, S = window.KlondikeSolver;
  var SUITS = ['♠', '♥', '♦', '♣'];
  var RANKS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var GEN_NODES = 20000;   // search budget per candidate deal
  var HINT_NODES = 60000;

  var $ = function (id) { return document.getElementById(id); };
  var board = $('board');

  // ---------- storage (safe) ----------
  function load(key, def) { try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { } }

  // ---------- solver worker ----------
  var worker = null, reqId = 0, pending = {};
  try {
    worker = new Worker('solver.js');
    worker.onmessage = function (e) { var cb = pending[e.data.id]; delete pending[e.data.id]; if (cb) cb(e.data.result); };
    worker.onerror = function () { worker = null; for (var k in pending) { var cb = pending[k]; delete pending[k]; cb(undefined); } };
  } catch (e) { worker = null; }

  function runSolver(msg) {
    return new Promise(function (resolve) {
      var local = function () {
        setTimeout(function () {
          if (msg.cmd === 'find') resolve(S.findWinnable(msg.seed, msg.draw, msg.maxNodes, msg.maxTries));
          else resolve(S.solve(msg.state, msg.draw, msg.maxNodes));
        }, 0);
      };
      if (!worker) return local();
      var id = ++reqId;
      msg.id = id;
      pending[id] = function (r) { if (r === undefined) local(); else resolve(r); };
      worker.postMessage(msg);
    });
  }

  function randomSeed() {
    try { var a = new Uint32Array(1); crypto.getRandomValues(a); return a[0]; }
    catch (e) { return Math.floor(Math.random() * 4294967296); }
  }

  function findDeal(seed, draw) {
    return runSolver({ cmd: 'find', seed: seed, draw: draw, maxNodes: GEN_NODES, maxTries: 500 });
  }

  // prefetched next deals for each mode
  var prefetch = { 1: null, 3: null };
  function doPrefetch(draw) {
    if (prefetch[draw]) return;
    prefetch[draw] = findDeal(randomSeed(), draw);
  }

  // ---------- state ----------
  var settings = load('fs.settings', { draw: 1 });
  var stats = load('fs.stats', {});
  var game = null, history = [], elapsed = 0, timerOn = false, lastTick = 0;
  var started = false, finished = false, busy = false, autoFinishing = false;

  function statFor(d) {
    if (!stats[d]) stats[d] = { played: 0, won: 0, streak: 0, best: 0, bestTime: null, bestMoves: null };
    return stats[d];
  }

  function persist() {
    if (!game) return;
    save('fs.current', { game: game, history: history.slice(-300), elapsed: elapsed, started: started, finished: finished });
  }

  // ---------- layout ----------
  var L = {};
  function layout() {
    var W = Math.min(window.innerWidth, 1200);
    var gap = Math.max(6, Math.round(W * 0.012));
    var cw = Math.min(118, Math.floor((W - 32 - gap * 6) / 7));
    var ch = Math.round(cw * 1.4);
    L.cw = cw; L.ch = ch; L.gap = gap;
    L.width = cw * 7 + gap * 6;
    L.pad = 16;
    L.x = function (i) { return i * (cw + gap); };
    L.tabTop = ch + Math.round(gap * 2);
    var top = board.getBoundingClientRect().top + window.scrollY;
    L.availH = Math.max(ch * 3, window.innerHeight - top - 16 - L.pad);
    document.documentElement.style.setProperty('--cw', cw + 'px');
    document.documentElement.style.setProperty('--ch', ch + 'px');
    board.style.width = L.width + 'px';
    board.style.marginTop = L.pad + 'px';
  }

  // ---------- DOM ----------
  var cardEls = [], slots = {};
  function makeCard(id) {
    var r = E.rankOf(id), s = E.suitOf(id);
    var el = document.createElement('div');
    el.className = 'card ' + (E.isRed(id) ? 'red' : 'black');
    el.dataset.id = id;
    var mid = r > 10 ? '<div class="mid face">' + RANKS[r] + '<i>' + SUITS[s] + '</i></div>' : '<div class="mid">' + SUITS[s] + '</div>';
    el.innerHTML = '<div class="f"><div class="tl">' + RANKS[r] + '<small>' + SUITS[s] + '</small></div><div class="tr">' + SUITS[s] + '</div>' + mid + '</div>';
    return el;
  }
  function makeSlot(cls, text) {
    var el = document.createElement('div');
    el.className = 'slot ' + cls;
    if (text) el.textContent = text;
    board.appendChild(el);
    return el;
  }
  function buildDom() {
    slots.stock = makeSlot('stock');
    slots.waste = makeSlot('waste');
    slots.fnd = [];
    for (var i = 0; i < 4; i++) slots.fnd.push(makeSlot('fnd', SUITS[i]));
    slots.tab = [];
    for (i = 0; i < 7; i++) slots.tab.push(makeSlot('tab', 'K'));
    for (i = 0; i < 52; i++) { cardEls[i] = makeCard(i); board.appendChild(cardEls[i]); }
  }

  // where each card is right now
  var where = [];
  var pos = []; // [x,y,z]

  function setPos(el, x, y, z) {
    el.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    el.style.zIndex = z;
  }

  function render() {
    var i, j, el, c;
    var cw = L.cw, ch = L.ch;
    setPos(slots.stock, L.x(0), 0, 0);
    setPos(slots.waste, L.x(1), 0, 0);
    slots.stock.classList.toggle('done', !game.stock.length && !game.waste.length);
    for (i = 0; i < 4; i++) setPos(slots.fnd[i], L.x(3 + i), 0, 0);
    var maxBottom = L.tabTop + ch;
    // stock
    for (i = 0; i < game.stock.length; i++) {
      c = game.stock[i];
      where[c] = { type: 'stock' };
      place(c, L.x(0), 0, 1 + i, false);
      cardEls[c].classList.add('stockcard');
    }
    // waste
    var wl = game.waste.length;
    var fanStart = game.draw === 3 ? Math.max(0, wl - 3) : wl;
    var fanStep = Math.round(cw * 0.24);
    for (i = 0; i < wl; i++) {
      c = game.waste[i];
      where[c] = { type: 'waste', top: i === wl - 1 };
      var off = i >= fanStart ? (i - fanStart) * fanStep : 0;
      place(c, L.x(1) + off, 0, 1 + i, true);
      cardEls[c].classList.remove('stockcard');
    }
    // foundations
    for (i = 0; i < 4; i++) {
      for (j = 1; j <= game.fnd[i]; j++) {
        c = i * 13 + j - 1;
        where[c] = { type: 'fnd', suit: i, top: j === game.fnd[i] };
        place(c, L.x(3 + i), 0, j, true);
        cardEls[c].classList.remove('stockcard');
      }
    }
    // tableau
    for (i = 0; i < 7; i++) {
      var col = game.tab[i], h = game.hid[i];
      var dn = ch * 0.11, up = ch * 0.27;
      var nUp = Math.max(0, col.length - h - 1);
      var need = h * dn + nUp * up + ch;
      if (need > L.availH - L.tabTop && col.length > 1) {
        var avail = L.availH - L.tabTop - ch;
        dn = Math.min(dn, Math.max(ch * 0.05, ch * 0.08));
        up = Math.max(ch * 0.12, (avail - h * dn) / Math.max(1, nUp));
        up = Math.min(up, ch * 0.27);
      }
      setPos(slots.tab[i], L.x(i), L.tabTop, 0);
      var y = L.tabTop;
      for (j = 0; j < col.length; j++) {
        c = col[j];
        where[c] = { type: 'tab', col: i, idx: j };
        place(c, L.x(i), Math.round(y), 1 + j, j >= h);
        cardEls[c].classList.remove('stockcard');
        y += j < h ? dn : up;
      }
      maxBottom = Math.max(maxBottom, Math.round(y - (col.length ? (col.length - 1 < h ? dn : up) : 0)) + ch);
    }
    board.style.height = (maxBottom + 8) + 'px';
    // movable cursor
    for (c = 0; c < 52; c++) {
      var w = where[c];
      var mov = (w.type === 'tab' && w.idx >= game.hid[w.col]) || ((w.type === 'waste' || w.type === 'fnd') && w.top);
      cardEls[c].classList.toggle('movable', !!mov);
    }
    updateInfo();
  }

  function place(c, x, y, z, faceUp) {
    var el = cardEls[c];
    pos[c] = [x, y, z];
    if (el.classList.contains('dragging')) return;
    setPos(el, x, y, z + (where[c].type === 'tab' ? 0 : 0));
    el.classList.toggle('down', !faceUp);
  }

  function fmtTime(sec) {
    sec = Math.floor(sec);
    var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function updateInfo() {
    $('dealNo').textContent = (game.draw === 3 ? '3枚引き' : '1枚引き') + ' #' + game.seed;
    $('moves').textContent = game.moves;
    $('time').textContent = fmtTime(elapsed);
    $('btnUndo').disabled = !history.length || finished;
  }

  // ---------- timer ----------
  setInterval(function () {
    if (timerOn && !document.hidden) {
      var now = Date.now();
      elapsed += (now - lastTick) / 1000;
      lastTick = now;
      $('time').textContent = fmtTime(elapsed);
    }
  }, 250);
  document.addEventListener('visibilitychange', function () { lastTick = Date.now(); if (document.hidden) persist(); });
  window.addEventListener('beforeunload', persist);

  function startTimerIfNeeded() {
    if (!started) {
      started = true;
      var st = statFor(game.draw);
      st.played++;
      save('fs.stats', stats);
    }
    if (!timerOn && !finished) { timerOn = true; lastTick = Date.now(); }
  }

  // ---------- game flow ----------
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, ms || 2600);
  }

  function abandonCurrent() {
    // a started but unfinished game breaks the streak
    if (game && started && !finished) {
      var st = statFor(game.draw);
      st.streak = 0;
      save('fs.stats', stats);
    }
  }

  function startGame(seed, draw) {
    stopFx();
    game = E.create(seed, draw);
    history = []; elapsed = 0; timerOn = false; started = false; finished = false; autoFinishing = false;
    clearHint();
    // deal animation: collapse all to stock first
    for (var c = 0; c < 52; c++) {
      cardEls[c].classList.add('anim-off');
      setPos(cardEls[c], L.x(0), 0, c);
      cardEls[c].classList.add('down');
    }
    void board.offsetWidth;
    for (c = 0; c < 52; c++) cardEls[c].classList.remove('anim-off');
    render();
    persist();
  }

  function newGame(opts) {
    if (busy) return;
    opts = opts || {};
    var draw = settings.draw;
    busy = true;
    $('dealNo').textContent = '配置を生成中…';
    var p;
    if (opts.seed !== undefined) p = findDeal(opts.seed, draw);
    else { doPrefetch(draw); p = prefetch[draw]; prefetch[draw] = null; }
    p.then(function (res) {
      busy = false;
      if (!res) { toast('配置の生成に失敗しました。もう一度お試しください。'); if (game) updateInfo(); return; }
      abandonCurrent();
      startGame(res.seed, draw);
      if (opts.seed !== undefined && res.seed !== (opts.seed >>> 0)) {
        toast('#' + opts.seed + ' はクリアできることを確認できなかったため、#' + res.seed + ' を配りました', 4500);
      }
      doPrefetch(draw);
    });
  }

  function snapshot() {
    history.push(E.clone(game));
    if (history.length > 1000) history.shift();
  }

  function afterChange() {
    clearHint();
    startTimerIfNeeded();
    render();
    if (E.isWon(game)) return onWin();
    if (E.canAutoFinish(game) && !autoFinishing) autoFinish();
    persist();
  }

  function tryMove(src, dst) {
    if (!E.canMove(game, src, dst)) return false;
    snapshot();
    E.doMove(game, src, dst);
    afterChange();
    return true;
  }

  function clickStock() {
    if (finished || autoFinishing) return;
    if (!game.stock.length && !game.waste.length) return;
    snapshot();
    E.drawStock(game);
    afterChange();
  }

  function undo() {
    if (!history.length || finished || autoFinishing) return;
    game = history.pop();
    clearHint();
    render();
    persist();
  }

  function restart() {
    if (busy) return;
    if (started && !finished && game.moves > 0) abandonCurrent();
    var seed = game.seed, draw = game.draw;
    startGame(seed, draw);
  }

  function autoFinish() {
    autoFinishing = true;
    (function step() {
      if (!autoFinishing) return;
      var mv = E.nextFinishMove(game);
      if (!mv) { autoFinishing = false; return; }
      snapshot();
      E.doMove(game, mv, { type: 'fnd' });
      render();
      if (E.isWon(game)) { autoFinishing = false; return onWin(); }
      setTimeout(step, 90);
    })();
  }

  function onWin() {
    finished = true; timerOn = false;
    var st = statFor(game.draw);
    st.won++; st.streak++;
    st.best = Math.max(st.best, st.streak);
    var t = Math.floor(elapsed);
    var newBest = st.bestTime === null || t < st.bestTime;
    if (newBest) st.bestTime = t;
    if (st.bestMoves === null || game.moves < st.bestMoves) st.bestMoves = game.moves;
    save('fs.stats', stats);
    save('fs.current', null);
    render();
    $('winText').innerHTML = '時間 <b>' + fmtTime(t) + '</b>　手数 <b>' + game.moves + '</b>' +
      (newBest ? '<br>ベストタイム更新！' : '') +
      '<br>連勝 ' + st.streak + '　勝利数 ' + st.won + ' / ' + st.played;
    startFx();
    setTimeout(function () { try { $('winDlg').showModal(); } catch (e) { $('winDlg').setAttribute('open', ''); } }, 900);
  }

  // ---------- auto move on click ----------
  function sourceOf(c) {
    var w = where[c];
    if (w.type === 'tab') return w.idx >= game.hid[w.col] ? { type: 'tab', col: w.col, idx: w.idx } : null;
    if (w.type === 'waste' && w.top) return { type: 'waste' };
    if (w.type === 'fnd' && w.top) return { type: 'fnd', suit: w.suit };
    return null;
  }

  function autoMove(src) {
    var cards = E.cardsAt(game, src);
    if (src.type !== 'fnd' && cards.length === 1 && E.canMove(game, src, { type: 'fnd' })) return tryMove(src, { type: 'fnd' });
    var empty = -1, i;
    var startCol = src.type === 'tab' ? src.col : -1;
    for (var k = 1; k <= 7; k++) {
      i = (startCol + k + 7) % 7;
      if (i === startCol) continue;
      if (!game.tab[i].length) { if (empty < 0) empty = i; continue; }
      if (E.canMove(game, src, { type: 'tab', col: i })) return tryMove(src, { type: 'tab', col: i });
    }
    if (empty >= 0 && !(src.type === 'tab' && src.idx === 0)) {
      if (E.canMove(game, src, { type: 'tab', col: empty })) return tryMove(src, { type: 'tab', col: empty });
    }
    return false;
  }

  function shake(cards) {
    cards.forEach(function (c) {
      var el = cardEls[c];
      el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
    });
  }

  // ---------- drag ----------
  var drag = null;
  board.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || finished || autoFinishing || !game) return;
    var el = e.target.closest('.card, .slot.stock');
    if (!el) return;
    if (el.classList.contains('slot') || where[+el.dataset.id].type === 'stock') { clickStock(); return; }
    var c = +el.dataset.id;
    var src = sourceOf(c);
    if (!src) return;
    var cards = E.cardsAt(game, src);
    drag = { src: src, cards: cards, x0: e.clientX, y0: e.clientY, moved: false, pid: e.pointerId };
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
      drag.cards.forEach(function (c, i) {
        var el = cardEls[c];
        el.classList.add('dragging', 'anim-off');
        el.style.zIndex = 1000 + i;
      });
    }
    drag.dx = dx; drag.dy = dy;
    drag.cards.forEach(function (c) {
      var p = pos[c];
      cardEls[c].style.transform = 'translate(' + (p[0] + dx) + 'px,' + (p[1] + dy) + 'px)';
    });
  });
  function endDrag(e, cancel) {
    if (!drag || e.pointerId !== drag.pid) return;
    var d = drag; drag = null;
    if (!d.moved) {
      if (!cancel && !autoMove(d.src)) shake(d.cards);
      return;
    }
    d.cards.forEach(function (c) { cardEls[c].classList.remove('dragging', 'anim-off'); });
    if (cancel) { render(); return; }
    // find best drop target by overlap
    var lead = pos[d.cards[0]];
    var rx = lead[0] + d.dx, ry = lead[1] + d.dy;
    var targets = [];
    for (var i = 0; i < 4; i++) targets.push({ dst: { type: 'fnd' }, x: L.x(3 + i), y: 0, h: L.ch });
    for (i = 0; i < 7; i++) {
      var col = game.tab[i];
      var top = col.length ? pos[col[col.length - 1]][1] : L.tabTop;
      targets.push({ dst: { type: 'tab', col: i }, x: L.x(i), y: L.tabTop, h: top - L.tabTop + L.ch });
    }
    var best = null, bestA = 0;
    targets.forEach(function (t) {
      var ox = Math.min(rx + L.cw, t.x + L.cw) - Math.max(rx, t.x);
      var oy = Math.min(ry + L.ch, t.y + t.h) - Math.max(ry, t.y);
      if (ox <= 0 || oy <= 0) return;
      var a = ox * Math.min(oy, L.ch);
      if (a > bestA && E.canMove(game, d.src, t.dst)) { bestA = a; best = t; }
    });
    if (!best || !tryMove(d.src, best.dst)) render();
  }
  board.addEventListener('pointerup', function (e) { endDrag(e, false); });
  board.addEventListener('pointercancel', function (e) { endDrag(e, true); });

  // ---------- hint ----------
  var hintEls = [];
  function clearHint() { hintEls.forEach(function (el) { el.classList.remove('hint'); delete el.dataset.hint; }); hintEls = []; }
  function addHint(el) { el.classList.add('hint'); el.dataset.hint = hintEls.length ? 'dst' : 'src'; hintEls.push(el); }
  var hinting = false;

  function hint() {
    if (finished || autoFinishing || hinting) return;
    clearHint();
    hinting = true;
    var snapshotMoves = game.moves;
    runSolver({ cmd: 'solve', state: E.toSolverState(game), draw: game.draw, maxNodes: HINT_NODES }).then(function (r) {
      hinting = false;
      if (game.moves !== snapshotMoves || finished) return;
      if (!r || r.status !== 'win') {
        if (r && r.status === 'fail') toast('この局面からはクリアできません。「戻す」で前の局面に戻してみてください。', 4000);
        else toast('有効な手が見つかりませんでした。「戻す」で戻ってみてください。', 4000);
        return;
      }
      var m = r.moves[0];
      if (!m) { toast('あとは自動で完成します'); return; }
      showHintMove(m);
    });
  }

  function showHintMove(m) {
    var c = m.card;
    if (m.t === 'wf' || m.t === 'wt') {
      var w = where[c];
      if (!(w.type === 'waste' && w.top)) {
        addHint(game.stock.length ? cardEls[game.stock[game.stock.length - 1]] : slots.stock);
        toast('山札をめくりましょう');
        return;
      }
    }
    if (m.t === 'ft') toast('組札のカードを場に戻すと進めます');
    addHint(cardEls[c]);
    if (m.t === 'tf' || m.t === 'wf') {
      var s = E.suitOf(c);
      addHint(game.fnd[s] ? cardEls[s * 13 + game.fnd[s] - 1] : slots.fnd[s]);
    } else {
      var col = game.tab[m.to];
      addHint(col.length ? cardEls[col[col.length - 1]] : slots.tab[m.to]);
    }
  }

  // ---------- win effect ----------
  var fx = $('fx'), fxCtx = fx.getContext('2d'), fxParts = [], fxRun = false;
  function startFx() {
    fx.width = window.innerWidth; fx.height = window.innerHeight;
    fxParts = [];
    var colors = ['#f0c541', '#ffffff', '#e8483b', '#4aa3ff', '#7ee08a'];
    for (var i = 0; i < 160; i++) {
      fxParts.push({ x: Math.random() * fx.width, y: -20 - Math.random() * fx.height * 0.6, vx: (Math.random() - 0.5) * 2,
        vy: 2 + Math.random() * 3, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.3,
        s: 6 + Math.random() * 6, c: colors[i % colors.length] });
    }
    fxRun = true;
    var t0 = Date.now();
    (function frame() {
      if (!fxRun) return;
      fxCtx.clearRect(0, 0, fx.width, fx.height);
      fxParts.forEach(function (p) {
        p.x += p.vx; p.y += p.vy; p.r += p.vr;
        fxCtx.save(); fxCtx.translate(p.x, p.y); fxCtx.rotate(p.r);
        fxCtx.fillStyle = p.c; fxCtx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); fxCtx.restore();
      });
      if (Date.now() - t0 < 6000) requestAnimationFrame(frame); else stopFx();
    })();
  }
  function stopFx() { fxRun = false; fxCtx.clearRect(0, 0, fx.width, fx.height); }

  // ---------- menu / stats ----------
  function renderStats() {
    var a = statFor(1), b = statFor(3);
    var pct = function (s) { return s.played ? Math.round(s.won / s.played * 100) + '%' : '-'; };
    var row = function (label, f) { return '<tr><td>' + label + '</td><td>' + f(a) + '</td><td>' + f(b) + '</td></tr>'; };
    $('statsBody').innerHTML =
      row('プレイ数', function (s) { return s.played; }) +
      row('勝利数', function (s) { return s.won; }) +
      row('勝率', pct) +
      row('現在の連勝', function (s) { return s.streak; }) +
      row('最高連勝', function (s) { return s.best; }) +
      row('ベストタイム', function (s) { return s.bestTime === null ? '-' : fmtTime(s.bestTime); }) +
      row('最少手数', function (s) { return s.bestMoves === null ? '-' : s.bestMoves; });
  }

  // ---------- wiring ----------
  $('btnNew').onclick = function () { newGame(); };
  $('btnRestart').onclick = restart;
  $('btnUndo').onclick = undo;
  $('btnHint').onclick = hint;
  $('drawMode').value = String(settings.draw);
  $('drawMode').onchange = function () {
    settings.draw = +this.value;
    save('fs.settings', settings);
    doPrefetch(settings.draw);
    if (!started || finished) newGame();
    else toast('次のゲームから' + settings.draw + '枚引きになります（「新しいゲーム」ですぐ開始）', 3500);
    this.blur();
  };
  $('btnMenu').onclick = function () { renderStats(); $('menu').showModal(); };
  $('btnCloseMenu').onclick = function () { $('menu').close(); };
  $('btnResetStats').onclick = function () {
    if (confirm('成績をすべてリセットしますか？')) { stats = {}; save('fs.stats', stats); renderStats(); }
  };
  $('btnSeed').onclick = function () {
    var v = $('seedInput').value.trim();
    var n = Number(v);
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
    else if (k === 'd' || k === ' ') { e.preventDefault(); clickStock(); }
  });

  var resizeT;
  window.addEventListener('resize', function () {
    clearTimeout(resizeT);
    resizeT = setTimeout(function () { layout(); if (game) render(); }, 60);
  });

  // ---------- boot ----------
  layout();
  buildDom();
  var saved = load('fs.current', null);
  if (saved && saved.game && !saved.finished && saved.game.tab) {
    game = saved.game; history = saved.history || []; elapsed = saved.elapsed || 0;
    started = !!saved.started; finished = false;
    if (started) { timerOn = true; lastTick = Date.now(); }
    render();
    doPrefetch(settings.draw);
  } else {
    newGame();
  }
})();
