const { test } = require("node:test");
const assert = require("node:assert/strict");

const cursor = require("../src/shared/message-text-cursor.js");

function fakeDocument(textNode, caretOffset = 0) {
  return {
    caretRangeFromPoint() {
      return { startContainer: textNode, startOffset: caretOffset };
    },
    createRange() {
      let start = 0;
      return {
        setStart(_node, offset) { start = offset; },
        setEnd() {},
        getClientRects() {
          const rect = [
            { left: 10, right: 18, top: 5, bottom: 21 },
            { left: 18, right: 26, top: 5, bottom: 21 },
            { left: 26, right: 34, top: 5, bottom: 21 },
          ][start];
          return rect ? [rect] : [];
        },
        detach() {},
      };
    },
  };
}

function fakeBubble(textNode, { interactive = false } = {}) {
  const region = {};
  const parent = {
    closest(selector) {
      if (selector.includes("code.inline-code")) return interactive ? {} : null;
      if (selector.includes("p,")) return region;
      return null;
    },
  };
  textNode.parentElement = parent;
  return {
    contains(node) {
      return node === parent || node === region || node === textNode;
    },
  };
}

test("pointHitsTextNode only matches character rects, not surrounding bubble space", () => {
  const textNode = { nodeType: 3, nodeValue: "abc" };
  const doc = fakeDocument(textNode, 1);

  assert.equal(cursor.pointHitsTextNode(doc, textNode, 1, 21, 12), true);
  assert.equal(cursor.pointHitsTextNode(doc, textNode, 1, 60, 12), false);
});

test("pointHitsMessageText requires a real message text region and skips interactive inline code", () => {
  const textNode = { nodeType: 3, nodeValue: "abc" };
  const doc = fakeDocument(textNode, 0);
  const bubble = fakeBubble(textNode);

  assert.equal(cursor.pointHitsMessageText(doc, bubble, 12, 12), true);
  assert.equal(cursor.pointHitsMessageText(doc, bubble, 60, 12), false);

  const interactiveText = { nodeType: 3, nodeValue: "abc" };
  const interactiveBubble = fakeBubble(interactiveText, { interactive: true });
  assert.equal(cursor.pointHitsMessageText(fakeDocument(interactiveText, 0), interactiveBubble, 12, 12), false);
});
