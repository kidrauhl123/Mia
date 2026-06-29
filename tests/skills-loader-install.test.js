const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const AdmZip = require("adm-zip");
const { createSkillsLoader } = require("../src/main/skills-loader.js");

function makeLoader(home) {
  return createSkillsLoader({
    runtimePaths: () => ({ home }),
    readJson: () => null, // no official library → only the private source is active
    officialLibraryManifestPath: () => path.join(home, "does-not-exist.json"),
    resolveOfficialLibraryRoot: () => "",
    getEngineState: () => ({ running: false }),
    apiKey: () => "",
    appendEngineLog: () => {},
    isChildPath: (parent, child) =>
      path.resolve(String(child)).startsWith(path.resolve(String(parent)) + path.sep)
  });
}

function makeBundledLoader(home) {
  const root = path.resolve(__dirname, "..");
  return createSkillsLoader({
    runtimePaths: () => ({ home }),
    readJson: (filePath, fallback) => {
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {
        return fallback;
      }
    },
    officialLibraryManifestPath: () => path.join(root, "resources", "official-library", "library.json"),
    resolveOfficialLibraryRoot: (value = "") => path.join(root, String(value || "")),
    getEngineState: () => ({ running: false }),
    apiKey: () => "",
    appendEngineLog: () => {},
    isChildPath: (parent, child) =>
      path.resolve(String(child)).startsWith(path.resolve(String(parent)) + path.sep)
  });
}

// A multi-file skill package: SKILL.md + a nested script.
function makeZip() {
  const zip = new AdmZip();
  zip.addFile("SKILL.md", Buffer.from("---\nname: demo-skill\ndescription: A demo.\n---\n# Demo Skill\n"));
  zip.addFile("scripts/run.py", Buffer.from("print('hi')\n"));
  return zip.toBuffer();
}

function makeNestedZip() {
  const zip = new AdmZip();
  zip.addFile("nested-skill/SKILL.md", Buffer.from("---\nname: nested-skill\ndescription: A nested marketplace skill.\n---\n# Nested Skill\n"));
  zip.addFile("nested-skill/scripts/run.py", Buffer.from("print('nested')\n"));
  return zip.toBuffer();
}

function makeNamedZip(name) {
  const zip = new AdmZip();
  zip.addFile("SKILL.md", Buffer.from(`---\nname: ${name}\ndescription: A legacy marketplace skill.\n---\n# ${name}\n`));
  return zip.toBuffer();
}

test("installMarketplaceSkill extracts a multi-file zip into <home>/skills and it scans as 'mia'", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeLoader(home);
    const library = await loader.installMarketplaceSkill({
      id: "demo-skill",
      zipBuffer: makeZip(),
      marketVersion: "1.2.3",
      marketMeta: {
        sourceLabel: "GitHub",
        upstreamId: "owner/repo/skills/demo-skill",
        upstreamRepo: "owner/repo",
        upstreamPath: "skills/demo-skill",
        trustLevel: "community",
        checksum: "a".repeat(64),
        nameZh: "演示技能",
        summaryZh: "用于验证安装来源。",
        categoryZh: "开发工程"
      }
    });

    const dir = path.join(home, "skills", "demo-skill");
    assert.ok(fs.existsSync(path.join(dir, "SKILL.md")), "SKILL.md extracted");
    assert.ok(fs.existsSync(path.join(dir, "scripts", "run.py")), "nested file extracted");
    const marker = JSON.parse(fs.readFileSync(path.join(dir, ".mia-market.json"), "utf8"));
    assert.equal(marker.sourceLabel, "GitHub");
    assert.equal(marker.id, "demo-skill");
    assert.equal(marker.version, "1.2.3");
    assert.equal(marker.upstreamId, "owner/repo/skills/demo-skill");
    assert.equal(marker.nameZh, "演示技能");
    assert.equal(marker.summaryZh, "用于验证安装来源。");
    assert.equal(marker.categoryZh, "开发工程");

    const found = library.skills.find((s) => s.name === "demo-skill");
    assert.ok(found, "installed skill appears in local scan");
    assert.equal(found.source, "mia");
    assert.equal(found.marketId, "demo-skill");
    assert.equal(found.marketVersion, "1.2.3");
    assert.equal(found.marketChecksum, "a".repeat(64));
    assert.equal(found.marketSourceLabel, "GitHub");
    assert.equal(found.marketUpstreamRepo, "owner/repo");
    assert.equal(found.marketUpstreamPath, "skills/demo-skill");
    assert.equal(found.marketNameZh, "演示技能");
    assert.equal(found.marketSummaryZh, "用于验证安装来源。");
    assert.equal(found.marketCategoryZh, "开发工程");

    const detail = loader.readLocalSkill(found.id);
    assert.equal(detail.marketId, "demo-skill");
    assert.equal(detail.marketNameZh, "演示技能");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("installMarketplaceSkill preserves market source when SKILL.md is nested inside the package", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeLoader(home);
    const library = await loader.installMarketplaceSkill({
      id: "community-nested-skill",
      zipBuffer: makeNestedZip(),
      marketMeta: { sourceLabel: "Community Source", upstreamSource: "example/skills", trustLevel: "community" }
    });

    const found = library.skills.find((s) => s.name === "nested-skill");
    assert.ok(found, "nested marketplace skill appears in local scan");
    assert.equal(found.source, "mia");
    assert.equal(found.pluginLabel, "我的技能");
    assert.equal(found.marketSourceLabel, "Community Source");
    assert.equal(found.marketUpstreamSource, "example/skills");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("legacy marketplace markers infer a known source label from the market id", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeLoader(home);
    const library = await loader.installMarketplaceSkill({
      id: "hermes.claude-marketplace.example.abc123",
      zipBuffer: makeNamedZip("legacy-source-skill")
    });

    const found = library.skills.find((s) => s.name === "legacy-source-skill");
    assert.ok(found, "legacy marketplace skill appears in local scan");
    assert.equal(found.pluginLabel, "我的技能");
    assert.equal(found.marketSourceLabel, "Claude");
    assert.equal(found.fromMarket, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("re-installing replaces the dir cleanly (no stale files)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeLoader(home);
    await loader.installMarketplaceSkill({ id: "demo-skill", zipBuffer: makeZip() });
    // a v2 zip without the script
    const v2 = new AdmZip();
    v2.addFile("SKILL.md", Buffer.from("---\nname: demo-skill\n---\n# v2\n"));
    await loader.installMarketplaceSkill({ id: "demo-skill", zipBuffer: v2.toBuffer() });
    const dir = path.join(home, "skills", "demo-skill");
    assert.ok(!fs.existsSync(path.join(dir, "scripts", "run.py")), "stale file removed on re-install");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("an installed marketplace skill is deletable (private source)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeLoader(home);
    const library = await loader.installMarketplaceSkill({ id: "demo-skill", zipBuffer: makeZip() });
    const installed = library.skills.find((s) => s.name === "demo-skill");
    const after = await loader.deleteLocalSkill(installed.id);
    assert.ok(!after.skills.some((s) => s.name === "demo-skill"), "skill removed after delete");
    assert.ok(!fs.existsSync(path.join(home, "skills", "demo-skill")), "skill dir removed");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("installMarketplaceSkill rejects a zip-slip entry and writes nothing outside the skill dir", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeLoader(home);
    // adm-zip's addFile normalizes paths, so force a raw traversal entry name.
    const zip = new AdmZip();
    zip.addFile("SKILL.md", Buffer.from("---\nname: evil\n---\n# Evil"));
    zip.addFile("evil.txt", Buffer.from("pwned"));
    zip.getEntries()[1].entryName = "../../evil.txt";
    const tampered = zip.toBuffer();
    if (new AdmZip(tampered).getEntries().some((e) => e.entryName.includes(".."))) {
      await assert.rejects(loader.installMarketplaceSkill({ id: "evil", zipBuffer: tampered }), /unsafe path/);
      assert.ok(!fs.existsSync(path.join(path.dirname(home), "evil.txt")), "no file escaped");
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("installMarketplaceSkill rejects an unsafe skill id", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeLoader(home);
    await assert.rejects(loader.installMarketplaceSkill({ id: "../escape", zipBuffer: makeZip() }), /invalid skill id/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("buildEnabledSkillsContext injects enabled skills' content, empty when none", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeLoader(home);
    await loader.installMarketplaceSkill({ id: "demo-skill", zipBuffer: makeZip() });

    const none = loader.buildEnabledSkillsContext({ capabilities: { enabledSkills: [] } });
    assert.equal(none, "");

    const ctx = loader.buildEnabledSkillsContext({ capabilities: { enabledSkills: ["demo-skill"] } });
    assert.match(ctx, /Skill: demo-skill/);
    assert.match(ctx, /# Demo Skill/);

    // unknown ids are skipped
    assert.equal(loader.buildEnabledSkillsContext({ capabilities: { enabledSkills: ["nope"] } }), "");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("bundled library exposes a Mia scheduler skill for reminder requests", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeBundledLoader(home);
    const library = await loader.loadLocalSkills();
    const skill = library.skills.find((item) => item.name === "mia-scheduler");

    assert.ok(skill, "mia-scheduler appears in bundled official skills");
    assert.equal(skill.source, "mia-official");
    assert.match(skill.description, /提醒|定时|schedule/i);

    const ctx = loader.buildEnabledSkillsContext({ capabilities: { enabledSkills: ["mia-scheduler"] } });
    assert.match(ctx, /schedule_create/);
    assert.match(ctx, /不要使用 shell/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("buildEnabledSkillsContext applies bundled preset defaults for old unconfigured official bots", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeBundledLoader(home);
    const ctx = loader.buildEnabledSkillsContext({
      key: "course-tutor",
      name: "课程助教",
      capabilities: { inheritEngineDefaults: true, enabledSkills: [], disabledSkills: [] }
    });

    assert.match(ctx, /Skill: paper-research/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("bundled official library exposes context-bearing assistant templates", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeBundledLoader(home);
    const rawLibrary = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "resources", "official-library", "library.json"), "utf8"));
    const rawPresets = Array.isArray(rawLibrary.botPresets) ? rawLibrary.botPresets : [];
    assert.equal(rawPresets.length, 6);
    assert.ok(rawPresets.every((preset) => !Object.prototype.hasOwnProperty.call(preset, "background")), "official bot presets should only maintain one color field");
    assert.ok(rawPresets.every((preset) => typeof preset.responsibility === "string" && preset.responsibility.trim()));
    assert.ok(rawPresets.every((preset) => preset.setup && Array.isArray(preset.setup.fields)));

    const presets = loader.readMiaOfficialBotPresets();
    assert.equal(presets.length, 6);
    assert.deepEqual(presets.map((preset) => preset.name), [
      "课程助教",
      "项目汇报负责人",
      "实验记录管理员",
      "求职投递管家",
      "个人事务秘书",
      "代码仓库维护员"
    ]);
    assert.deepEqual([...new Set(presets.map((preset) => preset.cat))], ["学习", "项目", "事务", "代码"]);
    assert.ok(presets.every((preset) => preset.name && preset.persona));
    assert.ok(presets.every((preset) => /^#[0-9a-f]{6}$/i.test(preset.c1) && /^#[0-9a-f]{6}$/i.test(preset.c2)));
    assert.ok(presets.every((preset) => preset.c1.toLowerCase() !== preset.c2.toLowerCase()));
    assert.ok(presets.every((preset) => Array.isArray(preset.capabilities?.enabledSkills) && preset.capabilities.enabledSkills.length));
    assert.ok(presets.every((preset) => typeof preset.responsibility === "string" && preset.responsibility.includes("长期")));
    assert.ok(presets.every((preset) => typeof preset.setupPrompt === "string" && preset.setupPrompt.trim()));
    assert.ok(presets.every((preset) => Array.isArray(preset.contextBindings) && preset.contextBindings.length));
    assert.ok(presets.every((preset) => Array.isArray(preset.handoffExamples) && preset.handoffExamples.length >= 3));
    assert.ok(presets.every((preset) => preset.setup.fields.every((field) => field.id && field.label && field.type)));
    assert.equal(presets.some((preset) => preset.name === "论文搭子"), false);
    assert.equal(presets.some((preset) => preset.name === "表格整理师"), false);
    assert.equal(presets.some((preset) => preset.name === "汇报设计师"), false);
    assert.equal(presets.some((preset) => preset.name === "文档编辑"), false);
    assert.equal(presets.some((preset) => preset.name === "会议纪要官"), false);
    assert.equal(presets.some((preset) => preset.name === "剧情主持"), false);
    assert.equal(presets.some((preset) => preset.key === "speak-partner"), false);

    const enabledSkillIds = new Set(presets.flatMap((preset) => preset.capabilities.enabledSkills));
    assert.ok([...enabledSkillIds].every((id) => String(id).startsWith("mia-official:") || id === "mia-scheduler"));
    const library = await loader.loadLocalSkills();
    assert.equal(library.botPresets.length, presets.length);
    for (const id of enabledSkillIds) {
      assert.ok(library.skills.some((skill) => skill.id === id || skill.name === id), `missing preset skill: ${id}`);
      assert.match(loader.buildEnabledSkillsContext({ capabilities: { enabledSkills: [id] } }), /=== Skill:/);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("installMarketplaceSkill rejects a missing package", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeLoader(home);
    await assert.rejects(loader.installMarketplaceSkill({ id: "x" }), /zipBuffer required/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("buildActiveSkillsDirective names selected, resolvable skills as a 'use this now' directive", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeLoader(home);
    await loader.installMarketplaceSkill({ id: "demo-skill", zipBuffer: makeZip() });

    const directive = loader.buildActiveSkillsDirective(["demo-skill"]);
    assert.match(directive, /明确选择了 Skill/);
    assert.match(directive, /「demo-skill」/);

    // No selection, or an unresolvable id, yields no directive (so nothing is forced).
    assert.equal(loader.buildActiveSkillsDirective([]), "");
    assert.equal(loader.buildActiveSkillsDirective(["does-not-exist"]), "");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
