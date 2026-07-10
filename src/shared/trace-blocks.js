// Trace blocks rendering — reasoning + tool-call panels shown on assistant
// messages. Shared by chat render (renderMessageHtml + streaming preview)
// and the tasks panel (run detail).
//
// Pure renderer: takes a structured `{reasoning, tools, content}` and returns
// HTML.  Reads state.openTraceKeys / state.animatedTraceKeys for the user's
// per-row open/closed memory (so trace expansion survives re-renders).
(function () {
  "use strict";

  let state;

  function initTraceBlocks(deps) {
    state = deps.state;
  }

  function animatedTraceKeys() {
    if (!state) return null;
    if (!state.animatedTraceKeys
      || typeof state.animatedTraceKeys.has !== "function"
      || typeof state.animatedTraceKeys.add !== "function") {
      state.animatedTraceKeys = new Set();
    }
    return state.animatedTraceKeys;
  }

  function normalizeTraceText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/```[\s\S]*?```/g, "")
      .replace(/[\s　`*_~#>()[\]{}.,，。!?！？:：;；"'“”‘’、|/\\-]+/g, "");
  }

  function isDuplicateTraceReasoning(reasoning, content) {
    const reasoningText = normalizeTraceText(reasoning);
    const contentText = normalizeTraceText(content);
    if (!reasoningText || !contentText) return false;
    if (reasoningText === contentText) return true;
    const shorter = reasoningText.length <= contentText.length ? reasoningText : contentText;
    const longer = reasoningText.length > contentText.length ? reasoningText : contentText;
    return shorter.length >= 16 && longer.includes(shorter);
  }

  function traceReasoningForDisplay(reasoning, tools, content = "", options = {}) {
    const text = String(reasoning || "").trim();
    if (!text) return "";
    const toolList = Array.isArray(tools) ? tools : [];
    if (isDuplicateTraceReasoning(text, content)) return "";
    if (!toolList.length && !options.showWithoutTools) return "";
    return text;
  }

  function traceAccordionBody(innerHtml) {
    return innerHtml ? `<div class="trace-accordion-body accordion-body">${innerHtml}</div>` : "";
  }

  function splitTraceLinkCandidate(value) {
    let target = String(value || "");
    let suffix = "";
    const pairedClosers = {
      ")": "(",
      "]": "[",
      "}": "{",
      "）": "（",
      "】": "【",
      "》": "《"
    };
    const hasUnmatchedCloser = (text, closer) => {
      const opener = pairedClosers[closer];
      if (!opener) return false;
      const escapedOpener = opener.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const escapedCloser = closer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const openCount = (text.match(new RegExp(escapedOpener, "g")) || []).length;
      const closeCount = (text.match(new RegExp(escapedCloser, "g")) || []).length;
      return closeCount > openCount;
    };
    while (target) {
      const last = target[target.length - 1];
      if (/[.,;!?，。！？、]/.test(last) || hasUnmatchedCloser(target, last)) {
        suffix = last + suffix;
        target = target.slice(0, -1);
        continue;
      }
      break;
    }
    return { target, suffix };
  }

  function traceLinkAnchorHtml(link) {
    if (!window.miaMarkdown || typeof window.miaMarkdown.messageLinkAnchorHtml !== "function") {
      return window.miaMarkdown.escapeHtml(link.text);
    }
    return window.miaMarkdown.messageLinkAnchorHtml(link, {
      className: "message-link trace-link",
      attrs: 'data-trace-link="true"',
      tabIndex: "-1"
    });
  }

  function renderTraceText(value) {
    const source = String(value || "");
    const api = window.miaMarkdown || {};
    if (typeof api.markdownLinkSpec !== "function") return api.escapeHtml(source);
    const pattern = /(^|[\s([{<"'`])((?:https?:\/\/|file:\/\/|\/|[A-Za-z]:[\\/]|\\\\)[^\s<>"'`]+)/g;
    let cursor = 0;
    let html = "";
    for (const match of source.matchAll(pattern)) {
      const prefix = match[1] || "";
      const candidate = match[2] || "";
      const candidateIndex = (match.index || 0) + prefix.length;
      if (candidateIndex < cursor) continue;
      const { target, suffix } = splitTraceLinkCandidate(candidate);
      if (!target) continue;
      const link = api.markdownLinkSpec(target, target);
      if (!link) continue;
      html += api.escapeHtml(source.slice(cursor, candidateIndex));
      html += traceLinkAnchorHtml({ ...link, text: target });
      html += api.escapeHtml(suffix);
      cursor = candidateIndex + candidate.length;
    }
    html += api.escapeHtml(source.slice(cursor));
    return html;
  }

  function renderTraceBlocks({ reasoning, tools, content, expanded, scopeKey, showReasoningWithoutTools }) {
    if (!state) return "";
    const animatedKeys = animatedTraceKeys();
    const toolList = Array.isArray(tools) ? tools : [];
    const displayReasoning = traceReasoningForDisplay(reasoning, toolList, content, {
      showWithoutTools: Boolean(showReasoningWithoutTools)
    });
    if (!displayReasoning && !toolList.length) return "";
    const rows = [];
    const openState = (key) => {
      if (!key) return { open: Boolean(expanded), userOpen: false, userClosed: false };
      const userOpen = state.openTraceKeys.has(key);
      const userClosed = state.openTraceKeys.has(`!${key}`);
      return {
        open: userOpen || (!userClosed && Boolean(expanded)),
        userOpen,
        userClosed
      };
    };
    const animClass = (key) => {
      if (!key) return "";
      if (animatedKeys.has(key)) return "";
      return " trace-anim-enter";
    };
    const rowAttrs = (key, idx, stateForKey) => {
      const attrs = [];
      if (key) attrs.push(`data-trace-key="${window.miaMarkdown.escapeHtml(key)}"`);
      if (stateForKey.open) attrs.push("open");
      if (stateForKey.open && stateForKey.userOpen) {
        attrs.push('data-user-open="true"');
      } else if (stateForKey.open) {
        attrs.push('data-auto-open="true"');
      }
      if (key && !animatedKeys.has(key)) {
        attrs.push(`style="--trace-delay:${Math.min(idx, 6) * 60}ms"`);
      }
      return attrs.length ? ` ${attrs.join(" ")}` : "";
    };
    if (displayReasoning) {
      const reasoningText = displayReasoning;
      const key = scopeKey ? `${scopeKey}::reasoning` : "";
      const stateForKey = openState(key);
      rows.push(
        `<details class="trace-row reasoning${animClass(key)}" data-accordion="true"${rowAttrs(key, rows.length, stateForKey)}>` +
          `<summary><span class="trace-chevron">▸</span><span class="trace-cmd">thinking</span>${stateForKey.open ? "" : `<span class="trace-arg">${window.miaMarkdown.escapeHtml(reasoningText.slice(0, 80).replace(/\s+/g, " "))}</span>`}</summary>` +
          traceAccordionBody(`<pre class="trace-body">${renderTraceText(reasoningText)}</pre>`) +
        `</details>`
      );
    }
    for (let idx = 0; idx < toolList.length; idx++) {
      const tool = toolList[idx];
      const status = tool.status === "completed" ? "ok" : tool.status === "error" ? "err" : "run";
      const glyph = status === "ok" ? "✓" : status === "err" ? "✗" : "●";
      const meta = status === "run"
        ? "…"
        : (tool.duration != null ? `${Number(tool.duration).toFixed(2)}s` : "");
      const name = String(tool.name || "tool");
      const preview = String(tool.preview || "");
      const previewInline = preview.replace(/\s+/g, " ").slice(0, 120);
      const key = scopeKey ? `${scopeKey}::tool::${tool.id || idx}` : "";
      const stateForKey = openState(key);
      rows.push(
        `<details class="trace-row tool${animClass(key)}" data-status="${status}" data-accordion="true"${rowAttrs(key, rows.length, stateForKey)}>` +
          `<summary>` +
            `<span class="trace-chevron">▸</span>` +
            `<span class="trace-glyph">${glyph}</span>` +
            `<span class="trace-cmd">${window.miaMarkdown.escapeHtml(name)}</span>` +
            (!stateForKey.open && previewInline ? `<span class="trace-arg">${window.miaMarkdown.escapeHtml(previewInline)}</span>` : "") +
            (meta ? `<span class="trace-meta">${window.miaMarkdown.escapeHtml(meta)}</span>` : "") +
          `</summary>` +
          traceAccordionBody(preview ? `<pre class="trace-body">${renderTraceText(preview)}</pre>` : "") +
        `</details>`
      );
    }
    return `<div class="trace">${rows.join("")}</div>`;
  }

  function traceOpenState(key, expanded) {
    if (!state || !key) return { open: Boolean(expanded), userOpen: false, userClosed: false };
    const userOpen = state.openTraceKeys.has(key);
    const userClosed = state.openTraceKeys.has(`!${key}`);
    return {
      open: userOpen || (!userClosed && Boolean(expanded)),
      userOpen,
      userClosed
    };
  }

  function traceAnimClass(key) {
    const animatedKeys = animatedTraceKeys();
    if (!key || !animatedKeys || animatedKeys.has(key)) return "";
    return " trace-anim-enter";
  }

  function traceRowAttrs(key, idx, stateForKey) {
    const animatedKeys = animatedTraceKeys();
    const attrs = [];
    if (key) attrs.push(`data-trace-key="${window.miaMarkdown.escapeHtml(key)}"`);
    if (stateForKey.open) attrs.push("open");
    if (stateForKey.open && stateForKey.userOpen) {
      attrs.push('data-user-open="true"');
    } else if (stateForKey.open) {
      attrs.push('data-auto-open="true"');
    }
    if (key && animatedKeys && !animatedKeys.has(key)) {
      attrs.push(`style="--trace-delay:${Math.min(idx, 6) * 60}ms"`);
    }
    return attrs.length ? ` ${attrs.join(" ")}` : "";
  }

  function renderFileEditBlock(block, { expanded, scopeKey, rowIndex }) {
    const status = block.status === "completed" ? "ok" : (block.error || block.status === "error" || block.status === "failed") ? "err" : "run";
    const glyph = status === "ok" ? "✓" : status === "err" ? "✗" : "●";
    const meta = fileEditMetaHtml(block);
    const title = fileEditTitleText(block);
    const diff = String(block.diff || "");
    const previewInline = diffPreviewLines(diff).join(" ").replace(/\s+/g, " ").slice(0, 120);
    const stateForKey = traceOpenState(scopeKey, expanded);
    return `<div class="trace">` +
      `<details class="trace-row file-edit${traceAnimClass(scopeKey)}" data-status="${status}" data-accordion="true"${traceRowAttrs(scopeKey, rowIndex, stateForKey)}>` +
        `<summary>` +
          `<span class="trace-chevron">▸</span>` +
          `<span class="trace-glyph">${glyph}</span>` +
          `<span class="trace-cmd">${window.miaMarkdown.escapeHtml(title)}</span>` +
          (!stateForKey.open && previewInline ? `<span class="trace-arg">${window.miaMarkdown.escapeHtml(previewInline)}</span>` : "") +
          meta +
        `</summary>` +
        traceAccordionBody(diff ? renderDiffBody(diff) : "") +
      `</details>` +
    `</div>`;
  }

  function renderRecapBlock(block, { expanded, scopeKey, rowIndex }) {
    const text = String(block.text || "");
    if (!text.trim()) return "";
    const stateForKey = traceOpenState(scopeKey, expanded);
    const previewInline = text.replace(/\s+/g, " ").slice(0, 120);
    return `<div class="trace">` +
      `<details class="trace-row recap${traceAnimClass(scopeKey)}" data-accordion="true"${traceRowAttrs(scopeKey, rowIndex, stateForKey)}>` +
        `<summary>` +
          `<span class="trace-chevron">▸</span>` +
          `<span class="trace-glyph">◆</span>` +
          `<span class="trace-cmd">Recap</span>` +
          (!stateForKey.open && previewInline ? `<span class="trace-arg">${window.miaMarkdown.escapeHtml(previewInline)}</span>` : "") +
        `</summary>` +
        traceAccordionBody(`<pre class="trace-body">${renderTraceText(text)}</pre>`) +
      `</details>` +
    `</div>`;
  }

  function fileEditTitleText(block) {
    const rawTitle = String(block.title || `${block.action || "edit"} ${block.path || ""}`).trim();
    const title = rawTitle.replace(/\s*\(\+\d+\s+-\d+\)\s*$/, "").trim();
    return title || "file edit";
  }

  function fileEditMetaHtml(block) {
    const additions = Number(block.additions || 0) || 0;
    const deletions = Number(block.deletions || 0) || 0;
    if (!additions && !deletions) return "";
    return `<span class="trace-meta diff-stats">` +
      `<span class="diff-stat diff-stat-add">+${window.miaMarkdown.escapeHtml(additions)}</span>` +
      `<span class="diff-stat diff-stat-del">-${window.miaMarkdown.escapeHtml(deletions)}</span>` +
    `</span>`;
  }

  function diffLineClass(line) {
    if (/^@@/.test(line)) return "diff-meta diff-hunk";
    if (/^(diff --git|index |@@|\+\+\+|---|\\ No newline)/.test(line)) return "diff-meta";
    if (line.startsWith("+")) return "diff-add";
    if (line.startsWith("-")) return "diff-del";
    return "diff-context";
  }

  function isDiffHeaderLine(line) {
    return /^(diff --git|index |\+\+\+|---)/.test(String(line || ""));
  }

  function visibleDiffLines(diff) {
    const lines = String(diff || "").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.filter((line) => !isDiffHeaderLine(line));
  }

  function diffPreviewLines(diff) {
    return visibleDiffLines(diff).filter((line) => !String(line || "").startsWith("@@"));
  }

  function parseHunkHeader(line) {
    const match = String(line || "").match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?/);
    if (!match) return null;
    return {
      oldLine: Number(match[1]) || 0,
      newLine: Number(match[3]) || 0
    };
  }

  function diffLineParts(line) {
    const text = String(line || "");
    if (text.startsWith("+") || text.startsWith("-") || text.startsWith(" ")) {
      return { marker: text.slice(0, 1), body: text.slice(1) };
    }
    return { marker: "", body: text };
  }

  function leadingIndentLength(text) {
    const match = String(text || "").match(/^[ \t]*/);
    return match ? match[0].length : 0;
  }

  function stripLeadingIndent(text, count) {
    const value = String(text || "");
    let idx = 0;
    while (idx < value.length && idx < count && (value[idx] === " " || value[idx] === "\t")) {
      idx += 1;
    }
    return value.slice(idx);
  }

  function sharedDiffCodeIndent(lines) {
    let minIndent = Infinity;
    for (const line of lines) {
      const text = String(line || "");
      if (!text || text.startsWith("@@") || text.startsWith("\\ No newline")) continue;
      const { body } = diffLineParts(text);
      if (!body.trim()) continue;
      minIndent = Math.min(minIndent, leadingIndentLength(body));
    }
    return Number.isFinite(minIndent) && minIndent >= 2 ? minIndent : 0;
  }

  function diffCodeText(line, trimIndent) {
    const { marker, body } = diffLineParts(line);
    return marker + stripLeadingIndent(body, trimIndent);
  }

  function renderDiffLine(line, className, lineLabel, trimIndent = 0) {
    return `<span class="diff-line ${className}">` +
      `<span class="diff-ln">${window.miaMarkdown.escapeHtml(lineLabel)}</span>` +
      `<span class="diff-code">${window.miaMarkdown.escapeHtml(diffCodeText(line, trimIndent))}</span>` +
    `</span>`;
  }

  function renderDiffBody(diff) {
    const lines = visibleDiffLines(diff);
    const trimIndent = sharedDiffCodeIndent(lines);
    let oldLine = 1;
    let newLine = 1;
    const html = lines.map((line) => {
      const cls = diffLineClass(line);
      const hunk = parseHunkHeader(line);
      if (hunk || line.startsWith("@@")) {
        if (hunk) {
          oldLine = hunk.oldLine;
          newLine = hunk.newLine;
        }
        return renderDiffLine("", cls, "···");
      }
      if (line.startsWith("-")) {
        const label = oldLine > 0 ? oldLine : "";
        oldLine += 1;
        return renderDiffLine(line, cls, label, trimIndent);
      }
      if (line.startsWith("+")) {
        const label = newLine > 0 ? newLine : "";
        newLine += 1;
        return renderDiffLine(line, cls, label, trimIndent);
      }
      const label = newLine > 0 ? newLine : (oldLine > 0 ? oldLine : "");
      oldLine += 1;
      newLine += 1;
      return renderDiffLine(line, cls, label, trimIndent);
    }).join("");
    return `<pre class="trace-body diff-body">${html}</pre>`;
  }

  function normalizeAssistantBlocks(blocks) {
    const api = window.miaAssistantContentBlocks;
    if (!api || typeof api.normalizeContentBlocks !== "function") return [];
    return api.normalizeContentBlocks(blocks);
  }

  function assistantTextFromBlocks(blocks) {
    return (Array.isArray(blocks) ? blocks : [])
      .filter((block) => block && block.type === "text")
      .map((block) => String(block.text || "").trim())
      .filter(Boolean)
      .join("\n\n");
  }

  function thinkingStatusText(block) {
    if (block.text) return block.text;
    if (block.status === "completed" && typeof block.duration === "number") return `已思考 ${Number(block.duration).toFixed(1)}s`;
    if (block.status === "completed") return "已思考";
    if (block.status === "error") return "思考失败";
    return "思考中";
  }

  function renderAssistantContentBlocks({ blocks, renderTextBlock, expanded, scopeKey }) {
    const normalized = normalizeAssistantBlocks(blocks);
    if (!normalized.length) return "";
    const assistantContent = assistantTextFromBlocks(normalized);
    const rows = [];
    for (let idx = 0; idx < normalized.length; idx++) {
      const block = normalized[idx];
      if (block.type === "text") {
        if (typeof renderTextBlock === "function") {
          rows.push(renderTextBlock(block, idx));
        }
      } else if (block.type === "thinking") {
        rows.push(renderTraceBlocks({
          reasoning: thinkingStatusText(block),
          tools: [],
          content: assistantContent,
          expanded,
          scopeKey: scopeKey ? `${scopeKey}::block::${idx}` : "",
          showReasoningWithoutTools: true
        }));
      } else if (block.type === "tool") {
        rows.push(renderTraceBlocks({
          reasoning: "",
          tools: [block],
          content: "",
          expanded,
          scopeKey: scopeKey ? `${scopeKey}::block::${idx}` : ""
        }));
      } else if (block.type === "recap") {
        rows.push(renderRecapBlock(block, {
          expanded,
          scopeKey: scopeKey ? `${scopeKey}::block::${idx}::recap::${block.id || idx}` : "",
          rowIndex: idx
        }));
      } else if (block.type === "file_edit") {
        rows.push(renderFileEditBlock(block, {
          expanded,
          scopeKey: scopeKey ? `${scopeKey}::block::${idx}::file_edit::${block.id || idx}` : "",
          rowIndex: idx
        }));
      }
    }
    return rows.join("");
  }

  function markRenderedTraceBlocks(root) {
    const animatedKeys = animatedTraceKeys();
    if (!animatedKeys) return;
    const scope = root && typeof root.querySelectorAll === "function"
      ? root
      : (typeof document !== "undefined" && document.querySelectorAll ? document : null);
    if (!scope) return;
    const rows = scope.querySelectorAll("details.trace-row[data-trace-key]");
    Array.prototype.forEach.call(rows, (row) => {
      const key = typeof row.getAttribute === "function"
        ? row.getAttribute("data-trace-key")
        : row.dataset?.traceKey;
      if (key) animatedKeys.add(key);
    });
  }

  window.miaTraceBlocks = {
    initTraceBlocks,
    normalizeTraceText,
    isDuplicateTraceReasoning,
    traceReasoningForDisplay,
    renderTraceText,
    renderTraceBlocks,
    renderAssistantContentBlocks,
    markRenderedTraceBlocks,
  };
})();
