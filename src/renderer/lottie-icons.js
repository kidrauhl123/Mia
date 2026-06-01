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
(function () {
  const BASE_PATH = "./assets/lottie/";

  const reg = new Map(); // container element -> { anim, open }
  const reducedMotion = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : { matches: false };

  const lastFrame = (anim) => Math.max(0, Math.floor(anim.totalFrames) - 1);

  function trigger(entry) {
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
    if (!entry || entry.open === open) return;
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

  function mount(container) {
    const name = container.dataset.lottie;
    if (!name || reg.has(container)) return;
    const triggerMode = container.dataset.lottieTrigger || "boomerang";
    // Optional, for multi-segment files (e.g. Lordicon in/hover markers): which
    // frame to rest on, and which [start,end] segment a trigger plays.
    const restFrame = Number(container.dataset.lottieRest) || 0;
    const seg = container.dataset.lottiePlay
      ? container.dataset.lottiePlay.split(",").map(Number)
      : null;
    const anim = window.lottie.loadAnimation({
      container,
      renderer: "svg",
      loop: false,
      autoplay: false,
      path: `${BASE_PATH}${name}.json`,
    });
    const entry = { anim, open: false, restFrame, segment: seg };
    reg.set(container, entry);

    anim.addEventListener("DOMLoaded", () => {
      // Drop the static fallback <svg> shipped in the markup; lottie appended its own.
      const fallback = container.querySelector("svg:first-child");
      if (fallback && container.children.length > 1) fallback.remove();
      anim.goToAndStop(restFrame, true); // idle / closed state
    });

    if (triggerMode === "boomerang" || triggerMode === "hover") {
      anim.addEventListener("complete", () => onComplete(entry));
      const button = container.closest("button");
      const event = triggerMode === "hover" ? "mouseenter" : "click";
      if (button) button.addEventListener(event, () => trigger(entry));
    }
    // "toggle": owner calls setOpen(); no auto listeners.
  }

  // Free instances whose container has left the DOM (e.g. a context menu that
  // was rebuilt via innerHTML), so the registry doesn't pin detached nodes.
  function sweepOrphans() {
    for (const [container, entry] of reg) {
      if (!container.isConnected) {
        entry.anim.destroy();
        reg.delete(container);
      }
    }
  }

  function init(root) {
    if (!window.lottie) return; // no player → keep the static fallback SVGs
    sweepOrphans();
    (root || document).querySelectorAll("[data-lottie]").forEach(mount);
  }

  window.miaLottieIcons = { init, setOpen };
})();
