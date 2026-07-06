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

  assert.equal(fallbackState.deliveryMode, "prompt-fallback");
  assert.deepEqual(fallbackState.nativeSkillsDirs, []);
  assert.equal(fallbackState.skillMaterialization.indexBlock, "INDEX:xlsx");
});

test("reconcileWorkspaceSkills deletes only Mia-managed stale links", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skill-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".claude", "skills"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude", "skills", "user-owned"));

  const owner = createSkillRuntimeOwner();
  const sourcePath = path.join(dir, "source-pdf");
  fs.mkdirSync(sourcePath);
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
      resolvedSkills: [{ id: "pdf", name: "pdf", sourcePath }],
      resolvedSkillIds: ["pdf"],
      skillFingerprint: "abc123"
    }
  });

  assert.equal(fs.existsSync(path.join(dir, ".claude", "skills", "pdf")), true);
  assert.equal(fs.existsSync(path.join(dir, ".claude", "skills", "stale-skill")), false);
  assert.equal(fs.existsSync(path.join(dir, ".claude", "skills", "user-owned")), true);
  assert.equal(result.manifestPath, managedManifestPath(dir));
});
