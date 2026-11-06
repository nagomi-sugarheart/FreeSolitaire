/*
 * FreeCell rules + solver / deal generator.
 * Cards: id = suit*13 + (rank-1). suit 0♠ 1♥ 2♦ 3♣ (1,2 are red).
 * State: { cols: 8 arrays (index 0 = bottom), cells: 4 entries (card or -1), fnd: 4 ranks }
 * Works in the browser main thread, as a Web Worker, and in Node.
 */
(function (root) {
  'use strict';

  var rankOf = function (c) { return (c % 13) + 1; };
  var suitOf = function (c) { return (c / 13) | 0; };
  var isRed = function (c) { var s = (c / 13) | 0; return s === 1 || s === 2; };

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Deterministic deal for a seed (0 .. 2^32-1). Salted so it differs from Klondike's shuffle.
  function deal(seed) {
    var rnd = mulberry32((seed ^ 0x5F3C11A7) >>> 0);
    var deck = [];
    for (var i = 0; i < 52; i++) deck.push(i);
    for (i = 51; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    var cols = [[], [], [], [], [], [], [], []];
    for (i = 0; i < 52; i++) cols[i % 8].push(deck[i]);
    return { cols: cols, cells: [-1, -1, -1, -1], fnd: [0, 0, 0, 0] };
  }

  function clone(s) {
    return { cols: s.cols.map(function (c) { return c.slice(); }), cells: s.cells.slice(), fnd: s.fnd.slice() };
  }

  function canStack(card, onto) { return rankOf(onto) === rankOf(card) + 1 && isRed(onto) !== isRed(card); }
  function canFound(s, card) { return s.fnd[suitOf(card)] === rankOf(card) - 1; }
  function isSafe(s, card) {
    var r = rankOf(card);
    if (r <= 2) return true;
    if (isRed(card)) return s.fnd[0] >= r - 1 && s.fnd[3] >= r - 1;
    return s.fnd[1] >= r - 1 && s.fnd[2] >= r - 1;
  }
  function freeCells(s) { var n = 0; for (var i = 0; i < 4; i++) if (s.cells[i] < 0) n++; return n; }
  function emptyCols(s) { var n = 0; for (var i = 0; i < 8; i++) if (!s.cols[i].length) n++; return n; }
  // how many cards can move at once (supermove), given destination column empty or not
  function capacity(s, toEmpty) {
    var e = emptyCols(s) - (toEmpty ? 1 : 0);
    return (freeCells(s) + 1) * Math.pow(2, Math.max(0, e));
  }
  // index where the movable ordered run at the top of a column starts
  function runStart(col) {
    var i = col.length - 1;
    while (i > 0 && canStack(col[i], col[i - 1])) i--;
    return i;
  }
  function isWon(s) { return s.fnd[0] + s.fnd[1] + s.fnd[2] + s.fnd[3] === 52; }

  // Move descriptors:
  //  {t:'cf', from}           column top -> foundation
  //  {t:'xf', cell}           cell -> foundation
  //  {t:'cc', from, idx, to}  column run (from idx) -> column
  //  {t:'cx', from, cell}     column top -> cell
  //  {t:'xc', cell, to}       cell -> column
  function apply(s, m) {
    var c;
    switch (m.t) {
      case 'cf': c = s.cols[m.from].pop(); s.fnd[suitOf(c)]++; break;
      case 'xf': c = s.cells[m.cell]; s.cells[m.cell] = -1; s.fnd[suitOf(c)]++; break;
      case 'cc':
        var run = s.cols[m.from].splice(m.idx);
        for (var i = 0; i < run.length; i++) s.cols[m.to].push(run[i]);
        break;
      case 'cx': s.cells[m.cell] = s.cols[m.from].pop(); break;
      case 'xc': s.cols[m.to].push(s.cells[m.cell]); s.cells[m.cell] = -1; break;
    }
  }

  function autoPlay(s, list) {
    var moved = true;
    while (moved) {
      moved = false;
      for (var i = 0; i < 4; i++) {
        var c = s.cells[i];
        if (c >= 0 && canFound(s, c) && isSafe(s, c)) {
          var m = { t: 'xf', cell: i, card: c }; apply(s, m); list.push(m); moved = true;
        }
      }
      for (i = 0; i < 8; i++) {
        var col = s.cols[i];
        if (!col.length) continue;
        c = col[col.length - 1];
        if (canFound(s, c) && isSafe(s, c)) {
          m = { t: 'cf', from: i, card: c }; apply(s, m); list.push(m); moved = true;
        }
      }
    }
  }

  function key(s) {
    var cols = [];
    for (var i = 0; i < 8; i++) cols.push(String.fromCharCode.apply(null, s.cols[i].map(function (c) { return c + 65; })));
    cols.sort();
    var cells = s.cells.filter(function (c) { return c >= 0; }).sort(function (a, b) { return a - b; });
    return cols.join(',') + '|' + String.fromCharCode.apply(null, cells.map(function (c) { return c + 65; }));
  }

  function heuristic(s) {
    var found = s.fnd[0] + s.fnd[1] + s.fnd[2] + s.fnd[3];
    var h = (52 - found) * 3;
    // depth of the next needed card of each suit
    for (var i = 0; i < 8; i++) {
      var col = s.cols[i];
      for (var j = 0; j < col.length; j++) {
        var c = col[j];
        if (rankOf(c) === s.fnd[suitOf(c)] + 1) h += (col.length - 1 - j);
        if (j > 0 && !canStack(c, col[j - 1])) h += 2;
      }
    }
    h += (4 - freeCells(s));
    h -= emptyCols(s) * 2;
    return h;
  }

  function genMoves(s) {
    var out = [];
    var i, j, col, c;
    var fc = -1;
    for (i = 0; i < 4; i++) if (s.cells[i] < 0) { fc = i; break; }
    var firstEmpty = -1;
    for (i = 0; i < 8; i++) if (!s.cols[i].length) { firstEmpty = i; break; }
    // to foundation
    for (i = 0; i < 4; i++) { c = s.cells[i]; if (c >= 0 && canFound(s, c)) out.push({ t: 'xf', cell: i, card: c }); }
    for (i = 0; i < 8; i++) { col = s.cols[i]; if (col.length && canFound(s, col[col.length - 1])) out.push({ t: 'cf', from: i, card: col[col.length - 1] }); }
    // column runs -> column
    for (i = 0; i < 8; i++) {
      col = s.cols[i];
      if (!col.length) continue;
      var rs = runStart(col);
      for (j = 0; j < 8; j++) {
        if (j === i) continue;
        var dst = s.cols[j];
        if (dst.length) {
          var top = dst[dst.length - 1];
          // exactly one card of the run fits on top
          for (var k = rs; k < col.length; k++) {
            if (canStack(col[k], top)) {
              if (col.length - k <= capacity(s, false)) out.push({ t: 'cc', from: i, idx: k, to: j, card: col[k] });
              break;
            }
          }
        } else if (j === firstEmpty) {
          var cap = capacity(s, true);
          for (k = Math.max(rs, col.length - cap); k < col.length; k++) {
            if (k === 0) continue; // moving whole column into an empty column is pointless
            out.push({ t: 'cc', from: i, idx: k, to: j, card: col[k] });
          }
        }
      }
    }
    // cell -> column
    for (i = 0; i < 4; i++) {
      c = s.cells[i];
      if (c < 0) continue;
      for (j = 0; j < 8; j++) {
        var d = s.cols[j];
        if (d.length ? canStack(c, d[d.length - 1]) : j === firstEmpty) out.push({ t: 'xc', cell: i, to: j, card: c });
      }
    }
    // column -> cell
    if (fc >= 0) {
      for (i = 0; i < 8; i++) {
        col = s.cols[i];
        if (col.length) out.push({ t: 'cx', from: i, cell: fc, card: col[col.length - 1] });
      }
    }
    return out;
  }

  // binary heap keyed on .f
  function Heap() { this.a = []; }
  Heap.prototype.push = function (x) {
    var a = this.a; a.push(x); var i = a.length - 1;
    while (i > 0) { var p = (i - 1) >> 1; if (a[p].f <= x.f) break; a[i] = a[p]; i = p; }
    a[i] = x;
  };
  Heap.prototype.pop = function () {
    var a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      var i = 0, n = a.length;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, m = i;
        var mv = last;
        if (l < n && a[l].f < mv.f) { m = l; mv = a[l]; }
        if (r < n && a[r].f < mv.f) { m = r; }
        if (m === i) break;
        a[i] = a[m]; i = m;
      }
      a[i] = last;
    }
    return top;
  };

  /* Greedy best-first search. Returns {status:'win'|'fail'|'limit', moves, nodes} */
  function solve(initial, maxNodes) {
    maxNodes = maxNodes || 100000;
    var start = clone(initial);
    var auto0 = [];
    autoPlay(start, auto0);
    if (isWon(start)) return { status: 'win', moves: auto0, nodes: 0 };
    var seen = new Set([key(start)]);
    var heap = new Heap();
    heap.push({ s: start, f: heuristic(start), parent: null, moves: auto0, g: 0 });
    var nodes = 0;
    while (heap.a.length) {
      if (++nodes > maxNodes) return { status: 'limit', moves: null, nodes: nodes };
      var node = heap.pop();
      var ms = genMoves(node.s);
      for (var i = 0; i < ms.length; i++) {
        var ns = clone(node.s);
        apply(ns, ms[i]);
        var seq = [ms[i]];
        autoPlay(ns, seq);
        if (isWon(ns)) {
          var path = seq;
          for (var n = node; n; n = n.parent) path = n.moves.concat(path);
          return { status: 'win', moves: path, nodes: nodes };
        }
        var k = key(ns);
        if (seen.has(k)) continue;
        seen.add(k);
        heap.push({ s: ns, f: heuristic(ns) + (node.g + 1) * 0.5, parent: node, moves: seq, g: node.g + 1 });
      }
    }
    return { status: 'fail', moves: null, nodes: nodes };
  }

  function findWinnable(seed, maxNodes, maxTries) {
    maxTries = maxTries || 100;
    for (var t = 0; t < maxTries; t++) {
      var sd = (seed + t) >>> 0;
      var r = solve(deal(sd), maxNodes);
      if (r.status === 'win') return { seed: sd, tries: t + 1, nodes: r.nodes, length: r.moves.length };
    }
    return null;
  }

  var api = {
    deal: deal, clone: clone, solve: solve, findWinnable: findWinnable, apply: apply,
    canStack: canStack, canFound: canFound, isSafe: isSafe, capacity: capacity, freeCells: freeCells,
    emptyCols: emptyCols, isWon: isWon, rankOf: rankOf, suitOf: suitOf, isRed: isRed
  };

  if (typeof document === 'undefined' && typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof module === 'undefined') {
    self.onmessage = function (e) {
      var d = e.data || {}, res;
      if (d.cmd === 'find') res = findWinnable(d.seed, d.maxNodes, d.maxTries);
      else if (d.cmd === 'solve') res = solve(d.state, d.maxNodes);
      self.postMessage({ id: d.id, result: res });
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FreeCellSolver = api;
})(typeof self !== 'undefined' ? self : this);
