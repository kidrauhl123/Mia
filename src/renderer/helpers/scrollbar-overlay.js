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
  let scrollbarInvalidationFrame = 0;

  function clearScrollbarHide(target) {
    if (!(target instanceof Element)) return;
    const previous = scrollbarTimers.get(target);
    if (previous) {
      window.clearTimeout(previous);
      scrollbarTimers.delete(target);
    }
  }

  function scrollbarTargetHiddenByShellState(target) {
    const shell = target.closest?.(".app-shell");
    if (!shell) return false;
    if (shell.dataset.sidebarState === "collapsed" && target.closest(".sidebar")) return true;
    if (shell.dataset.shellLayout !== "single") return false;
    if (shell.dataset.narrowPane === "content" && target.closest(".sidebar")) return true;
    if (shell.dataset.narrowPane === "index" && target.closest(".workspace")) return true;
    return false;
  }

  function isScrollbarTargetUsable(target) {
    if (!(target instanceof Element)) return false;
    if (target === document.documentElement || target === document.body) return false;
    if (!target.isConnected) return false;
    if (target.closest(".hidden, [hidden]")) return false;
    if (scrollbarTargetHiddenByShellState(target)) return false;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
    const style = window.getComputedStyle(target);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return target.scrollHeight > target.clientHeight;
  }

  function validateScrollbarOverlay() {
    const target = scrollbarOverlayTarget;
    if (!target) return;
    if (!isScrollbarTargetUsable(target)) {
      hideScrollbarOverlay(target, true);
      return;
    }
    updateScrollbarOverlay(target);
  }

  function scheduleScrollbarInvalidation() {
    if (scrollbarInvalidationFrame) return;
    scrollbarInvalidationFrame = window.requestAnimationFrame(() => {
      scrollbarInvalidationFrame = 0;
      validateScrollbarOverlay();
    });
  }

  function ensureScrollbarOverlay() {
    if (scrollbarOverlayEl) return scrollbarOverlayEl;
    scrollbarOverlayEl = document.createElement("div");
    scrollbarOverlayEl.className = "scrollbar-overlay";
    scrollbarOverlayEl.addEventListener("pointerdown", startScrollbarOverlayDrag);
    scrollbarOverlayEl.addEventListener("pointerenter", () => {
      const target = scrollbarOverlayTarget;
      if (!target) return;
      if (!isScrollbarTargetUsable(target)) {
        hideScrollbarOverlay(target, true);
        return;
      }
      clearScrollbarHide(target);
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

  function parseScrollbarRadiusY(value) {
    const parts = String(value || "")
      .trim()
      .split(/\s+/)
      .map((part) => Number.parseFloat(part))
      .filter((part) => Number.isFinite(part));
    return Math.max(0, parts[1] ?? parts[0] ?? 0);
  }

  function scrollbarRoundedRightEdgeBounds(target, rect) {
    let top = rect.top;
    let bottom = rect.bottom;
    const rightEdgeSlop = 4;

    for (
      let current = target;
      current && current !== document.body && current !== document.documentElement;
      current = current.parentElement
    ) {
      if (!(current instanceof Element)) continue;
      const currentRect = current.getBoundingClientRect();
      if (currentRect.width <= 0 || currentRect.height <= 0) continue;
      if (currentRect.bottom <= rect.top || currentRect.top >= rect.bottom) continue;
      if (Math.abs(currentRect.right - rect.right) > rightEdgeSlop) continue;

      const style = window.getComputedStyle(current);
      const topRadius = parseScrollbarRadiusY(style.borderTopRightRadius);
      const bottomRadius = parseScrollbarRadiusY(style.borderBottomRightRadius);
      if (topRadius <= 0 && bottomRadius <= 0) continue;

      top = Math.max(top, currentRect.top + topRadius);
      bottom = Math.min(bottom, currentRect.bottom - bottomRadius);
    }

    return {
      top,
      bottom,
      height: Math.max(0, bottom - top)
    };
  }

  function scrollbarOverlayTrackRect(target) {
    if (!(target instanceof Element)) return;
    const rect = target.getBoundingClientRect();
    let trackTop = rect.top;
    let trackBottom = rect.bottom;
    if (target.id === "chat") {
      const composer = document.querySelector("#chatView .composer-card");
      const composerRect = composer?.getBoundingClientRect?.();
      if (composerRect && composerRect.top > rect.top) {
        trackBottom = Math.min(trackBottom, composerRect.top);
      }
    }
    const trackRect = {
      top: trackTop,
      right: rect.right,
      bottom: trackBottom,
      left: rect.left,
      width: rect.width,
      height: Math.max(0, trackBottom - trackTop)
    };
    const roundedBounds = scrollbarRoundedRightEdgeBounds(target, trackRect);
    trackTop = roundedBounds.top;
    trackBottom = roundedBounds.bottom;
    return {
      top: trackTop,
      right: rect.right,
      bottom: trackBottom,
      left: rect.left,
      width: rect.width,
      height: Math.max(0, trackBottom - trackTop)
    };
  }

  function scrollbarOverlayMetrics(target) {
    if (!(target instanceof Element)) return;
    const maxScroll = target.scrollHeight - target.clientHeight;
    if (maxScroll <= 0) return;
    const trackRect = scrollbarOverlayTrackRect(target);
    const rect = trackRect;
    if (rect.width <= 0 || rect.height <= 0) return;
    const trackInset = 3;
    const trackHeight = Math.max(0, trackRect.height - trackInset * 2);
    const thumbHeight = Math.max(28, Math.min(trackHeight, (target.clientHeight / target.scrollHeight) * trackHeight));
    const travel = Math.max(0, trackHeight - thumbHeight);
    return { rect, maxScroll, trackInset, trackHeight, thumbHeight, travel };
  }

  function updateScrollbarOverlay(target) {
    if (!isScrollbarTargetUsable(target)) {
      hideScrollbarOverlay(target, true);
      return false;
    }
    const metrics = scrollbarOverlayMetrics(target);
    if (!metrics) {
      hideScrollbarOverlay(target, true);
      return false;
    }
    const { rect, maxScroll, trackInset, thumbHeight, travel } = metrics;
    const overlay = ensureScrollbarOverlay();
    const thumbTop = rect.top + trackInset + (target.scrollTop / maxScroll) * travel;
    const thumbLeft = rect.right - 8;

    overlay.style.height = `${thumbHeight}px`;
    overlay.style.transform = `translate3d(${Math.round(thumbLeft)}px, ${Math.round(thumbTop)}px, 0)`;
    overlay.classList.add("visible");
    scrollbarOverlayTarget = target;
    return true;
  }

  function hideScrollbarOverlay(target, force = false) {
    if (target && scrollbarOverlayTarget && scrollbarOverlayTarget !== target) return;
    if (scrollbarDrag?.active && !force) return;
    const activeTarget = target instanceof Element ? target : scrollbarOverlayTarget;
    if (activeTarget instanceof Element) {
      clearScrollbarHide(activeTarget);
      activeTarget.classList.remove("scrollbar-visible", "scrollbar-active");
    }
    if (scrollbarDrag?.active && force) {
      scrollbarOverlayEl?.releasePointerCapture?.(scrollbarDrag.pointerId);
      scrollbarDrag = null;
    }
    if (!scrollbarOverlayEl) {
      scrollbarOverlayTarget = null;
      return;
    }
    scrollbarOverlayEl.classList.remove("visible");
    scrollbarOverlayEl.classList.remove("dragging");
    scrollbarOverlayEl.style.transform = "translate3d(-9999px, -9999px, 0)";
    scrollbarOverlayTarget = null;
  }

  function scheduleScrollbarHide(target, delay = 850) {
    if (!(target instanceof Element)) return;
    if (!isScrollbarTargetUsable(target)) {
      hideScrollbarOverlay(target, true);
      return;
    }
    clearScrollbarHide(target);
    scrollbarTimers.set(target, window.setTimeout(() => {
      if (!isScrollbarTargetUsable(target)) {
        hideScrollbarOverlay(target, true);
        return;
      }
      if (scrollbarDrag?.active && scrollbarDrag.target === target) return;
      if (target.matches(":hover") || scrollbarOverlayEl?.matches(":hover")) return;
      target.classList.remove("scrollbar-visible");
      target.classList.remove("scrollbar-active");
      scrollbarTimers.delete(target);
      hideScrollbarOverlay(target);
    }, delay));
  }

  function showScrollingScrollbar(target) {
    if (!isScrollbarTargetUsable(target)) {
      hideScrollbarOverlay(target, true);
      return;
    }
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
      if (canScrollY && isScrollbarTargetUsable(current)) return current;
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
    if (!isScrollbarTargetUsable(target)) {
      hideScrollbarOverlay(target, true);
      return;
    }
    const metrics = scrollbarOverlayMetrics(target);
    if (!target || !metrics || !scrollbarOverlayEl) return;
    event.preventDefault();
    event.stopPropagation();
    clearScrollbarHide(target);
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
    if (!isScrollbarTargetUsable(scrollbarDrag.target)) {
      hideScrollbarOverlay(scrollbarDrag.target, true);
      return;
    }
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
    if (updateScrollbarOverlay(target)) scheduleScrollbarHide(target, 650);
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
    clearScrollbarHide(target);
  }

  function installScrollbarInvalidationObserver() {
    if (typeof MutationObserver !== "function") return;
    const observer = new MutationObserver((records) => {
      if (records.every((record) => scrollbarOverlayEl?.contains(record.target))) return;
      scheduleScrollbarInvalidation();
    });
    observer.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: [
        "class",
        "hidden",
        "style",
        "data-layout",
        "data-sidebar-state",
        "data-shell-layout",
        "data-narrow-pane"
      ]
    });
    window.addEventListener("resize", scheduleScrollbarInvalidation, { passive: true });
  }

  installScrollbarInvalidationObserver();

  window.miaScrollbarOverlay = {
    ensureScrollbarOverlay,
    scrollbarOverlayTrackRect,
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
    validateScrollbarOverlay,
  };
})();
