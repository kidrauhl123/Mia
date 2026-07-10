const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  callTool,
  readContext,
  toolDefinitionsForMode
} = require("../src/cloud-agent/mia-cloud-mcp-server.js");

test("cloud Mia MCP reads current context memories and skills without desktop Core", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-mcp-"));
  const contextPath = path.join(tmp, "context.json");
  fs.writeFileSync(contextPath, JSON.stringify({
    userId: "user_1",
    botId: "writer",
    conversationId: "conv_1",
    sessionId: "conv_1",
    originMessageId: "msg_1",
    enabledSkillIds: ["flashcards"],
    memories: [
      { id: "mem_user", scope: "user", text: "User likes compact answers." },
      { id: "mem_bot", scope: "bot", text: "Writer answers in Chinese." }
    ],
    skills: [
      {
        id: "flashcards",
        name: "Anki 记忆卡",
        description: "生成记忆卡。",
        body: "# STEM Flashcard Generation"
      }
    ]
  }, null, 2));

  try {
    const env = { MIA_CLOUD_MCP_CONTEXT_FILE: contextPath };
    const ctx = readContext({ env });
    assert.equal(ctx.botId, "writer");

    const memories = await callTool("memory_search", { query: "compact" }, { env });
    assert.deepEqual(memories.memories.map((item) => item.id), ["mem_user"]);

    const listed = await callTool("skill_list_current", {}, { env });
    assert.deepEqual(listed.skills, [{
      id: "flashcards",
      name: "Anki 记忆卡",
      description: "生成记忆卡。"
    }]);

    const skill = await callTool("skill_read_current", { id: "mia:flashcards" }, { env });
    assert.equal(skill.skill.id, "flashcards");
    assert.match(skill.skill.body, /STEM Flashcard Generation/);

    const snapshot = await callTool("context_snapshot", {}, { env });
    assert.equal(snapshot.botId, "writer");
    assert.equal(snapshot.sessionId, "conv_1");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("cloud Mia scheduler MCP mode exposes only schedule tools", () => {
  const names = toolDefinitionsForMode("scheduler").map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "schedule_create",
    "schedule_delete",
    "schedule_list",
    "schedule_pause",
    "schedule_resume",
    "schedule_update"
  ]);
});
