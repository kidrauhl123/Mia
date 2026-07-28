// Tasks panel module
// Single full-width card-grid layout (mirrors skill-library): chip row +
// card grid in main content; task and run output share one compact overlay
// card (#taskPreviewDialog).
(function () {
  "use strict";

  const __global = typeof window !== "undefined" ? window : globalThis;
  function contact() {
    if (__global.miaContact) return __global.miaContact;
    if (typeof require !== "undefined") return require("../../shared/contact");
    throw new Error("miaContact is not loaded");
  }
  function unreadShared() {
    if (__global.miaUnread) return __global.miaUnread;
    if (typeof require !== "undefined") return require("../../shared/unread");
    throw new Error("miaUnread is not loaded");
  }

  let state, els, mia;
  let escapeHtml, setText, formatRunTime;
  let render, renderView, renderChat;

  // Top-level pill toggle in topbar: 活跃任务 vs 历史.
  const MODES = [
    { key: "active",  label: "活跃任务" },
    { key: "history", label: "历史" }
  ];
  // Sub-chip filters inside 历史 mode, by run outcome.
  const HISTORY_FILTERS = [
    { key: "all",    label: "全部",      match: () => true },
    { key: "ok",     label: "成功",      match: (r) => r.status === "ok" },
    { key: "failed", label: "失败/错过", match: (r) => r.status === "failed" || r.status === "missed" }
  ];
  let pageTurnDirection = 0;

  // Single source of truth for run-status presentation. Any new run.status
  // value must extend this map so task cards and compact output stay in sync.
  const RUN_STATUS_ICONS  = { ok: "✓", failed: "✗", missed: "⊘", skipped: "·" };
  const RUN_STATUS_LABELS = { ok: "完成", failed: "失败", missed: "错过", skipped: "跳过" };
  function runStatusIcon(status)  { return RUN_STATUS_ICONS[status]  || "·"; }
  function runStatusLabel(status) { return RUN_STATUS_LABELS[status] || status || "—"; }
  function runStatusSuffix(run) {
    if (run.status === "missed") return ` 离线错过 ${run.missedCount || 1} 次`;
    return "";
  }
  function cloudConversationId(value) {
    const text = String(value || "").trim();
    return text.startsWith("conversation:") ? text.slice("conversation:".length) : text;
  }
  function taskConversationId(task) {
    return cloudConversationId(task?.conversationId || task?.sessionId || "");
  }

  function initTasksPanel(deps) {
    state = deps.state;
    els = deps.els;
    mia = deps.mia || (typeof window !== "undefined" ? window.mia : null);
    escapeHtml = deps.escapeHtml;
    setText = deps.setText;
    formatRunTime = deps.formatRunTime;
    render = deps.render;
    renderView = deps.renderView;
    renderChat = deps.renderChat;
    if (state) {
      if (!state.taskMode) state.taskMode = "active";
      if (!state.taskHistoryFilter) state.taskHistoryFilter = "all";
    }
  }

  function botContact(botId) {
    const { resolveContact, IdentityKind } = contact();
    const bots = ownedBots();
    return resolveContact({ kind: IdentityKind?.Bot || "bot", ref: botId }, { bots });
  }

  function botName(botId) {
    return botContact(botId).displayName || botId;
  }

  function taskExecutorAvatarView(task) {
    const resolved = botContact(task?.botId || "");
    const avatar = resolved.avatar || {};
    const label = resolved.displayName || task?.botId || "";
    return {
      avatar: {
        color: avatar.color || "#5e5ce6",
        crop: avatar.crop || null,
        image: avatar.image || "",
        text: avatar.image ? "" : avatar.text || label
      },
      label
    };
  }

  function ownedBots() {
    const managerBots = __global.miaBotManager?.allOwnedBots?.();
    if (Array.isArray(managerBots)) return managerBots;
    const runtime = state?.runtime || {};
    const identityBots = Array.isArray(__global.miaSocial?.moduleState?.bots)
      ? __global.miaSocial.moduleState.bots
      : [];
    if (__global.miaBotDirectory?.listOwnedBots) {
      return __global.miaBotDirectory.listOwnedBots({ identityBots, runtime });
    }
    return identityBots;
  }

  function formatNextTime(ms) {
    if (ms == null) return "—";
    return new Date(ms).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }

  function isTodayMs(ms, now) {
    if (ms == null) return false;
    const a = new Date(ms); const b = new Date(now);
    return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
  }

  // 活跃任务 view: tasks the user has set up that may still fire.
  // Paused is included — user might want to resume — but done/failed are not.
  function activeTasks(tasks) {
    return tasks
      .filter((t) => t.status === "active" || t.status === "paused")
      .sort((a, b) => {
        // Active before paused; within each group sort by nextFireAt asc.
        if (a.status !== b.status) return a.status === "active" ? -1 : 1;
        const an = a.nextFireAt ?? Infinity;
        const bn = b.nextFireAt ?? Infinity;
        return an - bn;
      });
  }

  function latestRun(task) {
    const runs = Array.isArray(task?.runs) ? task.runs : [];
    return runs.reduce((latest, run) =>
      !latest || (run.firedAt || 0) > (latest.firedAt || 0) ? run : latest, null);
  }

  // 历史 view: one card per task, ordered by that task's latest real run.
  function historyTasks(tasks) {
    return (Array.isArray(tasks) ? tasks : [])
      .filter((task) => latestRun(task))
      .slice()
      .sort((a, b) => (latestRun(b)?.firedAt || 0) - (latestRun(a)?.firedAt || 0));
  }

  function filterTasks(tasks, needle) {
    const q = (needle || "").trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter((t) => `${t.title} ${taskInstructionText(t)}`.toLowerCase().includes(q));
  }
  function filterHistoryTasks(tasks, needle) {
    const q = (needle || "").trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter((task) => {
      const outputs = (task.runs || []).map((run) => run.outputText || run.error || "").join(" ");
      return `${task.title} ${taskInstructionText(task)} ${outputs}`.toLowerCase().includes(q);
    });
  }

  // ── Main render: chip row + card grid + preview dialog ────────────────────

  function renderTaskView() {
    if (!state || !els?.tasksContent) return;
    const mode = state.taskMode || "active";
    renderModeToggle(mode);
    if (mode === "history") renderHistoryView();
    else renderActiveView();
    renderTaskPreview();
  }

  function renderModeToggle(mode) {
    const host = document.getElementById("taskModeToggle");
    if (!host) return;
    const active = activeTasks(state.tasks);
    const history = historyTasks(state.tasks);
    const counts = {
      active: active.length,
      history: history.length
    };
    const unreadCounts = {
      active: active.reduce((n, task) => n + taskUnreadCount(task), 0),
      history: state.tasks
        .filter((task) => (task.runs || []).length > 0)
        .reduce((n, task) => n + taskUnreadCount(task), 0)
    };
    __global.miaReactTasks?.publish?.({
      modeTabs: MODES.map((entry) => ({
        active: entry.key === mode,
        count: counts[entry.key],
        id: entry.key,
        label: entry.label,
        select: () => {
          if (state.taskMode === entry.key) return;
          const fromIndex = Math.max(0, MODES.findIndex((item) => item.key === state.taskMode));
          const toIndex = Math.max(0, MODES.findIndex((item) => item.key === entry.key));
          pageTurnDirection = toIndex >= fromIndex ? 1 : -1;
          window.miaMasonryGrid?.capture(els.tasksContent, pageTurnDirection);
          state.taskMode = entry.key;
          renderTaskView();
        },
        unread: unreadCounts[entry.key]
      }))
    });
  }

  function taskUnreadCount(task) {
    return state.tasksUnread?.get?.(task?.id) || 0;
  }

  function openTaskPreview(taskId) {
    state.selectedTaskId = taskId;
    state.tasksUnread.delete(state.selectedTaskId);
    updateTasksRailBadge();
    renderTaskView();
  }

  function publishTaskCards(cards, emptyKind = "") {
    __global.miaReactTasks?.publish?.({
      cards,
      emptyKind,
      newTask: openTaskCreate,
      pageDirection: pageTurnDirection
    });
    pageTurnDirection = 0;
  }

  function renderActiveView() {
    __global.miaReactTasks?.publish?.({ chips: [] });
    const tasks = filterTasks(activeTasks(state.tasks), state.taskFilter);
    if (tasks.length === 0) {
      publishTaskCards([], "active");
      return;
    }
    publishTaskCards(tasks.map(cardView));
  }

  function renderHistoryView() {
    const filterKey = state.taskHistoryFilter || "all";
    const allHistoryTasks = filterHistoryTasks(historyTasks(state.tasks), state.taskFilter);
    const counts = Object.fromEntries(
      HISTORY_FILTERS.map((entry) => [entry.key, allHistoryTasks.filter((task) => entry.match(latestRun(task))).length])
    );
    __global.miaReactTasks?.publish?.({
      chips: HISTORY_FILTERS.map((entry) => ({
        active: entry.key === filterKey,
        count: counts[entry.key],
        id: entry.key,
        label: entry.label,
        select: () => {
            const next = entry.key;
            if ((state.taskHistoryFilter || "all") === next) return;
            const fromIndex = Math.max(0, HISTORY_FILTERS.findIndex((item) => item.key === (state.taskHistoryFilter || "all")));
            const toIndex = Math.max(0, HISTORY_FILTERS.findIndex((item) => item.key === next));
            pageTurnDirection = toIndex >= fromIndex ? 1 : -1;
            window.miaMasonryGrid?.capture(els.tasksContent, pageTurnDirection);
            state.taskHistoryFilter = next;
            renderTaskView();
        }
      }))
    });
    const match = (HISTORY_FILTERS.find((f) => f.key === filterKey) || HISTORY_FILTERS[0]).match;
    const visible = allHistoryTasks.filter((task) => match(latestRun(task)));
    if (visible.length === 0) {
      publishTaskCards([], "history");
      return;
    }
    publishTaskCards(visible.map(historyCardView));
  }

  function cardView(task) {
    const dotClass = dotClassFor(task);
    const lastRun = (task.runs || [])[(task.runs || []).length - 1];
    const statusText = cardStatusText(task, lastRun);
    return {
      botLabel: "",
      dotClass,
      historyIcon: "",
      historyStatus: "",
      id: task.id,
      meta: `${botName(task.botId)} · ${scheduleText(task)}`,
      open: () => openTaskPreview(task.id),
      statusText,
      title: task.title,
      type: "active",
      unread: taskUnreadCount(task)
    };
  }

  function dotClassFor(task) {
    if (task.status !== "active") {
      const last = (task.runs || [])[(task.runs || []).length - 1];
      if (last?.status === "missed") return "missed";
      if (last?.status === "failed") return "failed";
      return "disabled";
    }
    if (task.nextFireAt == null) return "disabled";
    return isTodayMs(task.nextFireAt, Date.now()) ? "active" : "upcoming";
  }

  function cardStatusText(task, lastRun) {
    if (task.status === "active" && task.nextFireAt) {
      return `下次 ${formatNextTime(task.nextFireAt)}`;
    }
    if (task.status === "paused") return "已暂停";
    if (task.status === "done")   return "已完成";
    if (task.status === "failed") return "已失败";
    if (lastRun) {
      return `${runStatusLabel(lastRun.status)} · ${formatRunTime(lastRun.firedAt)}`;
    }
    return "—";
  }

  function historyCardView(task) {
    const run = latestRun(task);
    const runCount = (task.runs || []).length;
    const icon = runStatusIcon(run.status);
    const label = runStatusLabel(run.status);
    const detail = run.status === "missed"
      ? `离线期间错过 ${run.missedCount || 1} 次触发`
      : (run.outputText || run.error || "本次没有产生输出")
          .toString()
          .replace(/\s+/g, " ")
          .trim();
    return {
      botLabel: botName(task.botId),
      dotClass: "",
      historyIcon: icon,
      historyStatus: run.status,
      id: task.id,
      meta: detail,
      open: () => openTaskPreview(task.id),
      statusText: `${label} · ${formatRunTime(run.firedAt)} · 执行 ${runCount} 次`,
      title: task.title,
      type: "history",
      unread: taskUnreadCount(task)
    };
  }

  // ── Preview dialog (overlay): task detail OR run detail ──────────────────

  let _previewKeydownAbort = null;

  function renderTaskPreview() {
    const dialog = document.getElementById("taskPreviewDialog");
    if (!dialog) return;
    const task = state.selectedTaskId
      ? state.tasks.find((t) => t.id === state.selectedTaskId)
      : null;
    if (!task) {
      __global.miaReactTasks?.publish?.({ preview: null });
      hidePreviewDialog();
      return;
    }
    showPreviewDialog();
    renderTaskDetail(task);
  }

  function showPreviewDialog() {
    const dialog = document.getElementById("taskPreviewDialog");
    if (!dialog) return;
    dialog.classList.remove("hidden");
    if (_previewKeydownAbort) return;
    _previewKeydownAbort = new AbortController();
    const { signal } = _previewKeydownAbort;
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePreviewDialog();
    }, { signal });
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) closePreviewDialog();
    }, { signal });
    document.getElementById("closeTaskPreview")?.addEventListener("click", closePreviewDialog, { signal });
  }

  function hidePreviewDialog() {
    document.getElementById("taskPreviewDialog")?.classList.add("hidden");
    if (_previewKeydownAbort) {
      _previewKeydownAbort.abort();
      _previewKeydownAbort = null;
    }
  }

  function closePreviewDialog() {
    state.selectedTaskId = "";
    __global.miaReactTasks?.publish?.({ preview: null });
    hidePreviewDialog();
    renderTaskView();
  }

  function renderTaskDetail(task) {
    const runs = Array.isArray(task.runs)
      ? task.runs.slice().sort((a, b) => (a.firedAt || 0) - (b.firedAt || 0))
      : [];
    const conversationId = taskConversationId(task);

    setText(document.getElementById("taskPreviewTitle"), task.title);

    const pauseAction = task.status === "paused" ? "resume" : "pause";
    const closed = task.status === "done" || task.status === "failed";
    __global.miaReactTasks?.publish?.({
      preview: {
        canPause: !closed,
        deleteTask: () => runTaskAction(task, "delete"),
        pauseLabel: task.status === "paused" ? "恢复任务" : "暂停任务",
        pauseTask: () => runTaskAction(task, pauseAction),
        runs: runs.length
          ? runs.map((run) => taskOutputView(task, run, conversationId))
          : [taskOutputView(task, null, conversationId)],
        title: task.title
      }
    });
  }

  function taskOutputView(task, run, conversationId) {
    const executor = taskExecutorAvatarView(task);
    if (!run) {
      return {
        avatar: executor.avatar,
        avatarLabel: executor.label,
        jump: null,
        outputClass: "",
        outputHtml: "",
        outputText: "",
        pending: true,
        statusText: "",
        timeText: ""
      };
    }

    const outputText = String(run.outputText || "").trim();
    let displayText = "";
    let outputClass = "";
    let outputHtml = "";
    if (run.status === "missed") {
      const range = run.firstMissedAt && run.lastMissedAt
        ? `（${formatRunTime(run.firstMissedAt)} – ${formatRunTime(run.lastMissedAt)}）`
        : "";
      displayText = `设备离线期间错过 ${run.missedCount || 1} 次触发${range}，未补跑。`;
      outputClass = "missed";
    } else if (!outputText) {
      displayText = run.error ? `运行失败：${run.error}` : "本次没有产生输出。";
      outputClass = run.error ? "failed" : "empty";
    } else {
      outputHtml = window.miaMarkdown.renderMarkdown(outputText);
    }
    return {
      avatar: executor.avatar,
      avatarLabel: executor.label,
      jump: conversationId ? () => jumpToTaskConversation(task) : null,
      outputClass,
      outputHtml,
      outputText: displayText,
      pending: false,
      statusText: `${runStatusLabel(run.status)}${runStatusSuffix(run)}`,
      timeText: formatRunTime(run.firedAt)
    };
  }

  async function runTaskAction(task, action) {
    try {
      if (action === "pause") await mia.tasks.pause(task.id, task.taskSource);
      if (action === "resume") await mia.tasks.resume(task.id, task.taskSource);
      if (action === "delete") {
        if (!confirm(`删除任务「${task.title}」？已经发送的回复仍会保留在对话里。`)) return;
        await mia.tasks.delete(task.id, task.taskSource);
        state.selectedTaskId = "";
      }
    } catch (error) {
      console.warn("[task action]", action, error);
    }
    await loadTasksFromDaemon();
    renderTaskView();
  }

  function jumpToTaskConversation(task) {
    const conversationId = taskConversationId(task);
    if (!conversationId) return;
    const botKey = task.botId || "";
    state.activeKey = "";
    state.activeContactKey = botKey;
    state.activeView = "chat";
    state.selectedTaskId = "";
    hidePreviewDialog();
    __global.miaSocial?.setActiveConversationId?.(conversationId);
    if (typeof render === "function") render();
    else { renderView(); if (typeof renderChat === "function") renderChat(); }
  }

  function scheduleText(task) {
    const t = task.trigger || {};
    const pad = (n) => String(n).padStart(2, "0");
    if (t.type === "oneshot") {
      if (!t.at) return "一次性";
      const d = new Date(t.at);
      return Number.isNaN(d.getTime())
        ? "一次性"
        : `一次性 · ${d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
    }
    if (t.type === "cron") {
      const parts = String(t.cron || "").trim().split(/\s+/);
      if (parts.length !== 5) return t.cron || "—";
      const [m, h, dom, , dow] = parts;
      const time = `${pad(h)}:${pad(m)}`;
      const days = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
      if (dom === "*" && dow === "*") return `每天 ${time}`;
      if (dom === "*" && dow !== "*") return `每${days[Number(dow)] || "周" + dow} ${time}`;
      if (dom !== "*" && dow === "*") return `每月 ${dom} 号 ${time}`;
      return t.cron;
    }
    return "—";
  }

  function taskInstructionText(task) {
    if (String(task?.fireMode || "") === "deliver" && task?.deliveryText) {
      return String(task.deliveryText);
    }
    return String(task?.prompt || task?.deliveryText || "");
  }

  // ── Topbar create controls: split button + chevron dropdown ─────────────

  const CHAT_CREATE_PROMPT =
    "我想设置一个定时任务。先简要说明 Mia 的定时任务怎么用，然后问我几个问题，了解我希望你做什么、什么时候运行。";

  let _createControlsBound = false;
  function bindCreateControls() {
    if (_createControlsBound) return;
    _createControlsBound = true;
    const mainBtn = document.getElementById("newTask");
    const chevron = document.getElementById("taskCreateMenuToggle");
    const menu = document.getElementById("taskCreateMenu");
    mainBtn?.addEventListener("click", () => { closeCreateMenu(); createTaskViaChat(); });
    chevron?.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !menu?.classList.contains("hidden");
      open ? closeCreateMenu() : openCreateMenu();
    });
    menu?.querySelectorAll("[data-create-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        closeCreateMenu();
        if (btn.dataset.createMode === "chat") createTaskViaChat();
        else openTaskCreate();
      });
    });
    document.addEventListener("click", (e) => {
      if (menu?.classList.contains("hidden")) return;
      if (menu.contains(e.target) || chevron?.contains(e.target)) return;
      closeCreateMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !menu?.classList.contains("hidden")) closeCreateMenu();
    });
  }

  function openCreateMenu() {
    document.getElementById("taskCreateMenu")?.classList.remove("hidden");
    document.getElementById("taskCreateMenuToggle")?.setAttribute("aria-expanded", "true");
  }
  function closeCreateMenu() {
    document.getElementById("taskCreateMenu")?.classList.add("hidden");
    document.getElementById("taskCreateMenuToggle")?.setAttribute("aria-expanded", "false");
  }

  // Switch to chat view and seed the composer with a task-setup prompt. The
  // composer keeps its text across conversation switches, so this works even
  // if the user hasn't picked a conversation yet — they'll see the prompt
  // waiting once they enter any chat.
  function createTaskViaChat() {
    state.activeView = "chat";
    state.selectedTaskId = "";
    hidePreviewDialog();
    if (typeof render === "function") render();
    else { renderView(); if (typeof renderChat === "function") renderChat(); }
    const chatInput = document.getElementById("chatInput");
    if (chatInput) {
      chatInput.value = CHAT_CREATE_PROMPT;
      window.miaMessageHelpers?.resizeChatInput?.();
      chatInput.focus();
      // Place caret at end so the user can keep typing if they want to refine.
      const end = chatInput.value.length;
      chatInput.setSelectionRange?.(end, end);
    }
  }

  // ── Create dialog (unchanged behaviour) ──────────────────────────────────

  function openTaskCreate() {
    const bots = ownedBots();
    const botId = bots.some((bot) => bot.key === state.activeKey) ? state.activeKey : bots[0]?.key || "";
    window.miaReactDialogs?.publish?.({
      dialog: {
        botId,
        bots: bots.map((bot) => ({ id: bot.key, label: botName(bot.key) })),
        close: closeTaskCreate,
        kind: "task-create",
        submit: submitTaskCreate
      }
    });
  }

  function closeTaskCreate() {
    window.miaReactDialogs?.publish?.({ dialog: { kind: "closed" } });
  }

  async function submitTaskCreate(values = {}) {
    const botId = String(values.botId || "");
    const title = String(values.title || "").trim();
    const prompt = String(values.prompt || "").trim();
    const freq = String(values.frequency || "oneshot");
    if (!botId) return "请先选择执行的 Agent（去通讯录添加一个）。";
    if (!title) return "请填写任务名称。";
    if (!prompt) return "请填写要求说明。";
    const time = String(values.time || "");
    if (!time) return "请选择执行时间。";

    let timezone = "UTC";
    try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { /* keep UTC */ }

    const scheduleIntent = { kind: freq, time, timezone };
    if (freq === "oneshot") {
      const date = String(values.date || "");
      if (!date) return "请选择执行日期。";
      scheduleIntent.date = date;
    } else if (freq === "weekly") {
      scheduleIntent.weekday = Number(values.weekday || 0);
    } else if (freq === "monthly") {
      scheduleIntent.dayOfMonth = Number(values.dayOfMonth || 1);
    }

    let conversationId;
    try {
      conversationId = await resolveConversationForBot(botId);
    } catch (e) {
      return "无法为该 Agent 准备云端对话：" + (e?.message || e);
    }
    if (!conversationId) return "该 Agent 还没有可用云端对话，请先完成登录后重试。";

    try {
      const created = await mia.tasks.create({ title, botId, conversationId, instructions: prompt, scheduleIntent });
      closeTaskCreate();
      state.selectedTaskId = created?.id || "";
      await loadTasksFromDaemon();
      renderTaskView();
      return "";
    } catch (e) {
      return taskCreateErrorMessage(e);
    }
  }

  function taskCreateErrorMessage(error) {
    const message = String(error?.message || error || "创建失败");
    if (/oneshot schedule must be in the future|must be in the future|future/i.test(message)) {
      return "Core 拒绝了执行时间：必须选择未来时间。";
    }
    if (/invalid schedule|invalid cron|invalid timezone/i.test(message)) {
      return "Core 拒绝了执行时间：" + message;
    }
    return "创建失败：" + message;
  }

  async function resolveConversationForBot(botKey) {
    const key = String(botKey || "").trim();
    if (!key) return null;
    const existing = __global.miaSocial?.botConversationForKey?.(key);
    if (existing?.id) return existing.id;
    const bots = ownedBots();
    const bot = bots.find((item) => item?.key === key || item?.id === key) || { key };
    const conversation = await __global.miaSocial?.ensureBotConversation?.(bot);
    return conversation?.id || null;
  }

  // ── Data loading + SSE subscription ──────────────────────────────────────

  async function loadTasksFromDaemon() {
    try {
      state.tasks = await mia.tasks.list();
      const visibleTaskIds = new Set(state.tasks.map((task) => String(task?.id || "")).filter(Boolean));
      for (const taskId of state.tasksUnread.keys()) {
        if (!visibleTaskIds.has(String(taskId))) state.tasksUnread.delete(taskId);
      }
      updateTasksRailBadge();
    } catch (e) {
      console.warn("load tasks failed", e);
    }
  }

  let _tasksUnsubscribe = null;
  async function handleTaskEvent(envelope = {}) {
    await loadTasksFromDaemon();
    const type = String(envelope.type || "").replace(/^task\./, "");
    // Count completions, failures, and offline-missed sweeps as unread —
    // user-facing meaning is "something happened on this task while you
    // weren't looking", regardless of outcome status.
    if (["finished", "failed", "missed"].includes(type)) {
      const taskId = envelope.payload?.taskId || envelope.taskId;
      const visible = taskId && state.tasks.some((task) => String(task?.id || "") === String(taskId));
      if (visible && state.selectedTaskId !== taskId) {
        state.tasksUnread.set(taskId, (state.tasksUnread.get(taskId) || 0) + 1);
      }
    }
    updateTasksRailBadge();
    if (state.activeView === "tasks") renderTaskView();
  }

  function subscribeTaskEvents() {
    if (_tasksUnsubscribe) return;
    _tasksUnsubscribe = window.mia.tasks.subscribe(handleTaskEvent);
  }

  function updateTasksRailBadge() {
    if (!state || !els) return;
    const total = [...state.tasksUnread.values()].reduce((a, b) => a + b, 0);
    for (const badge of [els.tasksUnreadBadge, els.sidebarTasksUnreadBadge]) {
      if (!badge) continue;
      if (total > 0) {
        badge.classList.remove("hidden");
        badge.textContent = unreadShared().unreadBadgeText(total);
        badge.setAttribute?.("aria-hidden", "false");
      } else {
        badge.classList.add("hidden");
        badge.textContent = "";
        badge.setAttribute?.("aria-hidden", "true");
      }
    }
  }

  window.miaTasksPanel = {
    initTasksPanel,
    bindCreateControls,
    openTaskCreate,
    renderTaskView,
    loadTasksFromDaemon,
    subscribeTaskEvents,
    handleTaskEvent,
    updateTasksRailBadge
  };
})();
