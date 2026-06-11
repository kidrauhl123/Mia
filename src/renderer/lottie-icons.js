// Animated icons. Mounts Lottie micro-interaction icons (from the useanimations
// set — stroke-only, MIT/free) into [data-lottie] containers anywhere in the
// renderer (nav rail, composer add button, …).
//
// Two deliberate choices:
//  - Color is NOT baked in: these animations carry geometry only, so CSS paints
//    the generated <path> via currentColor — same theming path as the static
//    icons, so light/dark/accent just work with no per-theme files.
//  - Trigger modes (data-lottie-trigger):
//      "boomerang" (default): play forward then reverse back to the idle frame
//        on click of the closest button. useanimations are hover round-trips and
//        some have unusable end states (notification → crossed bell), so we
//        always settle back on frame 0; active/inactive is conveyed by color.
//      "toggle": no auto playback; the owner drives state via setOpen(), which
//        plays forward to the end frame (open) or reverse to frame 0 (closed).
//        Used for + ↔ × style buttons bound to a menu's open state.
//      "hover": boomerang on the closest button's mouseenter. For context-menu
//        items, which are rebuilt (innerHTML) on every open — call init(menuEl)
//        after rendering; init() first sweeps orphaned (detached) instances.
//      "loop": autoplay and loop until the element is removed. Used for startup
//        loading states that must animate without user input.
(function () {
  const BASE_PATH = "./assets/lottie/";

  const reg = new Map(); // container element -> { anim, open }
  const animationDataCache = new Map();
  const animationDataPromises = new Map();
  const reducedMotion = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : { matches: false };

  const lastFrame = (anim) => Math.max(0, Math.floor(anim.totalFrames) - 1);

  function trigger(entry) {
    if (!entry.anim) return;
    if (reducedMotion.matches) return; // honor reduced motion: stay on idle frame
    if (entry.segment) {
      // One-shot: play the named segment (e.g. a Lordicon hover marker) once.
      entry.anim.playSegments(entry.segment, true);
    } else {
      // Default boomerang: play forward, then reverse back to idle on complete.
      entry.anim.setDirection(1);
      entry.anim.goToAndPlay(0, true);
    }
  }

  function onComplete(entry) {
    if (!entry.anim) return;
    if (entry.segment) {
      entry.anim.goToAndStop(entry.restFrame, true); // settle back on the rest pose
      return;
    }
    // Forward leg finished → reverse leg back to the idle frame.
    // The reverse leg's own completion (direction -1) just rests at frame 0.
    if (entry.anim.playDirection === 1) {
      entry.anim.setDirection(-1);
      entry.anim.play();
    }
  }

  // Drive a "toggle" icon to its open/closed end. Idempotent per state.
  function setOpen(container, open) {
    const entry = reg.get(container);
    if (!entry || !entry.anim || entry.open === open) return;
    entry.open = open;
    const end = lastFrame(entry.anim);
    if (reducedMotion.matches) {
      entry.anim.goToAndStop(open ? end : 0, true);
      return;
    }
    // playSegments(force=true) plays the segment immediately, in reverse when
    // start > end — robust from any paused frame, unlike setDirection + play.
    entry.anim.playSegments(open ? [0, end] : [end, 0], true);
  }

  async function fetchTgsAnimationData(animationPath) {
    const response = await fetch(animationPath);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!window.DecompressionStream) throw new Error("gzip decompression is unavailable");
    const stream = response.body
      ? response.body.pipeThrough(new DecompressionStream("gzip"))
      : new Blob([await response.arrayBuffer()]).stream().pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  }

  async function loadTgsAnimationData(container, name, animationPath) {
    const cacheKey = animationPath || `status-badge:${name}`;
    if (animationDataCache.has(cacheKey)) return animationDataCache.get(cacheKey);
    if (animationDataPromises.has(cacheKey)) return animationDataPromises.get(cacheKey);
    const promise = loadTgsAnimationDataUncached(container, name, animationPath);
    animationDataPromises.set(cacheKey, promise);
    try {
      const animationData = await promise;
      animationDataCache.set(cacheKey, animationData);
      return animationData;
    } finally {
      animationDataPromises.delete(cacheKey);
    }
  }

  async function loadTgsAnimationDataUncached(container, name, animationPath) {
    const errors = [];
    if (animationPath) {
      try {
        return await fetchTgsAnimationData(animationPath);
      } catch (error) {
        errors.push(`fetch:${error?.message || error}`);
      }
    }
    if (container.dataset.lottieLocal === "status-badge" && window.mia?.loadStatusBadgeAsset) {
      try {
        const result = await window.mia.loadStatusBadgeAsset(name);
        if (!result?.ok || !result.animationData) throw new Error(result?.error || "status badge asset load failed");
        return result.animationData;
      } catch (error) {
        errors.push(`ipc:${error?.message || error}`);
      }
    }
    throw new Error(errors.join("; ") || "TGS animation load failed");
  }

  function firstSummary(details) {
    if (!details?.children) return null;
    for (const child of details.children) {
      if (child.tagName === "SUMMARY") return child;
    }
    return null;
  }

  function isInsideClosedDetailsBody(container) {
    for (let node = container?.parentElement; node; node = node.parentElement) {
      if (node.tagName !== "DETAILS" || node.open) continue;
      const summary = firstSummary(node);
      if (!summary || !summary.contains(container)) return true;
    }
    return false;
  }

  function hasLayoutBox(container) {
    if (typeof container?.getClientRects !== "function") return true;
    return container.getClientRects().length > 0;
  }

  function shouldDeferMount(container) {
    if (isInsideClosedDetailsBody(container)) return true;
    const format = String(container.dataset.lottieFormat || "").toLowerCase();
    return format === "tgs" && !hasLayoutBox(container);
  }

  function installAnimation(container, entry, animationConfig) {
    const anim = window.lottie.loadAnimation({
      container,
      renderer: "svg",
      loop: entry.triggerMode === "loop",
      autoplay: entry.triggerMode === "loop",
      ...animationConfig,
    });
    entry.anim = anim;

    anim.addEventListener("DOMLoaded", () => {
      // Drop the static fallback <svg> shipped in the markup; lottie appended its own.
      const fallback = container.querySelector("svg:first-child");
      if (fallback && container.children.length > 1) fallback.remove();
      if (entry.triggerMode !== "loop") {
        anim.goToAndStop(entry.restFrame, true); // idle / closed state
      }
    });

    if (entry.triggerMode === "boomerang" || entry.triggerMode === "hover") {
      anim.addEventListener("complete", () => onComplete(entry));
      const button = container.closest("button");
      const event = entry.triggerMode === "hover" ? "mouseenter" : "click";
      if (button) button.addEventListener(event, () => trigger(entry));
    }
    // "toggle": owner calls setOpen(); no auto listeners.
  }

  function mount(container) {
    const name = container.dataset.lottie;
    if (!name || reg.has(container)) return;
    if (shouldDeferMount(container)) return;
    const animationPath = container.dataset.lottiePath || `${BASE_PATH}${name}.json`;
    const triggerMode = container.dataset.lottieTrigger || "boomerang";
    // Optional, for multi-segment files (e.g. Lordicon in/hover markers): which
    // frame to rest on, and which [start,end] segment a trigger plays.
    const restFrame = Number(container.dataset.lottieRest) || 0;
    const seg = container.dataset.lottiePlay
      ? container.dataset.lottiePlay.split(",").map(Number)
      : null;
    const entry = { anim: null, open: false, restFrame, segment: seg, triggerMode };
    reg.set(container, entry);
    const format = String(container.dataset.lottieFormat || "").toLowerCase();
    if (format === "tgs") {
      loadTgsAnimationData(container, name, animationPath)
        .then((animationData) => {
          if (!container.isConnected || reg.get(container) !== entry) return;
          if (shouldDeferMount(container)) {
            reg.delete(container);
            return;
          }
          installAnimation(container, entry, { animationData });
        })
        .catch((error) => {
          console.warn?.("[lottie] TGS badge load failed:", error?.message || error);
          reg.delete(container);
        });
      return;
    }
    installAnimation(container, entry, { path: animationPath });
  }

  // Free instances whose container has left the DOM (e.g. a context menu that
  // was rebuilt via innerHTML), so the registry doesn't pin detached nodes.
  function sweepOrphans() {
    for (const [container, entry] of reg) {
      if (!container.isConnected) {
        entry.anim?.destroy?.();
        reg.delete(container);
      }
    }
  }

  function init(root) {
    if (!window.lottie) return; // no player → keep the static fallback SVGs
    sweepOrphans();
    (root || document).querySelectorAll("[data-lottie]").forEach(mount);
  }

  function initSoon(root) {
    init(root);
    const defer = window.requestAnimationFrame || window.setTimeout;
    if (typeof defer === "function") defer(() => init(root), 0);
  }

  // Destroy instances inside `root` (or all). Use when a still-connected
  // container is being torn down — e.g. a looping icon in a dialog that hides
  // (not removes) on close, which sweepOrphans can't reclaim on its own.
  function destroy(root) {
    for (const [container, entry] of reg) {
      if (!root || container === root || (root.contains && root.contains(container))) {
        entry.anim?.destroy?.();
        reg.delete(container);
      }
    }
  }

  if (typeof document !== "undefined") {
    document.addEventListener("toggle", (event) => {
      const details = event.target;
      if (details?.tagName === "DETAILS" && details.open) initSoon(details);
    }, true);
  }

  window.miaLottieIcons = { init, setOpen, destroy };
})();
