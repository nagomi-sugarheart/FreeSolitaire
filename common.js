/* Shared helpers for both games: storage, card DOM, toast, timer format, solver worker, win effect */
(function (root) {
  'use strict';
  var SUITS = ['♠', '♥', '♦', '♣'];
  var RANKS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var ARTRANK = ['', 'a', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'j', 'q', 'k'];
  var rankOf = function (c) { return (c % 13) + 1; };
  var suitOf = function (c) { return (c / 13) | 0; };
  var isRed = function (c) { var s = (c / 13) | 0; return s === 1 || s === 2; };

  function load(key, def) { try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { } }

  function makeCard(id) {
    var r = rankOf(id), s = suitOf(id);
    var el = document.createElement('div');
    el.className = 'card ' + (isRed(id) ? 'red' : 'black');
    el.dataset.id = id;
    var mid = r > 10 ? '<div class="mid face">' + RANKS[r] + '<i>' + SUITS[s] + '</i></div>' : '<div class="mid">' + SUITS[s] + '</div>';
    el.innerHTML = '<div class="f"><img class="art" src="cards/' + 'SHDC'[s] + ARTRANK[r] + '.svg" alt="' + RANKS[r] + SUITS[s] + '" draggable="false">' +
      '<div class="simple"><div class="tl">' + RANKS[r] + '<small>' + SUITS[s] + '</small></div><div class="tr">' + SUITS[s] + '</div>' + mid + '</div></div>';
    return el;
  }

  function setPos(el, x, y, z) {
    el.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    el.style.zIndex = z;
  }

  function fmtTime(sec) {
    sec = Math.floor(sec);
    var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function toast(msg, ms) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, ms || 2600);
  }

  function randomSeed() {
    try { var a = new Uint32Array(1); crypto.getRandomValues(a); return a[0]; }
    catch (e) { return Math.floor(Math.random() * 4294967296); }
  }

  // Runs solver requests in a Web Worker; falls back to the main thread (e.g. when opened from file://)
  function SolverClient(url, localFn) {
    var self = this;
    this.localFn = localFn; this.reqId = 0; this.pending = {}; this.worker = null;
    try {
      this.worker = new Worker(url);
      this.worker.onmessage = function (e) { var cb = self.pending[e.data.id]; delete self.pending[e.data.id]; if (cb) cb(e.data.result); };
      this.worker.onerror = function () {
        self.worker = null;
        for (var k in self.pending) { var cb = self.pending[k]; delete self.pending[k]; cb(undefined); }
      };
    } catch (e) { this.worker = null; }
  }
  SolverClient.prototype.run = function (msg) {
    var self = this;
    return new Promise(function (resolve) {
      var local = function () { setTimeout(function () { resolve(self.localFn(msg)); }, 0); };
      if (!self.worker) return local();
      var id = ++self.reqId;
      msg.id = id;
      self.pending[id] = function (r) { if (r === undefined) local(); else resolve(r); };
      self.worker.postMessage(msg);
    });
  };

  // confetti on win
  var fx, fxCtx, fxRun = false;
  function startFx() {
    fx = fx || document.getElementById('fx');
    fxCtx = fxCtx || fx.getContext('2d');
    fx.width = window.innerWidth; fx.height = window.innerHeight;
    var parts = [], colors = ['#f0c541', '#ffffff', '#e8483b', '#4aa3ff', '#7ee08a'];
    for (var i = 0; i < 160; i++) {
      parts.push({ x: Math.random() * fx.width, y: -20 - Math.random() * fx.height * 0.6, vx: (Math.random() - 0.5) * 2,
        vy: 2 + Math.random() * 3, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.3,
        s: 6 + Math.random() * 6, c: colors[i % colors.length] });
    }
    fxRun = true;
    var t0 = Date.now();
    (function frame() {
      if (!fxRun) return;
      fxCtx.clearRect(0, 0, fx.width, fx.height);
      parts.forEach(function (p) {
        p.x += p.vx; p.y += p.vy; p.r += p.vr;
        fxCtx.save(); fxCtx.translate(p.x, p.y); fxCtx.rotate(p.r);
        fxCtx.fillStyle = p.c; fxCtx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); fxCtx.restore();
      });
      if (Date.now() - t0 < 6000) requestAnimationFrame(frame); else stopFx();
    })();
  }
  function stopFx() { fxRun = false; if (fxCtx) fxCtx.clearRect(0, 0, fx.width, fx.height); }

  function showDialog(id) {
    var d = document.getElementById(id);
    try { d.showModal(); } catch (e) { d.setAttribute('open', ''); }
  }

  function shake(els) {
    els.forEach(function (el) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); });
  }

  // card design: 'classic' (illustrated SVG cards) or 'simple' (large text)
  function applyCardStyle(v) {
    document.documentElement.classList.toggle('classic', v !== 'simple');
  }
  // block the right-click menu (it is easy to hit by mistake while playing); keep it in text boxes
  document.addEventListener('contextmenu', function (e) {
    var t = e.target;
    if (t && t.closest && t.closest('input, textarea')) return;
    e.preventDefault();
  });

  var cardStyle = load('fs.cardStyle', 'classic');
  applyCardStyle(cardStyle);
  document.addEventListener('DOMContentLoaded', function () {
    var sel = document.getElementById('cardStyle');
    if (!sel) return;
    sel.value = cardStyle;
    sel.onchange = function () { cardStyle = sel.value; save('fs.cardStyle', cardStyle); applyCardStyle(cardStyle); };
  });

  root.Common = {
    SUITS: SUITS, RANKS: RANKS, rankOf: rankOf, suitOf: suitOf, isRed: isRed,
    load: load, save: save, makeCard: makeCard, setPos: setPos, fmtTime: fmtTime, toast: toast,
    randomSeed: randomSeed, SolverClient: SolverClient, startFx: startFx, stopFx: stopFx,
    showDialog: showDialog, shake: shake
  };
})(window);
