const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const AdmZip = require("adm-zip");
const { createSkillsLoader } = require("../src/main/skills-loader.js");

function makeLoader(home, overrides = {}) {
  return createSkillsLoader({
    runtimePaths: () => ({ home }),
    readJson: () => null, // no official library → only the private source is active
    officialLibraryManifestPath: () => path.join(home, "does-not-exist.json"),
    resolveOfficialLibraryRoot: () => "",
    getEngineState: () => ({ running: false }),
    apiServerKey: () => "",
    appendEngineLog: () => {},
    isChildPath: (parent, child) =>
      path.resolve(String(child)).startsWith(path.resolve(String(parent)) + path.sep),
    ...overrides
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
    apiServerKey: () => "",
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

test("resolveSkillMaterializationWithCore sends the turn skill request to Rust Core", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const skillDir = path.join(home, "skills", "xlsx");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: xlsx\ndescription: Excel deliverables.\n---\n# XLSX\nUse formulas.\n"
    );
    const requests = [];
    const loader = makeLoader(home, {
      materializeSkillsWithCore: async (request) => {
        requests.push(request);
        return {
          indexBlock: "CORE INDEX",
          loadedBlock: "CORE LOADED",
          loadedSkillIds: ["xlsx"]
        };
      }
    });

    const result = await loader.resolveSkillMaterializationWithCore({
      bot: { capabilities: { enabledSkills: ["xlsx"] } },
      activeSkillIds: [],
      intentSkillIds: ["xlsx"],
      requestedSkillIds: [],
      mode: "index"
    });

    assert.deepEqual(result, {
      indexBlock: "CORE INDEX",
      loadedBlock: "CORE LOADED",
      loadedSkillIds: ["xlsx"]
    });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].intentSkillIds, ["xlsx"]);
    assert.equal(requests[0].availableSkills[0].id, "xlsx");
    assert.equal(requests[0].availableSkills[0].name, "xlsx");
    assert.match(requests[0].availableSkills[0].body, /Use formulas/);
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

test("skillRecordsForBot exposes enabled skill records without prompt injection", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeLoader(home);
    await loader.installMarketplaceSkill({ id: "demo-skill", zipBuffer: makeZip() });

    assert.equal(Object.hasOwn(loader, "buildEnabledSkillsContext"), false);
    assert.deepEqual(loader.skillRecordsForBot({ capabilities: { enabledSkills: [] } }), []);

    const records = loader.skillRecordsForBot({ capabilities: { enabledSkills: ["demo-skill", "nope"] } });
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].id, "demo-skill");
    assert.deepEqual(records[0].name, "demo-skill");
    assert.match(records[0].body, /# Demo Skill/);

    const currentList = loader.listCurrentBotSkills({ capabilities: { enabledSkills: ["demo-skill", "nope"] } });
    assert.deepEqual(currentList, [{
      id: "demo-skill",
      name: "demo-skill",
      description: "A demo.",
      bodyChars: records[0].body.length
    }]);
    const currentSkill = loader.readCurrentBotSkill({ capabilities: { enabledSkills: ["demo-skill"] } }, "demo-skill");
    assert.match(currentSkill.body, /# Demo Skill/);
    assert.equal(currentSkill.bodyChars, records[0].body.length);
    assert.throws(
      () => loader.readCurrentBotSkill({ capabilities: { enabledSkills: [] } }, "demo-skill"),
      /not enabled/
    );

    const materialized = loader.resolveSkillMaterialization({
      bot: { capabilities: { enabledSkills: ["demo-skill"] } },
      activeSkillIds: [],
      intentSkillIds: []
    });
    assert.match(materialized.indexBlock, /demo-skill: A demo/);
    assert.doesNotMatch(materialized.indexBlock, /# Demo Skill/);
    assert.equal(materialized.loadedBlock, "");
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

    const full = loader.readLocalSkill("mia-scheduler");
    assert.match(full.body, /schedule_create/);
    assert.match(full.body, /不要使用 shell/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("resolveSkillMaterialization exposes index without full scheduler body by default", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeBundledLoader(home);
    const materialized = loader.resolveSkillMaterialization({
      bot: { capabilities: { enabledSkills: ["mia-scheduler"] } },
      activeSkillIds: [],
      intentSkillIds: []
    });

    assert.match(materialized.indexBlock, /mia-scheduler|Mia Scheduler|scheduled tasks/i);
    assert.doesNotMatch(materialized.indexBlock, /schedule_create|不要使用 shell/);
    assert.equal(materialized.loadedBlock, "");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("resolveSkillMaterialization loads full skill only for active or intent skill ids", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeBundledLoader(home);
    const byActive = loader.resolveSkillMaterialization({
      bot: { capabilities: { enabledSkills: ["mia-scheduler"] } },
      activeSkillIds: ["mia-scheduler"],
      intentSkillIds: []
    });
    const byIntent = loader.resolveSkillMaterialization({
      bot: { capabilities: { enabledSkills: ["mia-scheduler"] } },
      activeSkillIds: [],
      intentSkillIds: ["mia-scheduler"]
    });

    assert.match(byActive.loadedBlock, /schedule_create/);
    assert.match(byIntent.loadedBlock, /schedule_create/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("resolveSkillMaterialization resolves turn-local active and intent skills without mutating bot enabled skills", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeBundledLoader(home);
    const byActive = loader.resolveSkillMaterialization({
      bot: { capabilities: { enabledSkills: [] } },
      activeSkillIds: ["mia-scheduler"],
      intentSkillIds: []
    });
    const byIntent = loader.resolveSkillMaterialization({
      bot: { capabilities: { enabledSkills: [] } },
      activeSkillIds: [],
      intentSkillIds: ["mia-scheduler"]
    });

    assert.match(byActive.loadedBlock, /schedule_create/);
    assert.match(byIntent.loadedBlock, /schedule_create/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("resolveSkillMaterialization loads requested installed skills even when not preset-enabled", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeBundledLoader(home);
    const materialized = loader.resolveSkillMaterialization({
      bot: { capabilities: { enabledSkills: [] } },
      requestedSkillIds: ["mia-scheduler"]
    });

    assert.match(materialized.indexBlock, /LOAD_SKILL/);
    assert.match(materialized.loadedBlock, /schedule_create/);
    assert.deepEqual(materialized.loadedSkillIds, ["mia-official:mia-scheduler"]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("resolveSkillMaterialization indexes bundled preset defaults for old unconfigured official bots", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeBundledLoader(home);
    const materialized = loader.resolveSkillMaterialization({
      bot: {
        key: "course-tutor",
        name: "课程助教",
        capabilities: { inheritEngineDefaults: true, enabledSkills: [], disabledSkills: [] }
      }
    });

    assert.match(materialized.indexBlock, /paper-research/);
    assert.equal(materialized.loadedBlock, "");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("resolveSkillMaterialization preserves retired official assistant defaults as indexes", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeBundledLoader(home);
    const cases = [
      ["old-paper", "论文搭子", "paper-research"],
      ["paper-buddy", "论文搭子", "paper-research"],
      ["lab-data", "实验数据助手", "lab-report"],
      ["exam-buddy", "复习搭子", "study-review"],
      ["qa-helper", "答疑助手", "problem-explainer"],
      ["spreadsheet-organizer", "表格整理师", "spreadsheet-organizer"],
      ["presentation-designer", "汇报设计师", "presentation-designer"],
      ["meeting-notes", "会议纪要官", "meeting-notes"],
      ["document-editor", "文档编辑", "document-editor"],
      ["career-coach", "简历面试官", "resume-interview"],
      ["story-host", "剧情主持", "story-host"]
    ];

    for (const [key, name, skillName] of cases) {
      const byKey = loader.resolveSkillMaterialization({
        bot: {
          key,
          name: `${name}旧实例`,
          capabilities: { inheritEngineDefaults: true, enabledSkills: [], disabledSkills: [] }
        }
      });
      const byName = loader.resolveSkillMaterialization({
        bot: {
          key: `legacy-${key}-copy`,
          name,
          capabilities: { inheritEngineDefaults: true, enabledSkills: [], disabledSkills: [] }
        }
      });

      assert.match(byKey.indexBlock, new RegExp(skillName), `${key} should preserve retired preset defaults by key`);
      assert.match(byName.indexBlock, new RegExp(skillName), `${name} should preserve retired preset defaults by name`);
      assert.equal(byKey.loadedBlock, "");
      assert.equal(byName.loadedBlock, "");
    }
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
    assert.equal(rawPresets.length, 8);
    assert.ok(rawPresets.every((preset) => !Object.prototype.hasOwnProperty.call(preset, "background")), "official bot presets should only maintain one color field");
    assert.ok(rawPresets.every((preset) => typeof preset.responsibility === "string" && preset.responsibility.trim()));
    assert.ok(rawPresets.every((preset) => !Object.prototype.hasOwnProperty.call(preset, "setupPrompt")));
    assert.ok(rawPresets.every((preset) => !Object.prototype.hasOwnProperty.call(preset, "setup")));
    assert.ok(rawPresets.every((preset) => preset.avatar && typeof preset.avatar.emoji === "string" && preset.avatar.emoji.trim()));
    assert.ok(rawPresets.every((preset) => preset.avatar && typeof preset.avatar.token === "string" && preset.avatar.token.trim()));

    const presets = loader.readMiaOfficialBotPresets();
    assert.equal(presets.length, 8);
    assert.deepEqual(presets.map((preset) => preset.name), [
      "课程助教",
      "项目汇报负责人",
      "实验记录管理员",
      "求职投递管家",
      "个人事务秘书",
      "代码仓库维护员",
      "公开情报官",
      "跑团故事主持"
    ]);
    assert.deepEqual([...new Set(presets.map((preset) => preset.cat))], ["学习", "项目", "事务", "代码", "情报", "娱乐"]);
    assert.ok(presets.every((preset) => preset.name && preset.persona));
    assert.ok(presets.every((preset) => /^#[0-9a-f]{6}$/i.test(preset.c1) && /^#[0-9a-f]{6}$/i.test(preset.c2)));
    assert.ok(presets.every((preset) => preset.c1.toLowerCase() !== preset.c2.toLowerCase()));
    assert.ok(presets.every((preset) => Array.isArray(preset.capabilities?.enabledSkills) && preset.capabilities.enabledSkills.length));
    assert.ok(presets.every((preset) => preset.avatar && typeof preset.avatar.emoji === "string" && preset.avatar.emoji.trim()));
    assert.ok(presets.every((preset) => preset.avatar && typeof preset.avatar.token === "string" && preset.avatar.token.trim()));
    assert.ok(presets.every((preset) => typeof preset.responsibility === "string" && preset.responsibility.trim()));
    assert.ok(presets.every((preset) => !/长期上下文/.test(`${preset.line} ${preset.responsibility} ${preset.description || preset.desc || ""}`)));
    assert.ok(presets.filter((preset) => /长期/.test(`${preset.line} ${preset.responsibility} ${preset.description || preset.desc || ""}`)).length <= 2);
    assert.ok(presets.every((preset) => !Object.prototype.hasOwnProperty.call(preset, "setupPrompt")));
    assert.ok(presets.every((preset) => !Object.prototype.hasOwnProperty.call(preset, "setup")));
    assert.ok(presets.every((preset) => Array.isArray(preset.contextBindings) && preset.contextBindings.length));
    assert.ok(presets.every((preset) => Array.isArray(preset.handoffExamples) && preset.handoffExamples.length >= 3));
    assert.ok(presets.every((preset) => /不要求用户填写表格|不要要求用户填写表格/.test(preset.persona)));
    assert.equal(presets.some((preset) => preset.name === "论文搭子"), false);
    assert.equal(presets.some((preset) => preset.name === "表格整理师"), false);
    assert.equal(presets.some((preset) => preset.name === "汇报设计师"), false);
    assert.equal(presets.some((preset) => preset.name === "文档编辑"), false);
    assert.equal(presets.some((preset) => preset.name === "会议纪要官"), false);
    assert.equal(presets.some((preset) => preset.name === "剧情主持"), false);
    assert.equal(presets.some((preset) => preset.key === "speak-partner"), false);
    const experimentPreset = presets.find((preset) => preset.key === "experiment-records");
    assert.ok(experimentPreset.capabilities.enabledSkills.includes("mia-official:xlsx"));

    const enabledSkillIds = new Set(presets.flatMap((preset) => preset.capabilities.enabledSkills));
    assert.ok([...enabledSkillIds].every((id) => String(id).startsWith("mia-official:") || id === "mia-scheduler"));
    const library = await loader.loadLocalSkills();
    assert.equal(library.botPresets.length, presets.length);
    for (const id of enabledSkillIds) {
      assert.ok(library.skills.some((skill) => skill.id === id || skill.name === id), `missing preset skill: ${id}`);
      const indexed = loader.resolveSkillMaterialization({
        bot: { capabilities: { enabledSkills: [id] } },
        activeSkillIds: [],
        intentSkillIds: []
      });
      assert.match(indexed.indexBlock, /Available Mia Skills/);
      assert.equal(indexed.loadedBlock, "");

      const loaded = loader.resolveSkillMaterialization({
        bot: { capabilities: { enabledSkills: [id] } },
        activeSkillIds: [id],
        intentSkillIds: []
      });
      assert.match(loaded.loadedBlock, /=== Skill:/);
    }
    const xlsxContext = loader.resolveSkillMaterialization({
      bot: { capabilities: { enabledSkills: ["mia-official:xlsx"] } },
      activeSkillIds: ["mia-official:xlsx"],
      intentSkillIds: []
    }).loadedBlock;
    assert.match(xlsxContext, /Delivery Gate/);
    assert.match(xlsxContext, /Use Excel formulas/);
    assert.match(xlsxContext, /preserve its sheets, formatting, formulas/);
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

test("buildActiveSkillsDirective emits only the selected skill path block", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-skills-loader-"));
  try {
    const loader = makeLoader(home);
    await loader.installMarketplaceSkill({
      id: "demo-skill",
      zipBuffer: makeZip(),
      marketMeta: {
        nameZh: "演示技能",
        summaryZh: "按这个技能的流程处理当前任务。"
      }
    });

    const prompt = loader.buildActiveSkillsDirective(["demo-skill"]);
    assert.match(prompt, /selected_skill_paths/);
    assert.match(prompt, /<path>.*demo-skill\/SKILL\.md<\/path>/);
    assert.doesNotMatch(prompt, /demo-skill<\/id>|演示技能|directory|location/);
    assert.doesNotMatch(prompt, /# Demo Skill/);
    assert.equal(loader.buildActiveSkillsDirective([]), "");
    assert.equal(loader.buildActiveSkillsDirective(["does-not-exist"]), "");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
