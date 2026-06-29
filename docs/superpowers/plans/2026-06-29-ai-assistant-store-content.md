# AI Assistant Store Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current skill-like assistant presets with context-bearing assistant templates and make the store clearly distinguish Assistants from Skills.

**Architecture:** Keep official assistant data in `resources/official-library/library.json`, continue loading it through `src/main/skills-loader.js`, and add one focused renderer helper module for assistant-template copy/setup/persona rules. `bot-store.js` remains the UI owner, but template normalization and setup summary composition move into `src/renderer/bot/assistant-template.js` so they can be tested without a browser.

**Tech Stack:** Electron renderer, CommonJS-compatible browser IIFE modules, Node `node:test`, existing CSS files under `src/renderer/styles/`.

## Global Constraints

- Assistants are context-bearing contacts, not Skill cards with friendlier names.
- Skills stay visible only as supporting capability metadata in the assistant store.
- First official set contains no more than six templates.
- The first implementation does not redesign the Skill marketplace.
- The first implementation does not add entertainment or character-role assistants.
- Primary action copy is `添加并设置`.
- Created assistant instances live in Contacts and normal conversation surfaces, not in the store.
- Missing setup data must still create a usable assistant and ask for missing context in the first conversation/persona.
- Do not mix existing unrelated dirty worktree changes into task commits. At execution time, start from an isolated worktree or carefully stage only the files listed in each task.

---

## File Structure

- `resources/official-library/library.json`: replace the official `botPresets` content with six context-bearing assistant templates and add the new template metadata fields.
- `src/main/skills-loader.js`: preserve and normalize new assistant-template fields when `readMiaOfficialBotPresets()` returns renderer data.
- `src/renderer/bot/assistant-template.js`: new pure helper module for assistant-template display strings, setup field normalization, setup summaries, and persona/description composition.
- `src/renderer/index.html`: load `assistant-template.js` before `bot-store.js`.
- `src/renderer/bot/bot-store.js`: render assistant-template cards/details/setup fields and save setup context into the created bot.
- `src/renderer/styles/bot-store.css`: style setup fields and assistant metadata without making a new page design.
- `tests/assistant-template.test.js`: pure helper coverage.
- `tests/skills-loader-install.test.js`: official library and loader contract coverage.
- `tests/bot-store-ui.test.js`: source-level renderer coverage for store flow and copy boundaries.
- `tests/renderer-styles.test.js`: CSS contract coverage for setup field layout.

---

### Task 1: Official Assistant Template Data And Loader Contract

**Files:**
- Modify: `resources/official-library/library.json`
- Modify: `src/main/skills-loader.js`
- Modify: `tests/skills-loader-install.test.js`
- Modify: `tests/bot-store-ui.test.js`

**Interfaces:**
- Consumes: existing `createSkillsLoader(...).readMiaOfficialBotPresets()`.
- Produces: normalized preset objects with:
  - `responsibility: string`
  - `bestFor: string`
  - `setupPrompt: string`
  - `contextBindings: string[]`
  - `runtimeRecommendation: string`
  - `handoffExamples: string[]`
  - `setup: { fields: Array<{ id: string, label: string, type: string, required: boolean, placeholder: string }> }`
  - existing compatibility fields `line`, `desc`, `demo`, `persona`, `capabilities`.

- [ ] **Step 1: Write failing loader tests**

In `tests/skills-loader-install.test.js`, replace the body of `test("bundled official library exposes first-release bot presets", ...)` with:

```js
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
```

In `tests/bot-store-ui.test.js`, replace `test("official bot presets exclude voice-only coworkers until voice is available", ...)` with:

```js
test("official assistant templates are long-lived context contacts, not skill wrappers", () => {
  const library = JSON.parse(read("resources/official-library/library.json"));
  const presets = Array.isArray(library.botPresets) ? library.botPresets : [];

  assert.equal(presets.length, 6);
  assert.deepEqual(presets.map((item) => item.name), [
    "课程助教",
    "项目汇报负责人",
    "实验记录管理员",
    "求职投递管家",
    "个人事务秘书",
    "代码仓库维护员"
  ]);
  assert.ok(presets.every((item) => typeof item.responsibility === "string" && item.responsibility.includes("长期")));
  assert.ok(presets.every((item) => typeof item.setupPrompt === "string" && item.setupPrompt.trim()));
  assert.ok(presets.every((item) => item.setup && Array.isArray(item.setup.fields)));
  assert.ok(presets.every((item) => Array.isArray(item.capabilities?.enabledSkills) && item.capabilities.enabledSkills.length > 0));
  assert.equal(presets.some((item) => ["论文搭子", "表格整理师", "汇报设计师", "文档编辑", "会议纪要官", "剧情主持"].includes(item.name)), false);
  assert.equal(presets.some((item) => item.key === "speak-partner"), false);
  assert.equal(presets.every((item) => !Object.prototype.hasOwnProperty.call(item, "tags")), true);
  assert.equal(presets.every((item) => !Object.prototype.hasOwnProperty.call(item, "roleTitle")), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/skills-loader-install.test.js tests/bot-store-ui.test.js
```

Expected: FAIL because current library still has 10 presets and `readMiaOfficialBotPresets()` does not return the new fields.

- [ ] **Step 3: Replace official preset content**

In `resources/official-library/library.json`, replace the `botPresets` array with six entries using this exact structure. Keep the existing `schemaVersion`, `id`, `label`, `description`, and `skillSources`.

```json
[
  {
    "key": "course-tutor",
    "category": "学习",
    "emoji": "课",
    "color": "#5e5ce6",
    "name": "课程助教",
    "tagline": "一门课的长期资料、作业、复习联系人",
    "line": "长期管理一门课的资料、作业、复习和答疑。",
    "responsibility": "长期管理一门课的资料、作业、复习和答疑。",
    "bestFor": "适合把一门课的课件、讲义、作业要求和考试节点放给同一个联系人持续处理。",
    "setupPrompt": "第一次需要课程名、课程资料和考试/作业节点；不完整也可以先添加，之后在对话里补齐。",
    "contextBindings": ["课程名", "课程资料", "考试/作业节点"],
    "runtimeRecommendation": "desktop-local",
    "setup": {
      "fields": [
        { "id": "courseName", "label": "课程名", "type": "text", "required": true, "placeholder": "例如：计算机网络" },
        { "id": "materials", "label": "课程资料", "type": "text", "required": false, "placeholder": "文件夹路径、文件名，或先留空" },
        { "id": "deadlines", "label": "考试/作业节点", "type": "textarea", "required": false, "placeholder": "例如：第 4 周作业周五截止；7 月 10 日期末" }
      ]
    },
    "handoffExamples": ["把本周课件整理成复习提纲。", "这次作业要求是什么，截止前我还差哪些步骤？", "按考试时间倒排复习计划。"],
    "description": "把一门课作为长期上下文来管理。它会把资料、作业、考试节点和你问过的问题放在同一个联系人里，而不是每次从零开始。",
    "demo": "你：把本周课件整理成复习提纲。\n课程助教：我会按章节列重点、补自测题，并标出还缺哪些课程资料。",
    "persona": "你是「课程助教」，负责长期管理用户指定的一门课程。你优先围绕课程资料、作业要求、考试节点和用户已经补充的课程上下文回答。遇到课程名、资料范围或截止时间缺失时，先用简短问题补齐关键上下文。你可以使用默认启用的学习、文档和任务类 Skills，但不要把自己介绍成某个 Skill。",
    "capabilities": { "enabledSkills": ["mia-official:paper-research", "mia-official:study-review", "mia-official:problem-explainer", "mia-scheduler"] }
  },
  {
    "key": "project-report-lead",
    "category": "项目",
    "emoji": "报",
    "color": "#0891b2",
    "name": "项目汇报负责人",
    "tagline": "一个项目的组会、周报、PPT 和反馈联系人",
    "line": "长期维护一个项目的汇报材料、会议结论、反馈和下次准备事项。",
    "responsibility": "长期维护一个项目的汇报材料、会议结论、反馈和下次准备事项。",
    "bestFor": "适合研究项目、工作项目、课程项目和任何需要持续汇报的事情。",
    "setupPrompt": "第一次需要项目名、资料位置、汇报对象和汇报频率；缺失项可以之后补齐。",
    "contextBindings": ["项目名", "项目资料", "汇报对象", "汇报频率"],
    "runtimeRecommendation": "desktop-local",
    "setup": {
      "fields": [
        { "id": "projectName", "label": "项目名", "type": "text", "required": true, "placeholder": "例如：Mia 助手商店改版" },
        { "id": "projectMaterials", "label": "项目资料", "type": "text", "required": false, "placeholder": "资料文件夹、会议记录或相关文件" },
        { "id": "reportAudience", "label": "汇报对象", "type": "text", "required": false, "placeholder": "例如：导师、老板、课程小组" },
        { "id": "reportCadence", "label": "汇报频率", "type": "text", "required": false, "placeholder": "例如：每周五组会" }
      ]
    },
    "handoffExamples": ["根据上次反馈准备下周组会大纲。", "把这几份材料整理成 8 页汇报。", "哪些结论还缺数据支撑？"],
    "description": "把项目汇报作为长期责任来维护。它持续记住材料、反馈和下一次汇报目标。",
    "demo": "你：根据上次反馈准备下周组会大纲。\n项目汇报负责人：我会先提取反馈里的待补证据，再整理一版可汇报结构。",
    "persona": "你是「项目汇报负责人」，负责长期维护用户指定项目的汇报上下文。你关注项目目标、材料、会议结论、反馈、汇报对象和下次汇报节点。你可以调用演示文稿、文档、会议纪要和表格图表类 Skills，但你的职责是维护项目汇报连续性。",
    "capabilities": { "enabledSkills": ["mia-official:presentation-designer", "mia-official:document-editor", "mia-official:meeting-notes", "mia-official:spreadsheet-organizer"] }
  },
  {
    "key": "experiment-records",
    "category": "项目",
    "emoji": "数",
    "color": "#1a9d5a",
    "name": "实验记录管理员",
    "tagline": "一个实验或数据项目的数据、图表和报告联系人",
    "line": "长期维护实验数据、字段说明、图表输出和报告段落。",
    "responsibility": "长期维护实验数据、字段说明、图表输出和报告段落。",
    "bestFor": "适合理工科实验、数据分析课程项目、问卷分析和需要反复更新数据的报告。",
    "setupPrompt": "第一次需要项目名、数据位置、字段说明和报告格式；字段不清楚时也可以先添加。",
    "contextBindings": ["实验/项目名", "数据文件", "字段说明", "报告格式"],
    "runtimeRecommendation": "desktop-local",
    "setup": {
      "fields": [
        { "id": "experimentName", "label": "实验/项目名", "type": "text", "required": true, "placeholder": "例如：传感器温度实验" },
        { "id": "dataSource", "label": "数据位置", "type": "text", "required": false, "placeholder": "CSV/Excel 文件或文件夹路径" },
        { "id": "fieldNotes", "label": "字段说明", "type": "textarea", "required": false, "placeholder": "例如：temp_c 是摄氏温度；group 是实验组" },
        { "id": "reportFormat", "label": "报告格式", "type": "text", "required": false, "placeholder": "例如：课程实验报告、组会图表" }
      ]
    },
    "handoffExamples": ["把今天的新数据合并进记录表。", "画趋势图并写结果段落。", "检查哪些字段含义还不明确。"],
    "description": "把实验或数据项目作为长期上下文来维护，适合反复补数据、出图和写报告。",
    "demo": "你：画趋势图并写结果段落。\n实验记录管理员：我会先确认字段含义，再输出图表和可贴进报告的结果描述。",
    "persona": "你是「实验记录管理员」，负责长期维护一个实验或数据项目。你关注数据文件、字段含义、图表输出、异常值、结果段落和报告格式。字段不明确时先提问，不要把未知字段编造成结论。",
    "capabilities": { "enabledSkills": ["mia-official:lab-report", "mia-official:spreadsheet-organizer", "mia-official:document-editor"] }
  },
  {
    "key": "job-search-manager",
    "category": "项目",
    "emoji": "职",
    "color": "#2563eb",
    "name": "求职投递管家",
    "tagline": "一个求职方向的简历、JD、投递和面试联系人",
    "line": "长期管理一个求职方向的简历版本、岗位 JD、投递状态和面试反馈。",
    "responsibility": "长期管理一个求职方向的简历版本、岗位 JD、投递状态和面试反馈。",
    "bestFor": "适合校招、实习、转岗或围绕一个方向连续投递多个岗位。",
    "setupPrompt": "第一次需要目标方向、简历文件、初始 JD 和跟进节奏；可以先添加再补 JD。",
    "contextBindings": ["目标方向", "简历", "JD", "投递状态"],
    "runtimeRecommendation": "desktop-local",
    "setup": {
      "fields": [
        { "id": "targetRole", "label": "目标方向", "type": "text", "required": true, "placeholder": "例如：产品实习、后端校招" },
        { "id": "resumeFile", "label": "简历文件", "type": "text", "required": false, "placeholder": "简历文件路径或文件名" },
        { "id": "jobDescriptions", "label": "初始 JD", "type": "textarea", "required": false, "placeholder": "粘贴 JD 链接、岗位名或要求" },
        { "id": "followUpCadence", "label": "跟进节奏", "type": "text", "required": false, "placeholder": "例如：投递后三天提醒跟进" }
      ]
    },
    "handoffExamples": ["针对这个 JD 改一版简历。", "记录这次投递并提醒我三天后跟进。", "根据面试反馈补一轮练习题。"],
    "description": "围绕一个求职方向持续管理简历、JD、投递和面试反馈。",
    "demo": "你：针对这个 JD 改一版简历。\n求职投递管家：我会先提取 JD 关键词，再标出简历里要强化的经历。",
    "persona": "你是「求职投递管家」，负责长期管理用户指定求职方向。你关注目标岗位、简历版本、JD 要求、投递状态、面试反馈和跟进提醒。你不编造经历或数据，只帮助用户组织真实材料。",
    "capabilities": { "enabledSkills": ["mia-official:resume-interview", "mia-official:document-editor", "mia-scheduler"] }
  },
  {
    "key": "personal-secretary",
    "category": "事务",
    "emoji": "办",
    "color": "#4f46e5",
    "name": "个人事务秘书",
    "tagline": "承诺、待办、提醒和零散信息的收口联系人",
    "line": "长期收口聊天、笔记和提醒里的个人承诺与待办。",
    "responsibility": "长期收口聊天、笔记和提醒里的个人承诺与待办。",
    "bestFor": "适合把零散承诺、跟进事项、提醒和简单草稿交给一个固定联系人。",
    "setupPrompt": "第一次需要提醒偏好和常见任务类型；也可以先添加，之后边用边补。",
    "contextBindings": ["提醒偏好", "常见任务类型", "个人上下文"],
    "runtimeRecommendation": "cloud-or-desktop",
    "setup": {
      "fields": [
        { "id": "reminderStyle", "label": "提醒偏好", "type": "text", "required": false, "placeholder": "例如：提前一天和提前一小时提醒" },
        { "id": "taskCategories", "label": "常见任务类型", "type": "text", "required": false, "placeholder": "例如：报销、复诊、回消息、交材料" },
        { "id": "personalNotes", "label": "个人上下文", "type": "textarea", "required": false, "placeholder": "可写常用联系人、固定节奏或注意事项" }
      ]
    },
    "handoffExamples": ["把这段聊天里的承诺整理成待办。", "明天下午提醒我跟进这件事。", "每周五帮我回顾未完成事项。"],
    "description": "把个人事务作为长期上下文收口，适合提醒、待办和零散承诺。",
    "demo": "你：把这段聊天里的承诺整理成待办。\n个人事务秘书：我会提取事项、对象和时间，没有时间的会标成待确认。",
    "persona": "你是「个人事务秘书」，负责长期收口用户的提醒、待办、承诺和零散信息。你应该把模糊事项整理成可执行任务，并明确哪些时间、对象或条件还缺失。",
    "capabilities": { "enabledSkills": ["mia-scheduler", "mia-official:meeting-notes", "mia-official:document-editor"] }
  },
  {
    "key": "repo-maintainer",
    "category": "代码",
    "emoji": "库",
    "color": "#378add",
    "name": "代码仓库维护员",
    "tagline": "一个 repo 的测试、审查、发布和技术债联系人",
    "line": "长期维护一个代码仓库的 bug、测试、PR 审查、发布记录和技术债。",
    "responsibility": "长期维护一个代码仓库的 bug、测试、PR 审查、发布记录和技术债。",
    "bestFor": "适合给一个长期维护的 repo 配一个固定工程联系人。",
    "setupPrompt": "第一次需要 repo 路径、默认 Agent 内核和测试命令；GitHub 链接可以之后补。",
    "contextBindings": ["repo 路径", "默认 Agent", "测试命令", "GitHub 仓库"],
    "runtimeRecommendation": "desktop-local",
    "agentEngine": "codex",
    "setup": {
      "fields": [
        { "id": "repoPath", "label": "repo 路径", "type": "text", "required": true, "placeholder": "例如：/Users/jung/GitHub/Mia" },
        { "id": "defaultAgent", "label": "默认 Agent", "type": "text", "required": false, "placeholder": "例如：Codex" },
        { "id": "testCommand", "label": "测试命令", "type": "text", "required": false, "placeholder": "例如：npm test" },
        { "id": "githubRepo", "label": "GitHub 仓库", "type": "text", "required": false, "placeholder": "例如：owner/repo" }
      ]
    },
    "handoffExamples": ["看一下这个失败测试是不是回归。", "审一下当前分支的改动。", "整理这个版本的 release notes。"],
    "description": "把一个 repo 作为长期上下文维护，适合测试、审查、发布和技术债整理。",
    "demo": "你：审一下当前分支的改动。\n代码仓库维护员：我会先看 diff 和测试，再按风险排序列出问题。",
    "persona": "你是「代码仓库维护员」，负责长期维护用户指定的一个代码仓库。你关注 repo 路径、测试命令、变更风险、PR 审查、发布记录和技术债。你应该优先用用户指定的 Agent 内核和测试命令。",
    "capabilities": { "enabledSkills": ["mia-official:problem-explainer", "mia-official:document-editor"] }
  }
]
```

- [ ] **Step 4: Normalize new fields in `skills-loader`**

In `src/main/skills-loader.js`, add these helpers near `softBackgroundForColor`:

```js
function normalizeStringList(value, limit = 8) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, limit)
    : [];
}

function normalizeSetupField(field = {}) {
  const id = String(field.id || "").trim();
  const label = String(field.label || "").trim();
  if (!id || !label) return null;
  const type = ["text", "textarea", "folder"].includes(String(field.type || "").trim())
    ? String(field.type || "").trim()
    : "text";
  return {
    id,
    label,
    type,
    required: Boolean(field.required),
    placeholder: String(field.placeholder || "").trim()
  };
}

function normalizeAssistantSetup(setup = {}) {
  const value = setup && typeof setup === "object" ? setup : {};
  return {
    fields: (Array.isArray(value.fields) ? value.fields : [])
      .map(normalizeSetupField)
      .filter(Boolean)
      .slice(0, 8)
  };
}
```

In `readMiaOfficialBotPresets()`, extend the returned object with:

```js
          responsibility: String(item.responsibility || item.line || item.description || "").trim(),
          bestFor: String(item.bestFor || item.best_for || "").trim(),
          setupPrompt: String(item.setupPrompt || item.setup_prompt || "").trim(),
          contextBindings: normalizeStringList(item.contextBindings || item.context_bindings, 8),
          runtimeRecommendation: String(item.runtimeRecommendation || item.runtime_recommendation || "").trim(),
          handoffExamples: normalizeStringList(item.handoffExamples || item.handoff_examples, 6),
          setup: normalizeAssistantSetup(item.setup),
```

Keep the existing compatibility fields in the same return object.

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
node --test tests/skills-loader-install.test.js tests/bot-store-ui.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add resources/official-library/library.json src/main/skills-loader.js tests/skills-loader-install.test.js tests/bot-store-ui.test.js
git commit -m "feat(assistant): 重写官方助手模板数据"
```

---

### Task 2: Assistant Template Helper Module

**Files:**
- Create: `src/renderer/bot/assistant-template.js`
- Modify: `src/renderer/index.html`
- Create: `tests/assistant-template.test.js`

**Interfaces:**
- Consumes: normalized preset objects from Task 1.
- Produces global/browser and CommonJS-compatible API:
  - `assistantResponsibility(template): string`
  - `assistantSetupRequirement(template): string`
  - `assistantHandoffExamples(template): string[]`
  - `assistantSetupFields(template): Array<{ id, label, type, required, placeholder }>`
  - `assistantSetupSummary(template, values): { lines: string[], missingRequired: string[] }`
  - `assistantPersonaText(template, values): string`
  - `assistantDescription(template, values): string`

- [ ] **Step 1: Write failing helper tests**

Create `tests/assistant-template.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");

const helper = require("../src/renderer/bot/assistant-template.js");

const template = {
  name: "课程助教",
  responsibility: "长期管理一门课的资料、作业、复习和答疑。",
  line: "fallback line",
  setupPrompt: "第一次需要课程名、课程资料和考试/作业节点。",
  setup: {
    fields: [
      { id: "courseName", label: "课程名", type: "text", required: true, placeholder: "例如：计算机网络" },
      { id: "materials", label: "课程资料", type: "text", required: false, placeholder: "文件夹路径" },
      { id: "notes", label: "补充说明", type: "textarea", required: false, placeholder: "任意说明" }
    ]
  },
  handoffExamples: ["把本周课件整理成复习提纲。", "按考试时间倒排复习计划。"],
  persona: "你是「课程助教」，负责长期管理用户指定的一门课程。"
};

test("assistant template helper exposes responsibility and setup requirement", () => {
  assert.equal(helper.assistantResponsibility(template), "长期管理一门课的资料、作业、复习和答疑。");
  assert.equal(helper.assistantSetupRequirement(template), "第一次需要课程名、课程资料和考试/作业节点。");
  assert.deepEqual(helper.assistantHandoffExamples(template), ["把本周课件整理成复习提纲。", "按考试时间倒排复习计划。"]);
});

test("assistant setup summary records filled and missing required fields", () => {
  const summary = helper.assistantSetupSummary(template, { materials: "/tmp/course" });
  assert.deepEqual(summary.lines, ["课程资料：/tmp/course"]);
  assert.deepEqual(summary.missingRequired, ["课程名"]);
});

test("assistant persona text keeps long-lived responsibility and missing setup prompt", () => {
  const text = helper.assistantPersonaText(template, { materials: "/tmp/course" });
  assert.match(text, /你是「课程助教」/);
  assert.match(text, /## Mia Assistant Template Context/);
  assert.match(text, /长期负责：长期管理一门课的资料、作业、复习和答疑。/);
  assert.match(text, /已知设置：/);
  assert.match(text, /- 课程资料：\/tmp\/course/);
  assert.match(text, /缺失设置：课程名/);
  assert.match(text, /第一次对话请先补齐缺失设置/);
});

test("assistant description summarizes setup without replacing the role", () => {
  assert.equal(
    helper.assistantDescription(template, { courseName: "计算机网络" }),
    "长期管理一门课的资料、作业、复习和答疑。\n\n已设置：课程名：计算机网络"
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/assistant-template.test.js
```

Expected: FAIL with `Cannot find module '../src/renderer/bot/assistant-template.js'`.

- [ ] **Step 3: Implement helper module**

Create `src/renderer/bot/assistant-template.js`:

```js
(function attachAssistantTemplate(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaAssistantTemplate = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildAssistantTemplateApi() {
  "use strict";

  function text(value = "") {
    return String(value || "").trim();
  }

  function uniqueTextList(value = [], limit = 8) {
    return Array.isArray(value)
      ? [...new Set(value.map(text).filter(Boolean))].slice(0, limit)
      : [];
  }

  function assistantResponsibility(template = {}) {
    return text(template.responsibility || template.line || template.desc || template.description);
  }

  function assistantSetupRequirement(template = {}) {
    return text(template.setupPrompt || template.setup_prompt || template.bestFor || template.tagline);
  }

  function assistantHandoffExamples(template = {}) {
    const examples = uniqueTextList(template.handoffExamples || template.handoff_examples, 6);
    if (examples.length) return examples;
    return uniqueTextList(String(template.demo || "").split(/\r?\n/).filter((line) => !/^你[:：]/.test(line)), 3);
  }

  function normalizeSetupField(field = {}) {
    const id = text(field.id);
    const label = text(field.label);
    if (!id || !label) return null;
    const type = ["text", "textarea", "folder"].includes(text(field.type)) ? text(field.type) : "text";
    return {
      id,
      label,
      type,
      required: Boolean(field.required),
      placeholder: text(field.placeholder)
    };
  }

  function assistantSetupFields(template = {}) {
    const setup = template.setup && typeof template.setup === "object" ? template.setup : {};
    return (Array.isArray(setup.fields) ? setup.fields : [])
      .map(normalizeSetupField)
      .filter(Boolean)
      .slice(0, 8);
  }

  function assistantSetupSummary(template = {}, values = {}) {
    const fields = assistantSetupFields(template);
    const lines = [];
    const missingRequired = [];
    for (const field of fields) {
      const value = text(values[field.id]);
      if (value) lines.push(`${field.label}：${value}`);
      else if (field.required) missingRequired.push(field.label);
    }
    return { lines, missingRequired };
  }

  function assistantPersonaText(template = {}, values = {}) {
    const base = text(template.persona || template.personaText);
    const responsibility = assistantResponsibility(template);
    const setup = assistantSetupSummary(template, values);
    const sections = [];
    if (base) sections.push(base);
    const context = ["## Mia Assistant Template Context"];
    if (text(template.name)) context.push(`模板：${text(template.name)}`);
    if (responsibility) context.push(`长期负责：${responsibility}`);
    if (setup.lines.length) {
      context.push("已知设置：");
      for (const line of setup.lines) context.push(`- ${line}`);
    }
    if (setup.missingRequired.length) {
      context.push(`缺失设置：${setup.missingRequired.join("、")}`);
      context.push("第一次对话请先补齐缺失设置，再继续处理用户请求。");
    }
    sections.push(context.join("\n"));
    return sections.join("\n\n").trim();
  }

  function assistantDescription(template = {}, values = {}) {
    const responsibility = assistantResponsibility(template) || text(template.description || template.desc || template.line);
    const setup = assistantSetupSummary(template, values);
    if (!setup.lines.length) return responsibility;
    return `${responsibility}\n\n已设置：${setup.lines.join("；")}`.trim();
  }

  return {
    assistantResponsibility,
    assistantSetupRequirement,
    assistantHandoffExamples,
    assistantSetupFields,
    assistantSetupSummary,
    assistantPersonaText,
    assistantDescription
  };
});
```

- [ ] **Step 4: Load helper before bot store**

In `src/renderer/index.html`, add this script before `bot-store.js`:

```html
  <script src="./bot/assistant-template.js"></script>
```

It should sit between `starter-engine-bots.js` and `bot-dialog.js` or immediately before `bot-store.js`; keep `bot-store.js` after it.

- [ ] **Step 5: Run tests**

Run:

```bash
node --test tests/assistant-template.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/bot/assistant-template.js src/renderer/index.html tests/assistant-template.test.js
git commit -m "feat(assistant): 添加助手模板文案助手"
```

---

### Task 3: Assistant Store Cards And Details Use Template Semantics

**Files:**
- Modify: `src/renderer/bot/bot-store.js`
- Modify: `src/renderer/styles/bot-store.css`
- Modify: `tests/bot-store-ui.test.js`
- Modify: `tests/renderer-styles.test.js`

**Interfaces:**
- Consumes: `window.miaAssistantTemplate` API from Task 2.
- Produces: card/detail UI that shows role, long-term responsibility, first setup requirement, and Skill chips as metadata.

- [ ] **Step 1: Write failing UI source tests**

Append this test to `tests/bot-store-ui.test.js`:

```js
test("discover bot store presents assistant templates as context contacts", () => {
  const store = read("src/renderer/bot/bot-store.js");

  assert.match(store, /window\.miaAssistantTemplate/);
  assert.match(store, /assistantResponsibility\(f\)/);
  assert.match(store, /assistantSetupRequirement\(f\)/);
  assert.match(store, /bot-store-card-responsibility/);
  assert.match(store, /bot-store-card-setup/);
  assert.match(store, /bot-store-skill-chip/);
  assert.match(store, />添加并设置</);
  assert.match(store, /长期负责：/);
  assert.match(store, /第一次需要：/);
  assert.doesNotMatch(store, /<p class="line">\$\{escapeHtml\(f\.line\)\}<\/p>/);
  assert.doesNotMatch(store, /<button type="button" class="bot-store-btn primary" data-act="prepare">添加<\/button>/);
});
```

In `tests/renderer-styles.test.js`, append:

```js
test("assistant store cards keep responsibility, setup, and skill metadata distinct", () => {
  const css = fs.readFileSync(path.join(root, "src/renderer/styles/bot-store.css"), "utf8");

  assert.match(css, /\.bot-store-card-responsibility\s*\{[^}]*-webkit-line-clamp:\s*3;/);
  assert.match(css, /\.bot-store-card-setup\s*\{[^}]*font-size:\s*12px;[^}]*color:\s*var\(--faint\);/);
  assert.match(css, /\.bot-store-card-skills\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/);
  assert.match(css, /\.bot-store-skill-chip\s*\{[^}]*border-radius:\s*999px;/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/bot-store-ui.test.js tests/renderer-styles.test.js
```

Expected: FAIL because the store still renders `line` and a plain `添加` button, and CSS classes do not exist.

- [ ] **Step 3: Add helper accessors in `bot-store.js`**

Near `skillSummary(f = {})`, add:

```js
  function assistantTemplates() {
    return window.miaAssistantTemplate || {};
  }

  function assistantResponsibility(f = {}) {
    const fn = assistantTemplates().assistantResponsibility;
    return typeof fn === "function" ? fn(f) : String(f.responsibility || f.line || "").trim();
  }

  function assistantSetupRequirement(f = {}) {
    const fn = assistantTemplates().assistantSetupRequirement;
    return typeof fn === "function" ? fn(f) : String(f.setupPrompt || f.tagline || "").trim();
  }

  function assistantHandoffExamples(f = {}) {
    const fn = assistantTemplates().assistantHandoffExamples;
    return typeof fn === "function" ? fn(f) : [];
  }

  function skillChipHtml(f = {}) {
    const ids = enabledSkillIds(f);
    if (!ids.length) return `<span class="bot-store-skill-chip muted">未配置 Skill</span>`;
    return ids.slice(0, 3).map((id) => `<span class="bot-store-skill-chip">${escapeHtml(skillLabel(id))}</span>`).join("")
      + (ids.length > 3 ? `<span class="bot-store-skill-chip muted">+${ids.length - 3}</span>` : "");
  }
```

- [ ] **Step 4: Replace card HTML**

In `renderGrid()`, replace the current card body block with:

```js
        <div class="bot-store-card-body">
          <div class="bot-store-card-head">
            <strong>${escapeHtml(f.name)}</strong>
            <div class="tag">长期联系人</div>
          </div>
          <p class="bot-store-card-responsibility">长期负责：${escapeHtml(assistantResponsibility(f))}</p>
          <p class="bot-store-card-setup">第一次需要：${escapeHtml(assistantSetupRequirement(f))}</p>
          <div class="bot-store-card-skills" aria-label="默认 Skill">${skillChipHtml(f)}</div>
        </div>
```

- [ ] **Step 5: Replace detail sheet copy**

In `openSheet(f)`, replace the description/demo area and primary button with:

```js
      <p class="desc">${escapeHtml(assistantResponsibility(f))}</p>
      <div class="bot-store-template-meta">
        <div><span>第一次需要</span><strong>${escapeHtml(assistantSetupRequirement(f))}</strong></div>
        <div><span>默认 Skill</span><strong>${escapeHtml(skillSummary(f))}</strong></div>
      </div>
      <div class="bot-store-demo">
        ${assistantHandoffExamples(f).map((example) => `<p>${escapeHtml(example)}</p>`).join("") || textWithLineBreaks(f.demo)}
      </div>
      <div class="bot-store-actions">
        <button type="button" class="bot-store-btn ghost" data-act="back">返回</button>
        <button type="button" class="bot-store-btn primary" data-act="prepare">添加并设置</button>
      </div>
```

- [ ] **Step 6: Add CSS for card metadata**

In `src/renderer/styles/bot-store.css`, replace `.bot-store-card p.line` and `.bot-store-card-foot` rules with:

```css
.bot-store-card-responsibility {
  margin: 0;
  overflow: hidden;
  display: -webkit-box;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}
.bot-store-card-setup {
  margin: 0;
  overflow: hidden;
  color: var(--faint);
  font-size: 12px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bot-store-card-skills {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}
.bot-store-skill-chip {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  min-height: 20px;
  padding: 2px 7px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--bot-card-fg) 9%, transparent);
  color: color-mix(in srgb, var(--bot-card-fg) 78%, var(--text) 22%);
  font-size: 11px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bot-store-skill-chip.muted {
  background: var(--field);
  color: var(--faint);
}
.bot-store-template-meta {
  display: grid;
  gap: 8px;
  margin-top: 16px;
}
.bot-store-template-meta > div {
  display: grid;
  gap: 3px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--field);
}
.bot-store-template-meta span {
  color: var(--faint);
  font-size: 12px;
}
.bot-store-template-meta strong {
  color: var(--text);
  font-size: 13px;
  font-weight: var(--ui-text-max-weight, 500);
  line-height: 1.45;
}
.bot-store-demo p {
  margin: 0;
}
.bot-store-demo p + p {
  margin-top: 8px;
}
```

- [ ] **Step 7: Run tests**

Run:

```bash
node --test tests/bot-store-ui.test.js tests/renderer-styles.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/bot/bot-store.js src/renderer/styles/bot-store.css tests/bot-store-ui.test.js tests/renderer-styles.test.js
git commit -m "feat(assistant): 区分助手卡片和技能标签"
```

---

### Task 4: Setup Fields And Save Flow

**Files:**
- Modify: `src/renderer/bot/bot-store.js`
- Modify: `src/renderer/styles/bot-store.css`
- Modify: `tests/bot-store-ui.test.js`
- Modify: `tests/renderer-styles.test.js`

**Interfaces:**
- Consumes:
  - `assistantSetupFields(template)`
  - `assistantPersonaText(template, values)`
  - `assistantDescription(template, values)`
- Produces:
  - setup field UI in the enrollment step,
  - saved bot `description` and `personaText` containing setup context,
  - no hard block when required setup fields are empty.

- [ ] **Step 1: Write failing source tests**

Append this test to `tests/bot-store-ui.test.js`:

```js
test("assistant enrollment collects setup context and folds it into bot identity", () => {
  const store = read("src/renderer/bot/bot-store.js");

  assert.match(store, /function setupFieldsHtml/);
  assert.match(store, /data-assistant-setup-field/);
  assert.match(store, /function readAssistantSetupValues/);
  assert.match(store, /assistantPersonaText\(f,\s*setupValues\)/);
  assert.match(store, /assistantDescription\(f,\s*setupValues\)/);
  assert.match(store, /description:\s*assistantDescription\(f,\s*setupValues\)/);
  assert.match(store, /personaText:\s*assistantPersonaText\(f,\s*setupValues\)/);
  assert.match(store, /const setupValues = readAssistantSetupValues\(els\.botStoreSheet\)/);
  assert.doesNotMatch(store, /throw new Error\(".*课程名/);
  assert.doesNotMatch(store, /required[^;]+checkValidity/);
});
```

Append this test to `tests/renderer-styles.test.js`:

```js
test("assistant setup fields fit inside the enrollment sheet", () => {
  const css = fs.readFileSync(path.join(root, "src/renderer/styles/bot-store.css"), "utf8");

  assert.match(css, /\.bot-store-setup-fields\s*\{[^}]*display:\s*grid;[^}]*gap:\s*8px;/);
  assert.match(css, /\.bot-store-setup-field\s*\{[^}]*display:\s*grid;[^}]*min-width:\s*0;/);
  assert.match(css, /\.bot-store-setup-field input,\s*\.bot-store-setup-field textarea\s*\{[^}]*width:\s*100%;[^}]*box-sizing:\s*border-box;/);
  assert.match(css, /\.bot-store-setup-field textarea\s*\{[^}]*resize:\s*vertical;/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/bot-store-ui.test.js tests/renderer-styles.test.js
```

Expected: FAIL because setup fields and persona composition are not wired into `bot-store.js`.

- [ ] **Step 3: Add setup helper wrappers in `bot-store.js`**

Near the helper wrappers from Task 3, add:

```js
  function assistantSetupFields(f = {}) {
    const fn = assistantTemplates().assistantSetupFields;
    return typeof fn === "function" ? fn(f) : [];
  }

  function assistantPersonaText(f = {}, values = {}) {
    const fn = assistantTemplates().assistantPersonaText;
    return typeof fn === "function" ? fn(f, values) : String(f.persona || "").trim();
  }

  function assistantDescription(f = {}, values = {}) {
    const fn = assistantTemplates().assistantDescription;
    return typeof fn === "function" ? fn(f, values) : String(f.line || f.desc || "").trim();
  }

  function setupFieldsHtml(f = {}) {
    const fields = assistantSetupFields(f);
    if (!fields.length) return "";
    return `
      <div class="bot-store-setup-fields" aria-label="初始化设置">
        ${fields.map((field) => {
          const tag = field.type === "textarea" ? "textarea" : "input";
          const required = field.required ? " data-required=\"true\"" : "";
          const placeholder = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : "";
          const common = `class="bot-store-setup-input" data-assistant-setup-field="${escapeHtml(field.id)}"${placeholder}${required}`;
          return `
            <label class="bot-store-setup-field">
              <span>${escapeHtml(field.label)}${field.required ? "<em>建议填写</em>" : ""}</span>
              ${tag === "textarea"
                ? `<textarea ${common} rows="2"></textarea>`
                : `<input ${common} autocomplete="off">`}
            </label>
          `;
        }).join("")}
      </div>
    `;
  }

  function readAssistantSetupValues(sheet) {
    const values = {};
    sheet?.querySelectorAll?.("[data-assistant-setup-field]")?.forEach((field) => {
      const key = String(field.dataset.assistantSetupField || "").trim();
      const value = String(field.value || "").trim();
      if (key && value) values[key] = value;
    });
    return values;
  }
```

- [ ] **Step 4: Render setup fields in enrollment step**

In `openEnrollmentStep(f, selectedTarget = null)`, insert `setupFieldsHtml(f)` inside the `.bot-store-enroll-console`, after the badge stage and before the console closes:

```js
        ${setupFieldsHtml(f)}
```

The placement should be:

```js
        <div class="bot-store-badge-stage">
          ...
        </div>
        ${setupFieldsHtml(f)}
      </div>
```

- [ ] **Step 5: Save setup context into bot identity**

In `addBot(f, runtimeTarget = {}, plannedKey = "")`, after the `key` validation, add:

```js
      const setupValues = readAssistantSetupValues(els.botStoreSheet);
```

Then change the `bot` payload fields:

```js
          description: assistantDescription(f, setupValues),
          personaText: assistantPersonaText(f, setupValues),
```

Do not block creation when `setupValues` is empty.

- [ ] **Step 6: Add setup CSS**

In `src/renderer/styles/bot-store.css`, after `.bot-store-badge-stage`, add:

```css
.bot-store-setup-fields {
  display: grid;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--badge-card-line);
  background: var(--badge-bar-bg);
}
.bot-store-setup-field {
  display: grid;
  min-width: 0;
  gap: 5px;
}
.bot-store-setup-field span {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--badge-card-muted);
  font-size: 11px;
}
.bot-store-setup-field em {
  color: var(--badge-card-faint);
  font-style: normal;
  font-size: 10px;
}
.bot-store-setup-field input,
.bot-store-setup-field textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--badge-card-line);
  border-radius: 8px;
  background: var(--badge-card-bg);
  color: var(--badge-card-text);
  font: inherit;
  font-size: 12px;
  line-height: 1.35;
  outline: none;
}
.bot-store-setup-field input {
  height: 30px;
  padding: 0 9px;
}
.bot-store-setup-field textarea {
  min-height: 54px;
  max-height: 120px;
  padding: 7px 9px;
  resize: vertical;
}
.bot-store-setup-field input:focus,
.bot-store-setup-field textarea:focus {
  border-color: var(--engine-accent, var(--accent));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--engine-accent, var(--accent)) 16%, transparent);
}
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
node --test tests/assistant-template.test.js tests/bot-store-ui.test.js tests/renderer-styles.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/bot/bot-store.js src/renderer/styles/bot-store.css tests/bot-store-ui.test.js tests/renderer-styles.test.js
git commit -m "feat(assistant): 添加助手初始化设置"
```

---

### Task 5: End-To-End Verification And Regression Sweep

**Files:**
- Modify only if verification exposes a defect in files from Tasks 1-4.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a verified implementation with focused tests, renderer syntax checks, and a manual UI smoke pass.

- [ ] **Step 1: Run focused automated tests**

Run:

```bash
node --test tests/assistant-template.test.js tests/skills-loader-install.test.js tests/bot-store-ui.test.js tests/renderer-styles.test.js
```

Expected: PASS.

- [ ] **Step 2: Run renderer syntax checks**

Run:

```bash
node -c src/renderer/bot/assistant-template.js
node -c src/renderer/bot/bot-store.js
node -c src/main/skills-loader.js
```

Expected: each command exits with code 0 and prints no syntax error.

- [ ] **Step 3: Run broader checks that cover official library loading and renderer contracts**

Run:

```bash
npm run check
node --test tests/renderer-shell.test.js tests/packages-shared-contract.test.js
```

Expected: PASS.

- [ ] **Step 4: Manual UI smoke with isolated app data**

Create a temp Mia data dir and fake Cloud session:

```bash
tmp_dir="$(mktemp -d /tmp/mia-assistant-store-XXXXXX)"
mkdir -p "$tmp_dir/runtime/engine-home"
cat > "$tmp_dir/runtime/engine-home/mia-cloud.json" <<'JSON'
{
  "enabled": true,
  "url": "http://127.0.0.1:9",
  "token": "dev-token",
  "user": { "id": "dev-user", "displayName": "Dev User" }
}
JSON
MIA_USER_DATA_DIR="$tmp_dir" MIA_DISABLE_BACKGROUND_STARTUP=1 MIA_ALLOW_MULTIPLE_INSTANCES=1 npm start
```

Expected manual observations:

- Main app opens instead of onboarding.
- Contacts rail opens the explore section.
- "发现 AI 助手" shows six templates.
- Cards show `长期负责：`, `第一次需要：`, and Skill chips.
- Detail primary action says `添加并设置`.
- Enrollment step shows setup fields.
- Confirm can still be clicked when fields are empty, though Cloud save may fail if the fake Cloud endpoint is unreachable.

Close the app after the smoke check.

- [ ] **Step 5: Inspect git diff for accidental unrelated changes**

Run:

```bash
git status --short
git diff --stat
```

Expected: only files from this plan are modified or staged in the implementation worktree.

- [ ] **Step 6: Commit verification fixes or final no-op checkpoint**

If Step 4 exposed implementation fixes, commit them:

```bash
git add src/renderer/bot/bot-store.js src/renderer/styles/bot-store.css src/renderer/bot/assistant-template.js tests/assistant-template.test.js tests/bot-store-ui.test.js tests/renderer-styles.test.js
git commit -m "fix(assistant): 修正助手商店验证问题"
```

If no fixes were needed, do not create an empty commit.

---

## Self-Review

Spec coverage:

- Assistant/Skill boundary: Task 1 changes data, Task 2 helper, Task 3 UI copy.
- First official set of at most six: Task 1.
- First-run setup shape: Task 1 data, Task 4 UI/save flow.
- Skills as metadata: Task 3 card/detail rendering.
- Missing setup still creates usable assistant: Task 2 persona text and Task 4 non-blocking save.
- Existing custom bots unaffected: no task changes custom bot creation or cloud schema.

Placeholder scan:

- Plan contains no `TBD`, no `TODO`, and no unspecified "write tests for this" step.

Type consistency:

- Task 1 loader fields match Task 2 helper input names.
- Task 2 helper function names match Task 3 and Task 4 call sites.
- Task 4 save payload uses existing `description` and `personaText` fields supported by `bot-commands.js`.
