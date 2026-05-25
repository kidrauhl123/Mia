const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  listClaudeSessions,
  listCodexSessions
} = require("../src/main/agent-session-index.js");

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mia-session-index-"));
}

test("listClaudeSessions uses history titles and jsonl previews", () => {
  const home = tempHome();
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "history.jsonl"), JSON.stringify({
    sessionId,
    display: "History title",
    project: "/repo",
    timestamp: 2000
  }) + "\n");
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), JSON.stringify({
    type: "user",
    message: { content: "first prompt" }
  }) + "\n");

  assert.deepEqual(listClaudeSessions({ homeDir: home, limit: 5 })[0], {
    id: sessionId,
    title: "History title",
    preview: "first prompt",
    project: "/repo",
    updatedAt: 2000,
    path: path.join(projectDir, `${sessionId}.jsonl`)
  });
});

test("listClaudeSessions hides Claude command envelope prompts from titles", () => {
  const home = tempHome();
  const sessionId = "22222222-2222-4333-8444-555555555555";
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "history.jsonl"), JSON.stringify({
    sessionId,
    display: "/goal",
    project: "/repo",
    timestamp: 2000
  }) + "\n");
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), [
    JSON.stringify({
      type: "user",
      message: { content: "<command-name>/goal</command-name> <command-message>goal</command-message>" }
    })
  ].join("\n") + "\n");

  const row = listClaudeSessions({ homeDir: home, limit: 5 })[0];
  assert.equal(row.title, sessionId);
  assert.equal(row.preview, "");
});

test("listCodexSessions uses session_index titles and session_meta cwd", () => {
  const home = tempHome();
  const sessionId = "019e52a6-e802-7051-8952-6cd177c4a8a3";
  const sessionDir = path.join(home, ".codex", "sessions", "2026", "05", "23");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "session_index.jsonl"), JSON.stringify({
    id: sessionId,
    thread_name: "Indexed title",
    updated_at: "2026-05-23T02:25:44.001Z"
  }) + "\n");
  const filePath = path.join(sessionDir, `rollout-2026-05-23T10-25-44-${sessionId}.jsonl`);
  fs.writeFileSync(filePath, [
    JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: "/repo" } }),
    ...Array.from({ length: 90 }, (_, index) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", index } })),
    JSON.stringify({ type: "user_message", payload: { message: "hello codex" } })
  ].join("\n") + "\n");

  const row = listCodexSessions({ homeDir: home, limit: 5 })[0];
  assert.equal(row.id, sessionId);
  assert.equal(row.title, "Indexed title");
  assert.equal(row.preview, "hello codex");
  assert.equal(row.project, "/repo");
  assert.equal(row.path, filePath);
});
