const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");

// Files inside these directories are allowed to compare sender_kind/member_kind
// directly because they ARE the canonical source-of-truth layer:
//   - message-sources/  : adapters that normalize raw messages → MessageSpec
//   - shared/           : enum constants + helpers (resolveContact, etc.)
const ALLOWED_PREFIXES = [
  "renderer/message-sources/",
  "shared/"
];

const ALLOWED_FILES = [
  // Storage layer — persisting and reading raw kind literals against the
  // SQLite rows themselves is the canonical source of truth, not a bypass.
  "cloud/social-store.js",
  // Cloud agent service layer dispatches from raw conversation/message rows before
  // renderer message-source adapters exist; comparisons are against storage
  // fields, not rendered MessageSpec state.
  "cloud-agent/dispatcher.js"
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && full.endsWith(".js")) out.push(full);
  }
  return out;
}

test("no js file outside adapters/shared/storage inline-compares sender_kind or member_kind", () => {
  const offenders = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    if (ALLOWED_PREFIXES.some((p) => rel.startsWith(p))) continue;
    if (ALLOWED_FILES.includes(rel)) continue;
    const text = fs.readFileSync(file, "utf8");
    // Match only inline STRING-LITERAL compares (e.g., `=== "fellow"`).
    // `member_kind === MemberKind.Bot` is the canonical bot form and passes.
    if (/(sender_kind|member_kind)\s*(===|!==)\s*["']/.test(text)) {
      offenders.push(rel);
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
      `Files bypassing message adapter by inline sender_kind/member_kind compare:\n  ${offenders.join("\n  ")}\n` +
      `Route through src/renderer/message-sources/*-source.js (consume MessageSpec fields) ` +
      `or use packages/shared/contact.js resolveContact({ kind, ref }, ctx). ` +
      `If you need a new exception (e.g., a legitimate storage-layer file), add it to ALLOWED_FILES with a comment.`
  );
});
