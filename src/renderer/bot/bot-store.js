// 发现 AI 同事 —— 官方 Bot 预设商店（renderer 模块）
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

  // 样例预设：每个 = 人设包装 + 一段 personaText。技能组合（capabilities）等
  // 有意义的标签体系定了再挂；这里先不填，避免占位标签误导。
  const FALLBACK_PRESETS = [
    {
      key: "paper-buddy", cat: "论文", emoji: "📄", c1: "#eef0ff", c2: "#5e5ce6",
      name: "论文搭子", tagline: "文献综述 / 开题 / 引用",
      line: "拖一个装满 PDF 的文件夹进来，30 秒出一张文献综述对比表。",
      desc: "专治写论文最磨人的环节：把一堆文献读完、对比、整理成表。你只管把 PDF 丢进来，它来读。",
      demo: "你：<b>把这个文件夹里 18 篇文献做成综述对比表</b><br>论文搭子：已读完 → 按「作者 / 方法 / 结论 / 局限」生成了一张表 ✅",
      persona: "你是「论文搭子」，帮大学生处理文献相关的活：批量读 PDF、做文献综述对比表、整理引用格式、中英互译。语气务实、简洁，先确认用户给的文件再动手。"
    },
    {
      key: "lab-data", cat: "实验", emoji: "📊", c1: "#e9f9ef", c2: "#1a9d5a",
      name: "实验数据助手", tagline: "画图 / 统计 / 报告",
      line: "丢一个数据表，自动画图、跑统计，再写成实验报告段落。",
      desc: "理工科写 lab report 的苦力都给它。从原始 csv 到能贴进报告的图和结论，一步到位。",
      demo: "你：<b>用这份 data.csv 画个趋势图，跑下相关性</b><br>实验数据助手：图已生成，r = 0.81（强相关），结论段落见下 ✅",
      persona: "你是「实验数据助手」，帮大学生处理实验数据：读数据文件、画图、跑基础统计、把结果写成实验报告段落。动手前先确认数据列的含义。"
    },
    {
      key: "exam-buddy", cat: "复习", emoji: "📚", c1: "#fff3e6", c2: "#d9730a",
      name: "复习搭子", tagline: "提纲 / 自测题",
      line: "把一学期的 PPT、讲义丢进来，出复习提纲 + 自测题。",
      desc: "期末救命。把课件全塞给它，回你一份带例题的复习提纲，还能随时考你两道。",
      demo: "你：<b>这门课 12 个 PPT，帮我整一份复习提纲</b><br>复习搭子：提纲分 5 大块，每块附 2 道自测题 ✅",
      persona: "你是「复习搭子」，帮大学生备考：读 PPT / 讲义，整理出结构清晰的复习提纲，并出自测题。提纲要分块、抓重点，自测题给答案与解析。"
    },
    {
      key: "career-coach", cat: "求职", emoji: "💼", c1: "#eaf1ff", c2: "#2563eb",
      name: "简历面试官", tagline: "改简历 / 模拟面试",
      line: "简历 + JD 丢进来，改一版，还能陪你模拟面试。",
      desc: "网申季搭子。按目标岗位改简历，再扮演面试官跟你过一遍高频问题。",
      demo: "你：<b>照这个产品实习 JD 改我的简历</b><br>简历面试官：已对齐 JD 关键词，改了 6 处，要不要现在模拟面试？",
      persona: "你是「简历面试官」，帮大学生求职：按目标 JD 优化简历措辞与重点，并能扮演面试官做模拟面试、给反馈。先问清目标岗位再动手。"
    },
    {
      key: "qa-helper", cat: "复习", emoji: "💡", c1: "#fff7e0", c2: "#b8860b",
      name: "答疑助手", tagline: "讲题 / 讲代码",
      line: "拍一道题、贴一段代码，讲到你懂为止。",
      desc: "卡住的题别死磕。给它题目或报错代码，它一步步拆给你看，而不是直接甩答案。",
      demo: "你：<b>这段代码为什么报 NoneType 错？</b><br>答疑助手：第 14 行 find() 没命中返回了 None，往下拆给你看 …",
      persona: "你是「答疑助手」，帮大学生弄懂题目和代码：一步步拆解思路与原因，而不是直接给最终答案。讲完反问一句确认对方是否听懂。"
    }
  ];

  const ENGINE_META = {
    hermes: { label: "Hermes", department: "Mia 本机 Agent", clearance: "L3 · 对话 / 工具", accent: "#5dcaa5" },
    "claude-code": { label: "Claude Code", department: "代码工程部", clearance: "L4 · 代码 / 执行", accent: "#7f77dd" },
    codex: { label: "Codex", department: "代码工程部", clearance: "L4 · 代码 / 任务", accent: "#378add" },
    openclaw: { label: "OpenClaw", department: "开放 Agent 部", clearance: "L4 · ACP / 工具", accent: "#ef9f27" }
  };

  function presets() {
    const official = Array.isArray(state?.skillLibrary?.botPresets) ? state.skillLibrary.botPresets : [];
    return official.length ? official : FALLBACK_PRESETS;
  }

  function categories() {
    const out = ["全部"];
    for (const preset of presets()) {
      const cat = String(preset.cat || preset.category || "推荐").trim() || "推荐";
      if (!out.includes(cat)) out.push(cat);
    }
    return out;
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
    const devices = runtimeDevices();
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
    const local = Array.isArray(state?.runtime?.bots) ? state.runtime.bots : [];
    const cloud = Array.isArray(window.miaSocial?.moduleState?.bots) ? window.miaSocial.moduleState.bots : [];
    return [...local, ...cloud]
      .flatMap((item) => [item?.key, item?.id, item?.account_id, item?.accountId])
      .map((value) => String(value || "").trim())
      .filter(Boolean);
  }

  function generateEnrollmentPrincipalId(f = {}) {
    const existing = new Set(existingPrincipalIds());
    const presetId = principalId(f);
    if (presetId && !existing.has(presetId)) return presetId;
    const generate = window.miaIds?.generatePrincipalId;
    if (typeof generate !== "function") throw new Error("无法生成 AI 同事账号 ID。");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = String(generate() || "").trim();
      if (id && !existing.has(id)) return id;
    }
    throw new Error("无法生成未占用的 AI 同事账号 ID。");
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
      grid.innerHTML = `<div class="bot-store-empty">这个分类暂时还没有 AI 同事</div>`;
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
      window.alert(error?.message || "无法生成 AI 同事账号 ID。");
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
          <span>AI 同事入职</span>
          <span class="bot-store-enroll-status" data-enroll-status>确认位置</span>
        </div>
        <div class="bot-store-badge-stage">
          <div class="bot-store-badge-card">
            <div class="bot-store-badge-title">MIA · AI 同事凭证</div>
            <div class="bot-store-badge-shimmer" aria-hidden="true"></div>
            <div class="bot-store-badge-main">
              ${avatarHtml(f, "bot-store-badge-avatar")}
              <div class="bot-store-badge-id">
                <span>AI 同事</span>
                <strong>${escapeHtml(f.name)}</strong>
                <code data-badge-uid>UID · ${escapeHtml(plannedKey)}</code>
              </div>
            </div>
            <div class="bot-store-badge-fields">
              <div><span>分类</span><strong>${escapeHtml(f.cat || f.category || "推荐")}</strong></div>
              <div><span>权限</span><strong>${escapeHtml(meta.clearance)}</strong></div>
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

  async function addBot(f, runtimeTarget = {}, plannedKey = "") {
    if (adding) return;
    adding = true;
    const btn = els.botStoreSheet?.querySelector('[data-act="confirm"]');
    if (btn) { btn.disabled = true; btn.textContent = "确认中…"; }
    try {
      const target = normalizeRuntimeTarget(runtimeTarget);
      const key = String(plannedKey || "").trim();
      if (!key) throw new Error("AI 同事账号 ID 缺失。");
      const saved = await window.miaBotCommands.saveBot({
        state,
        runtimeKind: target.runtimeKind,
        isCreate: true,
        api: window.mia,
        social: window.miaSocial,
        bot: {
          key,
          name: f.name,
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
