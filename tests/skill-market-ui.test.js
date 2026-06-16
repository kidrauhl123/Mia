const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("market IPC channels + preload bridge are wired", () => {
  const channels = read("src/shared/ipc-channels.js");
  assert.match(channels, /SkillsMarketList:\s*"skills:market-list"/);
  assert.match(channels, /SkillsMarketRead:\s*"skills:market-read"/);
  assert.match(channels, /SkillsMarketInstall:\s*"skills:market-install"/);

  const preload = read("src/preload.js");
  assert.match(preload, /marketSkills:.*SkillsMarketList/);
  assert.match(preload, /readMarketSkill:.*SkillsMarketRead/);
  assert.match(preload, /installMarketSkill:.*SkillsMarketInstall/);
});

test("main serves a snapshot-plus-cloud market and installs through the unified path", () => {
  const main = read("src/main.js");
  assert.match(main, /SkillsMarketList.*listDesktopMarketSkills/);
  assert.match(main, /SkillsMarketRead.*readDesktopMarketSkill/);
  assert.match(main, /function skillMarketSnapshot/);
  assert.match(main, /function cachedDesktopMarketPayload/);
  assert.match(main, /forceRefresh:\s*true/);
  assert.match(main, /cloudDesktopSync\(\)\.listMarketSkills/);
  assert.match(main, /function isHiddenRemoteMarketSkill/);
  assert.match(main, /\.filter\(\(skill\) => !isHiddenRemoteMarketSkill\(skill\)\)/);
  assert.match(main, /SkillsMarketInstall.*installDesktopMarketSkill/);
  assert.match(main, /function installDesktopMarketSkill/);
  assert.match(main, /function readDesktopMarketSkill/);
  assert.match(main, /readSkillMarkdownFromPackage/);
  assert.match(main, /isHiddenRemoteMarketSkill\(\{\s*id\s*\}\)/);
  assert.match(main, /packageLocalCatalogSkill\(snapshot\.id\)/);
  assert.match(main, /cloudDesktopSync\(\)\.downloadSkillPackage/);
  assert.match(main, /verifySkillPackageChecksum/);
  assert.match(main, /marketMetaFromSkill/);
});

test("skill-library renders a market mode with modal install actions", () => {
  const src = read("src/renderer/skills/skill-library.js");
  assert.match(src, /const MARKET_SKILL_PAGE_LIMIT = 72/);
  assert.match(src, /function marketRequestParams/);
  assert.match(src, /limit:\s*MARKET_SKILL_PAGE_LIMIT/);
  assert.match(src, /state\.skillMarket\.queryKey/);
  assert.match(src, /window\.mia\.marketSkills\(params\)/);
  assert.match(src, /forceRefresh:\s*true/);
  assert.match(src, /background:\s*true/);
  assert.match(src, /state\.skillMarket\.refreshing/);
  assert.match(src, /data\?\.cached/);
  assert.match(src, /data\?\.stale/);
  assert.doesNotMatch(src, /window\.mia\.marketSkills\(\{\}\)/);
  assert.match(src, /state\.skillMarketMode/);
  assert.match(src, /function renderMarketView/);
  assert.match(src, /function installMarketSkill/);
  assert.match(src, /openMarketModal\(card\.dataset\.marketId\)/);
  assert.match(src, /installMarketSkill\(skill\.id\)/);
  assert.doesNotMatch(src, /data-skill-install=/);
});

test("market cards render Chinese fallback descriptions for English-only skills", () => {
  const src = read("src/renderer/skills/skill-library.js");
  assert.match(src, /function marketDescriptionZh/);
  assert.match(src, /function hasCjk/);
  assert.match(src, /description:\s*marketDescriptionZh\(skill\)/);
});

test("local skill helpers prefer market and official Chinese display metadata", () => {
  const src = read("src/renderer/skills/skill-helpers.js");
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(src, context, { filename: "skill-helpers.js" });

  assert.equal(
    context.window.miaSkillHelpers.skillDisplayName({ name: "pdf", marketNameZh: "PDF 文档处理" }),
    "PDF 文档处理"
  );
  assert.equal(
    context.window.miaSkillHelpers.skillSummaryZh({ name: "pdf", marketSummaryZh: "读写 PDF。" }),
    "读写 PDF。"
  );
  assert.equal(
    context.window.miaSkillHelpers.skillDisplayName({ source: "mia-official", name: "skill-creator" }),
    "技能创作"
  );
  assert.equal(
    context.window.miaSkillHelpers.skillDisplayName({ source: "mia-official", name: "xlsx" }),
    "Excel 表格"
  );
  assert.equal(
    context.window.miaSkillHelpers.skillDisplayCategory({ source: "mia-official", name: "xlsx", category: "uncategorized" }),
    "文档处理"
  );
  assert.match(
    context.window.miaSkillHelpers.skillSummaryZh({ source: "mia-official", name: "xlsx" }),
    /读写 Excel 表格/
  );
  assert.equal(
    context.window.miaSkillHelpers.skillDisplayName({ source: "mia", name: "my-custom-skill" }),
    "my-custom-skill"
  );
});

test("market cards render compact source logos beside source labels", () => {
  const src = read("src/renderer/skills/skill-library.js");
  assert.match(src, /MARKET_SOURCE_LOGOS/);
  assert.match(src, /function renderUnifiedSkillCard/);
  assert.match(src, /function marketSourceKey/);
  assert.match(src, /function marketSourceLogoHtml/);
  assert.match(src, /className = `skill-source-logo skill-source-logo-\$\{sourceKey\}`/);
  assert.match(src, /claude:\s*\{\s*label:\s*"Claude"/);
  assert.match(src, /values\.has\("anthropic"\)/);
  assert.match(src, /values\.has\("anthropics\/skills"\)/);
  assert.doesNotMatch(src, /function marketCardIconHtml/);
  assert.doesNotMatch(src, /marketCardIconHtml\(skill/);
  assert.match(src, /assets\/provider-icons\/skills-sh\.png/);
  assert.match(src, /assets\/provider-icons\/clawhub\.png/);
  assert.match(src, /assets\/provider-icons\/browse-sh\.svg/);
  assert.match(src, /assets\/provider-icons\/claude\.svg/);
  assert.match(src, /assets\/provider-icons\/lobehub\.svg/);
  assert.match(src, /installedLocalSkillForMarket/);
  assert.match(src, /local\.marketId/);
  assert.match(src, /local\.source === "mia-official"/);
  assert.doesNotMatch(src, /local\.name === skill\.name/);
  assert.doesNotMatch(src, /data-skill-use=/);
  assert.doesNotMatch(src, /data-skill-install=/);
  assert.doesNotMatch(src, /skill-card-action/);

  const css = read("src/renderer/styles/skills.css");
  assert.match(css, /\.skill-card\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.skill-card-source\s*\{[\s\S]*display:\s*flex/);
  const skillCardRule = css.match(/\.skill-card\s*\{([\s\S]*?)\}/)?.[1] || "";
  const skillCardHoverRule = css.match(/\.skill-card:hover\s*\{([\s\S]*?)\}/)?.[1] || "";
  assert.doesNotMatch(skillCardRule, /transition:[^;]*transform/, "skill cards should not animate their own position");
  assert.doesNotMatch(skillCardHoverRule, /transform:/, "skill cards should not float on hover");
  assert.match(css, /\.skill-source-logo\s*\{/);
  assert.match(css, /\.skill-source-logo-mask/);
  assert.match(css, /assets\/engine-icons\/hermesagent\.svg/);
  assert.match(css, /assets\/provider-icons\/github\.svg/);
  assert.match(css, /\.skill-source-logo-hermes\s*\{[\s\S]*color:\s*#0f172a/);
  assert.doesNotMatch(css, /\.skill-card-icon\.source-logo/);
  assert.doesNotMatch(css, /background:\s*var\(--accent\)/);
  assert.doesNotMatch(css, /\.skill-card-action/);

  [
    "src/renderer/assets/engine-icons/hermesagent.svg",
    "src/renderer/assets/provider-icons/github.svg",
    "src/renderer/assets/provider-icons/skills-sh.png",
    "src/renderer/assets/provider-icons/clawhub.png",
    "src/renderer/assets/provider-icons/browse-sh.svg",
    "src/renderer/assets/provider-icons/claude.svg",
    "src/renderer/assets/provider-icons/lobehub.svg"
  ].forEach((rel) => assert.ok(fs.existsSync(path.join(root, rel)), `${rel} should exist`));
});

test("market cards do not render direct install or use actions", () => {
  const src = read("src/renderer/skills/skill-library.js");
  const fakeEl = () => ({
    innerHTML: "",
    style: { setProperty: () => {} },
    classList: { toggle: () => {}, add: () => {}, remove: () => {} },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, width: 0, height: 0 })
  });
  const state = {
    skillFilter: "",
    skillCategoryFilter: "",
    skillMarketMode: true,
    skillMarket: {
      skills: [{ id: "skill-creator", name: "skill-creator", name_zh: "技能创作", category: "开发工程", description: "desc", sourceLabel: "Anthropic 官方" }],
      categories: [{ category: "开发工程", count: 1 }],
      loading: false,
      loaded: true,
      queryKey: JSON.stringify({ category: "", q: "", limit: 72 }),
      error: ""
    },
    skillLibrary: {
      skills: [{ id: "mia-official:skill-creator", source: "mia-official", name: "skill-creator" }]
    },
    installingSkillIds: new Set(),
    selectedSkillId: "",
    skillContextMenu: { open: false, skillId: "" }
  };
  const els = {
    skillModeToggle: fakeEl(),
    skillChipRow: fakeEl(),
    skillCardGrid: fakeEl(),
    skillPageTitle: fakeEl(),
    skillContextMenu: fakeEl()
  };
  const context = {
    console,
    requestAnimationFrame: (fn) => fn(),
    window: {
      addEventListener: () => {},
      innerWidth: 1024,
      miaSkillHelpers: {
        skillDisplayName: (skill) => skill.name_zh || skill.marketNameZh || skill.name,
        skillSummaryZh: (skill) => skill.description || "",
        skillDisplayCategory: (skill) => skill.category || skill.marketCategoryZh || "",
        skillAuthorLabel: (skill) => skill.pluginLabel || skill.sourceLabel || "Local",
        skillTone: () => "blue",
        skillInitials: () => "SK",
        renderSkillMarkdownSource: (body) => body
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(src, context, { filename: "skill-library.js" });
  context.window.miaSkillLibrary.initSkillLibrary({
    state,
    els,
    mia: null,
    escapeHtml: (value) => String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;"),
    setText: (el, value) => { el.textContent = String(value || ""); },
    menuItemHtml: () => "",
    syncTopbarClickCapture: () => {},
    closeGroupContextMenu: () => {},
    showNarrowContent: () => {},
    deleteSkill: () => {},
    openSkillDirectory: () => {}
  });

  context.window.miaSkillLibrary.renderSkillLibrary();
  assert.match(els.skillCardGrid.innerHTML, /data-market-id="skill-creator"/);
  assert.doesNotMatch(els.skillCardGrid.innerHTML, /skill-card-action/);
  assert.doesNotMatch(els.skillCardGrid.innerHTML, /data-skill-install=/);
  assert.doesNotMatch(els.skillCardGrid.innerHTML, /data-skill-use=/);

  state.skillLibrary.skills.push({ id: "mia:skill-creator", source: "mia", fromMarket: true, marketId: "skill-creator", name: "skill-creator" });
  context.window.miaSkillLibrary.renderSkillLibrary();
  assert.match(els.skillCardGrid.innerHTML, /data-market-id="skill-creator"/);
  assert.doesNotMatch(els.skillCardGrid.innerHTML, /skill-card-action/);
  assert.doesNotMatch(els.skillCardGrid.innerHTML, /data-skill-install=/);
  assert.doesNotMatch(els.skillCardGrid.innerHTML, /data-skill-use=/);
});

test("topbar has the mine/market toggle and market styles exist", () => {
  const html = read("src/renderer/index.html");
  assert.match(html, /id="skillModeToggle"/);
  const css = read("src/renderer/styles/skills.css");
  assert.match(css, /\.skill-mode-toggle/);
  assert.match(css, /\.skill-card/);
  assert.doesNotMatch(css, /\.skill-card-action/);
});

test("market state tracks cached pages separately from foreground loading", () => {
  const state = read("src/renderer/app-state.js");
  assert.match(state, /refreshing:\s*false/);
  assert.match(state, /cached:\s*false/);
  assert.match(state, /stale:\s*false/);
  assert.match(state, /updatedAt:\s*""/);
});

test("local market cards infer known source labels from legacy market ids", () => {
  const src = read("src/renderer/skills/skill-library.js");
  const context = {
    console,
    window: {
      miaSkillHelpers: {
        skillDisplayName: (skill) => skill.title || skill.name,
        skillSummaryZh: (skill) => skill.description || "",
        skillDisplayCategory: (skill) => skill.category || "",
        skillAuthorLabel: (skill) => skill.pluginLabel || skill.sourceLabel || "Local",
        skillTone: () => "blue",
        skillInitials: () => "SK",
        renderSkillMarkdownSource: (body) => body
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(src, context, { filename: "skill-library.js" });

  context.window.miaSkillLibrary.initSkillLibrary({
    state: { selectedSkillId: "" },
    els: {},
    mia: null,
    escapeHtml: (value) => String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;"),
    setText: () => {},
    menuItemHtml: () => "",
    syncTopbarClickCapture: () => {},
    closeGroupContextMenu: () => {},
    showNarrowContent: () => {},
    deleteSkill: () => {},
    openSkillDirectory: () => {}
  });

  const html = context.window.miaSkillLibrary.renderSkillCard({
    id: "mia:hermes.claude-marketplace.presentation-tools.abc123",
    name: "presentation-tools",
    title: "presentation-tools",
    description: "Use this skill when working with presentation files.",
    pluginLabel: "我的技能",
    relPath: "hermes.claude-marketplace.presentation-tools.abc123/SKILL.md"
  });

  assert.match(html, /skill-source-logo-claude/);
  assert.match(html, />Claude</);
});
