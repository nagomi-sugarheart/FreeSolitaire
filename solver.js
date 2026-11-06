/*
 * Klondike solver / deal generator.
 * Cards: id = suit*13 + (rank-1). suit 0♠ 1♥ 2♦ 3♣ (1,2 are red).
 * State:
 *   tab:  7 arrays of card ids (index 0 = bottom)
 *   hid:  number of face-down cards at the bottom of each column
 *   fnd:  4 numbers, top rank on each suit's foundation (0 = empty)
 *   tal:  talon = waste (bottom..top) followed by stock (next drawn first)
 *   p:    number of cards currently in the waste (tal[p-1] is the waste top)
 * Works in the browser main thread, as a Web Worker, and in Node.
 */
(function (root) {
  'use strict';

  var rankOf = function (c) { return (c % 13) + 1; };
  var suitOf = function (c) { return (c / 13) | 0; };
  var isRed = function (c) { var s = (c / 13) | 0; return s === 1 || s === 2; };

  // ---------- random ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Deterministic deal for a given seed (0 .. 2^32-1).
  function deal(seed) {
    var rnd = mulberry32(seed >>> 0);
    var deck = [];
    for (var i = 0; i < 52; i++) deck.push(i);
    for (i = 51; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    var tab = [[], [], [], [], [], [], []], hid = [];
    var k = 0;
    for (var row = 0; row < 7; row++) {
      for (var col = row; col < 7; col++) tab[col].push(deck[k++]);
    }
    for (col = 0; col < 7; col++) hid.push(col);
    // remaining 24 cards: stock. tal order = draw order.
    var tal = deck.slice(k);
    return { tab: tab, hid: hid, fnd: [0, 0, 0, 0], tal: tal, p: 0 };
  }

  function cloneState(s) {
    return {
      tab: s.tab.map(function (c) { return c.slice(); }),
      hid: s.hid.slice(), fnd: s.fnd.slice(), tal: s.tal.slice(), p: s.p
    };
  }

  // positions q (1..n) such that tal[q-1] can become the waste top
  function reachable(n, p, draw) {
    var out = [];
    if (n === 0) return out;
    if (draw === 1) { for (var i = 1; i <= n; i++) out.push(i); return out; }
    var seen = {};
    var add = function (q) { if (q > 0 && !seen[q]) { seen[q] = 1; out.push(q); } };
    add(p);
    var q = p;
    while (q < n) { q = Math.min(q + draw, n); add(q); }
    q = 0;
    while (q < n) { q = Math.min(q + draw, n); add(q); }
    return out;
  }

  function canStack(card, onto) { // card placed on onto in tableau
    return rankOf(onto) === rankOf(card) + 1 && isRed(onto) !== isRed(card);
  }
  function canFound(s, card) { return s.fnd[suitOf(card)] === rankOf(card) - 1; }
  function isSafe(s, card) {
    var r = rankOf(card);
    if (r <= 2) return true;
    if (isRed(card)) return s.fnd[0] >= r - 1 && s.fnd[3] >= r - 1;
    return s.fnd[1] >= r - 1 && s.fnd[2] >= r - 1;
  }

  function stateKey(s, draw) {
    var cols = [];
    for (var i = 0; i < 7; i++) {
      cols.push(String.fromCharCode(48 + s.hid[i]) + String.fromCharCode.apply(null, s.tab[i].map(function (c) { return c + 65; })));
    }
    cols.sort();
    var k = cols.join(',') + '|' + String.fromCharCode.apply(null, s.tal.map(function (c) { return c + 65; }));
    if (draw !== 1) k += '|' + s.p;
    return k;
  }

  // Apply safe foundation moves from tableau tops. Records moves into list.
  function autoPlay(s, list) {
    var moved = true;
    while (moved) {
      moved = false;
      for (var i = 0; i < 7; i++) {
        var col = s.tab[i];
        if (col.length === 0) continue;
        var c = col[col.length - 1];
        if (canFound(s, c) && isSafe(s, c)) {
          col.pop(); s.fnd[suitOf(c)]++;
          if (s.hid[i] >= col.length && s.hid[i] > 0) s.hid[i] = col.length - 1;
          list.push({ t: 'tf', from: i, card: c });
          moved = true;
        }
      }
    }
  }

  function fixHidden(s, i) {
    var col = s.tab[i];
    if (col.length > 0 && s.hid[i] >= col.length) s.hid[i] = col.length - 1;
    if (col.length === 0) s.hid[i] = 0;
  }

  function isWon(s) {
    if (s.tal.length) return false;
    for (var i = 0; i < 7; i++) if (s.hid[i]) return false;
    return true; // everything face-up, no talon -> always finishable
  }

  // Generate candidate moves, ordered by priority.
  function genMoves(s, draw) {
    var moves = [];
    var i, j, col, c;
    // 1. tableau -> foundation
    for (i = 0; i < 7; i++) {
      col = s.tab[i];
      if (!col.length) continue;
      c = col[col.length - 1];
      if (canFound(s, c)) moves.push({ t: 'tf', from: i, card: c, pr: 100 + (col.length === 1 + s.hid[i] && s.hid[i] ? 5 : 0) });
    }
    // 2. tableau -> tableau
    var emptyCol = -1;
    for (i = 0; i < 7; i++) if (!s.tab[i].length) { emptyCol = i; break; }
    for (i = 0; i < 7; i++) {
      col = s.tab[i];
      if (!col.length) continue;
      var h = s.hid[i];
      for (var idx = h; idx < col.length; idx++) {
        c = col[idx];
        var whole = idx === h;
        var useful;
        if (whole) {
          // reveals a hidden card, or empties the column
          if (h > 0) useful = 50 + h;
          else if (rankOf(c) !== 13) useful = 5; // empties a column
          else useful = 0; // king already at base: pointless
        } else {
          // partial move: only if the exposed card can go to foundation
          useful = canFound(s, col[idx - 1]) ? 40 : 0;
        }
        if (!useful) continue;
        for (j = 0; j < 7; j++) {
          if (j === i) continue;
          var dst = s.tab[j];
          if (dst.length) {
            if (canStack(c, dst[dst.length - 1])) moves.push({ t: 'tt', from: i, idx: idx, to: j, card: c, pr: useful + 2 });
          } else if (rankOf(c) === 13 && j === emptyCol) {
            moves.push({ t: 'tt', from: i, idx: idx, to: j, card: c, pr: useful });
          }
        }
      }
    }
    // 3. talon -> foundation / tableau
    var reach = reachable(s.tal.length, s.p, draw);
    for (var r = 0; r < reach.length; r++) {
      var k = reach[r] - 1;
      c = s.tal[k];
      var cost = (k === s.p - 1) ? 3 : 0;
      if (canFound(s, c)) moves.push({ t: 'wf', k: k, card: c, pr: 30 + cost });
      for (j = 0; j < 7; j++) {
        var d = s.tab[j];
        if (d.length) {
          if (canStack(c, d[d.length - 1])) moves.push({ t: 'wt', k: k, to: j, card: c, pr: 20 + cost });
        } else if (rankOf(c) === 13 && j === emptyCol) {
          moves.push({ t: 'wt', k: k, to: j, card: c, pr: 15 + cost });
        }
      }
    }
    // 4. foundation -> tableau (rarely needed)
    for (var su = 0; su < 4; su++) {
      var fr = s.fnd[su];
      if (fr < 3) continue;
      c = su * 13 + fr - 1;
      for (j = 0; j < 7; j++) {
        var d2 = s.tab[j];
        if (d2.length && canStack(c, d2[d2.length - 1])) { moves.push({ t: 'ft', suit: su, to: j, card: c, pr: 1 }); break; }
      }
    }
    moves.sort(function (a, b) { return b.pr - a.pr; });
    return moves;
  }

  function applyMove(s, m) {
    var col;
    switch (m.t) {
      case 'tf':
        s.tab[m.from].pop(); s.fnd[suitOf(m.card)]++; fixHidden(s, m.from); break;
      case 'tt':
        col = s.tab[m.from];
        var seq = col.splice(m.idx);
        for (var q = 0; q < seq.length; q++) s.tab[m.to].push(seq[q]);
        fixHidden(s, m.from); break;
      case 'wf':
        s.tal.splice(m.k, 1); s.p = m.k; s.fnd[suitOf(m.card)]++; break;
      case 'wt':
        s.tal.splice(m.k, 1); s.p = m.k; s.tab[m.to].push(m.card); break;
      case 'ft':
        s.fnd[m.suit]--; s.tab[m.to].push(m.card); break;
    }
  }

  /*
   * Depth-first search with a transposition table.
   * Returns {status:'win'|'fail'|'limit', moves:[...], nodes}
   */
  function solve(initial, draw, maxNodes) {
    draw = draw === 3 ? 3 : 1;
    maxNodes = maxNodes || 200000;
    var seen = new Set();
    var nodes = 0;
    var path = [];
    var limitHit = false;

    function dfs(s) {
      if (++nodes > maxNodes) { limitHit = true; return false; }
      var auto = [];
      autoPlay(s, auto);
      if (isWon(s)) { for (var a = 0; a < auto.length; a++) path.push(auto[a]); return true; }
      var key = stateKey(s, draw);
      if (seen.has(key)) return false;
      seen.add(key);
      var moves = genMoves(s, draw);
      for (var i = 0; i < moves.length; i++) {
        var m = moves[i];
        // avoid immediately undoing a foundation->tableau move etc. handled by seen set
        var ns = cloneState(s);
        applyMove(ns, m);
        var base = path.length;
        for (var b = 0; b < auto.length; b++) path.push(auto[b]);
        path.push(m);
        if (dfs(ns)) return true;
        path.length = base;
        if (limitHit) return false;
      }
      return false;
    }

    var ok = dfs(cloneState(initial));
    return { status: ok ? 'win' : (limitHit ? 'limit' : 'fail'), moves: ok ? path.slice() : null, nodes: nodes };
  }

  // Find a winnable deal, starting at seed and incrementing.
  function findWinnable(seed, draw, maxNodes, maxTries) {
    maxTries = maxTries || 200;
    for (var t = 0; t < maxTries; t++) {
      var sd = (seed + t) >>> 0;
      var r = solve(deal(sd), draw, maxNodes);
      if (r.status === 'win') return { seed: sd, tries: t + 1, solution: r.moves, nodes: r.nodes };
    }
    return null;
  }

  var api = {
    deal: deal, solve: solve, findWinnable: findWinnable, reachable: reachable,
    rankOf: rankOf, suitOf: suitOf, isRed: isRed, cloneState: cloneState, mulberry32: mulberry32
  };

  // Web Worker mode
  if (typeof document === 'undefined' && typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof module === 'undefined') {
    self.onmessage = function (e) {
      var d = e.data || {};
      var res;
      if (d.cmd === 'find') {
        res = findWinnable(d.seed, d.draw, d.maxNodes, d.maxTries);
      } else if (d.cmd === 'solve') {
        res = solve(d.state, d.draw, d.maxNodes);
      }
      self.postMessage({ id: d.id, result: res });
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.KlondikeSolver = api;
})(typeof self !== 'undefined' ? self : this);
