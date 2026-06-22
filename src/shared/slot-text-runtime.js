(function (global) {
  "use strict";

  const controllers = new WeakMap();
  const pending = new Map();
  let slotTextApi = null;

  function prefersReducedMotion() {
    try {
      return Boolean(global.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
    } catch {
      return false;
    }
  }

  function normalizeText(value) {
    return String(value ?? "");
  }

  function fallbackSet(element, text) {
    if (!element) return;
    const next = normalizeText(text);
    element.textContent = next;
    if (element.dataset) element.dataset.slotTextValue = next;
  }

  function optionsFor(next = {}) {
    return {
      duration: 260,
      stagger: 24,
      exitOffset: 38,
      ...next
    };
  }

  function currentValue(element, fallback = "") {
    if (element?.dataset && Object.prototype.hasOwnProperty.call(element.dataset, "slotTextValue")) {
      return normalizeText(element.dataset.slotTextValue);
    }
    return normalizeText(element?.textContent || fallback);
  }

  function canAnimate(element) {
    return Boolean(element && slotTextApi?.slotText && global.document && !prefersReducedMotion());
  }

  function ensureController(element, initialText, options = {}) {
    if (!canAnimate(element)) return null;
    const existing = controllers.get(element);
    if (existing) return existing;
    const text = normalizeText(initialText);
    const controller = slotTextApi.slotText(element, text, optionsFor(options));
    const record = { controller, value: text };
    controllers.set(element, record);
    element.dataset.slotTextValue = text;
    return record;
  }

  function set(element, text, options = {}) {
    if (!element) return;
    const next = normalizeText(text);
    if (!slotTextApi) pending.set(element, { text: next, options });
    else pending.delete(element);
    if (!canAnimate(element)) {
      fallbackSet(element, next);
      return;
    }
    const record = ensureController(element, currentValue(element, next), options);
    if (!record) {
      fallbackSet(element, next);
      return;
    }
    if (record.value === next) return;
    record.controller.set(next, optionsFor(options));
    record.value = next;
    element.dataset.slotTextValue = next;
  }

  function flash(element, text, options = {}) {
    if (!element) return;
    const next = normalizeText(text);
    const restingText = normalizeText(options.restingText || currentValue(element));
    const revertAfter = Number.isFinite(Number(options.revertAfter)) ? Number(options.revertAfter) : 1200;
    if (!canAnimate(element)) {
      fallbackSet(element, next);
      clearTimeout(element._slotTextFlashTimer);
      element._slotTextFlashTimer = setTimeout(() => fallbackSet(element, restingText), revertAfter);
      return;
    }
    const record = ensureController(element, restingText, options.enter || options);
    if (!record) {
      fallbackSet(element, next);
      clearTimeout(element._slotTextFlashTimer);
      element._slotTextFlashTimer = setTimeout(() => fallbackSet(element, restingText), revertAfter);
      return;
    }
    record.controller.flash(next, {
      revertAfter,
      enter: optionsFor({ direction: "up", ...(options.enter || {}) }),
      exit: optionsFor({ direction: "down", ...(options.exit || {}) })
    });
    record.value = restingText;
    element.dataset.slotTextValue = restingText;
  }

  function destroy(element) {
    const record = element ? controllers.get(element) : null;
    if (!record) return;
    record.controller.destroy();
    controllers.delete(element);
  }

  function flushPending() {
    for (const [element, item] of pending) {
      if (!element?.isConnected) {
        pending.delete(element);
        continue;
      }
      set(element, item.text, item.options);
    }
  }

  const ready = import("./vendor/slot-text/index.js")
    .then((api) => {
      slotTextApi = api;
      flushPending();
      return api;
    })
    .catch((error) => {
      console.warn("[slot-text] runtime unavailable", error);
      return null;
    });

  global.miaSlotText = {
    ready,
    set,
    flash,
    destroy
  };
})(typeof window !== "undefined" ? window : globalThis);
