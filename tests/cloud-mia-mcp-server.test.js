const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const {
  callTool,
  readContext,
  toolDefinitionsForMode
} = require("../src/cloud-agent/mia-cloud-mcp-server.js");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

test("cloud Mia MCP exposes single memory tool and current skills without desktop Core", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-mcp-"));
  const contextPath = path.join(tmp, "context.json");
  let mutateBody = null;
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, "Bearer test-token");
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/api/me/memory-documents/mutate");
      mutateBody = await readJson(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        action: mutateBody.action,
        target: mutateBody.target,
        currentEntries: [mutateBody.content],
        usedChars: mutateBody.content.length,
        limitChars: 2200,
        usagePercent: 1,
        noOp: false,
        error: null,
        suggestion: null
      }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  let serverStarted = false;
  fs.writeFileSync(contextPath, JSON.stringify({
    userId: "user_1",
    botId: "writer",
    conversationId: "conv_1",
    sessionId: "conv_1",
    originMessageId: "msg_1",
    memoryMode: "mia",
    enabledSkillIds: ["flashcards"],
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
    await listen(server);
    serverStarted = true;
    const address = server.address();
    const env = {
      MIA_CLOUD_MCP_CONTEXT_FILE: contextPath,
      MIA_CLOUD_URL: `http://${address.address}:${address.port}`,
      MIA_CLOUD_TOKEN: "test-token"
    };
    const ctx = readContext({ env });
    assert.equal(ctx.botId, "writer");

    const names = toolDefinitionsForMode({ env }).map((tool) => tool.name);
    assert.deepEqual(names.filter((name) => name.startsWith("memory")), ["memory"]);
    assert.equal(names.includes("memory_search"), false);

    const remembered = await callTool("memory", {
      action: "add",
      target: "memory",
      content: "Writer answers in Chinese."
    }, { env });
    assert.equal(remembered.success, true);
    assert.deepEqual(mutateBody, {
      conversationId: "conv_1",
      botId: "writer",
      action: "add",
      target: "memory",
      content: "Writer answers in Chinese."
    });

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
    assert.equal(snapshot.memoryMode, "mia");
    assert.deepEqual(snapshot.memoryTools, { enabled: true, memory: "memory" });
    assert.equal(Object.hasOwn(snapshot, "memories"), false);
  } finally {
    if (serverStarted) await close(server);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("cloud Mia MCP hides memory tool in native mode", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-mcp-native-"));
  const contextPath = path.join(tmp, "context.json");
  fs.writeFileSync(contextPath, JSON.stringify({ memoryMode: "native" }), "utf8");
  try {
    const env = { MIA_CLOUD_MCP_CONTEXT_FILE: contextPath };
    const names = toolDefinitionsForMode({ env }).map((tool) => tool.name);
    assert.equal(names.includes("memory"), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("cloud Mia MCP does not expose scheduler tools", () => {
  const names = toolDefinitionsForMode().map((tool) => tool.name);
  assert.equal(names.some((name) => name.startsWith("schedule_")), false);
});
