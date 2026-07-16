const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  assembleCloudRuntimeTurn,
  cloudSkillMaterialization
} = require("../src/cloud-agent/runtime-assembly.js");

test("cloud skill materialization resolves inherited OfficeCLI defaults and honors explicit disables", () => {
  const skillsCatalog = [
    { id: "officecli", name: "officecli", body: "# OfficeCLI system skill" },
    { id: "officecli-docx", name: "officecli-docx", body: "# OfficeCLI DOCX skill" },
    { id: "officecli-xlsx", name: "officecli-xlsx", body: "# OfficeCLI XLSX skill" },
    { id: "officecli-pptx", name: "officecli-pptx", body: "# OfficeCLI PPTX skill" },
    { id: "manual", name: "manual", body: "# Manual skill" }
  ];

  const result = cloudSkillMaterialization({
    bot: {
      capabilities: {
        inheritEngineDefaults: true,
        enabledSkills: [
          "mia-official:officecli-docx",
          "mia-official:officecli-xlsx",
          "mia-official:officecli-pptx",
          "manual"
        ],
        disabledSkills: ["mia-official:officecli-xlsx"]
      }
    },
    message: { skills_json: "[]" },
    skillsCatalog
  });

  assert.deepEqual(result.availableSkills.map((skill) => skill.id), [
    "officecli",
    "officecli-docx",
    "officecli-pptx",
    "manual"
  ]);
  assert.equal("materialization" in result, false);
});

test("cloud runtime assembly exposes memory through Mia MCP and materializes skills as native Claude skills", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-runtime-assembly-"));
  const calls = [];
  try {
    const result = assembleCloudRuntimeTurn({
      ownerId: "user_1",
      botId: "writer",
      conversationId: "conv_1",
      memoryMode: "mia",
      message: {
        id: "msg_1",
        body_md: "use my preferences",
        skills_json: JSON.stringify([{ id: "mia:flashcards", name: "Anki 记忆卡" }])
      },
      bot: {
        id: "writer",
        displayName: "Writer",
        personaText: "You are Writer.",
        capabilities: { enabledSkills: ["mia-official:flashcards"] }
      },
      worker: {
        paths: {
          agentHome: tmp,
          workspace: path.join(tmp, "workspace")
        }
      },
      runtimeConfig: {
        mcpServers: {
          docs: { type: "http", url: "https://docs.example/mcp" },
          "mia-app": {
            command: "/usr/bin/node",
            args: ["/Applications/Mia/mia-app-mcp-server.js"],
            env: {
              MIA_CORE_URL: "http://127.0.0.1:27861",
              MIA_CORE_TOKEN: "desktop-token"
            }
          }
        }
      },
      skillsCatalog: [{
        id: "flashcards",
        name: "Anki 记忆卡",
        description: "生成记忆卡。",
        body: "# STEM Flashcard Generation"
      }],
      memoryDocumentStore: {
        listDocuments(userId, input) {
          calls.push({ userId, input });
          return {
            documents: [
              { target: "user", botId: "", text: "User likes compact implementation notes.", deletedAt: "" },
              { target: "memory", botId: "writer", text: "Writer should answer in Chinese.", deletedAt: "" },
              { target: "memory", botId: "other", text: "Other bot memory is hidden.", deletedAt: "" }
            ]
          };
        }
      },
      includeMemorySnapshot: true,
      createCloudSessionToken(userId) {
        assert.equal(userId, "user_1");
        return "cloud-session-token";
      },
      cloudBaseUrl: "https://cloud.example"
    });

    assert.match(result.instructions, /Mia Runtime Context/);
    assert.match(result.instructions, /prefer Claude Code's built-in `WebSearch`/);
    assert.match(result.instructions, /try built-in `WebFetch`/);
    assert.match(result.instructions, /best-effort fallbacks/);
    assert.match(result.instructions, /Never describe search snippets as a complete page read/);
    assert.doesNotMatch(result.promptPrefix, /User likes compact implementation notes/);
    assert.match(result.memoryBlock, /Writer should answer in Chinese/);
    assert.doesNotMatch(result.memoryBlock, /Other bot memory/);
    assert.deepEqual(result.nativeSkillNames, ["flashcards"]);
    assert.equal(fs.readFileSync(path.join(result.runtimeCwd, ".claude", "skills", "flashcards", "SKILL.md"), "utf8"), "# STEM Flashcard Generation\n");
    assert.equal(calls.length, 1);

    assert.deepEqual(result.mcpServers.docs, { type: "http", url: "https://docs.example/mcp" });
    assert.equal(result.mcpServers["mia-app"].command, process.execPath);
    assert.equal(result.mcpServers["mia-app"].env.MIA_CLOUD_URL, "https://cloud.example");
    assert.equal(result.mcpServers["mia-app"].env.MIA_CLOUD_TOKEN, "cloud-session-token");
    assert.equal(result.mcpServers["mia-app"].env.MIA_CORE_URL, undefined);
    assert.equal(result.mcpServers["mia-scheduler"], undefined);
    assert.ok(fs.existsSync(result.contextPath));

    const context = JSON.parse(fs.readFileSync(result.contextPath, "utf8"));
    assert.equal(context.userId, "user_1");
    assert.equal(context.botId, "writer");
    assert.equal(context.sessionId, "conv_1");
    assert.equal(context.memoryMode, "mia");
    assert.deepEqual(context.enabledSkillIds, ["flashcards"]);
    assert.equal(context.skills[0].id, "flashcards");
    assert.equal(Object.hasOwn(context, "memories"), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
