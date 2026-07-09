const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createAgentSessionSkillRuntimeAdapter
} = require("../src/main/agent-session-skill-runtime.js");

test("AgentSession skill runtime requires Rust Core planner for preparation", async () => {
  const owner = createAgentSessionSkillRuntimeAdapter({
    listSkillRecordsForBot: () => [
      { id: "pdf", name: "pdf", sourcePath: "/skills/pdf", linkName: "pdf", body: "# PDF" }
    ]
  });

  await assert.rejects(
    () => owner.prepareAgentSessionSkillRuntime({
      engineId: "codex",
      runtimeConfig: { agentEngine: "codex" },
      botSnapshot: {
        skillRecords: [
          { id: "pdf", name: "pdf", sourcePath: "/skills/pdf", linkName: "pdf", body: "# PDF" }
        ]
      }
    }),
    /Rust Core skill runtime planner is required/
  );
});

test("native-link selected skills stay turn-local via a minimal skill path block", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-native-skill-workspace-"));
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mia-native-skill-sources-"));
  const pdfDir = path.join(sourceRoot, "pdf");
  const researchDir = path.join(sourceRoot, "deep-research");
  fs.mkdirSync(pdfDir);
  fs.mkdirSync(researchDir);
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  const allSkillRecords = [
    { id: "pdf", name: "pdf", sourcePath: pdfDir, body: "# pdf", linkName: "pdf" },
    {
      id: "deep-research",
      name: "deep-research",
      displayName: "深度研究",
      summary: "围绕一个题目展开检索与综合，产出结构化的分析和详尽的研究报告。",
      sourcePath: researchDir,
      body: "# deep",
      linkName: "deep-research"
    }
  ];
  const owner = createAgentSessionSkillRuntimeAdapter({
    listSkillRecordsForBot: (bot) => {
      const enabled = new Set((bot?.capabilities?.enabledSkills || []).map((id) => String(id)));
      return (bot.skillRecords || []).filter((record) => enabled.has(String(record.id || record.name || "")));
    },
    resolveSkillRecord: (skillId) => allSkillRecords.find((record) => record.id === skillId) || null,
    resolveSkillRuntimeWithCore: async (request) => ({
      deliveryMode: "native-link",
      nativeSkillsDirs: [".claude/skills"],
      resolvedSkillIds: ["pdf"],
      resolvedSkills: [{ id: "pdf", name: "pdf", sourcePath: pdfDir, linkName: "pdf", body: "# pdf" }],
      turnSelectedSkills: [],
      skillExternalDirs: [],
      skillFingerprint: "core-session-fingerprint",
      selectedSkillPrompt: request.activeSkillIds.includes("deep-research")
        ? `<selected_skill_paths>\n  <path>${researchDir}/SKILL.md</path>\n</selected_skill_paths>`
        : "",
      initialPromptPrefix: "",
      skillMaterialization: null,
      managedSkillTargets: [".claude/skills/pdf"],
      manifestPath: path.join(workspaceDir, ".mia", "skill-runtime.json")
    })
  });

  const withoutTurnSkill = await owner.prepareAgentSessionSkillRuntime({
    engineId: "claude",
    runtimeConfig: { agentEngine: "claude-code" },
    workspacePath: workspaceDir,
    botSnapshot: {
      capabilities: { enabledSkills: ["pdf"] },
      skillRecords: allSkillRecords
    }
  });
  const withTurnSkill = await owner.prepareAgentSessionSkillRuntime({
    engineId: "claude",
    runtimeConfig: { agentEngine: "claude-code" },
    workspacePath: workspaceDir,
    activeSkillIds: ["deep-research"],
    botSnapshot: {
      capabilities: { enabledSkills: ["pdf"] },
      skillRecords: allSkillRecords
    }
  });

  const skillDir = path.join(workspaceDir, ".claude", "skills", "deep-research");
  assert.equal(withoutTurnSkill.skillDeliveryMode, "native-link");
  assert.equal(withTurnSkill.skillDeliveryMode, "native-link");
  assert.equal(withoutTurnSkill.skillFingerprint, withTurnSkill.skillFingerprint);
  assert.equal(withoutTurnSkill.turnPromptPrefix, undefined);
  assert.match(withTurnSkill.turnPromptPrefix, /selected_skill_paths/);
  assert.match(withTurnSkill.turnPromptPrefix, /<path>.*deep-research\/SKILL\.md<\/path>/);
  assert.doesNotMatch(withTurnSkill.turnPromptPrefix, /深度研究|# deep|directory|location/);
  assert.equal(withTurnSkill.skillFallback, undefined);
  assert.equal(fs.existsSync(skillDir), false);
});

test("AgentSession skill runtime uses Rust Core runtime plan when available", async () => {
  const coreRequests = [];
  const owner = createAgentSessionSkillRuntimeAdapter({
    listSkillRecordsForBot: (bot) => bot.skillRecords || [],
    resolveSkillRecord: (skillId) => (
      skillId === "deep-research"
        ? {
            id: "deep-research",
            name: "deep-research",
            displayName: "Deep Research",
            summary: "Research guide",
            sourcePath: "/skills/deep-research",
            linkName: "deep-research",
            body: "# Deep"
          }
        : null
    ),
    resolveSkillRuntimeWithCore: async (request) => {
      coreRequests.push(request);
      return {
        deliveryMode: "native-link",
        nativeSkillsDirs: [".codex/skills"],
        resolvedSkillIds: ["pdf"],
        resolvedSkills: [
          { id: "pdf", name: "pdf", sourcePath: "/skills/pdf", linkName: "pdf", body: "# PDF" }
        ],
        turnSelectedSkills: [
          { id: "deep-research", name: "deep-research", sourcePath: "/skills/deep-research", linkName: "deep-research" }
        ],
        skillExternalDirs: [],
        skillFingerprint: "core-fingerprint",
        selectedSkillPrompt: "<selected_skill_paths>\n  <path>/skills/deep-research/SKILL.md</path>\n</selected_skill_paths>",
        initialPromptPrefix: "",
        skillMaterialization: null
      };
    }
  });

  const runtime = await owner.prepareAgentSessionSkillRuntime({
    engineId: "codex",
    runtimeConfig: { agentEngine: "codex" },
    activeSkillIds: ["deep-research"],
    botSnapshot: {
      skillRecords: [
        { id: "pdf", name: "pdf", sourcePath: "/skills/pdf", linkName: "pdf", body: "# PDF" }
      ]
    }
  });

  assert.equal(runtime.skillDeliveryMode, "native-link");
  assert.equal(runtime.skillFingerprint, "core-fingerprint");
  assert.match(runtime.turnPromptPrefix, /deep-research\/SKILL\.md/);
  assert.equal(coreRequests.length, 1);
  assert.deepEqual(
    coreRequests[0].availableSkills.map((skill) => skill.id).sort(),
    ["deep-research", "pdf"]
  );
  assert.deepEqual(coreRequests[0].sessionSkillIds, ["pdf"]);
  assert.deepEqual(coreRequests[0].activeSkillIds, ["deep-research"]);
});

test("AgentSession skill runtime skips local workspace reconciliation after Core handles links", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-linked-workspace-"));
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-linked-source-"));
  const pdfDir = path.join(sourceRoot, "pdf");
  fs.mkdirSync(pdfDir);
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));

  const coreRequests = [];
  const owner = createAgentSessionSkillRuntimeAdapter({
    listSkillRecordsForBot: (bot) => bot.skillRecords || [],
    resolveSkillRuntimeWithCore: async (request) => {
      coreRequests.push(request);
      return {
        deliveryMode: "native-link",
        nativeSkillsDirs: [".codex/skills"],
        resolvedSkillIds: ["pdf"],
        resolvedSkills: [
          { id: "pdf", name: "pdf", sourcePath: pdfDir, linkName: "pdf", body: "# PDF" }
        ],
        turnSelectedSkills: [],
        skillExternalDirs: [],
        skillFingerprint: "core-fingerprint",
        selectedSkillPrompt: "",
        initialPromptPrefix: "",
        skillMaterialization: null,
        managedSkillTargets: [".codex/skills/pdf"],
        manifestPath: path.join(workspaceDir, ".mia", "skill-runtime.json")
      };
    }
  });

  const runtime = await owner.prepareAgentSessionSkillRuntime({
    engineId: "codex",
    runtimeConfig: { agentEngine: "codex" },
    workspacePath: workspaceDir,
    botSnapshot: {
      skillRecords: [
        { id: "pdf", name: "pdf", sourcePath: pdfDir, linkName: "pdf", body: "# PDF" }
      ]
    }
  });

  assert.equal(fs.existsSync(path.join(workspaceDir, ".codex", "skills", "pdf")), false);
  assert.deepEqual(coreRequests.map((request) => request.workspacePath), [workspaceDir]);
  assert.deepEqual(runtime.managedSkillTargets, [".codex/skills/pdf"]);
  assert.equal(runtime.skillManifestPath, path.join(workspaceDir, ".mia", "skill-runtime.json"));
});

test("AgentSession skill runtime does not mutate workspace links without a Core manifest plan", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-no-js-link-workspace-"));
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mia-no-js-link-source-"));
  const pdfDir = path.join(sourceRoot, "pdf");
  fs.mkdirSync(pdfDir);
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));

  const owner = createAgentSessionSkillRuntimeAdapter({
    listSkillRecordsForBot: (bot) => bot.skillRecords || [],
    resolveSkillRuntimeWithCore: async () => ({
      deliveryMode: "native-link",
      nativeSkillsDirs: [".codex/skills"],
      resolvedSkillIds: ["pdf"],
      resolvedSkills: [{ id: "pdf", name: "pdf", sourcePath: pdfDir, linkName: "pdf", body: "# PDF" }],
      turnSelectedSkills: [],
      skillExternalDirs: [],
      skillFingerprint: "core-fingerprint",
      selectedSkillPrompt: "",
      initialPromptPrefix: "",
      skillMaterialization: null
    })
  });

  const runtime = await owner.prepareAgentSessionSkillRuntime({
    engineId: "codex",
    runtimeConfig: { agentEngine: "codex" },
    workspacePath: workspaceDir,
    botSnapshot: {
      skillRecords: [
        { id: "pdf", name: "pdf", sourcePath: pdfDir, linkName: "pdf", body: "# PDF" }
      ]
    }
  });

  assert.equal(runtime.skillDeliveryMode, "native-link");
  assert.equal(fs.existsSync(path.join(workspaceDir, ".codex", "skills", "pdf")), false);
  assert.equal(fs.existsSync(path.join(workspaceDir, ".mia", "skill-runtime.json")), false);
});

test("Hermes treats selected skills as a minimal path block without prompt fallback", async () => {
  const owner = createAgentSessionSkillRuntimeAdapter({
    resolveSkillRecord: (skillId) => (
      skillId === "mia:docx"
        ? {
            id: "mia:docx",
            name: "$deep-research",
            displayName: "深度研究",
            summary: "围绕一个题目展开检索与综合，产出结构化的分析和详尽的研究报告。",
            sourcePath: "/skills/deep-research",
            linkName: "deep-research"
          }
        : null
    ),
    resolveSkillRuntimeWithCore: async () => ({
      deliveryMode: "native-link",
      nativeSkillsDirs: [],
      resolvedSkillIds: [],
      resolvedSkills: [],
      turnSelectedSkills: [{ id: "mia:docx", name: "$deep-research", sourcePath: "/skills/deep-research", linkName: "deep-research" }],
      skillExternalDirs: [],
      skillFingerprint: "core-fingerprint",
      selectedSkillPrompt: "<selected_skill_paths>\n  <path>/skills/deep-research/SKILL.md</path>\n</selected_skill_paths>",
      initialPromptPrefix: "",
      skillMaterialization: null
    })
  });

  const runtime = await owner.prepareAgentSessionSkillRuntime({
    engineId: "hermes",
    runtimeConfig: { agentEngine: "hermes" },
    activeSkillIds: ["mia:docx"]
  });

  assert.equal(runtime.skillDeliveryMode, "native-link");
  assert.match(runtime.turnPromptPrefix, /selected_skill_paths/);
  assert.match(runtime.turnPromptPrefix, /<path>\/skills\/deep-research\/SKILL\.md<\/path>/);
  assert.equal(runtime.skillExternalDirs, undefined);
  assert.equal(runtime.skillFallback, undefined);
});

test("prompt-fallback AgentSession skill materialization awaits Rust Core blocks", async () => {
  const coreRequests = [];
  const owner = createAgentSessionSkillRuntimeAdapter({
    listSkillRecordsForBot: (bot) => bot.skillRecords || [],
    resolveSkillRuntimeWithCore: async (request) => {
      coreRequests.push(request);
      await Promise.resolve();
      return {
        deliveryMode: "prompt-fallback",
        nativeSkillsDirs: [],
        resolvedSkillIds: ["xlsx"],
        resolvedSkills: [{ id: "xlsx", name: "xlsx", sourcePath: "/skills/xlsx", linkName: "xlsx", body: "# xlsx" }],
        turnSelectedSkills: [],
        skillExternalDirs: [],
        skillFingerprint: "core-fingerprint",
        selectedSkillPrompt: "",
        initialPromptPrefix: "",
        managedSkillTargets: [],
        manifestPath: "",
        skillMaterialization: {
          indexBlock: "CORE INDEX",
          loadedBlock: request.requestedSkillIds.length ? "CORE LOADED" : "",
          loadedSkillIds: request.requestedSkillIds
        }
      };
    }
  });

  const runtime = await owner.prepareAgentSessionSkillRuntime({
    engineId: "hermes",
    runtimeConfig: { agentEngine: "hermes", nativeSkillsDirs: null },
    intentSkillIds: ["xlsx"],
    botSnapshot: {
      capabilities: { enabledSkills: ["xlsx"] },
      skillRecords: [{ id: "xlsx", name: "xlsx", sourcePath: "/skills/xlsx", body: "# xlsx" }]
    }
  });

  assert.equal(runtime.skillDeliveryMode, "prompt-fallback");
  assert.match(runtime.turnPromptPrefix, /CORE INDEX/);
  assert.equal(typeof runtime.skillFallback.materializePrompt, "function");
  assert.deepEqual(coreRequests.map((call) => call.intentSkillIds), [["xlsx"]]);

  const retryPrompt = await runtime.skillFallback.materializePrompt(["xlsx"]);
  assert.match(retryPrompt, /CORE LOADED/);
  assert.deepEqual(
    coreRequests.map((call) => call.requestedSkillIds),
    [[], ["xlsx"]]
  );
});

test("managed native-link turns expose selected skill paths without mutating workspace links", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-native-link-turn-"));
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mia-native-link-sources-"));
  const researchDir = path.join(sourceRoot, "deep-research");
  fs.mkdirSync(researchDir);
  const owner = createAgentSessionSkillRuntimeAdapter({
    resolveSkillRecord: (skillId) => (
      skillId === "deep-research"
        ? {
            id: "deep-research",
            name: "$deep-research",
            displayName: "深度研究",
            summary: "围绕一个题目展开检索与综合，产出结构化的分析和详尽的研究报告。",
            sourcePath: researchDir,
            linkName: "deep-research"
          }
        : null
    ),
    resolveSkillRuntimeWithCore: async () => ({
      deliveryMode: "native-link",
      nativeSkillsDirs: [".codex/skills"],
      resolvedSkillIds: [],
      resolvedSkills: [],
      turnSelectedSkills: [{ id: "deep-research", name: "$deep-research", sourcePath: researchDir, linkName: "deep-research" }],
      skillExternalDirs: [],
      skillFingerprint: "core-fingerprint",
      selectedSkillPrompt: `<selected_skill_paths>\n  <path>${researchDir}/SKILL.md</path>\n</selected_skill_paths>`,
      initialPromptPrefix: "",
      skillMaterialization: null
    })
  });

  try {
    t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
    const runtime = await owner.prepareAgentSessionSkillRuntime({
      engineId: "codex",
      runtimeConfig: { agentEngine: "codex" },
      workspacePath: workspaceDir,
      activeSkillIds: ["deep-research"]
    });

    const skillDir = path.join(workspaceDir, ".codex", "skills", "deep-research");
    assert.match(runtime.turnPromptPrefix, /selected_skill_paths/);
    assert.match(runtime.turnPromptPrefix, /<path>.*deep-research\/SKILL\.md<\/path>/);
    assert.equal(runtime.skillFallback, undefined);
    assert.equal(fs.existsSync(skillDir), false);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("AgentSession skill runtime forwards unresolved selected ids to Core without inventing records", async () => {
  const coreRequests = [];
  const owner = createAgentSessionSkillRuntimeAdapter({
    listSkillRecordsForBot: () => [
      null,
      { id: "pdf", name: "pdf", sourcePath: "/skills/pdf", body: "# pdf", linkName: "pdf" }
    ],
    resolveSkillRecord: () => null,
    resolveSkillRuntimeWithCore: async (request) => {
      coreRequests.push(request);
      return {
        deliveryMode: "native-link",
        nativeSkillsDirs: [".codex/skills"],
        resolvedSkillIds: ["pdf"],
        resolvedSkills: [{ id: "pdf", name: "pdf", sourcePath: "/skills/pdf", linkName: "pdf", body: "# pdf" }],
        turnSelectedSkills: [],
        skillExternalDirs: [],
        skillFingerprint: "core-fingerprint",
        selectedSkillPrompt: "",
        initialPromptPrefix: "",
        skillMaterialization: null
      };
    }
  });

  const runtime = await owner.prepareAgentSessionSkillRuntime({
    engineId: "codex",
    activeSkillIds: ["data-analysis"]
  });

  assert.equal(runtime.skillDeliveryMode, "native-link");
  assert.deepEqual(coreRequests[0].availableSkills.map((skill) => skill.id), ["pdf"]);
  assert.deepEqual(coreRequests[0].activeSkillIds, ["data-analysis"]);
});
