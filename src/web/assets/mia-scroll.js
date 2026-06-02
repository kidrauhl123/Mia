/* ============================================================
   Mia — scrollytelling controller + momentum (inertia) scroll
   ============================================================ */
(function () {
  'use strict';
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------------------------------------------------
     0) HERO MASCOT — watercolor logo-formation video. Plays once on
        load; replays when scrolled back into view. Holds last frame.
     --------------------------------------------------------- */
  (function () {
    var m = document.getElementById('heroMascot');
    if (!m) return;
    if (reduce) { try { m.currentTime = m.duration || 0; } catch (e) {} return; }
    var playing = false;
    function play() {
      if (playing) return;
      playing = true;
      try { m.currentTime = 0; } catch (e) {}
      var p = m.play();
      if (p && p.catch) p.catch(function () { playing = false; });
    }
    m.addEventListener('ended', function () { playing = false; });
    m.addEventListener('loadeddata', play);
    if (m.readyState >= 2) play();
    // replay when it re-enters the viewport (only once it has fully left)
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting && !playing) play(); });
    }, { threshold: 0.4 });
    io.observe(m);
  })();

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
    { hue: 'indigo', icon: ICON.sync,    name: '随处可用 · 自由选模型', meta: '多端同步,引擎随你挑', badge: '灵活' }
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
  var MOBILE_BG = ['#f1edfb'];
  function setActive(i) {
    if (i === current) return;
    current = i;
    steps.forEach(function (s, n) { s.classList.toggle('active', n === i); });
    scenes.forEach(function (s, n) { s.classList.toggle('active', n === i); });
    dots.forEach(function (d, n) { d.classList.toggle('on', n === i); });
    // rail highlight: chat icon for 0/1, others for 2/3 (decorative)
    railBtns.forEach(function (b, n) { b.classList.toggle('on', n === Math.min(Math.max(i, 0), railBtns.length - 1)); });
    if (workSection) workSection.classList.remove('steps-dark');
    if (svWindow) {
      svWindow.classList.add('card-mode');
      svWindow.style.background = '#f6f0ff';
    }
    // Mobile: the whole screen snaps to the active step's colour (one fixed
    // step shown at a time → no seam, no dark-text-on-dark). Paint the colour
    // on the #work section itself (in-flow, always renders); i === -1 means
    // we're outside the steps range.
    if (workSection && window.matchMedia('(max-width: 900px)').matches) {
      workSection.style.backgroundColor = i < 0 ? '' : (MOBILE_BG[i] || '#ffffff');
    }
    if (i >= 0) renderHead(i);
  }

  function pickActive() {
    if (!steps.length) return;
    // On narrow screens the colour is a full-screen snap, so switch the active
    // step as soon as its top rises into the upper viewport — that way the
    // background is already the step's colour by the time its content shows
    // (no dark-bg-with-dark-text flash during the transition). On desktop keep
    // the nearest-to-centre logic that drives the sticky window.
    var narrow = window.matchMedia('(max-width: 900px)').matches;
    if (narrow) {
      // fixed-stage model: one step is shown at a time, full-screen, and the
      // whole background snaps to its colour. The .scrolly-steps box is a tall
      // (steps × 100vh) scroll spacer; map the viewport centre through it.
      var cont = steps[0].parentNode;            // .scrolly-steps
      var cr = cont.getBoundingClientRect();
      var vh = window.innerHeight;
      // off only when the steps box is fully out of the viewport; while it
      // overlaps at all, clamp to step 0 on entry / last step on exit so the
      // snap colour runs edge-to-edge (continuous with the hero's dark, no
      // cream flash at the seams).
      if (cr.top > 0 || cr.bottom <= 0) { setActive(-1); return; }
      var seg = cr.height / steps.length;
      var idx = Math.floor((-cr.top) / seg);
      if (idx < 0) idx = 0;
      if (idx > steps.length - 1) idx = steps.length - 1;
      setActive(idx);
      return;
    }
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
  var heroDemo = document.getElementById('heroDemo');
  var pinHeading2 = document.getElementById('heroPinHeading2');
  var heroDemo2 = document.getElementById('heroDemo2');
  function clampv(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function updateSeq() {
    if (reduce || !track) return;
    var ih = window.innerHeight;
    var pinH = track.offsetHeight - ih;                        // total scroll room
    var scrolled = clampv(-track.getBoundingClientRect().top, 0, pinH);

    // 1) hero homepage content scrubs up 1:1 with scroll (no inertia/parallax)
    if (heroInner) heroInner.style.transform = 'translateY(' + (-scrolled) + 'px)';

    var isNarrow = window.matchMedia('(max-width: 900px)').matches;
    var heroProduct = document.querySelector('.hero-product');
    // ── snaps fire when the card's BOTTOM edge bisects the screen (at ih/2) ──
    // 1) act-1 window bottom edge reaches mid-screen -> snap DARK
    var winTop = (heroInner ? heroInner.offsetTop : 0) + (heroProduct ? heroProduct.offsetTop : 0);
    var winH = heroProduct ? heroProduct.offsetHeight : ih * 0.6;
    var darkOn = winTop + winH - ih * 0.5;
    var headIn    = darkOn + ih * 0.26;             // 2) heading fades in on dark
    var demoStart = headIn + ih * 0.5;              // 3) heading holds ALONE, then card enters
    var cardH = heroDemo ? heroDemo.offsetHeight : ih * 0.6;
    // 4) group card rises 1:1; when ITS bottom edge bisects the screen -> snap WHITE
    var whiteOn = demoStart + ih * 0.5 + cardH;
    if (whiteOn > pinH - ih * 0.3) whiteOn = pinH - ih * 0.3;

    // ── background: white -> dark (#3c315b) -> white ──
    if (snapBg) {
      if (scrolled < darkOn) {
        snapBg.style.opacity = '0';
      } else {
        snapBg.style.opacity = '1';
        snapBg.style.backgroundColor = scrolled >= whiteOn ? '#ffffff' : '#3c315b';
      }
    }

    // ── heading 1 "它们分工干活": fades in CENTRED, stays pinned until the group
    //    card has risen to sit a clear GAP below it (never overlapping), then
    //    UN-PINS and rides up 1:1 together with the card ──
    var headH = pinHeading && pinHeading.firstElementChild ? pinHeading.firstElementChild.offsetHeight : ih * 0.12;
    var rel1 = demoStart + (ih * 0.5 - headH * 0.5 - ih * 0.07);  // card top reaches just below heading
    if (pinHeading) {
      var f1in = clampv((scrolled - headIn) / (ih * 0.24), 0, 1);
      pinHeading.style.opacity = f1in.toFixed(3);
      var up1 = Math.max(0, scrolled - rel1);
      pinHeading.style.transform = 'translateY(' + (-up1).toFixed(1) + 'px)';
    }

    // ── group-relay demo card: off-screen until demoStart, then pure 1:1 slide up ──
    if (heroDemo) {
      var rise = Math.max(0, scrolled - demoStart);
      heroDemo.style.transform = 'translate(-50%,' + (ih * 0.5 - rise).toFixed(1) + 'px)';
      heroDemo.style.opacity = '1';
    }

    // ── heading 2 "多端互通,多内核兼容": fades in CENTRED at white, holds ALONE,
    //    then its merged card rises to a gap below it and they ride up together
    //    (mirrors heading 1 + group card) ──
    var demo2Start = whiteOn + ih * 0.5;            // heading2 solo beat, then card2 enters
    var headH2 = pinHeading2 && pinHeading2.firstElementChild ? pinHeading2.firstElementChild.offsetHeight : ih * 0.12;
    var rel2 = demo2Start + (ih * 0.5 - headH2 * 0.5 - ih * 0.07);
    if (pinHeading2) {
      var f2in = clampv((scrolled - whiteOn) / (ih * 0.22), 0, 1);
      pinHeading2.style.opacity = f2in.toFixed(3);
      var up2 = Math.max(0, scrolled - rel2);
      pinHeading2.style.transform = 'translateY(' + (-up2).toFixed(1) + 'px)';
    }
    if (heroDemo2) {
      var rise2 = Math.max(0, scrolled - demo2Start);
      heroDemo2.style.transform = 'translate(-50%,' + (ih * 0.5 - rise2).toFixed(1) + 'px)';
      heroDemo2.style.opacity = '1';
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
