// 发现 AI 助手 —— 官方 Bot 预设商店（renderer 模块）
// 预设来自 resources/official-library/library.json，通过 loadSkills 一并下发。
(function () {
  "use strict";

  let state, els, mia, escapeHtml, loadSkills, openBotConversation, render;
  let lastCategoryKey = "";
  let activeCat = "全部";
  let adding = false;
  let libraryRequested = false;
  let runtimeDevicesLoading = false;
  let runtimeDevicesLoadedAt = 0;
  const RUNTIME_DEVICE_REFRESH_INTERVAL_MS = 15_000;

  // 样例预设：官方库还没加载时使用；正式数据来自 resources/official-library/library.json。
  // capabilities.enabledSkills 要和官方库保持同一套 id，保存后会进入运行时 Skill 注入链路。
  const FALLBACK_PRESETS = [
    {
      key: "paper-buddy", cat: "学习", emoji: "📄", c1: "#ecebfc", c2: "#5e5ce6",
      name: "论文搭子", tagline: "文献综述 / 开题 / 引用",
      line: "把一组 PDF 变成综述表、研究脉络和可继续写的段落。",
      desc: "适合开题、综述、论文初稿阶段。它会先确认资料范围，再帮你提取作者、方法、结论和局限。",
      demo: "你：<b>把这个文件夹里 18 篇文献做成综述对比表</b><br>论文搭子：已按「作者 / 方法 / 结论 / 局限」整理，并标出共同脉络。",
      persona: "你是「论文搭子」，帮用户处理文献相关工作：批量读 PDF、做文献综述对比表、整理引用格式、中英互译。语气务实简洁，先确认用户给的文件和目标，再动手。",
      capabilities: { enabledSkills: ["mia-official:paper-research"] }
    },
    {
      key: "lab-data", cat: "学习", emoji: "📊", c1: "#e4f3eb", c2: "#1a9d5a",
      name: "实验数据助手", tagline: "画图 / 统计 / 报告",
      line: "丢一份数据表，自动检查列、画图、跑基础统计并写报告段落。",
      desc: "适合理工科实验、课程项目和小型分析。它会先问清数据列含义，再输出图表、统计结论和能贴进报告的文字。",
      demo: "你：<b>用 data.csv 画趋势图，跑相关性</b><br>实验数据助手：趋势图已生成，r = 0.81，下面是可放进报告的结果描述。",
      persona: "你是「实验数据助手」，帮用户处理实验数据：读取表格、确认列含义、画图、跑基础统计、把结果写成实验报告段落。遇到数据含义不明时先提问。",
      capabilities: { enabledSkills: ["mia-official:lab-report"] }
    },
    {
      key: "exam-buddy", cat: "学习", emoji: "📚", c1: "#faeee2", c2: "#d9730a",
      name: "复习搭子", tagline: "提纲 / 自测题 / 错题",
      line: "把课件和讲义整理成复习提纲，再按章节出自测题。",
      desc: "适合期末、考证和课程复盘。它会按知识点拆结构、抓重点、生成题目和答案解析。",
      demo: "你：<b>这门课 12 个 PPT，帮我做复习提纲</b><br>复习搭子：已分成 5 个模块，每个模块附 2 道自测题和答案。",
      persona: "你是「复习搭子」，帮用户备考：阅读 PPT、讲义或笔记，整理结构清晰的复习提纲，并生成自测题、答案与解析。表达清楚，不直接堆长篇。",
      capabilities: { enabledSkills: ["mia-official:study-review"] }
    },
    {
      key: "qa-helper", cat: "学习", emoji: "💡", c1: "#f6f0e2", c2: "#b8860b",
      name: "答疑助手", tagline: "讲题 / 讲代码 / 排错",
      line: "拍一道题或贴一段报错，按步骤讲到你能复述。",
      desc: "适合卡题、代码报错和概念不清。它会拆解原因和思路，不只是直接给最终答案。",
      demo: "你：<b>这段代码为什么报 NoneType 错？</b><br>答疑助手：第 14 行 find() 没命中返回 None，我按调用链拆给你看。",
      persona: "你是「答疑助手」，帮用户弄懂题目和代码：一步步拆解思路与原因，不直接甩最终答案。讲完反问一句确认对方是否听懂。",
      capabilities: { enabledSkills: ["mia-official:problem-explainer"] }
    },
    {
      key: "spreadsheet-organizer", cat: "办公", emoji: "🧮", c1: "#e2f1ef", c2: "#0f766e",
      name: "表格整理师", tagline: "清洗 / 公式 / 图表",
      line: "把杂乱 Excel、CSV 整成能分析、能汇报、能继续维护的表。",
      desc: "适合报销、问卷、运营表、实验记录和临时台账。它会先识别表头、单位和脏数据，再给出清洗结果、公式或图表。",
      demo: "你：<b>这张表列名乱、空值多，帮我整理出月度汇总</b><br>表格整理师：已清理重复行和空值，生成月度透视表，并标出异常数据。",
      persona: "你是「表格整理师」，帮用户处理 Excel、CSV 和表格数据：整理表头、清洗数据、补公式、做透视和图表。先确认字段含义和输出目标，不随意改动原始数据。",
      capabilities: { enabledSkills: ["mia-official:spreadsheet-organizer"] }
    },
    {
      key: "presentation-designer", cat: "办公", emoji: "📽", c1: "#e1f3f6", c2: "#0891b2",
      name: "汇报设计师", tagline: "大纲 / 排版 / 演示稿",
      line: "把资料和要点整理成一份结构清楚、能上台讲的 PPT。",
      desc: "适合课堂展示、组会、答辩和工作汇报。它会先抓主线，再拆页、写讲稿提示，并提醒哪些页面需要图表或素材。",
      demo: "你：<b>把这份调研整理成 8 页课堂展示</b><br>汇报设计师：已拆成问题、方法、发现和结论四段，并给每页配了标题和讲稿备注。",
      persona: "你是「汇报设计师」，帮用户制作演示文稿：梳理叙事主线、拆分页面、优化标题、给出排版和讲稿建议。默认追求清楚、有重点，而不是堆满文字。",
      capabilities: { enabledSkills: ["mia-official:presentation-designer"] }
    },
    {
      key: "meeting-notes", cat: "办公", emoji: "🗒", c1: "#eae9fc", c2: "#4f46e5",
      name: "会议纪要官", tagline: "摘要 / 决议 / 待办",
      line: "把会议记录、转写稿或零散笔记整理成纪要和可执行待办。",
      desc: "适合小组讨论、项目例会、访谈和头脑风暴复盘。它会区分结论、分歧、负责人和截止时间。",
      demo: "你：<b>把这段会议转写整理成纪要</b><br>会议纪要官：已按议题归纳 4 条决定、6 个待办和 2 个未决问题。",
      persona: "你是「会议纪要官」，帮用户整理会议材料：提炼议题、决定、待办、负责人和未决问题。事实不明确时标注待确认，不把讨论猜成结论。",
      capabilities: { enabledSkills: ["mia-official:meeting-notes"] }
    },
    {
      key: "document-editor", cat: "写作", emoji: "📝", c1: "#f3e7fb", c2: "#9333ea",
      name: "文档编辑", tagline: "润色 / 结构 / Word",
      line: "把草稿、报告和长文档改成结构清楚、表达稳妥的版本。",
      desc: "适合课程报告、申请材料、说明文档和正式邮件附件。它会先判断读者和用途，再做结构调整、措辞润色和格式建议。",
      demo: "你：<b>帮我把这份项目报告改得更正式</b><br>文档编辑：已重排章节标题，压缩重复段落，并给出可直接替换的修订版。",
      persona: "你是「文档编辑」，帮用户处理长文档和正式写作：调整结构、润色表达、统一术语、提出 Word 排版建议。保留用户原意，不替用户编造经历或数据。",
      capabilities: { enabledSkills: ["mia-official:document-editor"] }
    },
    {
      key: "career-coach", cat: "求职", emoji: "💼", c1: "#e5ecfd", c2: "#2563eb",
      name: "简历面试官", tagline: "改简历 / JD 匹配 / 模拟面试",
      line: "对照 JD 改简历，提炼项目亮点，再模拟一轮面试。",
      desc: "适合投实习、校招和转岗。它会先确认目标岗位，再把经历改成更贴近 JD 的表达。",
      demo: "你：<b>照这个产品实习 JD 改我的简历</b><br>简历面试官：已对齐 6 个关键词，并给出一轮模拟面试问题。",
      persona: "你是「简历面试官」，帮用户求职：按目标 JD 优化简历措辞与重点，提炼项目经历，并能扮演面试官做模拟面试和反馈。先问清目标岗位。",
      capabilities: { enabledSkills: ["mia-official:resume-interview"] }
    },
    {
      key: "story-host", cat: "娱乐", emoji: "🎲", c1: "#f7e1e7", c2: "#be123c",
      name: "剧情主持", tagline: "互动故事 / 角色 / 分支",
      line: "开一局轻量互动故事，帮你设定角色、推进剧情和保留选择后果。",
      desc: "适合放松、脑洞创作和桌游式文字冒险。它会维护当前场景、角色目标和分支结果，不需要屏幕录制或实时操作。",
      demo: "你：<b>来一局赛博校园悬疑，我想扮演调查员</b><br>剧情主持：夜里的实验楼只剩一盏灯，我先给你三个可选行动。",
      persona: "你是「剧情主持」，负责轻量互动故事和文字冒险：设定世界观、扮演 NPC、推进分支、记录关键选择。每轮给用户 2-4 个行动选项，也允许自由输入。保持娱乐性质，不把虚构内容当现实建议。",
      capabilities: { enabledSkills: ["mia-official:story-host"] }
    }
  ];

  const ENGINE_META = {
    hermes: { label: "Hermes", department: "Mia 本机 Agent", accent: "#5dcaa5" },
    "claude-code": { label: "Claude Code", department: "代码工程部", accent: "#7f77dd" },
    codex: { label: "Codex", department: "代码工程部", accent: "#378add" },
    openclaw: { label: "OpenClaw", department: "开放 Agent 部", accent: "#ef9f27" }
  };
  const CATEGORY_ORDER = ["学习", "办公", "写作", "求职", "娱乐", "推荐"];

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
    "mia-official:presentation-designer": "汇报设计",
    "presentation-designer": "汇报设计",
    "mia-official:meeting-notes": "会议纪要",
    "meeting-notes": "会议纪要",
    "mia-official:document-editor": "文档编辑",
    "document-editor": "文档编辑",
    "mia-official:story-host": "剧情主持",
    "story-host": "剧情主持",
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
    const aliases = Array.isArray(input.aliases)
      ? input.aliases.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    return {
      ...input,
      id,
      deviceName: firstNonEmpty(input.deviceName, input.device_name, input.name, id),
      status: String(input.status || "").trim(),
      isLocal: Boolean(input.isLocal),
      aliases: [...new Set([id, ...aliases])],
      capabilities: input.capabilities && typeof input.capabilities === "object" ? input.capabilities : {}
    };
  }

  function normalizedDeviceName(device = {}) {
    return String(device.deviceName || device.device_name || device.name || "").trim().toLowerCase();
  }

  function isSameLocalDevice(device, local) {
    if (!device || !local) return false;
    if (device.id === local.id) return true;
    const deviceName = normalizedDeviceName(device);
    const localName = normalizedDeviceName(local);
    return Boolean(deviceName && localName && deviceName === localName);
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

  function mergeDevices(existing, incoming, options = {}) {
    if (!existing) return incoming;
    const local = options.local || null;
    const keepLocalIdentity = Boolean(local && (isSameLocalDevice(existing, local) || isSameLocalDevice(incoming, local)));
    const aliases = [...new Set([...(existing.aliases || []), existing.id, ...(incoming.aliases || []), incoming.id].filter(Boolean))];
    const engines = mergeEngineLists(existing, incoming);
    const status = keepLocalIdentity
      ? "local"
      : ([existing.status, incoming.status].includes("online") ? "online" : (incoming.status || existing.status || ""));
    return {
      ...existing,
      ...incoming,
      id: keepLocalIdentity ? local.id : (existing.id || incoming.id),
      deviceName: keepLocalIdentity ? local.deviceName : (incoming.deviceName || existing.deviceName),
      status,
      isLocal: keepLocalIdentity || Boolean(existing.isLocal || incoming.isLocal),
      aliases,
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
    const local = localDeviceCandidate();
    const add = (device) => {
      const normalized = normalizeDevice(device);
      if (!normalized) return;
      const key = isSameLocalDevice(normalized, local) ? local.id : normalized.id;
      byId.set(key, mergeDevices(byId.get(key), normalized, { local }));
    };
    for (const device of state?.runtime?.cloud?.devices || state?.runtime?.cloud?.bridgeDevices || []) add(device);
    add(local);
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
    if (wantedDeviceId && !devices.some((device) => device.id === wantedDeviceId || (device.aliases || []).includes(wantedDeviceId))) {
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

  function runtimeTargetKey(target = {}) {
    const t = normalizeRuntimeTarget(target);
    return `${t.runtimeKind}:${t.deviceId}:${t.agentEngine}`;
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
      if (state.activeView === "bot-store") movePill();
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
        activeCat = c;
        cap.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        movePill();
        renderGrid();
      });
      cap.appendChild(b);
    });
    movePill();
  }

  function movePill() {
    const cap = els.botStoreCap;
    if (!cap) return;
    const a = cap.querySelector("button.active");
    if (!a || typeof a.getBoundingClientRect !== "function") return;
    const hr = cap.getBoundingClientRect();
    const ar = a.getBoundingClientRect();
    cap.style.setProperty("--pill-x", `${ar.left - hr.left}px`);
    cap.style.setProperty("--pill-w", `${ar.width}px`);
    cap.style.setProperty("--pill-ready", "1");
  }

  function avatarHtml(f, extraClass) {
    const cls = extraClass ? ` ${extraClass}` : "";
    return `<div class="bot-store-avatar${cls}" style="background:${f.c1};color:${f.c2}">${f.emoji}</div>`;
  }

  function textWithLineBreaks(value) {
    return escapeHtml(
      String(value || "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
    ).replace(/\n/g, "<br>");
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

  function targetOptionValue(target) {
    const t = normalizeRuntimeTarget(target);
    return encodeURIComponent(JSON.stringify({
      runtimeKind: t.runtimeKind,
      deviceId: t.deviceId,
      deviceName: t.deviceName,
      agentEngine: t.agentEngine
    }));
  }

  function parseTargetOptionValue(value = "") {
    try {
      return normalizeRuntimeTarget(JSON.parse(decodeURIComponent(String(value || ""))));
    } catch {
      return normalizeRuntimeTarget({});
    }
  }

  function targetSelectHtml(selectedTarget) {
    const groups = runtimeTargetGroups(selectedTarget);
    if (!groups.length) return `<option value="" disabled>没有可用 Agent</option>`;
    const selectedKey = runtimeTargetKey(selectedTarget);
    return groups.map((group) => `
      <optgroup label="${escapeHtml(group.label)}">
        ${group.targets.map((target) => {
          const t = normalizeRuntimeTarget(target);
          const selected = runtimeTargetKey(t) === selectedKey ? " selected" : "";
          return `<option value="${escapeHtml(targetOptionValue(t))}"${selected}>${escapeHtml(targetSummary(t))}</option>`;
        }).join("")}
      </optgroup>
    `).join("");
  }

  function writeEnrollmentTarget(sheet, target) {
    const t = normalizeRuntimeTarget(target);
    const meta = engineMeta(t.agentEngine);
    sheet.dataset.runtimeKind = t.runtimeKind;
    sheet.dataset.targetDeviceId = t.deviceId;
    sheet.dataset.targetDeviceName = t.deviceName;
    sheet.dataset.agentEngine = t.agentEngine;
    sheet.querySelector(".bot-store-enroll-console")?.style.setProperty("--engine-accent", safeColor(meta.accent, "#5dcaa5"));
    const engineLabelEl = sheet.querySelector("[data-badge-engine]");
    if (engineLabelEl) engineLabelEl.textContent = targetSummary(t);
    const select = sheet.querySelector("[data-runtime-target-select]");
    if (select) {
      select.innerHTML = targetSelectHtml(t);
      const selectedOption = Array.from(select.options || []).find((option) => runtimeTargetKey(parseTargetOptionValue(option.value)) === runtimeTargetKey(t));
      if (selectedOption) select.value = selectedOption.value;
      select.onchange = () => selectEnrollmentTarget(sheet, parseTargetOptionValue(select.value));
    }
  }

  function renderGrid() {
    const grid = els.botStoreGrid;
    if (!grid) return;
    maybeLoadOfficialLibrary();
    renderCategories();
    const list = presets().filter((f) => activeCat === "全部" || (f.cat || f.category) === activeCat);
    if (!list.length) {
      grid.innerHTML = `<div class="bot-store-empty">这个分类暂时还没有 AI 助手</div>`;
      return;
    }
    grid.innerHTML = list.map((f, i) => `
      <div class="bot-store-card" data-key="${escapeHtml(f.key)}" style="animation-delay:${(i * 0.05).toFixed(2)}s">
        <div class="bot-store-card-head">
          ${avatarHtml(f)}
          <div class="meta">
            <strong>${escapeHtml(f.name)}</strong>
            <div class="tag">${escapeHtml(f.tagline)}</div>
          </div>
        </div>
        <p class="line">${escapeHtml(f.line)}</p>
      </div>`).join("");
    grid.querySelectorAll(".bot-store-card").forEach((card) => {
      card.addEventListener("click", () => {
        const f = presets().find((x) => x.key === card.dataset.key);
        if (f) openSheet(f);
      });
    });
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
        <div><h2>${escapeHtml(f.name)}</h2><div class="tag">${escapeHtml(f.tagline)}</div></div>
      </div>
      <p class="desc">${escapeHtml(f.desc)}</p>
      <div class="bot-store-demo">${textWithLineBreaks(f.demo)}</div>
      <div class="bot-store-actions">
        <button type="button" class="bot-store-btn ghost" data-act="back">返回</button>
        <button type="button" class="bot-store-btn primary" data-act="prepare">添加</button>
      </div>`;
    sheet.querySelector('[data-act="back"]').addEventListener("click", closeSheet);
    sheet.querySelector('[data-act="prepare"]').addEventListener("click", () => openEnrollmentStep(f));
    scrim.classList.add("open");
  }

  function openEnrollmentStep(f, selectedTarget = null) {
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
    const target = normalizeRuntimeTarget(selectedTarget || defaultEnrollmentTarget(f));
    const meta = engineMeta(target.agentEngine);
    adding = false;
    sheet.classList.add("is-enrolling");
    sheet.classList.remove("is-stamped");
    sheet.dataset.botKey = plannedKey;
    sheet.innerHTML = `
      <div class="bot-store-enroll-console" style="--badge-accent:${safeColor(f.c2, "#5dcaa5")};--engine-accent:${safeColor(meta.accent, "#5dcaa5")}">
        <div class="bot-store-enroll-bar">
          <span class="bot-store-enroll-light" aria-hidden="true"></span>
          <span>AI 助手入库</span>
          <span class="bot-store-enroll-status" data-enroll-status>确认位置</span>
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
              <label class="bot-store-badge-field bot-store-badge-engine-row">
                <span>运行位置 / Agent</span><strong data-badge-engine>${escapeHtml(targetSummary(target))}</strong>
                <select class="bot-store-badge-target-select" data-runtime-target-select aria-label="运行位置和 Agent 内核">
                  ${targetSelectHtml(target)}
                </select>
              </label>
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
    writeEnrollmentTarget(sheet, target);
    sheet.querySelector('[data-act="confirm"]').addEventListener("click", () => addBot(f, readEnrollmentTarget(sheet), sheet.dataset.botKey || plannedKey));
    scrim.classList.add("open");
    refreshRuntimeDevicesForStore(f);
  }

  function readEnrollmentTarget(sheet) {
    return normalizeRuntimeTarget({
      runtimeKind: sheet?.dataset.runtimeKind || "desktop-local",
      deviceId: sheet?.dataset.targetDeviceId || "",
      deviceName: sheet?.dataset.targetDeviceName || "",
      agentEngine: sheet?.dataset.agentEngine || "hermes"
    });
  }

  function selectEnrollmentTarget(sheet, target) {
    writeEnrollmentTarget(sheet, target);
  }

  function refreshRuntimeDevicesForStore(f) {
    const now = Date.now();
    if (runtimeDevicesLoading || !state?.runtime?.cloud?.enabled || typeof window.mia?.social?.listBridgeDevices !== "function") return;
    if (now - runtimeDevicesLoadedAt < RUNTIME_DEVICE_REFRESH_INTERVAL_MS) return;
    runtimeDevicesLoading = true;
    runtimeDevicesLoadedAt = now;
    window.mia.social.listBridgeDevices({ includeOffline: true })
      .then((result) => {
        const devices = result?.data?.devices || result?.devices || [];
        if (!Array.isArray(devices)) return;
        state.runtime = {
          ...(state.runtime || {}),
          cloud: {
            ...(state.runtime?.cloud || {}),
            devices
          }
        };
        const sheet = els.botStoreSheet;
        if (!sheet?.classList.contains("is-enrolling")) return;
        const current = readEnrollmentTarget(sheet);
        const hasExplicitTarget = current.runtimeKind === "cloud-hermes" || Boolean(current.deviceId && current.deviceId !== "current-device");
        writeEnrollmentTarget(sheet, hasExplicitTarget ? current : defaultEnrollmentTarget(f));
      })
      .catch((error) => console.warn("[bot-store] bridge devices load failed:", error?.message || error))
      .finally(() => { runtimeDevicesLoading = false; });
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
    const btn = els.botStoreSheet?.querySelector('[data-act="confirm"]');
    if (btn) { btn.disabled = true; btn.textContent = "确认中…"; }
    try {
      const target = normalizeRuntimeTarget(runtimeTarget);
      const key = String(plannedKey || "").trim();
      if (!key) throw new Error("AI 助手账号 ID 缺失。");
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
          description: f.line,
          personaText: f.persona,
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
      await new Promise((resolve) => setTimeout(resolve, 720));
      closeSheet();
      if (savedKey && typeof openBotConversation === "function") {
        state.activeView = "chat";
        await openBotConversation(savedKey);
      } else {
        render();
      }
    } catch (error) {
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
