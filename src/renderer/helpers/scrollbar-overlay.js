// Scrollbar overlay module
// Extracted from app.js (formerly lines 17-20 + 407-556). Pure DOM/event
// helpers for the custom scrollbar overlay that appears next to scrollable
// areas. No state/els dependencies — fully self-contained.
//
// Exposed methods are read by chat/scroll event listeners in app.js; no init
// needed since the module owns its own DOM element and state.
(function () {
  "use strict";

  const scrollbarTimers = new WeakMap();
  let scrollbarOverlayEl = null;
  let scrollbarOverlayTarget = null;
  let scrollbarDrag = null;

  function ensureScrollbarOverlay() {
    if (scrollbarOverlayEl) return scrollbarOverlayEl;
    scrollbarOverlayEl = document.createElement("div");
    scrollbarOverlayEl.className = "scrollbar-overlay";
    scrollbarOverlayEl.addEventListener("pointerdown", startScrollbarOverlayDrag);
    scrollbarOverlayEl.addEventListener("pointerenter", () => {
      const target = scrollbarOverlayTarget;
      if (!target) return;
      const previous = scrollbarTimers.get(target);
      if (previous) {
        window.clearTimeout(previous);
        scrollbarTimers.delete(target);
      }
      target.classList.add("scrollbar-visible", "scrollbar-active");
      updateScrollbarOverlay(target);
    });
    scrollbarOverlayEl.addEventListener("pointerleave", () => {
      if (scrollbarDrag?.active) return;
      const target = scrollbarOverlayTarget;
      if (!target) return;
      scheduleScrollbarHide(target, 500);
    });
    document.body.appendChild(scrollbarOverlayEl);
    return scrollbarOverlayEl;
  }

  function scrollbarOverlayMetrics(target) {
    if (!(target instanceof Element)) return;
    const maxScroll = target.scrollHeight - target.clientHeight;
    if (maxScroll <= 0) return;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const trackInset = 3;
    const trackHeight = Math.max(0, rect.height - trackInset * 2);
    const thumbHeight = Math.max(28, Math.min(trackHeight, (target.clientHeight / target.scrollHeight) * trackHeight));
    const travel = Math.max(0, trackHeight - thumbHeight);
    return { rect, maxScroll, trackInset, trackHeight, thumbHeight, travel };
  }

  function updateScrollbarOverlay(target) {
    const metrics = scrollbarOverlayMetrics(target);
    if (!metrics) return;
    const { rect, maxScroll, trackInset, thumbHeight, travel } = metrics;
    const overlay = ensureScrollbarOverlay();
    const thumbTop = rect.top + trackInset + (target.scrollTop / maxScroll) * travel;
    const thumbLeft = rect.right - 10;

    overlay.style.height = `${thumbHeight}px`;
    overlay.style.transform = `translate3d(${Math.round(thumbLeft)}px, ${Math.round(thumbTop)}px, 0)`;
    overlay.classList.add("visible");
    scrollbarOverlayTarget = target;
  }

  function hideScrollbarOverlay(target) {
    if (scrollbarDrag?.active) return;
    if (target && scrollbarOverlayTarget !== target) return;
    if (!scrollbarOverlayEl) return;
    scrollbarOverlayEl.classList.remove("visible");
    scrollbarOverlayTarget = null;
  }

  function scheduleScrollbarHide(target, delay = 850) {
    if (!(target instanceof Element)) return;
    const previous = scrollbarTimers.get(target);
    if (previous) window.clearTimeout(previous);
    scrollbarTimers.set(target, window.setTimeout(() => {
      if (scrollbarDrag?.active && scrollbarDrag.target === target) return;
      if (target.matches(":hover") || scrollbarOverlayEl?.matches(":hover")) return;
      target.classList.remove("scrollbar-visible");
      target.classList.remove("scrollbar-active");
      scrollbarTimers.delete(target);
      hideScrollbarOverlay(target);
    }, delay));
  }

  function showScrollingScrollbar(target) {
    if (!(target instanceof Element)) return;
    if (target === document.documentElement || target === document.body) return;
    if (target.scrollHeight <= target.clientHeight && target.scrollWidth <= target.clientWidth) return;
    updateScrollbarOverlay(target);
    target.classList.add("scrollbar-visible");
    target.classList.add("scrollbar-active");
    scheduleScrollbarHide(target);
  }

  function scrollableAncestor(node) {
    let current = node instanceof Element ? node : node?.parentElement;
    while (current && current !== document.body && current !== document.documentElement) {
      const style = window.getComputedStyle(current);
      const canScrollY = current.scrollHeight > current.clientHeight && /(auto|scroll|overlay)/.test(style.overflowY);
      if (canScrollY) return current;
      current = current.parentElement;
    }
    return null;
  }

  function maybeShowScrollbarForPointer(event) {
    if (scrollbarDrag?.active) return;
    if (scrollbarOverlayEl?.contains(event.target)) return;
    const target = scrollableAncestor(event.target);
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const nearRightEdge = event.clientX >= rect.right - 18 && event.clientX <= rect.right + 4;
    if (!nearRightEdge && scrollbarOverlayTarget !== target) return;
    showScrollingScrollbar(target);
  }

  function startScrollbarOverlayDrag(event) {
    const target = scrollbarOverlayTarget;
    const metrics = scrollbarOverlayMetrics(target);
    if (!target || !metrics || !scrollbarOverlayEl) return;
    event.preventDefault();
    event.stopPropagation();
    const previous = scrollbarTimers.get(target);
    if (previous) {
      window.clearTimeout(previous);
      scrollbarTimers.delete(target);
    }
    scrollbarOverlayEl.setPointerCapture?.(event.pointerId);
    scrollbarOverlayEl.classList.add("dragging");
    target.classList.add("scrollbar-visible", "scrollbar-active");
    scrollbarDrag = {
      active: true,
      pointerId: event.pointerId,
      target,
      startY: event.clientY,
      startScrollTop: target.scrollTop,
      maxScroll: metrics.maxScroll,
      travel: metrics.travel || 1
    };
  }

  function updateScrollbarOverlayDrag(event) {
    if (!scrollbarDrag?.active) return;
    event.preventDefault();
    const { target, startY, startScrollTop, maxScroll, travel } = scrollbarDrag;
    const deltaY = event.clientY - startY;
    target.scrollTop = Math.max(0, Math.min(maxScroll, startScrollTop + (deltaY / travel) * maxScroll));
    updateScrollbarOverlay(target);
  }

  function stopScrollbarOverlayDrag(event) {
    if (!scrollbarDrag?.active) return;
    const { target, pointerId } = scrollbarDrag;
    scrollbarOverlayEl?.releasePointerCapture?.(pointerId);
    scrollbarOverlayEl?.classList.remove("dragging");
    scrollbarDrag = null;
    updateScrollbarOverlay(target);
    scheduleScrollbarHide(target, 650);
  }

  // Read-only getter so app.js can re-render on layout changes without
  // poking the internal target ref directly.
  function getScrollbarOverlayTarget() {
    return scrollbarOverlayTarget;
  }

  // Cancel any pending hide-timer for `target`. Used by the mouseover
  // listener in app.js so a hovered scrollbar stays visible.
  function cancelScrollbarHide(target) {
    if (!(target instanceof Element)) return;
    const previous = scrollbarTimers.get(target);
    if (previous) {
      window.clearTimeout(previous);
      scrollbarTimers.delete(target);
    }
  }

  window.aimashiScrollbarOverlay = {
    ensureScrollbarOverlay,
    scrollbarOverlayMetrics,
    updateScrollbarOverlay,
    hideScrollbarOverlay,
    scheduleScrollbarHide,
    showScrollingScrollbar,
    scrollableAncestor,
    maybeShowScrollbarForPointer,
    startScrollbarOverlayDrag,
    updateScrollbarOverlayDrag,
    stopScrollbarOverlayDrag,
    getScrollbarOverlayTarget,
    cancelScrollbarHide,
  };
})();
