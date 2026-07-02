# Trace Body Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make URL and local-path text clickable inside expanded trace bodies only when the user holds Command or Control.

**Architecture:** Add trace-body-only link tokenization in the shared trace renderer, mark those anchors as trace links, and gate their click behavior in the renderer event handler. Keep collapsed trace summaries plain text.

**Tech Stack:** Electron renderer JavaScript, shared browser renderer helpers, Node test runner, CSS.

## Global Constraints

- Expanded trace body text may contain hidden links; collapsed trace summaries remain plain text.
- Trace links inherit current trace color and show no underline unless the modifier key is pressed and the link is hovered.
- Normal `message-link` behavior outside trace remains unchanged.
- Reuse existing local file parsing and open handlers where practical.

---

### Task 1: Trace Body Link Rendering

**Files:**
- Modify: `tests/trace-blocks.test.js`
- Modify: `src/renderer/helpers/markdown-helpers.js`
- Modify: `src/shared/trace-blocks.js`

**Interfaces:**
- Consumes: `window.miaMarkdown.markdownLinkSpec(text, target)`, `window.miaMarkdown.messageLinkAnchorHtml(link, options)`
- Produces: `window.miaTraceBlocks.renderTraceText(text)`, used by `renderTraceBlocks()`

- [ ] **Step 1: Write failing renderer tests**

Add tests asserting expanded trace body links are anchors with `message-link trace-link`, `data-trace-link="true"`, and correct target data attributes; collapsed `.trace-arg` text is not linkified.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/trace-blocks.test.js`
Expected: FAIL because trace bodies currently escape all text.

- [ ] **Step 3: Implement minimal renderer support**

Export the existing markdown link helpers, add trace text tokenization in `src/shared/trace-blocks.js`, and replace expanded trace body escaping with `renderTraceText()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/trace-blocks.test.js`
Expected: PASS.

### Task 2: Modifier-Gated Trace Link Interaction

**Files:**
- Modify: `src/renderer/app.js`
- Modify: `src/renderer/styles/chat.css`
- Modify: `tests/trace-blocks.test.js`

**Interfaces:**
- Consumes: trace anchors with `data-trace-link="true"`
- Produces: click behavior that opens trace links only when `event.metaKey || event.ctrlKey`

- [ ] **Step 1: Write failing CSS/behavior checks**

Add CSS assertions for inherited trace link color, no default underline, and modifier-hover underline. Use existing trace CSS test style.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/trace-blocks.test.js`
Expected: FAIL because trace link CSS does not exist yet.

- [ ] **Step 3: Implement minimal interaction support**

Update the chat link click and keyboard handlers so trace links require Command/Control. Track modifier key state on the chat root with a class used by CSS.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test tests/trace-blocks.test.js` and `npm test`
Expected: PASS.
