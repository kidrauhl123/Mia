/* ============================================================
   Mia — scrollytelling controller + momentum (inertia) scroll
   ============================================================ */
(function () {
  'use strict';
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------------------------------------------------
     0) HERO MASCOT — optional video playback controller. Static or
        self-animated image mascots do not need JS playback.
     --------------------------------------------------------- */
  (function () {
    var m = document.getElementById('heroMascot');
    if (!m) return;
    if (typeof m.play !== 'function') return;
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
  var squadStack = document.getElementById('squadStack');
  var squadFlipStage = squadStack ? squadStack.querySelector('[data-squad-flip-stage]') : null;
  var squadCover = squadStack ? squadStack.querySelector('[data-squad-cover]') : null;
  var squadLayers = squadStack ? Array.prototype.slice.call(squadStack.querySelectorAll('[data-squad-layer]')) : [];
  var squadCards = squadStack ? Array.prototype.slice.call(squadStack.querySelectorAll('[data-squad-card]')) : [];
  var squadNudges = squadStack ? Array.prototype.slice.call(squadStack.querySelectorAll('[data-squad-nudge]')) : [];
  var squadGsap = window.gsap || null;
  var squadRotations = [0.01, -11, 7, -3.82];
  var squadCoverScreens = 1.45;
  var squadExtractLeadScreens = 0.5;
  var squadExtractScreens = 3;
  var squadExitHoldScreens = 0.55;
  var finalFeatureTailScreens = 0.68;
  var squadFlipped = false;
  var squadExtractionWasActive = false;
  if (squadGsap) {
    if (window.ScrollTrigger && typeof squadGsap.registerPlugin === 'function') squadGsap.registerPlugin(window.ScrollTrigger);
    squadGsap.set(squadCards, { rotate: 0 });
    if (squadFlipStage) squadGsap.set(squadFlipStage, { rotateY: 0 });
    if (squadCover) squadGsap.set(squadCover, { y: 0 });
    squadNudges.forEach(function (node, index) {
      var hit = node.parentElement;
      if (!hit) return;
      hit.addEventListener('pointerenter', function (event) {
        if (reduce) return;
        var rect = node.getBoundingClientRect();
        var dx = ((event.clientX - rect.left) / rect.width - 0.5) * -34;
        var dy = ((event.clientY - rect.top) / rect.height - 0.5) * -26;
        squadGsap.killTweensOf(node);
        squadGsap.fromTo(node, { x: dx, y: dy }, { x: 0, y: 0, duration: 1.1, ease: 'elastic.out(1.2, 0.8)' });
      });
    });
  }
  function clampv(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function mapRange(inMin, inMax, outMin, outMax, value) {
    if (inMax === inMin) return outMin;
    return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
  }

  function computeHeroBaseTimings(ih) {
    var heroProduct = document.querySelector('.hero-product');
    var winTop = (heroInner ? heroInner.offsetTop : 0) + (heroProduct ? heroProduct.offsetTop : 0);
    var winH = heroProduct ? heroProduct.offsetHeight : ih * 0.6;
    var darkOn = winTop + winH - ih * 0.5;
    var headIn = darkOn + ih * 0.26;
    var demoStart = headIn + ih * 0.5;
    var whiteOnRaw = demoStart + ih * (squadCoverScreens + squadExtractLeadScreens + squadExtractScreens + squadExitHoldScreens);
    return {
      darkOn: darkOn,
      headIn: headIn,
      demoStart: demoStart,
      whiteOnRaw: whiteOnRaw
    };
  }

  function syncHeroTrackLength() {
    if (reduce || !track) return;
    var ih = window.innerHeight;
    var base = computeHeroBaseTimings(ih);
    var endAt = base.whiteOnRaw + ih * (0.5 + finalFeatureTailScreens);
    track.style.height = Math.ceil(endAt + ih) + 'px';
  }

  function svgNode(name) {
    return document.createElementNS('http://www.w3.org/2000/svg', name);
  }

  function initSquadVizzes() {
    var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-squad-viz]'));
    nodes.forEach(function (node) {
      var type = node.getAttribute('data-squad-viz');
      var svg = svgNode('svg');
      svg.setAttribute('viewBox', '0 0 264 142');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      svg.setAttribute('class', 'squad-viz-' + type);
      node.textContent = '';
      node.appendChild(svg);

      if (type === 'bars') {
        for (var i = 0; i < 26; i++) {
          var rect = svgNode('rect');
          rect.setAttribute('x', String(4 + i * 10));
          rect.setAttribute('y', '18');
          rect.setAttribute('width', '6');
          rect.setAttribute('height', '108');
          rect.setAttribute('rx', '3');
          rect.style.animationDelay = (-i * 0.075).toFixed(3) + 's';
          svg.appendChild(rect);
        }
        return;
      }

      if (type === 'dots') {
        for (var d = 0; d < 40; d++) {
          var dot = svgNode('circle');
          var col = d % 10;
          var row = Math.floor(d / 10);
          dot.setAttribute('cx', String(24 + col * 24));
          dot.setAttribute('cy', String(28 + row * 27));
          dot.setAttribute('r', '4.8');
          dot.style.animationDelay = (-(col * 0.11 + row * 0.14)).toFixed(3) + 's';
          svg.appendChild(dot);
        }
        return;
      }

      if (type === 'orbit') {
        var ringA = svgNode('path');
        ringA.setAttribute('class', 'orbit-ring');
        ringA.setAttribute('d', 'M 80 71 A 52 52 0 0 1 185 43');
        var ringB = svgNode('path');
        ringB.setAttribute('class', 'orbit-ring');
        ringB.setAttribute('d', 'M 176 95 A 44 44 0 0 1 88 112');
        var dotA = svgNode('circle');
        dotA.setAttribute('class', 'orbit-dot');
        dotA.setAttribute('cx', '132');
        dotA.setAttribute('cy', '71');
        dotA.setAttribute('r', '15');
        var dotB = svgNode('circle');
        dotB.setAttribute('class', 'orbit-dot');
        dotB.setAttribute('cx', '178');
        dotB.setAttribute('cy', '34');
        dotB.setAttribute('r', '4.5');
        svg.appendChild(ringA);
        svg.appendChild(ringB);
        svg.appendChild(dotA);
        svg.appendChild(dotB);
        return;
      }

      if (type === 'type') {
        var textNode = svgNode('text');
        var target = node.getAttribute('data-squad-type') || '> mia agent run_';
        var chars = '!<>-_/[]{}=+*?#01';
        var frame = 0;
        var queue = target.split('').map(function (ch) {
          var start = Math.floor(Math.random() * 12);
          return { to: ch, start: start, end: start + 8 + Math.floor(Math.random() * 14), char: '' };
        });
        textNode.setAttribute('x', '0');
        textNode.setAttribute('y', '79');
        svg.appendChild(textNode);
        function typeLoop() {
          var out = '';
          var done = 0;
          queue.forEach(function (item) {
            if (frame >= item.end) {
              done += 1;
              out += item.to;
            } else if (frame >= item.start) {
              if (!item.char || Math.random() < 0.3) item.char = chars[Math.floor(Math.random() * chars.length)];
              out += item.char;
            } else {
              out += ' ';
            }
          });
          textNode.textContent = out;
          frame += 1;
          if (reduce) return;
          if (done < queue.length) {
            window.requestAnimationFrame(typeLoop);
          } else {
            window.setTimeout(function () {
              frame = 0;
              queue.forEach(function (item) { item.char = ''; });
              typeLoop();
            }, 1500);
          }
        }
        typeLoop();
        return;
      }

      if (type === 'ripple') {
        var paths = [];
        var lines = 9;
        var width = 264;
        var height = 142;
        var gap = height / (lines - 1);
        for (var l = 0; l < lines; l++) {
          var path = svgNode('path');
          path.setAttribute('opacity', (0.85 - l * 0.02).toFixed(2));
          svg.appendChild(path);
          paths.push(path);
        }
        function wave(x, line, t) {
          var phase = line * 0.55;
          return (
            7.0 * Math.sin(0.024 * x + t * 0.75 + phase) +
            4.5 * Math.sin(0.013 * x - t * 0.5 + phase * 1.7) +
            2.6 * Math.sin(0.045 * x + t * 1.2 + phase * 0.4) +
            1.8 * Math.sin(0.08 * x - t * 0.95)
          );
        }
        var start = null;
        function rippleLoop(ts) {
          if (start === null) start = ts;
          var t = (ts - start) / 1000;
          for (var r = 0; r < lines; r++) {
            var by = r * gap;
            var data = 'M -10 ' + (by + wave(-10, r, t)).toFixed(2);
            for (var x = 0; x <= width + 10; x += 8) {
              data += ' L ' + x + ' ' + (by + wave(x, r, t)).toFixed(2);
            }
            paths[r].setAttribute('d', data);
          }
          if (!reduce) window.requestAnimationFrame(rippleLoop);
        }
        window.requestAnimationFrame(rippleLoop);
      }
    });
  }
  initSquadVizzes();

  function setSquadFlip(next) {
    if (!squadGsap || !squadFlipStage || !squadCards.length || squadFlipped === next) return;
    squadFlipped = next;
    if (!next) squadExtractionWasActive = false;
    squadGsap.killTweensOf(squadFlipStage);
    squadGsap.to(squadFlipStage, {
      rotateY: next ? 180 : 0,
      duration: reduce ? 0 : 1,
      ease: 'power3.out'
    });
    squadGsap.to(squadCards, {
      rotate: next ? function (index) { return squadRotations[index] || 0; } : 0,
      delay: next && !reduce ? 0.5 : 0,
      duration: reduce ? 0 : (next ? 1.2 : 0.6),
      ease: next ? 'elastic.out(2, 0.8)' : undefined,
      overwrite: true
    });
  }

  function updateSquadCards(scrolled, stackStart, whiteOn, ih) {
    if (!squadGsap || !squadStack || !squadCover || !squadFlipStage || !squadLayers.length || !squadCards.length) return;
    var visible = scrolled >= stackStart && scrolled < whiteOn ? 1 : 0;
    if (heroDemo) heroDemo.style.opacity = visible ? '1' : '0';

    var coverDuration = ih * squadCoverScreens;
    var flipAt = stackStart + coverDuration;
    var coverPhase = clampv((scrolled - stackStart) / coverDuration, 0, 1);
    var startTop = Number.parseFloat(window.getComputedStyle(squadCover).top) || 0;
    var centeredTop = (window.innerHeight - squadCover.offsetHeight) / 2;
    squadGsap.set(squadCover, { y: (centeredTop - startTop) * coverPhase });

    setSquadFlip(scrolled >= flipAt);

    var trackStart = flipAt + ih * squadExtractLeadScreens;
    var trackEnd = trackStart + ih * squadExtractScreens;
    if (scrolled < trackStart) {
      squadLayers.forEach(function (layer) {
        squadGsap.to(layer, {
          yPercent: 0,
          duration: reduce ? 0 : 0.8,
          ease: 'elastic.out(1, 0.5)',
          overwrite: true
        });
      });
      if (squadExtractionWasActive && squadFlipped) {
        squadGsap.to(squadCards, {
          rotate: function (index) { return squadRotations[index] || 0; },
          duration: reduce ? 0 : 0.8,
          ease: 'elastic.out(1, 0.5)',
          overwrite: true
        });
      }
      squadExtractionWasActive = false;
      return;
    }
    squadExtractionWasActive = true;
    var progress = clampv((scrolled - trackStart) / Math.max(1, trackEnd - trackStart), 0, 1);
    squadLayers.forEach(function (layer, index) {
      var phase = clampv(mapRange(index / squadLayers.length, (index + 1.5) / squadLayers.length, 0, 1, progress), 0, 1);
      var direction = Math.sign(squadRotations[index] || 1);
      squadGsap.to(layer, {
        yPercent: -100 * phase,
        duration: reduce ? 0 : 0.8,
        ease: 'elastic.out(1, 0.5)',
        overwrite: true
      });
      squadGsap.to(squadCards[index], {
        rotate: (squadRotations[index] || 0) + phase * 40 * direction,
        duration: reduce ? 0 : 0.8,
        ease: 'elastic.out(1, 0.5)',
        overwrite: true
      });
    });
  }

  function updateSeq() {
    if (reduce || !track) return;
    var ih = window.innerHeight;
    var pinH = track.offsetHeight - ih;                        // total scroll room
    var scrolled = clampv(-track.getBoundingClientRect().top, 0, pinH);

    // 1) hero homepage content scrubs up 1:1 with scroll (no inertia/parallax)
    if (heroInner) heroInner.style.transform = 'translateY(' + (-scrolled) + 'px)';

    // ── snaps fire when the card's BOTTOM edge bisects the screen (at ih/2) ──
    // 1) act-1 window bottom edge reaches mid-screen -> snap DARK
    var baseTimings = computeHeroBaseTimings(ih);
    var darkOn = baseTimings.darkOn;
    var headIn = baseTimings.headIn;                // 2) heading fades in on dark
    var demoStart = baseTimings.demoStart;          // 3) heading holds ALONE, then the card stack enters
    // 4) the card stack keeps JungUI's flip/extract rhythm, but the cover
    //    begins fully below the viewport and gets a longer climb before flip.
    var whiteOn = baseTimings.whiteOnRaw;
    if (whiteOn > pinH - ih) whiteOn = pinH - ih;

    // ── background: white -> dark (#3c315b) -> white ──
    if (snapBg) {
      if (scrolled < darkOn) {
        snapBg.style.opacity = '0';
      } else {
        snapBg.style.opacity = '1';
        snapBg.style.backgroundColor = scrolled >= whiteOn ? '#ffffff' : '#3c315b';
      }
    }

    // ── heading 1: it stays fixed; the cover card rises over it. Once the
    //    card has taken the centre, the heading disappears instead of drifting.
    if (pinHeading) {
      var f1in = clampv((scrolled - headIn) / (ih * 0.24), 0, 1);
      var coveredByCard = scrolled >= demoStart + ih * squadCoverScreens * 0.72;
      pinHeading.style.opacity = coveredByCard ? '0' : f1in.toFixed(3);
      pinHeading.style.transform = 'none';
    }

    // ── Mia work-squad stack: full-viewport stage; internal cards follow the
    //    JungUI Maxima timing instead of the old one-card slide.
    if (heroDemo) {
      if (heroDemo.classList.contains('hero-demo--squad')) {
        heroDemo.style.transform = 'none';
      } else {
        var rise = Math.max(0, scrolled - demoStart);
        heroDemo.style.transform = 'translate(-50%,' + (ih * 0.5 - rise).toFixed(1) + 'px)';
        heroDemo.style.opacity = '1';
      }
    }
    updateSquadCards(scrolled, demoStart, whiteOn, ih);

    // ── heading 2 "多端同步，多模型可选": fades in CENTRED at white, holds ALONE,
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
  syncHeroTrackLength();
  window.addEventListener('scroll', updateSeq, { passive: true });
  window.addEventListener('resize', function () {
    syncHeroTrackLength();
    updateSeq();
  }, { passive: true });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      syncHeroTrackLength();
      updateSeq();
    });
  }
  window.setTimeout(function () {
    syncHeroTrackLength();
    updateSeq();
  }, 120);
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
