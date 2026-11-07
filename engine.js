/* Klondike game rules (pure logic, no DOM). Shares card encoding with solver.js */
(function (root) {
  'use strict';
  var S = root.KlondikeSolver || (typeof require !== 'undefined' ? require('./solver.js') : null);
  var rankOf = S.rankOf, suitOf = S.suitOf, isRed = S.isRed;

  function create(seed, draw) {
    var d = S.deal(seed);
    return {
      seed: seed >>> 0, draw: draw,
      tab: d.tab, hid: d.hid, fnd: [0, 0, 0, 0],
      stock: d.tal.slice().reverse(), // top of stock = last element
      waste: [], passes: 0, moves: 0
    };
  }

  function clone(g) { return JSON.parse(JSON.stringify(g)); }

  function toSolverState(g) {
    return {
      tab: g.tab.map(function (c) { return c.slice(); }), hid: g.hid.slice(), fnd: g.fnd.slice(),
      tal: g.waste.concat(g.stock.slice().reverse()), p: g.waste.length
    };
  }

  function flipTop(g, i) {
    var col = g.tab[i];
    if (col.length && g.hid[i] >= col.length) { g.hid[i] = col.length - 1; return true; }
    if (!col.length) g.hid[i] = 0;
    return false;
  }

  function canStack(card, onto) { return rankOf(onto) === rankOf(card) + 1 && isRed(onto) !== isRed(card); }
  function canFound(g, card) { return g.fnd[suitOf(card)] === rankOf(card) - 1; }

  // draw from stock (or recycle). returns true if something happened
  function drawStock(g) {
    if (g.stock.length) {
      var n = Math.min(g.draw, g.stock.length);
      for (var i = 0; i < n; i++) g.waste.push(g.stock.pop());
      g.moves++;
      return true;
    }
    if (g.waste.length) {
      g.stock = g.waste.reverse(); g.waste = []; g.passes++; g.moves++;
      return true;
    }
    return false;
  }

  // src: {type:'tab', col, idx} | {type:'waste'} | {type:'fnd', suit}
  // dst: {type:'tab', col} | {type:'fnd'}
  function cardsAt(g, src) {
    if (src.type === 'tab') return g.tab[src.col].slice(src.idx);
    if (src.type === 'waste') return g.waste.length ? [g.waste[g.waste.length - 1]] : [];
    if (src.type === 'fnd') return g.fnd[src.suit] ? [src.suit * 13 + g.fnd[src.suit] - 1] : [];
    return [];
  }

  function canMove(g, src, dst) {
    var cards = cardsAt(g, src);
    if (!cards.length) return false;
    if (src.type === 'tab') {
      if (src.idx < g.hid[src.col]) return false;
      if (dst.type === 'tab' && dst.col === src.col) return false;
    }
    if (src.type === 'fnd' && dst.type === 'fnd') return false;
    var c = cards[0];
    if (dst.type === 'fnd') return cards.length === 1 && canFound(g, c);
    var col = g.tab[dst.col];
    if (!col.length) return rankOf(c) === 13;
    return canStack(c, col[col.length - 1]);
  }

  function doMove(g, src, dst) {
    if (!canMove(g, src, dst)) return false;
    var cards;
    if (src.type === 'tab') { cards = g.tab[src.col].splice(src.idx); flipTop(g, src.col); }
    else if (src.type === 'waste') cards = [g.waste.pop()];
    else { cards = [src.suit * 13 + g.fnd[src.suit] - 1]; g.fnd[src.suit]--; }
    if (dst.type === 'fnd') g.fnd[suitOf(cards[0])]++;
    else for (var i = 0; i < cards.length; i++) g.tab[dst.col].push(cards[i]);
    g.moves++;
    return true;
  }

  function isWon(g) { return g.fnd[0] === 13 && g.fnd[1] === 13 && g.fnd[2] === 13 && g.fnd[3] === 13; }

  // next foundation move for auto finish: smallest rank among tableau tops and the waste top
  function nextFinishMove(g) {
    var best = null, bestRank = 99;
    for (var i = 0; i < 7; i++) {
      var col = g.tab[i];
      if (!col.length) continue;
      var c = col[col.length - 1];
      if (canFound(g, c) && rankOf(c) < bestRank) { bestRank = rankOf(c); best = { type: 'tab', col: i, idx: col.length - 1 }; }
    }
    if (g.waste.length) {
      var w = g.waste[g.waste.length - 1];
      if (canFound(g, w) && rankOf(w) < bestRank) best = { type: 'waste' };
    }
    return best;
  }

  // one step of the automatic finish: a foundation move, or turning the stock
  function finishStep(g) {
    var mv = nextFinishMove(g);
    if (mv) return { kind: 'fnd', src: mv };
    if (g.stock.length || g.waste.length) return { kind: 'draw' };
    return null;
  }

  // Simulate the automatic finish on a copy: true if it reaches a win.
  // (Draw 1 always succeeds once all tableau cards are face up; draw 3 occasionally cannot.)
  function finishWorks(g) {
    var s = clone(g), idle = 0;
    for (var guard = 0; guard < 5000; guard++) {
      if (isWon(s)) return true;
      var st = finishStep(s);
      if (!st) return false;
      if (st.kind === 'fnd') { doMove(s, st.src, { type: 'fnd' }); idle = 0; }
      else {
        drawStock(s);
        // two full passes through the stock without progress -> stuck
        if (++idle > 2 * (Math.ceil((s.stock.length + s.waste.length) / s.draw) + 1)) return false;
      }
    }
    return false;
  }

  // every tableau card is face up (the stock may still have cards)
  function allFaceUp(g) {
    if (isWon(g)) return false;
    for (var i = 0; i < 7; i++) if (g.hid[i]) return false;
    return true;
  }
  function canAutoFinish(g) { return allFaceUp(g) && finishWorks(g); }

  var api = {
    create: create, clone: clone, toSolverState: toSolverState, drawStock: drawStock,
    canMove: canMove, doMove: doMove, cardsAt: cardsAt, isWon: isWon, canFound: canFound,
    canAutoFinish: canAutoFinish, nextFinishMove: nextFinishMove, finishStep: finishStep, allFaceUp: allFaceUp, finishWorks: finishWorks, rankOf: rankOf, suitOf: suitOf, isRed: isRed
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.KlondikeEngine = api;
})(typeof self !== 'undefined' ? self : this);
