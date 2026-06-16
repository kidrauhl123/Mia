(function attachMessageTextCursor(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaMessageTextCursor = api;
  if (root?.document) api.initMessageTextCursor(root.document);
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildMessageTextCursor() {
  "use strict";

  const TEXT_HIT_CLASS = "text-hit";
  const BUBBLE_SELECTOR = ".bubble";
  const TEXT_REGION_SELECTOR = [
    "p",
    "li",
    "td",
    "th",
    "h1",
    "h2",
    "h3",
    "blockquote",
    ".message-code-block pre",
  ].join(",");
  const INTERACTIVE_SELECTOR = [
    "a.message-link",
    "code.inline-code",
    "[data-copy-code]",
    "button",
    "input",
    "textarea",
    "select",
    "[role='button']",
    "[contenteditable='true']",
  ].join(",");

  function isTextNode(node) {
    return !!node && node.nodeType === 3 && typeof node.nodeValue === "string";
  }

  function caretFromPoint(doc, x, y) {
    if (typeof doc?.caretPositionFromPoint === "function") {
      const position = doc.caretPositionFromPoint(x, y);
      if (position) return { node: position.offsetNode, offset: position.offset };
    }
    if (typeof doc?.caretRangeFromPoint === "function") {
      const range = doc.caretRangeFromPoint(x, y);
      if (range) return { node: range.startContainer, offset: range.startOffset };
    }
    return null;
  }

  function isInsideMessageText(node, bubble) {
    const parent = node?.parentElement;
    if (!parent || !bubble?.contains?.(parent)) return false;
    if (parent.closest(INTERACTIVE_SELECTOR)) return false;
    const region = parent.closest(TEXT_REGION_SELECTOR);
    return !!region && bubble.contains(region);
  }

  function charRangeForOffset(text, offset) {
    const length = text.length;
    if (offset < 0 || offset >= length) return null;
    let start = offset;
    let end = offset + 1;
    const current = text.charCodeAt(offset);
    if (current >= 0xdc00 && current <= 0xdfff && offset > 0) {
      const previous = text.charCodeAt(offset - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) start = offset - 1;
    } else if (current >= 0xd800 && current <= 0xdbff && offset + 1 < length) {
      const next = text.charCodeAt(offset + 1);
      if (next >= 0xdc00 && next <= 0xdfff) end = offset + 2;
    }
    return { start, end };
  }

  function pointInsideRect(rect, x, y) {
    const tolerance = 0.5;
    return x >= rect.left - tolerance
      && x <= rect.right + tolerance
      && y >= rect.top - tolerance
      && y <= rect.bottom + tolerance;
  }

  function pointHitsTextNode(doc, textNode, offset, x, y) {
    const text = textNode.nodeValue || "";
    const candidates = [offset, offset - 1];
    const seen = new Set();
    for (const candidate of candidates) {
      const rangeOffsets = charRangeForOffset(text, candidate);
      if (!rangeOffsets) continue;
      const key = `${rangeOffsets.start}:${rangeOffsets.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const range = doc.createRange();
      range.setStart(textNode, rangeOffsets.start);
      range.setEnd(textNode, rangeOffsets.end);
      const rects = Array.from(range.getClientRects());
      range.detach?.();
      if (rects.some((rect) => pointInsideRect(rect, x, y))) return true;
    }
    return false;
  }

  function pointHitsMessageText(doc, bubble, x, y) {
    const caret = caretFromPoint(doc, x, y);
    if (!caret || !isTextNode(caret.node)) return false;
    if (!isInsideMessageText(caret.node, bubble)) return false;
    return pointHitsTextNode(doc, caret.node, caret.offset, x, y);
  }

  function initMessageTextCursor(rootEl) {
    const rootNode = rootEl || (typeof document !== "undefined" ? document : null);
    if (!rootNode?.addEventListener) return () => {};
    const doc = rootNode.nodeType === 9 ? rootNode : rootNode.ownerDocument;
    if (!doc) return () => {};
    let activeBubble = null;

    function setActiveBubble(bubble, active) {
      if (activeBubble && activeBubble !== bubble) activeBubble.classList.remove(TEXT_HIT_CLASS);
      if (bubble) bubble.classList.toggle(TEXT_HIT_CLASS, !!active);
      activeBubble = active ? bubble : null;
    }

    function clearActiveBubble() {
      if (!activeBubble) return;
      activeBubble.classList.remove(TEXT_HIT_CLASS);
      activeBubble = null;
    }

    function rootContains(node) {
      return rootNode === doc || rootNode.contains?.(node);
    }

    function update(event) {
      const target = event.target;
      const bubble = target?.closest?.(BUBBLE_SELECTOR);
      if (!bubble || !rootContains(bubble)) {
        clearActiveBubble();
        return;
      }
      if (target.closest?.(INTERACTIVE_SELECTOR)) {
        setActiveBubble(bubble, false);
        return;
      }
      setActiveBubble(
        bubble,
        pointHitsMessageText(doc, bubble, event.clientX, event.clientY)
      );
    }

    rootNode.addEventListener("pointermove", update, { passive: true });
    rootNode.addEventListener("pointerover", update, { passive: true });
    rootNode.addEventListener("pointerleave", clearActiveBubble, { passive: true });
    rootNode.addEventListener("pointercancel", clearActiveBubble, { passive: true });
    rootNode.addEventListener("scroll", clearActiveBubble, { capture: true, passive: true });
    return () => {
      rootNode.removeEventListener("pointermove", update);
      rootNode.removeEventListener("pointerover", update);
      rootNode.removeEventListener("pointerleave", clearActiveBubble);
      rootNode.removeEventListener("pointercancel", clearActiveBubble);
      rootNode.removeEventListener("scroll", clearActiveBubble, { capture: true });
      clearActiveBubble();
    };
  }

  return {
    initMessageTextCursor,
    pointHitsMessageText,
    pointHitsTextNode,
  };
});
