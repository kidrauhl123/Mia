// 发现 AI 助手 —— 官方 Bot 预设商店（renderer 模块）
// 预设来自 resources/official-library/library.json，通过 loadSkills 一并下发。
(function () {
  "use strict";

  let state, els, mia, escapeHtml, loadSkills, openBotConversation, render;
  let lastCategoryKey = "";
  let activeCat = "全部";
  let pageTurnDirection = 0;
  let adding = false;
  let libraryRequested = false;

  // 样例预设：官方库还没加载时使用；正式数据来自 resources/official-library/library.json。
  // capabilities.enabledSkills 要和官方库保持同一套 id，保存后会进入运行时 Skill 注入链路。
  const FALLBACK_PRESETS = [
    {
      key: "course-tutor", cat: "学习", category: "学习", emoji: "课", c1: "#ecebfc", c2: "#5e5ce6",
      avatar: { emoji: "📚", token: "books" },
      name: "课程助教", tagline: "一门课的长期资料、作业、复习联系人",
      line: "长期管理一门课的资料、作业、复习和答疑。",
      responsibility: "长期管理一门课的资料、作业、复习和答疑。",
      bestFor: "适合把一门课的课件、讲义、作业要求和考试节点放给同一个联系人持续处理。",
      setupPrompt: "第一次需要课程名、课程资料和考试/作业节点；不完整也可以先添加，之后在对话里补齐。",
      contextBindings: ["课程名", "课程资料", "考试/作业节点"],
      runtimeRecommendation: "desktop-local",
      setup: {
        fields: [
          { id: "courseName", label: "课程名", type: "text", required: true, placeholder: "例如：计算机网络" },
          { id: "materials", label: "课程资料", type: "text", required: false, placeholder: "文件夹路径、文件名，或先留空" },
          { id: "deadlines", label: "考试/作业节点", type: "textarea", required: false, placeholder: "例如：第 4 周作业周五截止；7 月 10 日期末" }
        ]
      },
      handoffExamples: ["把本周课件整理成复习提纲。", "这次作业要求是什么，截止前我还差哪些步骤？", "按考试时间倒排复习计划。"],
      desc: "把一门课作为长期上下文来管理。它会把资料、作业、考试节点和你问过的问题放在同一个联系人里，而不是每次从零开始。",
      demo: "你：把本周课件整理成复习提纲。\n课程助教：我会按章节列重点、补自测题，并标出还缺哪些课程资料。",
      persona: "你是「课程助教」，负责长期管理用户指定的一门课程。你优先围绕课程资料、作业要求、考试节点和用户已经补充的课程上下文回答。遇到课程名、资料范围或截止时间缺失时，先用简短问题补齐关键上下文。你可以使用默认启用的学习、文档和任务类 Skills，但不要把自己介绍成某个 Skill。",
      capabilities: { enabledSkills: ["mia-official:paper-research", "mia-official:study-review", "mia-official:problem-explainer", "mia-scheduler"] }
    },
    {
      key: "project-report-lead", cat: "项目", category: "项目", emoji: "报", c1: "#e1f3f6", c2: "#0891b2",
      avatar: { emoji: "🧾", token: "receipt" },
      name: "项目汇报负责人", tagline: "一个项目的组会、周报、PPT 和反馈联系人",
      line: "长期维护一个项目的汇报材料、会议结论、反馈和下次准备事项。",
      responsibility: "长期维护一个项目的汇报材料、会议结论、反馈和下次准备事项。",
      bestFor: "适合研究项目、工作项目、课程项目和任何需要持续汇报的事情。",
      setupPrompt: "第一次需要项目名、资料位置、汇报对象和汇报频率；缺失项可以之后补齐。",
      contextBindings: ["项目名", "项目资料", "汇报对象", "汇报频率"],
      runtimeRecommendation: "desktop-local",
      setup: {
        fields: [
          { id: "projectName", label: "项目名", type: "text", required: true, placeholder: "例如：Mia 助手商店改版" },
          { id: "projectMaterials", label: "项目资料", type: "text", required: false, placeholder: "资料文件夹、会议记录或相关文件" },
          { id: "reportAudience", label: "汇报对象", type: "text", required: false, placeholder: "例如：导师、老板、课程小组" },
          { id: "reportCadence", label: "汇报频率", type: "text", required: false, placeholder: "例如：每周五组会" }
        ]
      },
      handoffExamples: ["根据上次反馈准备下周组会大纲。", "把这几份材料整理成 8 页汇报。", "哪些结论还缺数据支撑？"],
      desc: "把项目汇报作为长期责任来维护。它持续记住材料、反馈和下一次汇报目标。",
      demo: "你：根据上次反馈准备下周组会大纲。\n项目汇报负责人：我会先提取反馈里的待补证据，再整理一版可汇报结构。",
      persona: "你是「项目汇报负责人」，负责长期维护用户指定项目的汇报上下文。你关注项目目标、材料、会议结论、反馈、汇报对象和下次汇报节点。你可以调用演示文稿、文档、会议纪要和表格图表类 Skills，但你的职责是维护项目汇报连续性。",
      capabilities: { enabledSkills: ["mia-official:presentation-designer", "mia-official:document-editor", "mia-official:meeting-notes", "mia-official:spreadsheet-organizer", "mia-official:xlsx"] }
    },
    {
      key: "experiment-records", cat: "项目", category: "项目", emoji: "数", c1: "#e4f3eb", c2: "#1a9d5a",
      avatar: { emoji: "🧪", token: "test-tube" },
      name: "实验记录管理员", tagline: "一个实验或数据项目的数据、图表和报告联系人",
      line: "长期维护实验数据、字段说明、图表输出和报告段落。",
      responsibility: "长期维护实验数据、字段说明、图表输出和报告段落。",
      bestFor: "适合理工科实验、数据分析课程项目、问卷分析和需要反复更新数据的报告。",
      setupPrompt: "第一次需要项目名、数据位置、字段说明和报告格式；字段不清楚时也可以先添加。",
      contextBindings: ["实验/项目名", "数据文件", "字段说明", "报告格式"],
      runtimeRecommendation: "desktop-local",
      setup: {
        fields: [
          { id: "experimentName", label: "实验/项目名", type: "text", required: true, placeholder: "例如：传感器温度实验" },
          { id: "dataSource", label: "数据位置", type: "text", required: false, placeholder: "CSV/Excel 文件或文件夹路径" },
          { id: "fieldNotes", label: "字段说明", type: "textarea", required: false, placeholder: "例如：temp_c 是摄氏温度；group 是实验组" },
          { id: "reportFormat", label: "报告格式", type: "text", required: false, placeholder: "例如：课程实验报告、组会图表" }
        ]
      },
      handoffExamples: ["把今天的新数据合并进记录表。", "画趋势图并写结果段落。", "检查哪些字段含义还不明确。"],
      desc: "把实验或数据项目作为长期上下文来维护，适合反复补数据、出图和写报告。",
      demo: "你：画趋势图并写结果段落。\n实验记录管理员：我会先确认字段含义，再输出图表和可贴进报告的结果描述。",
      persona: "你是「实验记录管理员」，负责长期维护一个实验或数据项目。你关注数据文件、字段含义、图表输出、异常值、结果段落和报告格式。字段不明确时先提问，不要把未知字段编造成结论。",
      capabilities: { enabledSkills: ["mia-official:lab-report", "mia-official:spreadsheet-organizer", "mia-official:xlsx", "mia-official:document-editor"] }
    },
    {
      key: "job-search-manager", cat: "项目", category: "项目", emoji: "职", c1: "#e5ecfd", c2: "#2563eb",
      avatar: { emoji: "💼", token: "briefcase" },
      name: "求职投递管家", tagline: "一个求职方向的简历、JD、投递和面试联系人",
      line: "长期管理一个求职方向的简历版本、岗位 JD、投递状态和面试反馈。",
      responsibility: "长期管理一个求职方向的简历版本、岗位 JD、投递状态和面试反馈。",
      bestFor: "适合校招、实习、转岗或围绕一个方向连续投递多个岗位。",
      setupPrompt: "第一次需要目标方向、简历文件、初始 JD 和跟进节奏；可以先添加再补 JD。",
      contextBindings: ["目标方向", "简历", "JD", "投递状态"],
      runtimeRecommendation: "desktop-local",
      setup: {
        fields: [
          { id: "targetRole", label: "目标方向", type: "text", required: true, placeholder: "例如：产品实习、后端校招" },
          { id: "resumeFile", label: "简历文件", type: "text", required: false, placeholder: "简历文件路径或文件名" },
          { id: "jobDescriptions", label: "初始 JD", type: "textarea", required: false, placeholder: "粘贴 JD 链接、岗位名或要求" },
          { id: "followUpCadence", label: "跟进节奏", type: "text", required: false, placeholder: "例如：投递后三天提醒跟进" }
        ]
      },
      handoffExamples: ["针对这个 JD 改一版简历。", "记录这次投递并提醒我三天后跟进。", "根据面试反馈补一轮练习题。"],
      desc: "围绕一个求职方向持续管理简历、JD、投递和面试反馈。",
      demo: "你：针对这个 JD 改一版简历。\n求职投递管家：我会先提取 JD 关键词，再标出简历里要强化的经历。",
      persona: "你是「求职投递管家」，负责长期管理用户指定求职方向。你关注目标岗位、简历版本、JD 要求、投递状态、面试反馈和跟进提醒。你不编造经历或数据，只帮助用户组织真实材料。",
      capabilities: { enabledSkills: ["mia-official:resume-interview", "mia-official:document-editor", "mia-scheduler"] }
    },
    {
      key: "personal-secretary", cat: "事务", category: "事务", emoji: "办", c1: "#eae9fc", c2: "#4f46e5",
      avatar: { emoji: "✅", token: "check" },
      name: "个人事务秘书", tagline: "承诺、待办、提醒和零散信息的收口联系人",
      line: "长期收口聊天、笔记和提醒里的个人承诺与待办。",
      responsibility: "长期收口聊天、笔记和提醒里的个人承诺与待办。",
      bestFor: "适合把零散承诺、跟进事项、提醒和简单草稿交给一个固定联系人。",
      setupPrompt: "第一次需要提醒偏好和常见任务类型；也可以先添加，之后边用边补。",
      contextBindings: ["提醒偏好", "常见任务类型", "个人上下文"],
      runtimeRecommendation: "cloud-or-desktop",
      setup: {
        fields: [
          { id: "reminderStyle", label: "提醒偏好", type: "text", required: false, placeholder: "例如：提前一天和提前一小时提醒" },
          { id: "taskCategories", label: "常见任务类型", type: "text", required: false, placeholder: "例如：报销、复诊、回消息、交材料" },
          { id: "personalNotes", label: "个人上下文", type: "textarea", required: false, placeholder: "可写常用联系人、固定节奏或注意事项" }
        ]
      },
      handoffExamples: ["把这段聊天里的承诺整理成待办。", "明天下午提醒我跟进这件事。", "每周五帮我回顾未完成事项。"],
      desc: "把个人事务作为长期上下文收口，适合提醒、待办和零散承诺。",
      demo: "你：把这段聊天里的承诺整理成待办。\n个人事务秘书：我会提取事项、对象和时间，没有时间的会标成待确认。",
      persona: "你是「个人事务秘书」，负责长期收口用户的提醒、待办、承诺和零散信息。你应该把模糊事项整理成可执行任务，并明确哪些时间、对象或条件还缺失。",
      capabilities: { enabledSkills: ["mia-scheduler", "mia-official:meeting-notes", "mia-official:document-editor"] }
    },
    {
      key: "repo-maintainer", cat: "代码", category: "代码", emoji: "库", c1: "#dcecff", c2: "#378add",
      avatar: { emoji: "🧩", token: "puzzle" },
      name: "代码仓库维护员", tagline: "一个 repo 的测试、审查、发布和技术债联系人",
      line: "长期维护一个代码仓库的 bug、测试、PR 审查、发布记录和技术债。",
      responsibility: "长期维护一个代码仓库的 bug、测试、PR 审查、发布记录和技术债。",
      bestFor: "适合给一个长期维护的 repo 配一个固定工程联系人。",
      setupPrompt: "第一次需要 repo 路径、默认 Agent 内核和测试命令；GitHub 链接可以之后补。",
      contextBindings: ["repo 路径", "默认 Agent", "测试命令", "GitHub 仓库"],
      runtimeRecommendation: "desktop-local",
      agentEngine: "codex",
      setup: {
        fields: [
          { id: "repoPath", label: "repo 路径", type: "text", required: true, placeholder: "例如：/Users/jung/GitHub/Mia" },
          { id: "defaultAgent", label: "默认 Agent", type: "text", required: false, placeholder: "例如：Codex" },
          { id: "testCommand", label: "测试命令", type: "text", required: false, placeholder: "例如：npm test" },
          { id: "githubRepo", label: "GitHub 仓库", type: "text", required: false, placeholder: "例如：owner/repo" }
        ]
      },
      handoffExamples: ["看一下这个失败测试是不是回归。", "审一下当前分支的改动。", "整理这个版本的 release notes。"],
      desc: "把一个 repo 作为长期上下文维护，适合测试、审查、发布和技术债整理。",
      demo: "你：审一下当前分支的改动。\n代码仓库维护员：我会先看 diff 和测试，再按风险排序列出问题。",
      persona: "你是「代码仓库维护员」，负责长期维护用户指定的一个代码仓库。你关注 repo 路径、测试命令、变更风险、PR 审查、发布记录和技术债。你应该优先用用户指定的 Agent 内核和测试命令。",
      capabilities: { enabledSkills: ["mia-official:problem-explainer", "mia-official:document-editor"] }
    }
  ];

  const ENGINE_META = {
    hermes: { label: "Hermes", department: "Mia 本机 Agent", accent: "#5dcaa5" },
    "claude-code": { label: "Claude Code", department: "代码工程部", accent: "#7f77dd" },
    codex: { label: "Codex", department: "代码工程部", accent: "#378add" },
    openclaw: { label: "OpenClaw", department: "开放 Agent 部", accent: "#ef9f27" }
  };
  const CATEGORY_ORDER = ["学习", "项目", "事务", "代码", "推荐"];

  const SKILL_LABELS = {
    "mia-official:paper-research": "文献研究",
    "paper-research": "文献研究",
    "mia-official:lab-report": "实验报告",
    "lab-report": "实验报告",
    "mia-official:study-review": "复习规划",
    "study-review": "复习规划",
    "mia-official:resume-interview": "简历面试",
    "resume-interview": "简历面试",
    "mia-official:problem-explainer": "讲题排错",
    "problem-explainer": "讲题排错",
    "mia-official:spreadsheet-organizer": "表格整理",
    "spreadsheet-organizer": "表格整理",
    "mia-official:xlsx": "Excel 交付",
    "xlsx": "Excel 交付",
    "mia-official:presentation-designer": "汇报设计",
    "presentation-designer": "汇报设计",
    "mia-official:meeting-notes": "会议纪要",
    "meeting-notes": "会议纪要",
    "mia-official:document-editor": "文档编辑",
    "document-editor": "文档编辑",
    "mia-official:story-host": "剧情主持",
    "story-host": "剧情主持",
    "mia-scheduler": "定时任务",
    "weekly-report": "周报",
    "commit-craft": "提交信息",
    "trip-planner": "行程"
  };

  function presets() {
    const official = Array.isArray(state?.skillLibrary?.botPresets) ? state.skillLibrary.botPresets : [];
    return official.length ? official : FALLBACK_PRESETS;
  }

  function categories() {
    const seen = [];
    for (const preset of presets()) {
      const cat = String(preset.cat || preset.category || "推荐").trim() || "推荐";
      if (!seen.includes(cat)) seen.push(cat);
    }
    seen.sort((a, b) => {
      const ia = CATEGORY_ORDER.includes(a) ? CATEGORY_ORDER.indexOf(a) : CATEGORY_ORDER.length;
      const ib = CATEGORY_ORDER.includes(b) ? CATEGORY_ORDER.indexOf(b) : CATEGORY_ORDER.length;
      return ia - ib || a.localeCompare(b, "zh-Hans-CN");
    });
    return ["全部", ...seen];
  }

  function maybeLoadOfficialLibrary() {
    if (!state || (state.skillLibrary?.botPresets || []).length || state.skillsLoading || libraryRequested) return;
    if (typeof loadSkills !== "function") return;
    libraryRequested = true;
    Promise.resolve(loadSkills()).finally(() => { libraryRequested = false; });
  }

  function normalizeAgentEngine(value = "hermes") {
    const raw = String(value || "hermes").trim().toLowerCase().replace(/_/g, "-");
    if (raw === "claude" || raw === "claude-code") return "claude-code";
    if (raw === "codex" || raw === "openai-codex") return "codex";
    if (raw === "openclaw" || raw === "open-claw") return "openclaw";
    return "hermes";
  }

  function engineMeta(engine) {
    return ENGINE_META[normalizeAgentEngine(engine)] || ENGINE_META.hermes;
  }

  function engineLabel(engine) {
    return engineMeta(engine).label;
  }

  function safeColor(value, fallback) {
    const color = String(value || "").trim();
    return /^#[0-9a-f]{3,8}$/i.test(color) ? color : fallback;
  }

  const ASSISTANT_AVATAR_EMOJI = Object.freeze({
    books: "📚",
    receipt: "🧾",
    "test-tube": "🧪",
    briefcase: "💼",
    check: "✅",
    puzzle: "🧩"
  });

  function assistantAvatarEmojiToken(f = {}) {
    const meta = f.avatar && typeof f.avatar === "object" ? f.avatar : {};
    const token = String(meta.token || meta.emojiToken || f.avatarEmojiToken || "").trim();
    if (Object.prototype.hasOwnProperty.call(ASSISTANT_AVATAR_EMOJI, token)) return token;
    const glyph = String(meta.emoji || f.avatarEmoji || "").trim();
    const found = Object.entries(ASSISTANT_AVATAR_EMOJI).find(([, value]) => value === glyph);
    return found ? found[0] : "";
  }

  function assistantAvatarEmoji(f = {}) {
    return ASSISTANT_AVATAR_EMOJI[assistantAvatarEmojiToken(f)] || "";
  }

  function assistantAvatarImage(f = {}) {
    const meta = f.avatar && typeof f.avatar === "object" ? f.avatar : {};
    const explicit = String(meta.image || f.avatarImage || "").trim();
    if (explicit) return explicit;
    const token = assistantAvatarEmojiToken(f);
    return token ? `emoji:${token}` : "";
  }

  function assistantAvatarCrop(avatarImage = "") {
    return String(avatarImage || "").startsWith("emoji:")
      ? null
      : (avatarImage ? { x: 50, y: 50, zoom: 1 } : null);
  }

  function enabledSkillIds(f = {}) {
    const caps = f.capabilities && typeof f.capabilities === "object" ? f.capabilities : {};
    return Array.isArray(caps.enabledSkills)
      ? [...new Set(caps.enabledSkills.map((item) => String(item || "").trim()).filter(Boolean))]
      : [];
  }

  function skillLabel(skillId = "") {
    const id = String(skillId || "").trim();
    const skill = (state?.skillLibrary?.skills || []).find((item) => item.id === id || item.name === id);
    return SKILL_LABELS[id] || skill?.label || skill?.name || id;
  }

  function skillSummary(f = {}) {
    const ids = enabledSkillIds(f);
    if (!ids.length) return "未配置";
    const labels = ids.map(skillLabel).filter(Boolean);
    const shown = labels.slice(0, 3).join(" / ");
    return labels.length > 3 ? `${shown} +${labels.length - 3}` : shown;
  }

  function assistantTemplates() {
    return window.miaAssistantTemplate || {};
  }

  function assistantResponsibility(f = {}) {
    const fn = assistantTemplates().assistantResponsibility;
    return typeof fn === "function" ? fn(f) : String(f.responsibility || f.line || "").trim();
  }

  function assistantPersonaText(f = {}, values = {}) {
    const fn = assistantTemplates().assistantPersonaText;
    return typeof fn === "function" ? fn(f, values) : String(f.persona || "").trim();
  }

  function assistantDescription(f = {}, values = {}) {
    const fn = assistantTemplates().assistantDescription;
    return typeof fn === "function" ? fn(f, values) : String(f.line || f.desc || "").trim();
  }

  function assistantDisplayDescription(f = {}) {
    return String(f.desc || f.description || f.line || f.responsibility || "").trim();
  }

  function skillChipHtml(f = {}) {
    const ids = enabledSkillIds(f);
    if (!ids.length) return `<span class="bot-store-skill-chip muted">未配置 Skill</span>`;
    return ids.slice(0, 3).map((id) => `<span class="bot-store-skill-chip">${escapeHtml(skillLabel(id))}</span>`).join("")
      + (ids.length > 3 ? `<span class="bot-store-skill-chip muted">+${ids.length - 3}</span>` : "");
  }

  function defaultConversationTagName(f = {}) {
    return String(f.cat || f.category || "推荐").trim() || "推荐";
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      const text = String(value || "").trim();
      if (text) return text;
    }
    return "";
  }

  function compactDeviceName(value = "") {
    return String(value || "")
      .trim()
      .replace(/\s*(?:·|-)?\s*Mia\s+(?:Desktop|Bridge)(?=\s*(?:·|-|$))/gi, "")
      .replace(/\.local(?=\s|$)/gi, "")
      .replace(/\s*(?:·|-)\s*(?:本机|在线|离线)\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeDevice(input = {}) {
    const id = String(input.id || input.deviceId || "").trim();
    if (!id) return null;
    return {
      ...input,
      id,
      deviceName: firstNonEmpty(input.deviceName, input.device_name, input.name, id),
      status: String(input.status || "").trim(),
      isLocal: Boolean(input.isLocal),
      capabilities: input.capabilities && typeof input.capabilities === "object" ? input.capabilities : {}
    };
  }

  function mergeEngineLists(left = {}, right = {}) {
    const out = [];
    for (const source of [left, right]) {
      const engines = Array.isArray(source.capabilities?.engines) ? source.capabilities.engines : [];
      for (const engine of engines) {
        const id = normalizeAgentEngine(engine);
        if (id && !out.includes(id)) out.push(id);
      }
    }
    return out;
  }

  function mergeDevices(existing, incoming) {
    if (!existing) return incoming;
    const engines = mergeEngineLists(existing, incoming);
    const isLocal = Boolean(existing.isLocal || incoming.isLocal);
    const status = isLocal
      ? "local"
      : ([existing.status, incoming.status].includes("online") ? "online" : (incoming.status || existing.status || ""));
    return {
      ...existing,
      ...incoming,
      id: existing.id || incoming.id,
      deviceName: incoming.deviceName || existing.deviceName,
      status,
      isLocal,
      capabilities: {
        ...(existing.capabilities || {}),
        ...(incoming.capabilities || {}),
        ...(engines.length ? { engines } : {})
      }
    };
  }

  function localDeviceCandidate() {
    const runtime = state?.runtime || {};
    const engines = [];
    if (runtime.agentEngines?.hermes?.available || runtime.agentEngines?.hermes?.installed || runtime.engineInstalled || runtime.engineRunning) engines.push("hermes");
    if (runtime.agentEngines?.claudeCode?.available) engines.push("claude-code");
    if (runtime.agentEngines?.codex?.available) engines.push("codex");
    if (runtime.agentEngines?.openClaw?.available || runtime.agentEngines?.openClaw?.installed) engines.push("openclaw");
    if (!engines.length) engines.push(normalizeAgentEngine(state?.preferredAgentEngine || "hermes"));
    return normalizeDevice({
      id: firstNonEmpty(runtime.localDevice?.id, runtime.cloud?.deviceId, "current-device"),
      deviceName: firstNonEmpty(runtime.localDevice?.name, runtime.cloud?.deviceName, "当前设备"),
      status: "local",
      isLocal: true,
      capabilities: { engines }
    });
  }

  function runtimeDevices() {
    const byId = new Map();
    const add = (device) => {
      const normalized = normalizeDevice(device);
      if (!normalized) return;
      byId.set(normalized.id, mergeDevices(byId.get(normalized.id), normalized));
    };
    for (const device of state?.runtime?.cloud?.devices || state?.runtime?.cloud?.bridgeDevices || []) add(device);
    add(localDeviceCandidate());
    return [...byId.values()];
  }

  function editableRuntimeDevices() {
    const local = localDeviceCandidate();
    return local ? [local] : [];
  }

  function deviceStatusLabel(device = {}) {
    if (device.isLocal || device.status === "local") return "本机";
    if (device.status === "online") return "在线";
    if (device.status === "offline") return "离线";
    return device.status || "离线";
  }

  function runtimeDeviceDisplayName(device = {}) {
    if (device.isLocal || device.status === "local") return "本机";
    return compactDeviceName(device.deviceName || device.device_name || device.name || "") || String(device.id || "").trim() || "设备";
  }

  function runtimeDeviceGroupLabel(device = {}) {
    const name = runtimeDeviceDisplayName(device);
    const status = deviceStatusLabel(device);
    return status && status !== name ? `${name} · ${status}` : name;
  }

  function deviceEngines(device = {}) {
    const advertised = Array.isArray(device.capabilities?.engines)
      ? device.capabilities.engines.map((id) => normalizeAgentEngine(id)).filter(Boolean)
      : [];
    const supported = advertised.filter((id) => ["hermes", "claude-code", "codex", "openclaw"].includes(id));
    if (supported.length) return [...new Set(supported)];
    const engine = normalizeAgentEngine(device.engine || "");
    return ["hermes", "claude-code", "codex", "openclaw"].includes(engine) ? [engine] : [];
  }

  function runtimeTargetGroups(current = {}) {
    const groups = [];
    if (state?.runtime?.cloud?.enabled) {
      groups.push({
        label: "Mia Cloud · 在线",
        targets: [{
          runtimeKind: "cloud-hermes",
          deviceId: "",
          deviceName: "Mia Cloud",
          agentEngine: "hermes"
        }]
      });
    }
    const wantedDeviceId = String(current.deviceId || "").trim();
    const devices = editableRuntimeDevices();
    if (wantedDeviceId && !devices.some((device) => device.id === wantedDeviceId)) {
      devices.push(normalizeDevice({
        id: wantedDeviceId,
        deviceName: current.deviceName || wantedDeviceId,
        status: "offline",
        capabilities: { engines: [current.agentEngine || "hermes"] }
      }));
    }
    for (const device of devices.filter(Boolean)) {
      const targets = deviceEngines(device).map((engine) => ({
        runtimeKind: "desktop-local",
        deviceId: device.id,
        deviceName: runtimeDeviceDisplayName(device),
        agentEngine: engine
      }));
      if (!targets.length) continue;
      groups.push({ label: runtimeDeviceGroupLabel(device), targets });
    }
    return groups;
  }

  function normalizeRuntimeTarget(target = {}) {
    const kind = target.runtimeKind === "cloud-hermes" ? "cloud-hermes" : "desktop-local";
    return {
      runtimeKind: kind,
      deviceId: kind === "cloud-hermes" ? "" : String(target.deviceId || target.targetDeviceId || "").trim(),
      deviceName: kind === "cloud-hermes" ? "Mia Cloud" : String(target.deviceName || target.targetDeviceName || "").trim(),
      agentEngine: kind === "cloud-hermes" ? "hermes" : normalizeAgentEngine(target.agentEngine || state?.preferredAgentEngine || "hermes")
    };
  }

  function targetSummary(target = {}) {
    const t = normalizeRuntimeTarget(target);
    const device = t.runtimeKind === "cloud-hermes" ? "Mia Cloud" : (t.deviceName || "本机");
    return `${device} · ${engineLabel(t.agentEngine)}`;
  }

  function principalId(f = {}) {
    return String(f.account_id || f.accountId || f.uid || "").trim();
  }

  function existingPrincipalIds() {
    const cloud = Array.isArray(window.miaSocial?.moduleState?.bots) ? window.miaSocial.moduleState.bots : [];
    return [...cloud]
      .flatMap((item) => [item?.key, item?.id, item?.account_id, item?.accountId])
      .map((value) => String(value || "").trim())
      .filter(Boolean);
  }

  function generateEnrollmentPrincipalId(f = {}) {
    const existing = new Set(existingPrincipalIds());
    const presetId = principalId(f);
    if (presetId && !existing.has(presetId)) return presetId;
    const generate = window.miaIds?.generatePrincipalId;
    if (typeof generate !== "function") throw new Error("无法生成 AI 助手账号 ID。");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = String(generate() || "").trim();
      if (id && !existing.has(id)) return id;
    }
    throw new Error("无法生成未占用的 AI 助手账号 ID。");
  }

  function initBotStore(deps) {
    state = deps.state;
    els = deps.els;
    mia = deps.mia || (typeof window !== "undefined" ? window.mia : null);
    escapeHtml = deps.escapeHtml || ((s) => String(s == null ? "" : s));
    loadSkills = deps.loadSkills;
    openBotConversation = deps.openBotConversation;
    render = deps.render || (() => {});

    renderCategories();

    els.botStoreScrim?.addEventListener("click", (event) => {
      if (event.target === els.botStoreScrim) closeSheet();
    });

    window.addEventListener("resize", () => {
      if (state.activeView !== "bot-store") return;
      scrollCategoryButtonIntoView(els.botStoreCap?.querySelector("button.active"), "auto");
      movePill();
    });
  }

  function renderCategories() {
    const cap = els?.botStoreCap;
    if (!cap) return;
    const cats = categories();
    const key = cats.join("\n");
    if (key === lastCategoryKey) return;
    lastCategoryKey = key;
    if (!cats.includes(activeCat)) activeCat = "全部";
    cap.innerHTML = "";
    cats.forEach((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = c;
      if (c === activeCat) b.classList.add("active");
      b.addEventListener("click", () => {
        if (activeCat === c) return;
        const fromIndex = Math.max(0, cats.indexOf(activeCat));
        const toIndex = Math.max(0, cats.indexOf(c));
        pageTurnDirection = toIndex >= fromIndex ? 1 : -1;
        window.miaMasonryGrid?.capture(els.botStoreGrid, pageTurnDirection);
        activeCat = c;
        cap.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        scrollCategoryButtonIntoView(b, "smooth");
        movePill();
        renderGrid();
      });
      cap.appendChild(b);
    });
    scrollCategoryButtonIntoView(cap.querySelector("button.active"), "auto");
    movePill();
  }

  function scrollCategoryButtonIntoView(button, behavior = "smooth") {
    const cap = els?.botStoreCap;
    if (!button || !cap || typeof button.scrollIntoView !== "function") return;
    if ((cap.scrollWidth || 0) <= (cap.clientWidth || 0)) return;
    const prefersReducedMotion = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    try {
      button.scrollIntoView({
        block: "nearest",
        inline: "center",
        behavior: prefersReducedMotion ? "auto" : behavior
      });
    } catch {
      button.scrollIntoView();
    }
  }

  function movePill() {
    const cap = els.botStoreCap;
    if (!cap) return;
    const a = cap.querySelector("button.active");
    if (!a || typeof a.getBoundingClientRect !== "function") return;
    const ar = a.getBoundingClientRect();
    const pillX = Number.isFinite(a.offsetLeft) ? a.offsetLeft : (ar.left - cap.getBoundingClientRect().left + cap.scrollLeft);
    const pillW = Number.isFinite(a.offsetWidth) && a.offsetWidth > 0 ? a.offsetWidth : ar.width;
    cap.style.setProperty("--pill-x", `${pillX}px`);
    cap.style.setProperty("--pill-w", `${pillW}px`);
    cap.style.setProperty("--pill-ready", "1");
  }

  function avatarHtml(f, extraClass) {
    const cls = extraClass ? ` ${extraClass}` : "";
    const c1 = safeColor(f.c1, "#ecebfc");
    const c2 = safeColor(f.c2, "#5e5ce6");
    const emoji = assistantAvatarEmoji(f);
    const fallback = escapeHtml(String(f.emoji || "◇").trim() || "◇");
    const body = emoji
      ? `<span class="bot-store-avatar-emoji" aria-hidden="true">${escapeHtml(emoji)}</span>`
      : fallback;
    return `<div class="bot-store-avatar${cls}" style="background:${c1};color:${c2}">${body}</div>`;
  }

  function cardStyle(f) {
    const c1 = safeColor(f.c1, "#ecebfc");
    const c2 = safeColor(f.c2, "#5e5ce6");
    return `--bot-card-bg:${c1};--bot-card-fg:${c2}`;
  }

  function defaultEnrollmentTarget(f = {}) {
    const wantedEngine = normalizeAgentEngine(f.agentEngine || state?.preferredAgentEngine || "hermes");
    const groups = runtimeTargetGroups({ agentEngine: wantedEngine });
    const flat = groups.flatMap((group) => group.targets);
    return flat.find((target) => target.runtimeKind === "desktop-local" && target.agentEngine === wantedEngine)
      || flat.find((target) => target.runtimeKind === "desktop-local")
      || flat[0]
      || normalizeRuntimeTarget({ runtimeKind: "desktop-local", agentEngine: wantedEngine });
  }

  function renderGrid() {
    const grid = els.botStoreGrid;
    if (!grid) return;
    maybeLoadOfficialLibrary();
    renderCategories();
    const list = presets().filter((f) => activeCat === "全部" || (f.cat || f.category) === activeCat);
    if (!list.length) {
      grid.innerHTML = `<div class="bot-store-empty">这个分类暂时还没有 AI 助手</div>`;
      window.miaMasonryGrid?.layout(grid, ".bot-store-card", { animate: pageTurnDirection });
      pageTurnDirection = 0;
      return;
    }
    grid.innerHTML = list.map((f) => `
      <div class="bot-store-card" data-key="${escapeHtml(f.key)}" style="${cardStyle(f)}">
        <div class="bot-store-card-cover">
          <span class="bot-store-card-category">${escapeHtml(f.cat || f.category || "推荐")}</span>
          ${avatarHtml(f, "bot-store-cover-avatar")}
        </div>
        <div class="bot-store-card-body">
          <div class="bot-store-card-head">
            <strong>${escapeHtml(f.name)}</strong>
          </div>
          <p class="bot-store-card-description">${escapeHtml(assistantDisplayDescription(f))}</p>
          <div class="bot-store-card-skills" aria-label="预设技能">${skillChipHtml(f)}</div>
        </div>
      </div>`).join("");
    grid.querySelectorAll(".bot-store-card").forEach((card) => {
      card.addEventListener("click", () => {
        const f = presets().find((x) => x.key === card.dataset.key);
        if (f) openSheet(f);
      });
    });
    window.miaMasonryGrid?.layout(grid, ".bot-store-card", { animate: pageTurnDirection });
    pageTurnDirection = 0;
  }

  function openSheet(f) {
    const sheet = els.botStoreSheet;
    const scrim = els.botStoreScrim;
    if (!sheet || !scrim) return;
    adding = false;
    sheet.classList.remove("is-enrolling");
    sheet.classList.remove("is-stamped");
    sheet.innerHTML = `
      <div class="bot-store-sheet-head">
        ${avatarHtml(f)}
        <div><h2>${escapeHtml(f.name)}</h2></div>
      </div>
      <div class="bot-store-sheet-section">
        <span>描述</span>
        <strong>${escapeHtml(assistantDisplayDescription(f))}</strong>
      </div>
      <div class="bot-store-sheet-section">
        <span>预设技能</span>
        <strong>${escapeHtml(skillSummary(f))}</strong>
      </div>
      <div class="bot-store-actions">
        <button type="button" class="bot-store-btn ghost" data-act="back">返回</button>
        <button type="button" class="bot-store-btn primary" data-act="add">添加</button>
      </div>`;
    sheet.querySelector('[data-act="back"]').addEventListener("click", closeSheet);
    sheet.querySelector('[data-act="add"]').addEventListener("click", () => addPresetBot(f));
    scrim.classList.add("open");
  }

  function addPresetBot(f = {}) {
    const sheet = els.botStoreSheet;
    const scrim = els.botStoreScrim;
    if (!sheet || !scrim) return;
    let plannedKey = "";
    try {
      plannedKey = generateEnrollmentPrincipalId(f);
    } catch (error) {
      window.alert(error?.message || "无法生成 AI 助手账号 ID。");
      return;
    }
    const target = normalizeRuntimeTarget(defaultEnrollmentTarget(f));
    const meta = engineMeta(target.agentEngine);
    sheet.classList.add("is-enrolling");
    sheet.classList.remove("is-stamped");
    sheet.dataset.botKey = plannedKey;
    sheet.innerHTML = `
      <div class="bot-store-enroll-console" style="--badge-accent:${safeColor(f.c2, "#5dcaa5")};--engine-accent:${safeColor(meta.accent, "#5dcaa5")}">
        <div class="bot-store-enroll-bar">
          <span class="bot-store-enroll-light" aria-hidden="true"></span>
          <span>AI 助手入库</span>
          <span class="bot-store-enroll-status" data-enroll-status>确认信息</span>
        </div>
        <div class="bot-store-badge-stage">
          <div class="bot-store-badge-card">
            <div class="bot-store-badge-title">MIA · AI 助手凭证</div>
            <div class="bot-store-badge-shimmer" aria-hidden="true"></div>
            <div class="bot-store-badge-main">
              ${avatarHtml(f, "bot-store-badge-avatar")}
              <div class="bot-store-badge-id">
                <span>AI 助手</span>
                <strong>${escapeHtml(f.name)}</strong>
                <code data-badge-uid>UID · ${escapeHtml(plannedKey)}</code>
              </div>
            </div>
            <div class="bot-store-badge-fields">
              <div><span>分类</span><strong>${escapeHtml(f.cat || f.category || "推荐")}</strong></div>
              <div><span>技能</span><strong>${escapeHtml(skillSummary(f))}</strong></div>
              <div><span>运行位置 / Agent</span><strong data-badge-engine>${escapeHtml(targetSummary(target))}</strong></div>
            </div>
            <div class="bot-store-badge-stamp" aria-hidden="true">
              <strong>已激活</strong>
              <span>ACTIVATED</span>
            </div>
          </div>
          <div class="bot-store-badge-flash" aria-hidden="true"></div>
        </div>
      </div>
      <div class="bot-store-actions">
        <button type="button" class="bot-store-btn ghost" data-act="detail">上一步</button>
        <button type="button" class="bot-store-btn primary" data-act="confirm">确认</button>
      </div>`;
    sheet.querySelector('[data-act="detail"]').addEventListener("click", () => openSheet(f));
    sheet.querySelector('[data-act="confirm"]').addEventListener("click", () => addBot(f, target, sheet.dataset.botKey || plannedKey));
    scrim.classList.add("open");
  }

  function closeSheet() {
    els.botStoreScrim?.classList.remove("open");
  }

  function savedConversationId(saved = {}) {
    return String(
      saved.conversation?.id
      || saved.data?.conversation?.id
      || saved.conversationId
      || saved.bot?.conversationId
      || ""
    ).trim();
  }

  async function applyDefaultConversationTag(f, saved) {
    const conversationId = savedConversationId(saved);
    if (!conversationId || typeof window.miaSocial?.setConversationTagNames !== "function") return;
    try {
      await window.miaSocial.setConversationTagNames(conversationId, [defaultConversationTagName(f)]);
    } catch (error) {
      console.warn("[bot-store] default assistant tag failed:", error?.message || error);
    }
  }

  async function addBot(f, runtimeTarget = {}, plannedKey = "") {
    if (adding) return;
    adding = true;
    const btn = els.botStoreSheet?.querySelector('[data-act="add"], [data-act="confirm"]');
    if (btn) { btn.disabled = true; btn.textContent = "确认中…"; }
    try {
      const target = normalizeRuntimeTarget(runtimeTarget);
      const key = String(plannedKey || "").trim();
      if (!key) throw new Error("AI 助手账号 ID 缺失。");
      const avatarImage = assistantAvatarImage(f);
      const saved = await window.miaBotCommands.saveBot({
        state,
        runtimeKind: target.runtimeKind,
        isCreate: true,
        api: window.mia,
        social: window.miaSocial,
        bot: {
          key,
          name: f.name,
          category: defaultConversationTagName(f),
          color: f.c2,
          avatarImage: avatarImage,
          avatarCrop: assistantAvatarCrop(avatarImage),
          description: assistantDescription(f, {}),
          personaText: assistantPersonaText(f, {}),
          agentEngine: target.agentEngine,
          targetDeviceId: target.deviceId,
          targetDeviceName: target.deviceName,
          capabilities: f.capabilities || {}
        }
      });
      if (saved.runtime) state.runtime = saved.runtime;
      await applyDefaultConversationTag(f, saved);
      els.botStoreSheet?.classList.add("is-stamped");
      const status = els.botStoreSheet?.querySelector("[data-enroll-status]");
      if (status) status.textContent = "✓ 已激活";
      const savedKey = saved.key || saved.bot?.key || saved.bot?.id || "";
      const uid = els.botStoreSheet?.querySelector("[data-badge-uid]");
      if (uid && savedKey) uid.textContent = `UID · ${savedKey}`;
      if (btn) btn.textContent = "已添加";
      if (els.botStoreSheet?.classList.contains("is-enrolling")) {
        await new Promise((resolve) => setTimeout(resolve, 720));
      }
      closeSheet();
      if (savedKey && typeof openBotConversation === "function") {
        state.activeView = "chat";
        await openBotConversation(savedKey);
      } else {
        render();
      }
    } catch (error) {
      const status = els.botStoreSheet?.querySelector("[data-enroll-status]");
      if (status) status.textContent = "添加失败";
      if (btn) { btn.disabled = false; btn.textContent = "确认"; }
      adding = false;
      window.alert(`添加失败：${error?.message || error}`);
      return;
    }
    adding = false;
  }

  // 进入商店视图时调用：渲染网格并对齐胶囊
  function renderBotStore() {
    renderGrid();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(movePill);
    else movePill();
  }

  window.miaBotStore = { initBotStore, renderBotStore };
})();
