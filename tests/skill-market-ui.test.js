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
  assert.match(channels, /SkillsMarketInstall:\s*"skills:market-install"/);

  const preload = read("src/preload.js");
  assert.match(preload, /marketSkills:.*SkillsMarketList/);
  assert.match(preload, /installMarketSkill:.*SkillsMarketInstall/);
});

test("main serves the local curated market and installs from the bundled catalog", () => {
  const main = read("src/main.js");
  assert.match(main, /SkillsMarketList.*loadLocalSkillMarketPayload/);
  // install: zip the bundled skill dir → extract into the local skills dir
  assert.match(main, /packageLocalCatalogSkill\(skill\.id\)/);
  assert.match(main, /installMarketplaceSkill\(\{[\s\S]*id: skill\.id[\s\S]*zipBuffer/);
  assert.match(main, /marketMeta:\s*\{\s*sourceLabel: skill\.sourceLabel/);
});

test("skill-library renders a market mode with an install action", () => {
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
  assert.match(src, /data-skill-install=/);
  // local curated market: no Mia Cloud sign-in gate
  assert.doesNotMatch(src, /登录 Mia Cloud/);
});

test("market cards render Chinese fallback descriptions for English-only skills", () => {
  const src = read("src/renderer/skills/skill-library.js");
  assert.match(src, /function marketDescriptionZh/);
  assert.match(src, /function hasCjk/);
  assert.match(src, /来自 \$\{source\} 的技能/);
  assert.match(src, /description:\s*marketDescriptionZh\(skill\)/);
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
  assert.doesNotMatch(src, /已添加/);
  assert.match(src, /installedLocalSkillForMarket/);
  assert.match(src, /data-skill-use=/);
  assert.match(src, /skill-card-action-use/);
  assert.match(src, /skill-card-action-install/);

  const css = read("src/renderer/styles/skills.css");
  assert.match(css, /\.skill-card\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.skill-card-source\s*\{[\s\S]*display:\s*flex/);
  assert.match(css, /\.skill-source-logo\s*\{/);
  assert.match(css, /\.skill-source-logo-mask/);
  assert.match(css, /assets\/engine-icons\/hermesagent\.svg/);
  assert.match(css, /assets\/provider-icons\/github\.svg/);
  assert.match(css, /\.skill-source-logo-hermes\s*\{[\s\S]*color:\s*#0f172a/);
  assert.doesNotMatch(css, /\.skill-card-icon\.source-logo/);
  assert.doesNotMatch(css, /background:\s*var\(--accent\)/);
  assert.doesNotMatch(css, /\.skill-card-action\.installed/);
  assert.match(css, /\.skill-card-action\s*\{[\s\S]*border:\s*0/);
  assert.match(css, /\.skill-card-action\s*\{[\s\S]*opacity:\s*1/);
  assert.match(css, /\.skill-card-action-use\s*\{[\s\S]*opacity:\s*1/);
  assert.match(css, /\.skill-card-action-install\s*\{[\s\S]*opacity:\s*0/);
  assert.match(css, /\.skill-card:hover \.skill-card-action-install/);
  assert.match(css, /\.skill-card:focus-within \.skill-card-action-install/);
  assert.match(css, /\.skill-card-action-install\s*\{[\s\S]*background:\s*#111827/);
  assert.match(css, /\.skill-card-action-install\s*\{[\s\S]*color:\s*#fff/);

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

test("topbar has the mine/market toggle and market styles exist", () => {
  const html = read("src/renderer/index.html");
  assert.match(html, /id="skillModeToggle"/);
  const css = read("src/renderer/styles/skills.css");
  assert.match(css, /\.skill-mode-toggle/);
  assert.match(css, /\.skill-card-action/);
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
  assert.doesNotMatch(html, />我的技能</);
});
