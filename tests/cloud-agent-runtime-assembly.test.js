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
      memoryStore: {
        listMemories(userId, input) {
          calls.push({ userId, input });
          if (input.scope === "user") {
            return [{ id: "mem_user", scope: "user", text: "User likes compact implementation notes." }];
          }
          if (input.scope === "bot") {
            return [{ id: "mem_bot", scope: "bot", text: "Writer should answer in Chinese." }];
          }
          return [];
        }
      },
      createCloudSessionToken(userId) {
        assert.equal(userId, "user_1");
        return "cloud-session-token";
      },
      cloudBaseUrl: "https://cloud.example"
    });

    assert.match(result.instructions, /Mia Runtime Context/);
    assert.equal(result.promptPrefix, "");
    assert.deepEqual(result.nativeSkillNames, ["flashcards"]);
    assert.equal(fs.readFileSync(path.join(result.runtimeCwd, ".claude", "skills", "flashcards", "SKILL.md"), "utf8"), "# STEM Flashcard Generation\n");
    assert.equal(calls.length, 3);

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
    assert.deepEqual(context.enabledSkillIds, ["flashcards"]);
    assert.equal(context.skills[0].id, "flashcards");
    assert.equal(context.memories.some((memory) => memory.text === "User likes compact implementation notes."), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
