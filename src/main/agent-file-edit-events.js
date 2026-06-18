const fs = require("node:fs");
const path = require("node:path");

const MAX_FILE_DIFF_PREVIEW = 20000;
const MAX_WORKSPACE_SCAN_FILES = 2000;
const MAX_WORKSPACE_SCAN_DEPTH = 8;
const MAX_WORKSPACE_TEXT_BYTES = 256 * 1024;
const DEFAULT_DIFF_CONTEXT_LINES = 3;

const SKIP_WORKSPACE_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "release",
  "build",
  ".next",
  ".turbo",
  "coverage"
]);

function safeString(value) {
  return value == null ? "" : String(value);
}

function safeFilePath(value) {
  return safeString(value).trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function nonNegativeInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function normalizeFileAction(value, fallback = "update") {
  const action = safeString(value).trim().toLowerCase();
  if (["add", "added", "create", "created", "new"].includes(action)) return "add";
  if (["delete", "deleted", "remove", "removed"].includes(action)) return "delete";
  if (["update", "updated", "edit", "edited", "modify", "modified"].includes(action)) return "update";
  return fallback;
}

function normalizeStatus(value, fallback = "completed") {
  const status = safeString(value).trim().toLowerCase();
  if (["complete", "completed", "done", "success", "succeeded"].includes(status)) return "completed";
  if (["error", "failed", "failure"].includes(status)) return "failed";
  if (status) return status;
  return fallback;
}

function diffStats(diff = "") {
  let additions = 0;
  let deletions = 0;
  for (const line of safeString(diff).split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
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

function truncateDiff(diff = "") {
  const text = safeString(diff);
  if (text.length <= MAX_FILE_DIFF_PREVIEW) return text;
  return `${text.slice(0, MAX_FILE_DIFF_PREVIEW)}\n... diff truncated ...`;
}

function splitDiffLines(text = "") {
  const normalized = safeString(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized) return [];
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let idx = 0;
  while (idx < max && a[idx] === b[idx]) idx += 1;
  return idx;
}

function commonSuffixLength(a, b, prefixLength) {
  const max = Math.min(a.length, b.length) - prefixLength;
  let count = 0;
  while (count < max && a[a.length - 1 - count] === b[b.length - 1 - count]) count += 1;
  return count;
}

function hunkRange(startIndex, count) {
  const startLine = count > 0 ? startIndex + 1 : startIndex;
  return `${startLine},${count}`;
}

function unifiedDiffFromTextPair({ path, oldText = "", newText = "", contextLines = DEFAULT_DIFF_CONTEXT_LINES } = {}) {
  const filePath = safeFilePath(path);
  if (!filePath) return "";
  const oldLines = splitDiffLines(oldText);
  const newLines = splitDiffLines(newText);
  const prefix = commonPrefixLength(oldLines, newLines);
  if (prefix === oldLines.length && prefix === newLines.length) return "";
  const suffix = commonSuffixLength(oldLines, newLines, prefix);
  const oldChangeEnd = oldLines.length - suffix;
  const newChangeEnd = newLines.length - suffix;
  const context = Math.max(0, nonNegativeInt(contextLines));
  const oldHunkStart = Math.max(0, prefix - context);
  const newHunkStart = Math.max(0, prefix - context);
  const oldHunkEnd = Math.min(oldLines.length, oldChangeEnd + context);
  const newHunkEnd = Math.min(newLines.length, newChangeEnd + context);
  const oldCount = oldHunkEnd - oldHunkStart;
  const newCount = newHunkEnd - newHunkStart;
  const hunkLines = [];
  for (let idx = oldHunkStart; idx < prefix; idx += 1) hunkLines.push(` ${oldLines[idx]}`);
  for (let idx = prefix; idx < oldChangeEnd; idx += 1) hunkLines.push(`-${oldLines[idx]}`);
  for (let idx = prefix; idx < newChangeEnd; idx += 1) hunkLines.push(`+${newLines[idx]}`);
  for (let idx = oldChangeEnd; idx < oldHunkEnd; idx += 1) hunkLines.push(` ${oldLines[idx]}`);
  return [
    `diff --git a/${filePath} b/${filePath}`,
    oldLines.length ? `--- a/${filePath}` : "--- /dev/null",
    newLines.length ? `+++ b/${filePath}` : "+++ /dev/null",
    `@@ -${hunkRange(oldHunkStart, oldCount)} +${hunkRange(newHunkStart, newCount)} @@`,
    ...hunkLines
  ].join("\n");
}

function pathFromUnifiedDiff(diff = "") {
  const text = safeString(diff);
  const git = text.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  if (git) return safeFilePath(git[2] === "/dev/null" ? git[1] : git[2]);
  const plus = text.match(/^\+\+\+\s+(?:b\/)?(.+)$/m);
  if (plus && plus[1] !== "/dev/null") return safeFilePath(plus[1]);
  const minus = text.match(/^---\s+(?:a\/)?(.+)$/m);
  if (minus && minus[1] !== "/dev/null") return safeFilePath(minus[1]);
  return "";
}

function actionFromUnifiedDiff(diff = "") {
  const text = safeString(diff);
  if (/^---\s+\/dev\/null$/m.test(text)) return "add";
  if (/^\+\+\+\s+\/dev\/null$/m.test(text)) return "delete";
  return "update";
}

function fileEditPayloadFromUnifiedDiff(diff, options = {}) {
  const rawDiff = safeString(diff);
  if (!rawDiff.trim()) return null;
  const filePath = safeFilePath(options.path || pathFromUnifiedDiff(rawDiff));
  if (!filePath) return null;
  const stats = diffStats(rawDiff);
  const hasAdditions = options.additions !== undefined && options.additions !== null && options.additions !== "";
  const hasDeletions = options.deletions !== undefined && options.deletions !== null && options.deletions !== "";
  const additions = hasAdditions
    ? nonNegativeInt(options.additions)
    : stats.additions;
  const deletions = hasDeletions
    ? nonNegativeInt(options.deletions)
    : stats.deletions;
  const action = normalizeFileAction(
    options.action,
    actionFromUnifiedDiff(rawDiff)
  );
  const status = normalizeStatus(options.status, "completed");
  const error = Boolean(options.error || status === "failed" || status === "error");
  return {
    id: safeString(options.id || "file_edit").trim() || "file_edit",
    path: filePath,
    action,
    title: fileEditTitle({
      title: options.title || options.name,
      action,
      path: filePath,
      additions,
      deletions
    }),
    diff: truncateDiff(rawDiff),
    additions,
    deletions,
    status,
    error
  };
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function normalizeDiffItems(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(normalizeDiffItems);
  if (typeof value === "string") return [{ diff: value }];
  if (typeof value !== "object") return [];
  const directType = safeString(value.type || value.kind).trim().toLowerCase();
  if (directType === "diff" || directType === "file_diff" || directType === "file-diff") return [value];
  const nested = [];
  for (const key of ["file_diff", "fileDiff", "diffs", "content", "items"]) {
    nested.push(...normalizeDiffItems(value[key]));
  }
  if (typeof value.diff === "string" && (value.path || value.file || value.file_path)) nested.push(value);
  return nested;
}

function payloadFromDiffItem(item = {}, options = {}, index = 0) {
  const idPrefix = safeString(options.idPrefix || options.id || "file_edit").trim() || "file_edit";
  const filePath = safeFilePath(
    firstDefined(item.path, item.file, item.file_path, item.filePath, options.path)
  );
  const oldText = firstDefined(item.old_text, item.oldText, item.before, item.old);
  const newText = firstDefined(item.new_text, item.newText, item.after, item.new);
  const explicitDiff = safeString(firstDefined(item.diff, item.patch, item.unified_diff, item.unifiedDiff));
  const diff = explicitDiff || unifiedDiffFromTextPair({ path: filePath, oldText, newText });
  const action = item.action || item.kind || options.action || (
    oldText === "" && newText !== "" ? "add" : newText === "" && oldText !== "" ? "delete" : "update"
  );
  return fileEditPayloadFromUnifiedDiff(diff, {
    id: safeString(item.id || `${idPrefix}_diff_${index}`),
    path: filePath,
    action,
    title: item.title || item.name || options.title,
    additions: item.additions,
    deletions: item.deletions,
    status: item.status || options.status,
    error: item.error || options.error
  });
}

function fileEditPayloadsFromAcpContent(content, options = {}) {
  const items = normalizeDiffItems(content);
  const payloads = [];
  for (let idx = 0; idx < items.length; idx += 1) {
    const payload = payloadFromDiffItem(items[idx], options, idx);
    if (payload) payloads.push(payload);
  }
  return payloads;
}

function fileEditPayloadsFromToolPayload(payload = {}, options = {}) {
  const source = payload && typeof payload === "object"
    ? [
        payload.result_display?.file_diff,
        payload.resultDisplay?.fileDiff,
        payload.file_diff,
        payload.fileDiff,
        payload.diffs,
        payload.content,
        payload.diff && (payload.path || payload.file || payload.file_path)
          ? { path: payload.path || payload.file || payload.file_path, diff: payload.diff }
          : null
      ]
    : [];
  return fileEditPayloadsFromAcpContent(source, {
    idPrefix: options.idPrefix || payload.tool || payload.name || "file_edit",
    path: options.path || payload.path || payload.file || payload.file_path,
    status: options.status || payload.status,
    error: options.error || payload.error
  });
}

function readSmallTextFile(filePath, stat, maxBytes = MAX_WORKSPACE_TEXT_BYTES) {
  if (!stat || !stat.isFile() || stat.size > maxBytes) return null;
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

function createWorkspaceSnapshot(rootDir, options = {}) {
  const root = safeString(rootDir).trim();
  const snapshot = new Map();
  if (!root) return snapshot;
  let rootStat;
  try {
    rootStat = fs.statSync(root);
  } catch {
    return snapshot;
  }
  if (!rootStat.isDirectory()) return snapshot;
  const maxFiles = nonNegativeInt(options.maxFiles) || MAX_WORKSPACE_SCAN_FILES;
  const maxDepth = nonNegativeInt(options.maxDepth) || MAX_WORKSPACE_SCAN_DEPTH;
  const maxBytes = nonNegativeInt(options.maxBytes) || MAX_WORKSPACE_TEXT_BYTES;

  function visit(dir, relDir, depth) {
    if (snapshot.size >= maxFiles || depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (snapshot.size >= maxFiles) return;
      if (entry.isSymbolicLink()) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_WORKSPACE_DIRS.has(entry.name)) continue;
        visit(abs, rel, depth + 1);
        continue;
      }
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const text = readSmallTextFile(abs, stat, maxBytes);
      snapshot.set(rel, {
        path: rel,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        text
      });
    }
  }

  visit(root, "", 0);
  return snapshot;
}

function fileEditPayloadsBetweenSnapshots(before, after, options = {}) {
  const oldMap = before instanceof Map ? before : new Map();
  const newMap = after instanceof Map ? after : new Map();
  const paths = [...new Set([...oldMap.keys(), ...newMap.keys()])].sort();
  const payloads = [];
  const idPrefix = safeString(options.idPrefix || "workspace").trim() || "workspace";
  for (const filePath of paths) {
    const oldFile = oldMap.get(filePath);
    const newFile = newMap.get(filePath);
    if (oldFile && newFile && oldFile.size === newFile.size && oldFile.mtimeMs === newFile.mtimeMs) continue;
    const oldText = oldFile ? oldFile.text : "";
    const newText = newFile ? newFile.text : "";
    if (oldText == null || newText == null) continue;
    if (oldText === newText) continue;
    const action = !oldFile ? "add" : !newFile ? "delete" : "update";
    const diff = unifiedDiffFromTextPair({ path: filePath, oldText, newText });
    const payload = fileEditPayloadFromUnifiedDiff(diff, {
      id: `${idPrefix}_diff_${payloads.length}`,
      path: filePath,
      action,
      status: options.status || "completed",
      error: options.error
    });
    if (payload) payloads.push(payload);
  }
  return payloads;
}

function createWorkspaceDiffTracker(rootDir, options = {}) {
  const root = safeString(rootDir).trim();
  if (!root) {
    return {
      collect: () => []
    };
  }
  let snapshot = createWorkspaceSnapshot(root, options);
  return {
    collect(eventOptions = {}) {
      const next = createWorkspaceSnapshot(root, options);
      const payloads = fileEditPayloadsBetweenSnapshots(snapshot, next, eventOptions);
      snapshot = next;
      return payloads;
    }
  };
}

module.exports = {
  MAX_FILE_DIFF_PREVIEW,
  createWorkspaceDiffTracker,
  createWorkspaceSnapshot,
  diffStats,
  fileEditPayloadFromUnifiedDiff,
  fileEditPayloadsFromAcpContent,
  fileEditPayloadsBetweenSnapshots,
  fileEditPayloadsFromToolPayload,
  normalizeFileAction,
  unifiedDiffFromTextPair
};
