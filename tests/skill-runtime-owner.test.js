const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createSkillRuntimeOwner,
  managedManifestPath
} = require("../src/main/mia-core/skill-runtime-owner.js");

test("skill runtime owner resolves native-link and prompt-fallback deterministically", () => {
  const owner = createSkillRuntimeOwner({
    listSkillRecordsForBot: (bot) => bot.skillRecords || [],
    materializePromptFallback: ({ resolvedSkillIds }) => ({
      indexBlock: `INDEX:${resolvedSkillIds.join(",")}`,
      loadedBlock: "",
      loadedSkillIds: []
    })
  });

  const nativeState = owner.resolveRuntimeSkillState({
    bot: {
      capabilities: { enabledSkills: ["pdf"] },
      skillRecords: [{ id: "pdf", name: "pdf", sourcePath: "/skills/pdf", body: "# pdf" }]
    },
    agentEngine: "claude-code",
    activeSkillIds: [],
    intentSkillIds: [],
    requestedSkillIds: []
  });

  assert.equal(nativeState.deliveryMode, "native-link");
  assert.deepEqual(nativeState.nativeSkillsDirs, [".claude/skills"]);
  assert.equal(nativeState.skillMaterialization, null);
  assert.match(nativeState.skillFingerprint, /^[a-f0-9]{16}$/);

  const fallbackState = owner.resolveRuntimeSkillState({
    bot: {
      capabilities: { enabledSkills: ["xlsx"] },
      skillRecords: [{ id: "xlsx", name: "xlsx", sourcePath: "/skills/xlsx", body: "# xlsx" }]
    },
    agentEngine: "hermes",
    activeSkillIds: [],
    intentSkillIds: [],
    requestedSkillIds: []
  });

  assert.equal(fallbackState.deliveryMode, "native-link");
  assert.deepEqual(fallbackState.nativeSkillsDirs, []);
  assert.equal(fallbackState.skillMaterialization, null);
  assert.deepEqual(fallbackState.skillExternalDirs, ["/skills/xlsx"]);

  const openClawState = owner.resolveRuntimeSkillState({
    bot: {
      capabilities: { enabledSkills: ["xlsx"] },
      skillRecords: [{ id: "xlsx", name: "xlsx", sourcePath: "/skills/xlsx", body: "# xlsx" }]
    },
    agentEngine: "openclaw",
    activeSkillIds: [],
    intentSkillIds: [],
    requestedSkillIds: []
  });

  assert.equal(openClawState.deliveryMode, "prompt-fallback");
  assert.equal(openClawState.nativeSkillsDirs, null);
  assert.match(openClawState.skillMaterialization.indexBlock, /^INDEX:/);
});

test("skill runtime owner honors runtime metadata skill dirs over engine defaults", () => {
  const owner = createSkillRuntimeOwner({
    listSkillRecordsForBot: (bot) => bot.skillRecords || []
  });

  const state = owner.resolveRuntimeSkillState({
    bot: {
      skillRecords: [{ id: "pdf", name: "pdf", sourcePath: "/skills/pdf", body: "# pdf" }]
    },
    agentEngine: "openclaw",
    runtimeConfig: {
      nativeSkillsDirs: [".openclaw/skills"]
    }
  });

  assert.equal(state.deliveryMode, "native-link");
  assert.deepEqual(state.nativeSkillsDirs, [".openclaw/skills"]);
});

test("reconcileWorkspaceSkills deletes only Mia-managed stale links and mounts session-level skills", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skill-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".claude", "skills"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude", "skills", "user-owned"));

  const owner = createSkillRuntimeOwner();
  const sourcePath = path.join(dir, "source-pdf");
  const selectedSourcePath = path.join(dir, "source-deep-research");
  fs.mkdirSync(sourcePath);
  fs.mkdirSync(selectedSourcePath);
  await fs.promises.mkdir(path.join(dir, ".mia"), { recursive: true });
  await fs.promises.writeFile(
    managedManifestPath(dir),
    JSON.stringify({ managedTargets: [".claude/skills/stale-skill"] }, null, 2)
  );
  fs.mkdirSync(path.join(dir, ".claude", "skills", "stale-skill"));

  const result = await owner.reconcileWorkspaceSkills({
    workspacePath: dir,
    engineId: "claude-code",
    state: {
      deliveryMode: "native-link",
      nativeSkillsDirs: [".claude/skills"],
      resolvedSkills: [{ id: "pdf", name: "pdf", sourcePath, linkName: "pdf" }],
      turnSelectedSkills: [{ id: "deep-research", name: "deep-research", sourcePath: selectedSourcePath, linkName: "deep-research" }],
      resolvedSkillIds: ["pdf"],
      skillFingerprint: "abc123"
    }
  });

  assert.equal(fs.existsSync(path.join(dir, ".claude", "skills", "pdf")), true);
  assert.equal(fs.existsSync(path.join(dir, ".claude", "skills", "deep-research")), false);
  assert.equal(fs.existsSync(path.join(dir, ".claude", "skills", "stale-skill")), false);
  assert.equal(fs.existsSync(path.join(dir, ".claude", "skills", "user-owned")), true);
  assert.equal(result.manifestPath, managedManifestPath(dir));
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
  const owner = createSkillRuntimeOwner({
    listSkillRecordsForBot: (bot) => {
      const enabled = new Set((bot?.capabilities?.enabledSkills || []).map((id) => String(id)));
      return (bot.skillRecords || []).filter((record) => enabled.has(String(record.id || record.name || "")));
    },
    resolveSkillRecord: (skillId) => allSkillRecords.find((record) => record.id === skillId) || null,
    materializePromptFallback: ({ activeSkillIds, intentSkillIds, mode }) => ({
      indexBlock: mode === "none" ? "" : "INDEX:session",
      loadedBlock: [...activeSkillIds, ...intentSkillIds].length
        ? `LOADED:${[...activeSkillIds, ...intentSkillIds].join(",")}`
        : "",
      loadedSkillIds: [...activeSkillIds, ...intentSkillIds]
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

test("Hermes treats selected skills as a minimal path block without prompt fallback", async () => {
  const owner = createSkillRuntimeOwner({
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
    materializePromptFallback: ({ activeSkillIds, requestedSkillIds, mode }) => ({
      indexBlock: mode === "index" ? "INDEX:session" : "",
      loadedBlock: [...activeSkillIds, ...requestedSkillIds].length
        ? `LOADED:${[...activeSkillIds, ...requestedSkillIds].join(",")}`
        : "",
      loadedSkillIds: [...activeSkillIds, ...requestedSkillIds]
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

test("managed native-link turns expose selected skill paths without mutating workspace links", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-native-link-turn-"));
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mia-native-link-sources-"));
  const researchDir = path.join(sourceRoot, "deep-research");
  fs.mkdirSync(researchDir);
  const owner = createSkillRuntimeOwner({
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
    materializePromptFallback: ({ activeSkillIds }) => ({
      indexBlock: "",
      loadedBlock: activeSkillIds.length ? `LOADED:${activeSkillIds.join(",")}` : "",
      loadedSkillIds: activeSkillIds
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

test("Hermes keeps turn-local selected skill paths out of the native session fingerprint", async () => {
  const owner = createSkillRuntimeOwner({
    listSkillRecordsForBot: (bot) => {
      const enabled = new Set((bot?.capabilities?.enabledSkills || []).map((id) => String(id)));
      return (bot.skillRecords || []).filter((record) => enabled.has(String(record.id || record.name || "")));
    },
    resolveSkillRecord: (skillId) => (
      skillId === "deep-research"
        ? { id: "deep-research", name: "deep-research", sourcePath: "/skills/deep-research", linkName: "deep-research", body: "# deep" }
        : null
    ),
    materializePromptFallback: ({ resolvedSkillIds }) => ({
      indexBlock: `INDEX:${resolvedSkillIds.join(",")}`,
      loadedBlock: "",
      loadedSkillIds: []
    })
  });

  const withoutTurnSkill = await owner.prepareAgentSessionSkillRuntime({
    engineId: "hermes",
    runtimeConfig: { agentEngine: "hermes" },
    botSnapshot: {
      capabilities: { enabledSkills: ["pdf"] },
      skillRecords: [{ id: "pdf", name: "pdf", sourcePath: "/skills/pdf", linkName: "pdf", body: "# pdf" }]
    }
  });
  const withTurnSkill = await owner.prepareAgentSessionSkillRuntime({
    engineId: "hermes",
    runtimeConfig: { agentEngine: "hermes" },
    activeSkillIds: ["deep-research"],
    botSnapshot: {
      capabilities: { enabledSkills: ["pdf"] },
      skillRecords: [{ id: "pdf", name: "pdf", sourcePath: "/skills/pdf", linkName: "pdf", body: "# pdf" }]
    }
  });

  assert.equal(withoutTurnSkill.skillFingerprint, withTurnSkill.skillFingerprint);
  assert.deepEqual(withTurnSkill.skillExternalDirs, ["/skills/pdf"]);
  assert.match(withTurnSkill.turnPromptPrefix, /<path>\/skills\/deep-research\/SKILL\.md<\/path>/);
});

test("unresolved selected skills and null session records are ignored instead of crashing runtime preparation", () => {
  const owner = createSkillRuntimeOwner({
    listSkillRecordsForBot: () => [
      null,
      { id: "pdf", name: "pdf", sourcePath: "/skills/pdf", body: "# pdf", linkName: "pdf" }
    ],
    resolveSkillRecord: () => null
  });

  const state = owner.resolveRuntimeSkillState({
    agentEngine: "codex",
    activeSkillIds: ["data-analysis"]
  });

  assert.equal(state.deliveryMode, "native-link");
  assert.deepEqual(state.resolvedSkillIds, ["pdf"]);
  assert.deepEqual(state.turnSelectedSkills, []);
});
