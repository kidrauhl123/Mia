/* ============================================================
   Mia — scrollytelling controller + momentum (inertia) scroll
   ============================================================ */
(function () {
  'use strict';
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------------------------------------------------
     1) PINNED SCROLLYTELLING — active step drives the window
     --------------------------------------------------------- */
  var steps = Array.prototype.slice.call(document.querySelectorAll('.sstep'));
  var scenes = Array.prototype.slice.call(document.querySelectorAll('.sv-scene'));
  var dots = Array.prototype.slice.call(document.querySelectorAll('.sv-progress i'));
  var railBtns = Array.prototype.slice.call(document.querySelectorAll('.sv-rail-btn'));
  var topbar = document.getElementById('svTopbar');
  var workSection = document.getElementById('work');
  var workBg = document.getElementById('workBg');
  var svWindow = document.querySelector('.sv-window');

  // Phantom-style background snap: a FIXED full-viewport tint (no section edge,
  // so there's never a seam). One light theme colour per step.
  var TINTS = [
    '#eee9fa',  // 01 协作 — violet
    '#e6f3ef',  // 02 掌控 — teal
    '#ecebfb',  // 03 随处可用 — indigo
    '#f6f0e3'   // 04 选模型 — amber
  ];

  // per-step window header (name / meta / right badge / avatar)
  var ICON = {
    analyst: '<path d="M5 20V13"/><path d="M10 20V6"/><path d="M15 20v-9"/><path d="M20 20V9"/>',
    coder: '<path d="M9 8l-4 4 4 4"/><path d="M15 8l4 4-4 4"/>',
    sync: '<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>'
  };
  var HEADS = [
    { hue: 'violet', icon: ICON.analyst, name: '改版上线小组', meta: '你 + 3 位 Fellow · 周五前上线', badge: '群聊' },
    { hue: 'teal',   icon: ICON.coder,   name: '小柯 · 工程',  meta: 'Bash · 当前设备运行',     badge: '待允许' },
    { hue: 'indigo', icon: ICON.sync,    name: '多端同步',     meta: '桌面 · 网页 · 手机',       badge: '已同步' },
    { hue: 'amber',  icon: ICON.cpu,     name: '引擎设置',     meta: '按事挑人,自由切换',       badge: '可切换' }
  ];

  function renderHead(i) {
    if (!topbar) return;
    var h = HEADS[i] || HEADS[0];
    topbar.innerHTML =
      '<div class="mw-av av av--' + h.hue + '"><svg viewBox="0 0 24 24">' + h.icon + '</svg></div>' +
      '<div><div class="sv-top-name">' + h.name + '</div>' +
      '<div class="sv-top-meta">' + h.meta + '</div></div>' +
      '<span class="sv-top-id">' + h.badge + '</span>';
  }

  var current = -1;
  function setActive(i) {
    if (i === current) return;
    current = i;
    steps.forEach(function (s, n) { s.classList.toggle('active', n === i); });
    scenes.forEach(function (s, n) { s.classList.toggle('active', n === i); });
    dots.forEach(function (d, n) { d.classList.toggle('on', n === i); });
    // rail highlight: chat icon for 0/1, others for 2/3 (decorative)
    railBtns.forEach(function (b, n) { b.classList.toggle('on', n === Math.min(i, railBtns.length - 1)); });
    if (workSection) workSection.classList.toggle('steps-dark', i === 0);
    if (svWindow) {
      var cm = i >= 2;
      svWindow.classList.toggle('card-mode', cm);
      svWindow.style.background = cm ? (i === 2 ? '#f6efb1' : '#f9dde3') : '';
    }
    renderHead(i);
  }

  function pickActive() {
    if (!steps.length) return;
    var midY = window.innerHeight / 2;
    var best = 0, bestDist = Infinity;
    for (var n = 0; n < steps.length; n++) {
      var r = steps[n].getBoundingClientRect();
      var c = r.top + r.height / 2;
      var d = Math.abs(c - midY);
      if (d < bestDist) { bestDist = d; best = n; }
    }
    setActive(best);
  }

  if (steps.length) {
    window.addEventListener('scroll', pickActive, { passive: true });
    window.addEventListener('resize', pickActive, { passive: true });
    pickActive();
    setTimeout(pickActive, 60);
  }

  /* ---- PINNED HERO SEQUENCE: scrub card (1:1), snap bg, fade heading ---- */
  var track = document.getElementById('heroTrack');
  var heroInner = document.getElementById('heroInner');
  var snapBg = document.getElementById('heroSnapBg');
  var pinHeading = document.getElementById('heroPinHeading');
  function clampv(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function updateSeq() {
    if (reduce || !track) return;
    var ih = window.innerHeight;
    var pinH = track.offsetHeight - ih;                        // total scroll room
    var scrolled = clampv(-track.getBoundingClientRect().top, 0, pinH);

    // 1) card + homepage content move up EXACTLY with the scroll (no inertia, no parallax)
    if (heroInner) heroInner.style.transform = 'translateY(' + (-scrolled) + 'px)';

    var darkOn = ih * 0.92;      // snap to dark once card is ~half off screen

    // 2) instant white -> dark snap; stays dark (the light return happens later,
    //    inside the steps at step 2)
    if (snapBg) snapBg.style.opacity = scrolled >= darkOn ? '1' : '0';

    // 3) heading fades in centre a beat after the snap, then HOLDS (no fade-out)
    if (pinHeading) {
      var fin = clampv((scrolled - (darkOn + ih * 0.18)) / (ih * 0.42), 0, 1);
      pinHeading.style.opacity = fin.toFixed(3);
    }
  }
  // run directly on scroll (the function is a few cheap style writes — no rAF
  // throttle, so it stays exact and never gets stuck)
  window.addEventListener('scroll', updateSeq, { passive: true });
  window.addEventListener('resize', updateSeq, { passive: true });
  updateSeq();

  /* ---------------------------------------------------------
     2) (momentum scroll removed — native scrolling, no wheel hijack)
     --------------------------------------------------------- */

  /* ---------------------------------------------------------
     3) richer reveals (.reveal-up) — fade + rise on enter
     --------------------------------------------------------- */
  var ruIO = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add('in'); ruIO.unobserve(e.target); }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.reveal-up').forEach(function (el) { ruIO.observe(el); });
})();
