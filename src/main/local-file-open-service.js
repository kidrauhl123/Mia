const path = require("node:path");
const { fileURLToPath } = require("node:url");

function safeDecodeUri(value) {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function normalizeLocalFileTarget(target) {
  const raw = String(target || "").trim();
  if (!raw || raw.includes("\0")) return "";
  if (/^file:/i.test(raw)) {
    try {
      return fileURLToPath(raw);
    } catch {
      return "";
    }
  }
  const decoded = safeDecodeUri(raw);
  return path.isAbsolute(decoded) ? decoded : "";
}

function createLocalFileOpenService({ shellOpenPath }) {
  if (typeof shellOpenPath !== "function") {
    throw new Error("shellOpenPath dependency is required.");
  }

  async function openLocalFile(target) {
    const normalized = normalizeLocalFileTarget(target);
    if (!normalized) return { ok: false, path: "", error: "invalid-path" };
    const error = await shellOpenPath(normalized);
    return {
      ok: !error,
      path: normalized,
      error: error || ""
    };
  }

  return { openLocalFile };
}

module.exports = {
  createLocalFileOpenService,
  normalizeLocalFileTarget
};
