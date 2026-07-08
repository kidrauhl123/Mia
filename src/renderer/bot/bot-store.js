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
      name: "课程助教", tagline: "课件、作业、复习和答疑的课程助手",
      line: "整理课程资料、作业要求、复习节奏和答疑线索。",
      responsibility: "整理课程资料、作业要求、复习节奏和答疑线索。",
      contextBindings: ["课程名", "课程资料", "考试/作业节点"],
      runtimeRecommendation: "desktop-local",
      handoffExamples: ["把本周课件整理成复习提纲。", "这次作业要求是什么，截止前我还差哪些步骤？", "按考试时间倒排复习计划。"],
      desc: "把课件、作业、考试节点和问过的问题放在一起整理，帮你复习、补漏、安排下一步。",
      demo: "你：把本周课件整理成复习提纲。\n课程助教：我会按章节列重点、补自测题，并标出还缺哪些课程资料。",
      persona: "你是「课程助教」，负责整理用户指定课程的资料、作业、复习和答疑。你优先围绕课程资料、作业要求、考试节点和用户已经补充的线索回答。用户没有给出课程名、资料范围或截止时间时，用一句自然问题补齐最关键的信息；不要要求用户填写表格，也不要把自己介绍成某个 Skill。",
      capabilities: { enabledSkills: ["mia-official:paper-research", "mia-official:study-review", "mia-official:problem-explainer", "mia-scheduler"] }
    },
    {
      key: "project-report-lead", cat: "项目", category: "项目", emoji: "报", c1: "#e1f3f6", c2: "#0891b2",
      avatar: { emoji: "🧾", token: "receipt" },
      name: "项目汇报负责人", tagline: "组会、周报、PPT 和反馈的项目助手",
      line: "整理项目材料、会议结论、反馈和下次汇报准备。",
      responsibility: "整理项目材料、会议结论、反馈和下次汇报准备。",
      contextBindings: ["项目名", "项目资料", "汇报对象", "汇报频率"],
      runtimeRecommendation: "desktop-local",
      handoffExamples: ["根据上次反馈准备下周组会大纲。", "把这几份材料整理成 8 页汇报。", "哪些结论还缺数据支撑？"],
      desc: "把材料、反馈和会议结论串成清楚的汇报结构，帮你准备组会、周报和 PPT。",
      demo: "你：根据上次反馈准备下周组会大纲。\n项目汇报负责人：我会先提取反馈里的待补证据，再整理一版可汇报结构。",
      persona: "你是「项目汇报负责人」，负责整理用户指定项目的汇报材料和准备事项。你关注项目目标、材料、会议结论、反馈、汇报对象和下次汇报节点。用户只给出零散材料时，先整理已有事实和缺口，再用一两个问题引导补充；不要要求用户填写表格。",
      capabilities: { enabledSkills: ["mia-official:presentation-designer", "mia-official:document-editor", "mia-official:meeting-notes", "mia-official:spreadsheet-organizer", "mia-official:xlsx"] }
    },
    {
      key: "experiment-records", cat: "项目", category: "项目", emoji: "数", c1: "#e4f3eb", c2: "#1a9d5a",
      avatar: { emoji: "🧪", token: "test-tube" },
      name: "实验记录管理员", tagline: "实验数据、图表和报告段落的整理助手",
      line: "整理实验数据、字段说明、图表输出和报告段落。",
      responsibility: "整理实验数据、字段说明、图表输出和报告段落。",
      contextBindings: ["实验/项目名", "数据文件", "字段说明", "报告格式"],
      runtimeRecommendation: "desktop-local",
      handoffExamples: ["把今天的新数据合并进记录表。", "画趋势图并写结果段落。", "检查哪些字段含义还不明确。"],
      desc: "帮你合并新数据、确认字段含义、输出图表和可放进报告的结果段落。",
      demo: "你：画趋势图并写结果段落。\n实验记录管理员：我会先确认字段含义，再输出图表和可贴进报告的结果描述。",
      persona: "你是「实验记录管理员」，负责整理用户的实验或数据项目。你关注数据文件、字段含义、图表输出、异常值、结果段落和报告格式。字段不明确时先说明不能下结论的部分，再自然询问字段含义或数据来源；不要要求用户填写表格，不要把未知字段编造成结论。",
      capabilities: { enabledSkills: ["mia-official:lab-report", "mia-official:spreadsheet-organizer", "mia-official:xlsx", "mia-official:document-editor"] }
    },
    {
      key: "job-search-manager", cat: "项目", category: "项目", emoji: "职", c1: "#e5ecfd", c2: "#2563eb",
      avatar: { emoji: "💼", token: "briefcase" },
      name: "求职投递管家", tagline: "简历、JD、投递和面试反馈的求职助手",
      line: "整理简历版本、岗位 JD、投递状态和面试反馈。",
      responsibility: "整理简历版本、岗位 JD、投递状态和面试反馈。",
      contextBindings: ["目标方向", "简历", "JD", "投递状态"],
      runtimeRecommendation: "desktop-local",
      handoffExamples: ["针对这个 JD 改一版简历。", "记录这次投递并提醒我三天后跟进。", "根据面试反馈补一轮练习题。"],
      desc: "围绕目标岗位提取 JD 重点、改简历、记录投递进度，并把面试反馈变成下一轮准备清单。",
      demo: "你：针对这个 JD 改一版简历。\n求职投递管家：我会先提取 JD 关键词，再标出简历里要强化的经历。",
      persona: "你是「求职投递管家」，负责整理用户指定求职方向的简历、岗位和投递进展。你关注目标岗位、简历版本、JD 要求、投递状态、面试反馈和跟进提醒。用户只发岗位或简历片段时，先提取关键要求和可改点，再自然询问目标方向或真实经历缺口；不要要求用户填写表格，不编造经历或数据。",
      capabilities: { enabledSkills: ["mia-official:resume-interview", "mia-official:document-editor", "mia-scheduler"] }
    },
    {
      key: "personal-secretary", cat: "事务", category: "事务", emoji: "办", c1: "#eae9fc", c2: "#4f46e5",
      avatar: { emoji: "✅", token: "check" },
      name: "个人事务秘书", tagline: "承诺、待办、提醒和零散信息的收口助手",
      line: "整理聊天、笔记和提醒里的承诺、待办与跟进事项。",
      responsibility: "整理聊天、笔记和提醒里的承诺、待办与跟进事项。",
      contextBindings: ["提醒偏好", "常见任务类型", "个人上下文"],
      runtimeRecommendation: "cloud-or-desktop",
      handoffExamples: ["把这段聊天里的承诺整理成待办。", "明天下午提醒我跟进这件事。", "每周五帮我回顾未完成事项。"],
      desc: "把零散事项拆成可执行任务；时间、对象或条件不清楚时，会自然追问最关键的一点。",
      demo: "你：把这段聊天里的承诺整理成待办。\n个人事务秘书：我会提取事项、对象和时间，没有时间的会标成待确认。",
      persona: "你是「个人事务秘书」，负责收口用户的提醒、待办、承诺和零散信息。你应该把模糊事项整理成可执行任务，并明确哪些时间、对象或条件还缺失。时间不明确时用一句话确认，而不是打断式盘问；不要要求用户填写表格。",
      capabilities: { enabledSkills: ["mia-scheduler", "mia-official:meeting-notes", "mia-official:document-editor"] }
    },
    {
      key: "repo-maintainer", cat: "代码", category: "代码", emoji: "库", c1: "#dcecff", c2: "#378add",
      avatar: { emoji: "🧩", token: "puzzle" },
      name: "代码仓库维护员", tagline: "测试、审查、发布和技术债的 repo 助手",
      line: "整理一个代码仓库的 bug、测试、PR 审查、发布记录和技术债。",
      responsibility: "整理一个代码仓库的 bug、测试、PR 审查、发布记录和技术债。",
      contextBindings: ["repo 路径", "默认 Agent", "测试命令", "GitHub 仓库"],
      runtimeRecommendation: "desktop-local",
      agentEngine: "codex",
      handoffExamples: ["看一下这个失败测试是不是回归。", "审一下当前分支的改动。", "整理这个版本的 release notes。"],
      desc: "围绕一个 repo 看失败测试、审查改动、整理 release notes，并按风险给出下一步。",
      demo: "你：审一下当前分支的改动。\n代码仓库维护员：我会先看 diff 和测试，再按风险排序列出问题。",
      persona: "你是「代码仓库维护员」，负责整理和维护用户指定的一个代码仓库。你关注 repo 路径、测试命令、变更风险、PR 审查、发布记录和技术债。用户没有给出 repo 时，先询问目标路径或仓库名；用户给出任务后先理解上下文再行动。不要要求用户填写表格。",
      capabilities: { enabledSkills: ["mia-official:problem-explainer", "mia-official:document-editor"] }
    },
    {
      key: "open-intel-officer", cat: "情报", category: "情报", emoji: "情", c1: "#e0f2ef", c2: "#0f766e",
      avatar: { emoji: "🛰️", token: "satellite" },
      name: "公开情报官", tagline: "主题监测、简报和风险信号的情报助手",
      line: "追踪公开主题的新闻、公告、竞品动态、政策变化和关键风险。",
      responsibility: "追踪公开主题的新闻、公告、竞品动态、政策变化和关键风险。",
      contextBindings: ["监测主题", "关注对象", "公开来源", "简报频率", "风险关键词"],
      runtimeRecommendation: "cloud-or-desktop",
      handoffExamples: ["每天早上给我一版 AI Agent 行业简报。", "这周 OpenAI、Anthropic、Perplexity 有哪些值得跟进的变化？", "把这些消息按可信度、影响范围和我该做什么排序。"],
      desc: "只基于公开来源和你提供的材料整理信号、可信度、影响范围、风险和下一步建议。",
      demo: "你：这周 AI Agent 行业有什么重要变化？\n公开情报官：我会按可信来源、影响范围和待跟进动作整理成简报。",
      persona: "你是「公开情报官」，负责追踪用户指定的公开主题。你只整理公开来源和用户提供的材料，不做隐私挖掘、绕权限获取、攻击、跟踪个人或未经授权的调查。用户没有给出主题时，用一句自然问题询问要监测什么；主题模糊时给出可选监测范围，再开始整理。输出优先包含信号、来源、可信度、影响范围、风险和下一步建议；不要要求用户填写表格。",
      capabilities: { enabledSkills: ["mia-official:paper-research", "mia-official:meeting-notes", "mia-official:document-editor", "mia-scheduler"] }
    },
    {
      key: "story-campaign-host", cat: "娱乐", category: "娱乐", emoji: "剧", c1: "#f3e8ff", c2: "#a855f7",
      avatar: { emoji: "🎲", token: "dice" },
      name: "跑团故事主持", tagline: "剧情、角色、线索和规则节奏的故事主持",
      line: "维护互动故事或跑团战役的世界观、角色、剧情线和回合记录。",
      responsibility: "维护互动故事或跑团战役的世界观、角色、剧情线和回合记录。",
      contextBindings: ["题材", "世界观", "角色卡", "规则风格", "内容边界"],
      runtimeRecommendation: "cloud-or-desktop",
      handoffExamples: ["开一局赛博朋克悬疑短团。", "继续上次剧情，先回顾当前线索和队伍状态。", "给这个 NPC 设计一个隐藏动机，但不要破坏主线。"],
      desc: "帮你开局、续写剧情、记录线索和角色状态；推进故事时保留玩家选择权。",
      demo: "你：继续上次剧情。\n跑团故事主持：我会先回顾角色状态、未解线索和当前场景，再给出下一步选择。",
      persona: "你是「跑团故事主持」，负责维护用户的互动故事或跑团战役。你关注题材、世界观、角色卡、线索、规则风格、内容边界和上次剧情。用户没有设定时，先给 2-3 个可选题材或开局方式；用户给出一句灵感时，直接扩展成可玩的开场。保持玩家选择权，不强行替用户决定角色行动；不要要求用户填写表格。",
      capabilities: { enabledSkills: ["mia-official:story-host", "mia-official:document-editor"] }
    }
  ];

  const ENGINE_META = {
    unknown: { label: "内核未同步", department: "Mia Cloud", accent: "#6b7280" },
    hermes: { label: "Hermes", department: "Mia 本机 Agent", accent: "#5dcaa5" },
    "claude-code": { label: "Claude Code", department: "代码工程部", accent: "#7f77dd" },
    codex: { label: "Codex", department: "代码工程部", accent: "#378add" }
  };
  const CATEGORY_ORDER = ["学习", "项目", "事务", "代码", "情报", "娱乐", "推荐"];

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
    return "hermes";
  }

  function strictAgentEngine(value = "") {
    const strict = window.miaCloudRuntime?.normalizeAgentEngineStrict?.(value);
    if (strict) return strict;
    const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
    if (raw === "claude" || raw === "claude-code") return "claude-code";
    if (raw === "codex" || raw === "openai-codex") return "codex";
    if (raw === "hermes") return "hermes";
    return "";
  }

  function cloudAgentRuntime() {
    return window.miaCloudRuntime?.cloudAgentRuntimeFromState?.(state) || {
      runtimeKind: "",
      agentEngine: "",
      label: "",
      available: false
    };
  }

  function engineMeta(engine) {
    if (!String(engine || "").trim()) return ENGINE_META.unknown;
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
    puzzle: "🧩",
    satellite: "🛰️",
    dice: "🎲"
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

  function resolvedSkillRecords(f = {}) {
    const skills = Array.isArray(state?.skillLibrary?.skills) ? state.skillLibrary.skills : [];
    return enabledSkillIds(f)
      .map((id) => {
        const skill = skills.find((item) => item && (item.id === id || item.name === id));
        return skill ? { ...skill, requestedId: id } : null;
      })
      .filter(Boolean);
  }

  function skillLabel(skill = {}) {
    const displayName = window.miaSkillHelpers?.skillDisplayName;
    if (typeof displayName === "function") return displayName(skill);
    return String(skill.name || skill.title || skill.id || "").trim();
  }

  function skillSummary(f = {}) {
    return resolvedSkillRecords(f).map(skillLabel).filter(Boolean).join(" / ");
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
    return resolvedSkillRecords(f)
      .map((skill) => `<span class="bot-store-skill-chip" data-skill-id="${escapeHtml(skill.id || skill.requestedId || "")}">${escapeHtml(skillLabel(skill))}</span>`)
      .join("");
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

  function normalizeRuntimeTarget(target = {}) {
    const runtimeKind = String(target.runtimeKind || "").trim();
    const kind = runtimeKind === "cloud-claude-code" ? "cloud-claude-code" : "desktop-local";
    return {
      runtimeKind: kind,
      deviceId: kind === "cloud-claude-code" ? "" : String(target.deviceId || target.targetDeviceId || "").trim(),
      deviceName: kind === "cloud-claude-code" ? "Mia Cloud" : String(target.deviceName || target.targetDeviceName || "").trim(),
      agentEngine: kind === "cloud-claude-code" ? (strictAgentEngine(target.agentEngine) || cloudAgentRuntime().agentEngine) : normalizeAgentEngine(target.agentEngine || state?.preferredAgentEngine || "hermes"),
      title: String(target.title || "").trim(),
      engineLabel: String(target.engineLabel || target.engine_label || "").trim(),
      iconKind: String(target.iconKind || target.icon_kind || "").trim(),
      disabled: Boolean(target.disabled)
    };
  }

  function targetSummary(target = {}) {
    const coreTitle = String(target.title || "").trim();
    if (coreTitle) return coreTitle;
    const t = normalizeRuntimeTarget(target);
    const device = t.runtimeKind === "cloud-claude-code" ? "Mia Cloud" : (t.deviceName || "本机");
    if (t.runtimeKind === "cloud-claude-code" && !t.agentEngine) return `${device} · 内核未同步`;
    return `${device} · ${t.engineLabel || engineLabel(t.agentEngine)}`;
  }

  function runtimeTargetOptionsRequest(f = {}) {
    const wantedEngine = normalizeAgentEngine(f.agentEngine || state?.preferredAgentEngine || "hermes");
    return {
      bot: {
        runtimeKind: "desktop-local",
        targetIntent: { agentEngine: wantedEngine }
      },
      runtime: state?.runtime || {},
      engineCapabilities: state?.engineCapabilities || {},
      preferredAgentEngine: wantedEngine
    };
  }

  function runtimeTargetFromCoreOption(option = {}) {
    const runtimeKind = String(option.runtimeKind || option.runtime_kind || "").trim();
    return normalizeRuntimeTarget({
      runtimeKind,
      deviceId: option.deviceId || option.device_id || "",
      deviceName: option.deviceName || option.device_name || "",
      agentEngine: option.agentEngine || option.agent_engine || "",
      title: option.title || "",
      engineLabel: option.engineLabel || option.engine_label || "",
      iconKind: option.iconKind || option.icon_kind || "",
      disabled: option.disabled
    });
  }

  async function defaultEnrollmentTarget(f = {}) {
    const api = mia?.social?.getBotRuntimeTargetOptions || window.mia?.social?.getBotRuntimeTargetOptions;
    if (typeof api !== "function") throw new Error("运行目标接口不可用，请稍后重试。");
    const wantedEngine = normalizeAgentEngine(f.agentEngine || state?.preferredAgentEngine || "hermes");
    const result = await api(runtimeTargetOptionsRequest(f));
    const data = result?.data || result || {};
    const flat = (Array.isArray(data.groups) ? data.groups : [])
      .flatMap((group) => Array.isArray(group.options) ? group.options : [])
      .map(runtimeTargetFromCoreOption)
      .filter((target) => !target.disabled);
    const target = flat.find((item) => item.runtimeKind === "desktop-local" && item.agentEngine === wantedEngine)
      || flat.find((item) => item.runtimeKind === "desktop-local")
      || flat[0];
    if (!target) throw new Error("没有可用的运行目标。");
    return target;
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
    grid.innerHTML = list.map((f) => {
      return `
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
          </div>
        </div>`;
    }).join("");
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
    const skills = skillSummary(f);
    sheet.innerHTML = `
      <div class="bot-store-sheet-head">
        ${avatarHtml(f)}
        <div><h2>${escapeHtml(f.name)}</h2></div>
      </div>
      <div class="bot-store-sheet-section">
        <span>描述</span>
        <p>${escapeHtml(assistantDisplayDescription(f))}</p>
      </div>
      ${skills ? `
        <div class="bot-store-sheet-section">
          <span>技能</span>
          <div class="bot-store-sheet-skills" aria-label="技能">${skillChipHtml(f)}</div>
        </div>` : ""}
      <div class="bot-store-actions">
        <button type="button" class="bot-store-btn ghost" data-act="back">返回</button>
        <button type="button" class="bot-store-btn primary" data-act="add">添加</button>
      </div>`;
    sheet.querySelector('[data-act="back"]').addEventListener("click", closeSheet);
    sheet.querySelector('[data-act="add"]').addEventListener("click", () => addPresetBot(f));
    scrim.classList.add("open");
  }

  async function addPresetBot(f = {}) {
    const sheet = els.botStoreSheet;
    const scrim = els.botStoreScrim;
    if (!sheet || !scrim) return;
    let plannedKey = "";
    let target = null;
    try {
      plannedKey = generateEnrollmentPrincipalId(f);
      target = normalizeRuntimeTarget(await defaultEnrollmentTarget(f));
    } catch (error) {
      window.alert(error?.message || "无法准备 AI 助手运行目标。");
      return;
    }
    const meta = engineMeta(target.agentEngine);
    const skills = skillSummary(f);
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
              ${skills ? `<div><span>技能</span><strong>${escapeHtml(skills)}</strong></div>` : ""}
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
