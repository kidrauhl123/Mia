const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("skill-library renders a single unified skill grid without icon cards", () => {
  const src = read("src/renderer/skills/skill-library.js");
  // 卡片只保留标题、描述、来源和动作按钮；数据驱动分类，本机详情复用共享弹窗
  assert.match(src, /renderUnifiedSkillCard/);
  assert.doesNotMatch(src, /skill-card-icon/);
  assert.match(src, /data-skill-select=/);
  assert.match(src, /openLocalSkillModal/);
  // 不再有 plugins/connectors/extensions 的渲染与目录导航
  assert.doesNotMatch(src, /renderPluginCard|renderConnectorCard|renderExtensionDetail|renderExtensionNavRow|renderDirectorySectionRow|directorySectionRows/);
  assert.doesNotMatch(src, /data-directory-section|data-extension-select|data-extension-install|data-skill-plugin/);
  assert.doesNotMatch(src, /state\.directorySection|state\.skillLibraryMode|state\.selectedExtensionId|state\.skillPluginFilter|state\.skillStatusFilter/);
});

test("skills view has no DIRECTORY sidebar and search lives in the workspace", () => {
  const html = read("src/renderer/index.html");
  assert.doesNotMatch(html, /id="skillsSidebar"/);
  assert.doesNotMatch(html, /id="skillNav"/);
  // 搜索框在 skillsView 工作区内
  const view = html.slice(html.indexOf('id="skillsView"'), html.indexOf('id="skillContextMenu"'));
  assert.match(view, /id="skillSearch"/);
  // skills.css 已链接
  assert.match(html, /styles\/skills\.css/);
});

test("app.js drops skills sidebar refs and collapses the shell column", () => {
  const src = read("src/renderer/app.js");
  assert.doesNotMatch(src, /skillsSidebar:\s*document\.getElementById/);
  assert.doesNotMatch(src, /els\.skillsSidebar\?\.classList\.toggle/);
  assert.doesNotMatch(src, /skillNav:\s*document\.getElementById/);
  assert.doesNotMatch(src, /state\.skillLibraryMode\s*=\s*"plugins"/);
  // 进入视图时把 activeView 写到 app-shell，供 CSS 折叠侧栏列
  assert.match(src, /appShell\?\.setAttribute\("data-active-view"/);
});

test("skill styles moved to feature stylesheet and grid is full-width", () => {
  const skillsCss = (() => { try { return read("src/renderer/styles/skills.css"); } catch { return ""; } })();
  const baseCss = read("src/renderer/styles.css");
  // 新表存在且含全屏网格 + 折叠侧栏列规则
  assert.match(skillsCss, /\.skill-card-grid/);
  assert.doesNotMatch(skillsCss, /\.skill-card-icon/);
  assert.match(skillsCss, /\.app-shell\[data-active-view="skills"\]/);
  // base 表不再含已删/已迁移的技能专属规则
  assert.doesNotMatch(baseCss, /\.skills-sidebar\b/);
  assert.doesNotMatch(baseCss, /\.extension-detail\b/);
  assert.doesNotMatch(baseCss, /\.skill-row-card\b/);
});

test("skills workspace spans content columns and hides the resize handle", () => {
  const skillsCss = read("src/renderer/styles/skills.css");
  // 没有中栏后，skillsView 必须显式跨 sidebar/handle/workspace 三列，否则会落进 0 宽列
  assert.match(skillsCss, /\.skills-workspace\s*\{[^}]*grid-column:\s*2\s*\/\s*-1/);
  // 调宽手柄在 skills 视图隐藏，避免它占用 col2
  assert.match(skillsCss, /\[data-active-view="skills"\][^{]*#sidebarResizeHandle[^{]*\{[^}]*display:\s*none/);
});
