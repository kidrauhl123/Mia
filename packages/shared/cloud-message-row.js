(function attachCloudMessageRow(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaCloudMessageRow = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildCloudMessageRow() {
  function parseJson(value, fallback) {
    if (value == null || value === "") return fallback;
    if (typeof value === "object") return value;
    try {
      const parsed = JSON.parse(String(value));
      return parsed == null ? fallback : parsed;
    } catch {
      return fallback;
    }
  }

  function arrayField(row, directKeys, jsonKeys) {
    const source = row && typeof row === "object" ? row : {};
    let directFallback = null;
    for (const key of directKeys) {
      if (!Array.isArray(source[key])) continue;
      if (source[key].length) return source[key];
      directFallback = source[key];
    }
    for (const key of jsonKeys) {
      const parsed = parseJson(source[key], []);
      if (Array.isArray(parsed)) return parsed;
    }
    return directFallback || [];
  }

  function objectField(row, directKeys, jsonKeys) {
    const source = row && typeof row === "object" ? row : {};
    for (const key of directKeys) {
      const value = source[key];
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    }
    for (const key of jsonKeys) {
      const parsed = parseJson(source[key], null);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    }
    return null;
  }

  function normalizeCloudMessageFields(row) {
    return {
      attachments: arrayField(row, ["attachments"], ["attachments_json"]),
      mentions: arrayField(row, ["mentions"], ["mentions_json"]),
      skills: arrayField(row, ["skills"], ["skills_json"]),
      contentBlocks: arrayField(row, ["contentBlocks", "content_blocks"], ["content_blocks_json"]),
      trace: objectField(row, ["trace"], ["trace_json"])
    };
  }

  return { parseJson, normalizeCloudMessageFields };
});
