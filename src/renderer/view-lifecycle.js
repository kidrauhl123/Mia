(function initViewLifecycle(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.miaViewLifecycle = factory();
})(typeof globalThis !== "undefined" ? globalThis : window, function viewLifecycleFactory() {
  "use strict";

  function createViewLifecycle({
    document: documentRef = typeof document !== "undefined" ? document : null,
    initialView = ""
  } = {}) {
    let activeView = String(initialView || "");
    let documentVisible = !documentRef?.hidden;
    let started = false;
    const subscribers = new Set();

    function snapshot(reason = "snapshot") {
      return {
        activeView,
        documentVisible,
        interactive: documentVisible,
        reason
      };
    }

    function notify(reason) {
      const state = snapshot(reason);
      for (const subscriber of [...subscribers]) {
        try {
          subscriber(state);
        } catch (error) {
          console.warn?.("[renderer-lifecycle] subscriber failed", error);
        }
      }
      return state;
    }

    function setActiveView(nextView) {
      const next = String(nextView || "");
      if (next === activeView) return snapshot("view-unchanged");
      activeView = next;
      return notify("view");
    }

    function syncDocumentVisibility() {
      const nextVisible = !documentRef?.hidden;
      if (nextVisible === documentVisible) return snapshot("visibility-unchanged");
      documentVisible = nextVisible;
      return notify("visibility");
    }

    function subscribe(subscriber, { immediate = true } = {}) {
      if (typeof subscriber !== "function") return () => {};
      subscribers.add(subscriber);
      if (immediate) subscriber(snapshot("subscribe"));
      return () => subscribers.delete(subscriber);
    }

    function start() {
      if (started) return;
      started = true;
      documentRef?.addEventListener?.("visibilitychange", syncDocumentVisibility);
    }

    function destroy() {
      if (started) documentRef?.removeEventListener?.("visibilitychange", syncDocumentVisibility);
      started = false;
      subscribers.clear();
    }

    start();

    return {
      destroy,
      isActive: (view) => documentVisible && activeView === String(view || ""),
      setActiveView,
      snapshot,
      subscribe,
      syncDocumentVisibility
    };
  }

  return { createViewLifecycle };
});
