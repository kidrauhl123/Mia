const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && full.endsWith(".js")) out.push(full);
  }
  return out;
}

function findOffenders(allowedRelPaths, regex) {
  const offenders = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file);
    if (allowedRelPaths.includes(rel)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (regex.test(text)) offenders.push(rel);
  }
  return offenders;
}

// 元规律 C 兜底 — 副本不许再生
// Static scan of src/ that fails if patterns owned by shared/* modules
// reappear elsewhere. Pairs with shared-migration plan task "宪法测试 C".

test("no toLocaleTimeString/toLocaleDateString outside shared/time-format.js", () => {
  const offenders = findOffenders(
    ["shared/time-format.js"],
    /toLocale(Time|Date)String/
  );
  assert.deepStrictEqual(
    offenders,
    [],
    `These files duplicate shared/time-format.js:\n  ${offenders.join("\n  ")}\n` +
      `Use \`window.aimashiTimeFormat.formatMessageTime(value)\` (or require fallback).`
  );
});

test("no inline > 99 ? '99+' badge truncation outside shared/unread.js", () => {
  const offenders = findOffenders(
    ["shared/unread.js"],
    /> 99 \? .99\+./
  );
  assert.deepStrictEqual(
    offenders,
    [],
    `These files duplicate shared/unread.js badge truncation:\n  ${offenders.join("\n  ")}\n` +
      `Use \`window.aimashiUnread.unreadBadgeHtml(count)\` or the shared count helpers.`
  );
});

test("no fellowMember/fellowById helper definitions (removed in task 4.3)", () => {
  const offenders = findOffenders(
    [],
    /function fellowMember\b|function fellowById\b/
  );
  assert.deepStrictEqual(
    offenders,
    [],
    `These files redefine fellowMember/fellowById helpers removed in task 4.3:\n  ${offenders.join("\n  ")}\n` +
      `Use shared/contact.js resolveContact({ kind: ContactKind.Fellow, ref: id }, ctx).`
  );
});

// TODO: pattern #4 from the plan — inline `@\w+` mention regex parsing
// outside shared/send-pipeline.js — is intentionally not guarded here.
// The existing parseMentions helper in src/renderer/group/group-prompts.js
// is a legitimate exemption, and a static regex on `@\w+` is too noisy
// to distinguish parser definitions from incidental string literals.
// Revisit once parseMentions is itself folded into shared/send-pipeline.
