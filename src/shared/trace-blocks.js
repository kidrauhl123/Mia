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
  const lazyTraceBodies = new Map();
  const MAX_LAZY_TRACE_BODIES = 512;

  function rememberLazyTraceBody(key, render) {
    if (!key || typeof render !== "function") return;
    lazyTraceBodies.set(key, render);
    while (lazyTraceBodies.size > MAX_LAZY_TRACE_BODIES) {
      const oldest = lazyTraceBodies.keys().next().value;
      if (oldest == null) break;
      lazyTraceBodies.delete(oldest);
    }
  }

  function traceBodyHtml({ key = "", open = false, render } = {}) {
    if (typeof render !== "function") return "";
    rememberLazyTraceBody(key, render);
    if (open || !key) {
      return `<div class="trace-accordion-body accordion-body">${render()}</div>`;
    }
    return `<div class="trace-accordion-body accordion-body" data-lazy-trace-body="true"></div>`;
  }

  function traceInlinePreview(value, maxLength = 120) {
    return String(value || "").slice(0, maxLength).replace(/\s+/g, " ");
  }

  function processDurationSeconds(entries = []) {
    return (Array.isArray(entries) ? entries : []).reduce((total, entry) => {
      const duration = Number(entry?.duration);
      return Number.isFinite(duration) && duration > 0 ? total + duration : total;
    }, 0);
  }

  function formatProcessDuration(seconds) {
    const totalSeconds = Math.round(Number(seconds) || 0);
    if (totalSeconds <= 0) return "";
    const minutes = Math.floor(totalSeconds / 60);
    const remainder = totalSeconds % 60;
    if (!minutes) return `${remainder}s`;
    return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  }

  function traceKeyFromRow(row) {
    if (!row) return "";
    if (typeof row.getAttribute === "function") return String(row.getAttribute("data-trace-key") || "");
    return String(row.dataset?.traceKey || "");
  }

  function hydrateTraceRow(row) {
    const key = traceKeyFromRow(row);
    const render = key ? lazyTraceBodies.get(key) : null;
    const target = row?.querySelector?.("[data-lazy-trace-body]");
    if (!render || !target) return false;
    target.innerHTML = render();
    target.removeAttribute?.("data-lazy-trace-body");
    if (target.dataset) target.dataset.traceBodyLoaded = "true";
    return true;
  }

  function releaseTraceRow(row) {
    const target = row?.querySelector?.(".trace-accordion-body[data-trace-body-loaded='true']")
      || row?.querySelector?.(".trace-accordion-body[data-lazy-trace-body='true']");
    if (!target || !target.dataset?.traceBodyLoaded) return false;
    target.innerHTML = "";
    target.dataset.traceBodyLoaded = "";
    target.setAttribute?.("data-lazy-trace-body", "true");
    return true;
  }

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

  function isMiaMemoryTool(name) {
    const normalized = String(name || "").trim().toLowerCase();
    return normalized === "memory"
      || normalized === "mcp.mia-app.memory"
      || normalized === "mcp__mia_app__memory";
  }

  function miaMemoryToolPresentation(tool = {}, status = "run") {
    if (!isMiaMemoryTool(tool.name)) return null;
    if (status === "err") {
      return { glyph: "🧠", title: "记忆未更新", body: "未能更新当前 Bot 的记忆。" };
    }
    if (status === "run") {
      return { glyph: "🧠", title: "正在记录记忆", body: "正在更新当前 Bot 的记忆。" };
    }
    return { glyph: "🧠", title: "记忆已更新", body: "已更新当前 Bot 的记忆。" };
  }

  function renderTraceBlocks({ reasoning, tools, content, expanded, scopeKey, showReasoningWithoutTools, completed = false, durationSeconds = 0 }) {
    if (!state) return "";
    const animatedKeys = animatedTraceKeys();
    const defaultExpanded = completed || Boolean(expanded);
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
        open: userOpen || (!userClosed && defaultExpanded),
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
          traceBodyHtml({
            key,
            open: stateForKey.open,
            render: () => `<pre class="trace-body">${renderTraceText(reasoningText)}</pre>`
          }) +
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
      const memoryPresentation = miaMemoryToolPresentation(tool, status);
      const displayName = memoryPresentation?.title || name;
      const displayGlyph = memoryPresentation?.glyph || glyph;
      const displayBody = memoryPresentation?.body || tool.body || preview;
      const previewInline = traceInlinePreview(memoryPresentation?.body || preview);
      const key = scopeKey ? `${scopeKey}::tool::${tool.id || idx}` : "";
      const stateForKey = openState(key);
      rows.push(
        `<details class="trace-row tool${memoryPresentation ? " memory-tool" : ""}${animClass(key)}" data-status="${status}" data-accordion="true"${rowAttrs(key, rows.length, stateForKey)}>` +
          `<summary>` +
            `<span class="trace-chevron">▸</span>` +
            `<span class="trace-glyph${memoryPresentation ? " trace-memory-glyph" : ""}">${displayGlyph}</span>` +
            `<span class="trace-cmd">${window.miaMarkdown.escapeHtml(displayName)}</span>` +
            (!stateForKey.open && previewInline ? `<span class="trace-arg">${window.miaMarkdown.escapeHtml(previewInline)}</span>` : "") +
            (meta ? `<span class="trace-meta">${window.miaMarkdown.escapeHtml(meta)}</span>` : "") +
          `</summary>` +
          traceBodyHtml({
            key,
            open: stateForKey.open,
            render: () => displayBody ? `<pre class="trace-body">${renderTraceText(displayBody)}</pre>` : ""
          }) +
        `</details>`
      );
    }
    const traceHtml = `<div class="trace">${rows.join("")}</div>`;
    if (!completed) return traceHtml;
    return renderAssistantProcessDetails({
      processKey: scopeKey ? `${scopeKey}::process` : "",
      durationSeconds: Number(durationSeconds) > 0 ? Number(durationSeconds) : processDurationSeconds(toolList),
      render: () => traceHtml
    });
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

  function renderAssistantProcessDetails({ processKey, durationSeconds, render }) {
    const processState = traceOpenState(processKey, false);
    const durationText = formatProcessDuration(durationSeconds);
    return `<div class="trace assistant-process-trace">` +
      `<details class="trace-row assistant-process${traceAnimClass(processKey)}" data-accordion="true"${traceRowAttrs(processKey, 0, processState)}>` +
        `<summary>` +
          `<span class="assistant-process-label">已处理</span>` +
          (durationText ? `<span class="assistant-process-duration">${window.miaMarkdown.escapeHtml(durationText)}</span>` : "") +
          `<span class="trace-chevron" aria-hidden="true"></span>` +
        `</summary>` +
        traceBodyHtml({
          key: processKey,
          open: processState.open,
          render: () => `<div class="assistant-process-content">${render()}</div>`
        }) +
      `</details>` +
    `</div>`;
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
        traceBodyHtml({
          key: scopeKey,
          open: stateForKey.open,
          render: () => diff ? renderDiffBody(diff) : ""
        }) +
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
        traceBodyHtml({
          key: scopeKey,
          open: stateForKey.open,
          render: () => `<pre class="trace-body">${renderTraceText(text)}</pre>`
        }) +
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

  function renderAssistantBlockEntries({
    entries,
    renderTextBlock,
    expanded,
    scopeKey,
    assistantContent,
    process = false
  }) {
    const rows = [];
    for (const entry of entries) {
      const { block, index: idx } = entry;
      if (block.type === "text") {
        if (typeof renderTextBlock === "function") {
          rows.push(renderTextBlock(block, idx, { process, final: false }));
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

  function renderCompletedAssistantContent({
    normalized,
    renderTextBlock,
    scopeKey,
    assistantContent,
    durationSeconds
  }) {
    let finalTextIndex = -1;
    for (let idx = normalized.length - 1; idx >= 0; idx -= 1) {
      if (normalized[idx]?.type === "text" && String(normalized[idx].text || "").trim()) {
        finalTextIndex = idx;
        break;
      }
    }
    if (finalTextIndex < 0 || normalized.length < 2) return "";
    const entries = normalized.map((block, index) => ({ block, index }));
    const processEntries = entries.filter((entry) => entry.index !== finalTextIndex);
    if (!processEntries.length) return "";
    const processKey = scopeKey ? `${scopeKey}::process` : "";
    const processHtml = () => renderAssistantBlockEntries({
      entries: processEntries,
      renderTextBlock,
      expanded: true,
      scopeKey,
      assistantContent,
      process: true
    });
    const processDetails = renderAssistantProcessDetails({
      processKey,
      durationSeconds: Number(durationSeconds) > 0
        ? Number(durationSeconds)
        : processDurationSeconds(processEntries.map((entry) => entry.block)),
      render: processHtml
    });
    const finalBlock = normalized[finalTextIndex];
    const finalHtml = typeof renderTextBlock === "function"
      ? renderTextBlock(finalBlock, finalTextIndex, { process: false, final: true })
      : "";
    return `${processDetails}${finalHtml}`;
  }

  function renderAssistantContentBlocks({ blocks, renderTextBlock, expanded, scopeKey, completed = false, durationSeconds = 0 }) {
    const normalized = normalizeAssistantBlocks(blocks);
    if (!normalized.length) return "";
    const assistantContent = assistantTextFromBlocks(normalized);
    if (completed) {
      const completedHtml = renderCompletedAssistantContent({
        normalized,
        renderTextBlock,
        scopeKey,
        assistantContent,
        durationSeconds
      });
      if (completedHtml) return completedHtml;
    }
    return renderAssistantBlockEntries({
      entries: normalized.map((block, index) => ({ block, index })),
      renderTextBlock,
      expanded,
      scopeKey,
      assistantContent
    });
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
    isMiaMemoryTool,
    miaMemoryToolPresentation,
    renderTraceBlocks,
    renderAssistantContentBlocks,
    hydrateTraceRow,
    releaseTraceRow,
    markRenderedTraceBlocks,
  };
})();
