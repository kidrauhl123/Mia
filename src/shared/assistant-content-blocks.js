(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.miaAssistantContentBlocks = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function () {
  "use strict";

  const MAX_BLOCKS = 200;
  const MAX_PREVIEW_LENGTH = 4000;
  const MAX_DIFF_LENGTH = 20000;

  function safeString(value) {
    return value == null ? "" : String(value);
  }

  function finiteDuration(value) {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function nonNegativeInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  function normalizeStatus(value) {
    const status = safeString(value).trim().toLowerCase();
    if (status === "complete" || status === "completed" || status === "done") return "completed";
    if (status === "error" || status === "failed" || status === "failure") return "error";
    return "running";
  }

  function eventType(event = {}) {
    return safeString(event.type || event.event || event.kind || "");
  }

  function eventText(event = {}) {
    for (const key of ["reasoning", "delta", "content_delta", "text_delta", "text", "content", "final_response"]) {
      if (typeof event[key] === "string") return event[key];
    }
    const data = event.data && typeof event.data === "object" ? event.data : null;
    return data ? eventText(data) : "";
  }

  function eventId(event = {}, fallback) {
    const id = safeString(event.id || event.msg_id || event.message_id || event.item_id || "").trim();
    return id || fallback;
  }

  function normalizeInputBlocks(input) {
    if (Array.isArray(input)) return input;
    if (typeof input === "string" && input.trim()) {
      try {
        const parsed = JSON.parse(input);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  }

  function normalizeFileAction(value) {
    const action = safeString(value).trim().toLowerCase();
    if (action === "add" || action === "added" || action === "create" || action === "created") return "add";
    if (action === "delete" || action === "deleted" || action === "remove" || action === "removed") return "delete";
    return "update";
  }

  function mergeThinkingBlock(target, source) {
    const text = safeString(source.text);
    if (text) target.text = `${target.text || ""}${text}`;
    if (source.status === "error" || source.status === "completed") target.status = source.status;
    if (source.duration != null) target.duration = source.duration;
    return target;
  }

  function fileEditVerb(action) {
    if (action === "add") return "Added";
    if (action === "delete") return "Deleted";
    return "Edited";
  }

  function fileEditTitle({ title, action, path, additions, deletions }) {
    const explicit = safeString(title).trim();
    if (explicit) return explicit;
    const stats = additions || deletions ? ` (+${additions} -${deletions})` : "";
    return `${fileEditVerb(action)} ${path}${stats}`;
  }

  function normalizeContentBlocks(input) {
    const raw = normalizeInputBlocks(input);
    const out = [];
    for (let idx = 0; idx < raw.length && out.length < MAX_BLOCKS; idx += 1) {
      const block = raw[idx];
      if (!block || typeof block !== "object") continue;
      const type = safeString(block.type).trim();
      if (type === "text") {
        const text = safeString(block.text);
        if (!text.trim()) continue;
        out.push({
          type: "text",
          id: safeString(block.id || `text_${out.length}`).trim() || `text_${out.length}`,
          text
        });
      } else if (type === "thinking") {
        const text = safeString(block.text);
        const normalized = {
          type: "thinking",
          id: safeString(block.id || `thinking_${out.length}`).trim() || `thinking_${out.length}`,
          status: normalizeStatus(block.status),
          duration: finiteDuration(block.duration)
        };
        if (text.trim()) normalized.text = text;
        if (!normalized.text && !safeString(block.status).trim() && normalized.duration == null) continue;
        if (out[out.length - 1]?.type === "thinking") {
          mergeThinkingBlock(out[out.length - 1], normalized);
          continue;
        }
        out.push(normalized);
      } else if (type === "tool") {
        const name = safeString(block.name).trim();
        if (!name) continue;
        const preview = safeString(block.preview).slice(0, MAX_PREVIEW_LENGTH);
        out.push({
          type: "tool",
          id: safeString(block.id || `tool_${out.length}`).trim() || `tool_${out.length}`,
          name,
          preview,
          status: block.error ? "error" : normalizeStatus(block.status),
          duration: finiteDuration(block.duration),
          error: Boolean(block.error)
        });
      } else if (type === "file_edit") {
        const filePath = safeString(block.path || block.file || block.file_path).trim();
        if (!filePath) continue;
        const action = normalizeFileAction(block.action || block.kind);
        const additions = nonNegativeInt(block.additions);
        const deletions = nonNegativeInt(block.deletions);
        const diff = safeString(block.diff || block.preview).slice(0, MAX_DIFF_LENGTH);
        out.push({
          type: "file_edit",
          id: safeString(block.id || `file_edit_${out.length}`).trim() || `file_edit_${out.length}`,
          path: filePath,
          action,
          title: fileEditTitle({
            title: block.title || block.name,
            action,
            path: filePath,
            additions,
            deletions
          }),
          diff,
          additions,
          deletions,
          status: block.error ? "error" : normalizeStatus(block.status),
          error: Boolean(block.error)
        });
      }
    }
    return out;
  }

  function appendTextSegment(currentText, nextText) {
    const current = safeString(currentText);
    const next = safeString(nextText);
    if (!current) return next;
    return /[\r\n]\s*$/.test(current) || /^\s*[\r\n]/.test(next)
      ? `${current}${next}`
      : `${current}\n\n${next}`;
  }

  function bodyMdFromContentBlocks(input) {
    const textBlocks = normalizeContentBlocks(input)
      .filter((block) => block.type === "text")
      .map((block) => block.text);
    let body = "";
    for (const text of textBlocks) {
      body = appendTextSegment(body, text);
    }
    return body.trim();
  }

  function textWithoutWhitespace(value) {
    return safeString(value).replace(/\s+/g, "");
  }

  function suffixAfterWhitespaceInsensitivePrefix(fullText, prefixText) {
    const full = safeString(fullText);
    const prefix = textWithoutWhitespace(prefixText);
    if (!prefix) return full.trim();
    let matched = 0;
    let index = 0;
    while (index < full.length && matched < prefix.length) {
      const ch = full[index];
      if (/\s/.test(ch)) {
        index += 1;
        continue;
      }
      if (ch !== prefix.charAt(matched)) return null;
      matched += 1;
      index += 1;
    }
    if (matched !== prefix.length) return null;
    return full.slice(index).trim();
  }

  function mergeAssistantText(currentText, nextText) {
    const current = safeString(currentText);
    const next = safeString(nextText);
    const currentTrim = current.trim();
    const nextTrim = next.trim();
    if (!nextTrim) return { kind: "noop", text: current, delta: "" };
    if (!currentTrim) return { kind: "start", text: next, delta: next };
    if (currentTrim === nextTrim) return { kind: "noop", text: current, delta: "" };
    if (currentTrim.startsWith(nextTrim)) return { kind: "noop", text: current, delta: "" };
    if (next.startsWith(current)) {
      return { kind: "extend", text: next, delta: next.slice(current.length) };
    }
    return { kind: "append", text: appendTextSegment(current, next), delta: next };
  }

  function stripLegacyDuplicateFinalTextBlock(blocks) {
    if (!Array.isArray(blocks) || blocks.length < 2) return blocks;
    const last = blocks[blocks.length - 1];
    if (last?.type !== "text" || !/^text_final_/i.test(safeString(last.id).trim())) return blocks;
    const previous = blocks.slice(0, -1);
    const previousBody = bodyMdFromContentBlocks(previous);
    if (!previousBody) return blocks;
    const lastText = safeString(last.text).trim();
    if (!lastText) return previous;
    if (previousBody === lastText) return previous;
    if (textWithoutWhitespace(previousBody) === textWithoutWhitespace(lastText)) return previous;
    const suffix = suffixAfterWhitespaceInsensitivePrefix(lastText, previousBody);
    if (suffix == null) return blocks;
    if (!suffix) return previous;
    return normalizeContentBlocks([
      ...previous,
      {
        ...last,
        text: suffix
      }
    ]);
  }

  function finalTextToAppend(blocks, finalText) {
    const final = safeString(finalText).trim();
    if (!final) return "";
    const normalized = stripLegacyDuplicateFinalTextBlock(normalizeContentBlocks(blocks));
    const textBlocks = normalized.filter((block) => block.type === "text");
    const current = bodyMdFromContentBlocks(normalized);
    if (!current) return final;
    if (current === final) return "";
    if (textBlocks.some((block) => block.text.trim() === final)) return "";
    if (final.startsWith(current)) return final.slice(current.length).trim();
    if (textBlocks.length > 1) {
      const currentNoWhitespace = textWithoutWhitespace(current);
      const finalNoWhitespace = textWithoutWhitespace(final);
      if (currentNoWhitespace && currentNoWhitespace === finalNoWhitespace) return "";
      if (textBlocks.some((block) => textWithoutWhitespace(block.text) === finalNoWhitespace)) return "";
      if (currentNoWhitespace && finalNoWhitespace.startsWith(currentNoWhitespace)) {
        const suffix = suffixAfterWhitespaceInsensitivePrefix(final, current);
        if (suffix != null) return suffix;
      }
    }
    return final;
  }

  function contentBlocksWithFinalText(input, finalText) {
    const blocks = stripLegacyDuplicateFinalTextBlock(normalizeContentBlocks(input));
    const text = finalTextToAppend(blocks, finalText);
    if (!text) return blocks;
    return normalizeContentBlocks([
      ...blocks,
      {
        type: "text",
        id: `text_final_${blocks.length}`,
        text
      }
    ]);
  }

  function contentBlocksWithDisplayText(input, displayText) {
    const blocks = normalizeContentBlocks(input);
    if (arguments.length < 2) return blocks;
    let remaining = safeString(displayText);
    const out = [];
    for (const block of blocks) {
      if (block.type !== "text") {
        out.push(block);
        continue;
      }
      if (!remaining) continue;
      const text = remaining.slice(0, block.text.length);
      remaining = remaining.slice(text.length);
      if (text.trim()) out.push({ ...block, text });
    }
    return out;
  }

  function createStreamingTextSmoother(options = {}) {
    const charsPerFrame = Math.max(1, nonNegativeInt(options.charsPerFrame) || 4);
    const schedule = typeof options.schedule === "function"
      ? options.schedule
      : (fn) => setTimeout(fn, 16);
    const cancel = typeof options.cancel === "function"
      ? options.cancel
      : (handle) => clearTimeout(handle);
    const onUpdate = typeof options.onUpdate === "function" ? options.onUpdate : () => {};
    const states = new Map();

    function step(run) {
      const state = states.get(run);
      if (!state) return;
      state.handle = null;
      const current = safeString(run.displayText);
      const next = state.target.slice(0, Math.min(state.target.length, current.length + charsPerFrame));
      if (next !== current) {
        run.displayText = next;
        onUpdate(run);
      }
      if (run.displayText.length < state.target.length) {
        state.handle = schedule(() => step(run));
      }
    }

    function enqueue(run, text) {
      if (!run || typeof run !== "object") return;
      const target = safeString(text);
      const state = states.get(run) || { target: "", handle: null };
      state.target = target;
      states.set(run, state);
      const current = safeString(run.displayText);
      if (!target.startsWith(current)) run.displayText = "";
      else if (run.displayText == null) run.displayText = "";
      if (!state.handle && safeString(run.displayText).length < target.length) {
        state.handle = schedule(() => step(run));
      }
    }

    function flush(run) {
      const state = states.get(run);
      if (!state) return;
      if (state.handle) cancel(state.handle);
      state.handle = null;
      run.displayText = state.target;
      onUpdate(run);
      states.delete(run);
    }

    return { enqueue, flush };
  }

  function createAssistantContentBlockCollector() {
    const blocks = [];
    const toolsById = new Map();
    const toolsByName = new Map();
    const thinkingBlocksByEventId = new Map();

    function nextId(prefix) {
      return `${prefix}_${blocks.length}`;
    }

    function rememberTool(tool) {
      if (tool.id) toolsById.set(tool.id, tool);
      const queue = toolsByName.get(tool.name) || [];
      queue.push(tool);
      toolsByName.set(tool.name, queue);
    }

    function toolFromEvent(event = {}) {
      const id = safeString(event.id || event.tool_call_id || "").trim();
      const name = safeString(event.tool || event.name || event.data?.tool || "").trim();
      let tool = id ? toolsById.get(id) : null;
      if (!tool && name) {
        const queue = toolsByName.get(name);
        tool = queue && [...queue].reverse().find((item) => item.status === "running");
      }
      if (!tool && !id && !name) {
        tool = [...blocks].reverse().find((item) => item.type === "tool" && item.status === "running");
      }
      return tool || null;
    }

    function appendText(event = {}) {
      const text = eventText(event);
      if (!text) return;
      const explicitId = safeString(event.id || event.msg_id || event.message_id || event.item_id || "").trim();
      const last = blocks[blocks.length - 1];
      if (last && last.type === "text" && (!explicitId || last.id === explicitId)) {
        last.text += text;
        return;
      }
      const id = explicitId || nextId("text");
      blocks.push({ type: "text", id, text });
    }

    function updateRecentThinking(event = {}) {
      const id = safeString(event.id || event.msg_id || event.message_id || "").trim();
      const match = (id ? thinkingBlocksByEventId.get(id) : null)
        || [...blocks].reverse().find((block) => block.type === "thinking" && (!id || block.id === id));
      const status = normalizeStatus(event.status || event.state || "completed");
      const duration = finiteDuration(event.duration);
      if (match) {
        match.status = status;
        if (duration != null) match.duration = duration;
        return;
      }
      blocks.push({
        type: "thinking",
        id: id || nextId("thinking"),
        status,
        duration
      });
      if (id) thinkingBlocksByEventId.set(id, blocks[blocks.length - 1]);
    }

    function appendThinking(event = {}) {
      const text = eventText(event);
      if (!text) {
        if (event.status || event.state || event.duration != null) updateRecentThinking(event);
        return;
      }
      const explicitId = safeString(event.id || event.msg_id || event.message_id || event.item_id || "").trim();
      const last = blocks[blocks.length - 1];
      if (last && last.type === "thinking") {
        last.text = `${last.text || ""}${text}`;
        last.status = normalizeStatus(event.status || last.status || "running");
        if (event.duration != null) last.duration = finiteDuration(event.duration);
        if (explicitId) thinkingBlocksByEventId.set(explicitId, last);
        return;
      }
      blocks.push({
        type: "thinking",
        id: explicitId || nextId("thinking"),
        text,
        status: normalizeStatus(event.status || "running"),
        duration: finiteDuration(event.duration)
      });
      if (explicitId) thinkingBlocksByEventId.set(explicitId, blocks[blocks.length - 1]);
    }

    function appendTool(event = {}) {
      const name = safeString(event.tool || event.name || event.data?.tool || "工具").trim() || "工具";
      const tool = {
        type: "tool",
        id: eventId(event, nextId("tool")),
        name,
        preview: safeString(event.preview || event.input || event.data?.input || "").slice(0, MAX_PREVIEW_LENGTH),
        status: "running",
        duration: null,
        error: false
      };
      blocks.push(tool);
      rememberTool(tool);
    }

    function updateToolDelta(event = {}) {
      const tool = toolFromEvent(event);
      if (!tool) return;
      const preview = safeString(event.preview || event.delta || event.input || event.data?.preview || "");
      if (preview) tool.preview = preview.slice(0, MAX_PREVIEW_LENGTH);
    }

    function completeTool(event = {}) {
      let tool = toolFromEvent(event);
      if (!tool) {
        appendTool(event);
        tool = blocks[blocks.length - 1];
      }
      tool.status = event.error || event.data?.error ? "error" : normalizeStatus(event.status || "completed");
      tool.duration = finiteDuration(event.duration);
      tool.error = Boolean(event.error || event.data?.error);
      const preview = safeString(event.preview || event.output || event.data?.preview || "");
      if (preview) tool.preview = preview.slice(0, MAX_PREVIEW_LENGTH);
    }

    function appendFileEdit(event = {}) {
      const filePath = safeString(event.path || event.file || event.file_path || event.data?.path || "").trim();
      if (!filePath) return;
      const action = normalizeFileAction(event.action || event.kind || event.data?.kind);
      const additions = nonNegativeInt(event.additions || event.data?.additions);
      const deletions = nonNegativeInt(event.deletions || event.data?.deletions);
      blocks.push({
        type: "file_edit",
        id: eventId(event, nextId("file_edit")),
        path: filePath,
        action,
        title: fileEditTitle({
          title: event.title || event.name,
          action,
          path: filePath,
          additions,
          deletions
        }),
        diff: safeString(event.diff || event.preview || event.data?.diff || "").slice(0, MAX_DIFF_LENGTH),
        additions,
        deletions,
        status: normalizeStatus(event.status || "completed"),
        error: Boolean(event.error || event.data?.error)
      });
    }

    function collect(kindOrEvent, data = {}) {
      const event = typeof kindOrEvent === "object" && kindOrEvent
        ? kindOrEvent
        : { type: kindOrEvent, ...(data && typeof data === "object" ? data : {}) };
      const name = eventType(event);
      if (name === "message.delta" || name === "text_delta") {
        appendText(event);
      } else if (name === "message.complete" || name === "message.completed") {
        if (!blocks.some((block) => block.type === "text")) appendText(event);
      } else if (name === "reasoning.available" || name === "reasoning_delta" || name === "reasoning.delta" || name === "thinking_delta" || name === "thinking.delta") {
        appendThinking(event);
      } else if (name === "reasoning.done" || name === "reasoning.completed" || name === "thinking.done" || name === "thinking.completed") {
        updateRecentThinking(event);
      } else if (name === "tool.started" || name === "tool.start" || name === "tool_call_started") {
        appendTool(event);
      } else if (name === "tool.delta" || name === "tool.progress" || name === "tool_call_delta") {
        updateToolDelta(event);
      } else if (name === "tool.completed" || name === "tool.complete" || name === "tool_call_completed") {
        completeTool(event);
      } else if (name === "file_edit" || name === "file.edit" || name === "file_edit.completed") {
        appendFileEdit(event);
      }
    }

    function payload(finalText = "") {
      if (!blocks.length) return [];
      return contentBlocksWithFinalText(blocks, finalText);
    }

    return { collect, payload };
  }

  return {
    MAX_BLOCKS,
    MAX_DIFF_LENGTH,
    MAX_PREVIEW_LENGTH,
    bodyMdFromContentBlocks,
    contentBlocksWithDisplayText,
    contentBlocksWithFinalText,
    createAssistantContentBlockCollector,
    createStreamingTextSmoother,
    mergeAssistantText,
    normalizeContentBlocks,
    normalizeStatus
  };
});
