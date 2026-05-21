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

  function traceReasoningForDisplay(reasoning, tools, content = "") {
    const text = String(reasoning || "").trim();
    if (!text) return "";
    const toolList = Array.isArray(tools) ? tools : [];
    if (isDuplicateTraceReasoning(text, content)) return "";
    if (!toolList.length) return "";
    return text;
  }

  function renderTraceBlocks({ reasoning, tools, content, expanded, scopeKey }) {
    if (!state) return "";
    const toolList = Array.isArray(tools) ? tools : [];
    const displayReasoning = traceReasoningForDisplay(reasoning, toolList, content);
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
      if (state.animatedTraceKeys.has(key)) return "";
      return " trace-anim-enter";
    };
    const rowAttrs = (key, idx, stateForKey) => {
      const attrs = [];
      if (key) attrs.push(`data-trace-key="${window.aimashiMarkdown.escapeHtml(key)}"`);
      if (stateForKey.open) attrs.push("open");
      if (stateForKey.open && stateForKey.userOpen) {
        attrs.push('data-user-open="true"');
      } else if (stateForKey.open) {
        attrs.push('data-auto-open="true"');
      }
      if (key && !state.animatedTraceKeys.has(key)) {
        attrs.push(`style="--trace-delay:${Math.min(idx, 6) * 60}ms"`);
      }
      return attrs.length ? ` ${attrs.join(" ")}` : "";
    };
    if (displayReasoning) {
      const reasoningText = displayReasoning;
      const key = scopeKey ? `${scopeKey}::reasoning` : "";
      const stateForKey = openState(key);
      rows.push(
        `<details class="trace-row reasoning${animClass(key)}"${rowAttrs(key, rows.length, stateForKey)}>` +
          `<summary><span class="trace-chevron">▸</span><span class="trace-cmd">thinking</span><span class="trace-arg">${window.aimashiMarkdown.escapeHtml(reasoningText.slice(0, 80).replace(/\s+/g, " "))}</span></summary>` +
          `<pre class="trace-body">${window.aimashiMarkdown.escapeHtml(reasoningText)}</pre>` +
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
        `<details class="trace-row tool${animClass(key)}" data-status="${status}"${rowAttrs(key, rows.length, stateForKey)}>` +
          `<summary>` +
            `<span class="trace-chevron">▸</span>` +
            `<span class="trace-glyph">${glyph}</span>` +
            `<span class="trace-cmd">${window.aimashiMarkdown.escapeHtml(name)}</span>` +
            (previewInline ? `<span class="trace-arg">${window.aimashiMarkdown.escapeHtml(previewInline)}</span>` : "") +
            (meta ? `<span class="trace-meta">${window.aimashiMarkdown.escapeHtml(meta)}</span>` : "") +
          `</summary>` +
          (preview ? `<pre class="trace-body">${window.aimashiMarkdown.escapeHtml(preview)}</pre>` : "") +
        `</details>`
      );
    }
    return `<div class="trace">${rows.join("")}</div>`;
  }

  window.aimashiTraceBlocks = {
    initTraceBlocks,
    normalizeTraceText,
    isDuplicateTraceReasoning,
    traceReasoningForDisplay,
    renderTraceBlocks,
  };
})();
