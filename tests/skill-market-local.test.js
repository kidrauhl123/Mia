const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  loadLocalSkillMarket,
  loadLocalSkillMarketPayload,
  packageLocalCatalogSkill,
  validateCatalog
} = require("../src/main/skills/skill-market-local.js");

function makeCatalogDir(skills, zhEntries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-market-local-"));
  for (const skill of skills) {
    fs.mkdirSync(path.join(dir, skill.id), { recursive: true });
    if (skill.skillMd !== null) {
      fs.writeFileSync(path.join(dir, skill.id, "SKILL.md"), skill.skillMd);
    }
  }
  if (zhEntries !== null) {
    fs.writeFileSync(
      path.join(dir, "catalog.zh.json"),
      JSON.stringify({ version: 1, skills: zhEntries }, null, 2)
    );
  }
  return dir;
}

function skillMd({ name, description = "", category = "" }) {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    `category: ${category}`,
    "---",
    "",
    `# ${name}`,
    "body text"
  ].join("\n");
}

test("loadLocalSkillMarket merges SKILL.md with catalog.zh.json by id", () => {
  const dir = makeCatalogDir(
    [{ id: "pdf", skillMd: skillMd({ name: "pdf", description: "Work with PDFs" }) }],
    [{ id: "pdf", name_zh: "PDF 文档处理", summary_zh: "读写 PDF。", category_zh: "文档处理", source_label: "Anthropic 官方", order: 1 }]
  );
  try {
    const list = loadLocalSkillMarket({ catalogDir: dir });
    assert.equal(list.length, 1);
    const [s] = list;
    assert.equal(s.id, "pdf");
    assert.equal(s.name, "pdf");
    assert.equal(s.name_zh, "PDF 文档处理");
    assert.equal(s.summary_zh, "读写 PDF。");
    assert.equal(s.category_zh, "文档处理");
    assert.equal(s.sourceLabel, "Anthropic 官方");
    assert.equal(s.latestVersion, "1.0.0");
    assert.equal(s.version, "1.0.0");
    assert.match(s.checksum, /^[a-f0-9]{64}$/);
    assert.ok(s.body.includes("body text"), "full SKILL.md kept as body");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadLocalSkillMarketPayload exposes the snapshot in renderer/cloud shape", () => {
  const dir = makeCatalogDir(
    [
      { id: "pdf", skillMd: skillMd({ name: "pdf", description: "Work with PDFs", category: "docs" }) },
      { id: "code", skillMd: skillMd({ name: "code", description: "Work with code", category: "dev" }) }
    ],
    [
      { id: "pdf", name_zh: "PDF 文档处理", summary_zh: "读写 PDF。", category_zh: "文档处理", source_label: "Anthropic 官方", order: 1 },
      { id: "code", name_zh: "代码任务", summary_zh: "写代码。", category_zh: "开发工程", source_label: "社区", order: 2 }
    ]
  );
  try {
    const page = loadLocalSkillMarketPayload({ catalogDir: dir, params: { category: "文档处理", q: "PDF", limit: 10 } });
    assert.deepEqual(page.categories, [{ category: "文档处理", count: 1 }]);
    assert.equal(page.skills.length, 1);
    const [skill] = page.skills;
    assert.equal(skill.id, "pdf");
    assert.equal(skill.category, "文档处理");
    assert.equal(skill.rawCategory, "docs");
    assert.equal(skill.description, "读写 PDF。");
    assert.match(skill.checksum, /^[a-f0-9]{64}$/);
    assert.equal(Buffer.isBuffer(packageLocalCatalogSkill("pdf", { catalogDir: dir })), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadLocalSkillMarket sorts by order then id", () => {
  const dir = makeCatalogDir(
    [
      { id: "b", skillMd: skillMd({ name: "b" }) },
      { id: "a", skillMd: skillMd({ name: "a" }) },
      { id: "c", skillMd: skillMd({ name: "c" }) }
    ],
    [
      { id: "b", name_zh: "B", summary_zh: "b", category_zh: "x", order: 5 },
      { id: "a", name_zh: "A", summary_zh: "a", category_zh: "x", order: 5 },
      { id: "c", name_zh: "C", summary_zh: "c", category_zh: "x", order: 1 }
    ]
  );
  try {
    const ids = loadLocalSkillMarket({ catalogDir: dir }).map((s) => s.id);
    assert.deepEqual(ids, ["c", "a", "b"], "order asc, ties broken by id");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadLocalSkillMarket excludes underscore-prefixed dirs (builtin)", () => {
  const dir = makeCatalogDir(
    [
      { id: "pdf", skillMd: skillMd({ name: "pdf" }) },
      { id: "_builtin", skillMd: skillMd({ name: "builtin" }) }
    ],
    [{ id: "pdf", name_zh: "PDF", summary_zh: "x", category_zh: "文档处理", order: 1 }]
  );
  try {
    const ids = loadLocalSkillMarket({ catalogDir: dir }).map((s) => s.id);
    assert.deepEqual(ids, ["pdf"], "_-prefixed dirs are not market entries");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadLocalSkillMarket falls back to English description when no zh entry", () => {
  const dir = makeCatalogDir(
    [{ id: "pdf", skillMd: skillMd({ name: "pdf", description: "Work with PDFs" }) }],
    []
  );
  try {
    const [s] = loadLocalSkillMarket({ catalogDir: dir });
    assert.equal(s.id, "pdf");
    assert.equal(s.summary_zh, "Work with PDFs", "summary_zh falls back to English description");
    assert.equal(s.name_zh, "pdf", "name_zh falls back to name");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateCatalog passes when dirs and manifest agree", () => {
  const dir = makeCatalogDir(
    [{ id: "pdf", skillMd: skillMd({ name: "pdf" }) }],
    [{ id: "pdf", name_zh: "PDF", summary_zh: "读写 PDF", category_zh: "文档处理", order: 1 }]
  );
  try {
    assert.doesNotThrow(() => validateCatalog({ catalogDir: dir }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateCatalog throws when a skill dir is missing from the manifest", () => {
  const dir = makeCatalogDir(
    [
      { id: "pdf", skillMd: skillMd({ name: "pdf" }) },
      { id: "docx", skillMd: skillMd({ name: "docx" }) }
    ],
    [{ id: "pdf", name_zh: "PDF", summary_zh: "x", category_zh: "文档处理", order: 1 }]
  );
  try {
    assert.throws(() => validateCatalog({ catalogDir: dir }), /docx/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateCatalog throws when a manifest id has no skill dir", () => {
  const dir = makeCatalogDir(
    [{ id: "pdf", skillMd: skillMd({ name: "pdf" }) }],
    [
      { id: "pdf", name_zh: "PDF", summary_zh: "x", category_zh: "文档处理", order: 1 },
      { id: "ghost", name_zh: "幽灵", summary_zh: "x", category_zh: "文档处理", order: 2 }
    ]
  );
  try {
    assert.throws(() => validateCatalog({ catalogDir: dir }), /ghost/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateCatalog throws when a manifest entry misses required zh fields", () => {
  const dir = makeCatalogDir(
    [{ id: "pdf", skillMd: skillMd({ name: "pdf" }) }],
    [{ id: "pdf", name_zh: "PDF", summary_zh: "", category_zh: "文档处理", order: 1 }]
  );
  try {
    assert.throws(() => validateCatalog({ catalogDir: dir }), /summary_zh/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
