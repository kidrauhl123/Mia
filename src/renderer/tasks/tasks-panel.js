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
  let modeToggleIndicatorHost = null;
  let modeToggleIndicatorResizeBound = false;
  let pageTurnDirection = 0;

  function syncModeToggleIndicator(host) {
    modeToggleIndicatorHost = host || modeToggleIndicatorHost;
    if (!modeToggleIndicatorHost) return;

    const update = () => {
      const active = modeToggleIndicatorHost.querySelector("button.active");
      if (!active || typeof active.getBoundingClientRect !== "function") return;
      const hostRect = modeToggleIndicatorHost.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      modeToggleIndicatorHost.style.setProperty("--pill-x", `${activeRect.left - hostRect.left}px`);
      modeToggleIndicatorHost.style.setProperty("--pill-w", `${activeRect.width}px`);
      modeToggleIndicatorHost.style.setProperty("--pill-ready", "1");
    };

    if (typeof requestAnimationFrame === "function") requestAnimationFrame(update);
    else update();

    if (!modeToggleIndicatorResizeBound && typeof window !== "undefined") {
      modeToggleIndicatorResizeBound = true;
      window.addEventListener("resize", () => syncModeToggleIndicator(modeToggleIndicatorHost));
    }
  }

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

  function taskExecutorAvatarHtml(task) {
    const resolved = botContact(task?.botId || "");
    const avatar = resolved.avatar || {};
    const label = resolved.displayName || task?.botId || "";
    return __global.miaAvatar.avatarHtml({
      className: "avatar task-output-avatar",
      image: avatar.image || "",
      crop: avatar.crop || null,
      color: avatar.color || "#5e5ce6",
      text: avatar.image ? "" : avatar.text || label,
      attrs: `role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"`
    });
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
    const renderKey = JSON.stringify({
      kind: "task-mode-toggle",
      mode,
      counts,
      unreadCounts
    });
    const html = MODES.map((m) => `
      <button type="button" role="tab" class="${m.key === mode ? "active" : ""}" data-mode="${m.key}">
        ${escapeHtml(m.label)}<span class="task-mode-count">${counts[m.key]}</span>${modeUnreadBadgeHtml(unreadCounts[m.key])}
      </button>
    `).join("");
    if (host.__miaRenderKey !== renderKey) {
      host.innerHTML = html;
      host.__miaRenderKey = renderKey;
      host.querySelectorAll("[data-mode]").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (state.taskMode === btn.dataset.mode) return;
          const fromIndex = Math.max(0, MODES.findIndex((item) => item.key === state.taskMode));
          const toIndex = Math.max(0, MODES.findIndex((item) => item.key === btn.dataset.mode));
          pageTurnDirection = toIndex >= fromIndex ? 1 : -1;
          window.miaMasonryGrid?.capture(els.tasksContent, pageTurnDirection);
          state.taskMode = btn.dataset.mode;
          renderTaskView();
        });
      });
    }
    syncModeToggleIndicator(host);
  }

  function taskUnreadCount(task) {
    return state.tasksUnread?.get?.(task?.id) || 0;
  }

  function modeUnreadBadgeHtml(unread) {
    const badge = unreadShared().unreadBadgeHtml(unread);
    return badge ? badge.replace('class="unread-badge"', 'class="task-mode-unread"') : "";
  }

  function cardUnreadBadgeHtml(task) {
    const badge = unreadShared().unreadBadgeHtml(taskUnreadCount(task));
    return badge ? badge.replace('class="unread-badge"', 'class="task-card-unread"') : "";
  }

  function setTasksContentHtml(kind, html, bind) {
    const renderKey = `${kind}:${html}`;
    if (els.tasksContent.__miaRenderKey === renderKey) {
      try { window.miaLottieIcons?.init?.(els.tasksContent); } catch { /* decorative task animation is optional */ }
      return false;
    }
    els.tasksContent.innerHTML = html;
    els.tasksContent.__miaRenderKey = renderKey;
    if (typeof bind === "function") bind();
    try { window.miaLottieIcons?.init?.(els.tasksContent); } catch { /* decorative task animation is optional */ }
    return true;
  }

  function renderActiveView() {
    const chipRow = document.getElementById("taskChipRow");
    if (chipRow) {
      if (chipRow.__miaRenderKey !== "task-chip-row:hidden") {
        chipRow.innerHTML = "";
        chipRow.__miaRenderKey = "task-chip-row:hidden";
      }
      chipRow.hidden = true;
    }
    const tasks = filterTasks(activeTasks(state.tasks), state.taskFilter);
    if (tasks.length === 0) {
      setTasksContentHtml("task-active-empty", renderActiveEmpty(), () => {
        els.tasksContent.querySelector("[data-action='new-task']")
          ?.addEventListener("click", openTaskCreate);
      });
      layoutTaskCards();
      return;
    }
    const html = tasks.map(cardHtml).join("");
    setTasksContentHtml("task-active-cards", html, () => {
      els.tasksContent.querySelectorAll("[data-task-id]").forEach((btn) => {
        btn.addEventListener("click", () => {
          state.selectedTaskId = btn.dataset.taskId;
          state.tasksUnread.delete(state.selectedTaskId);
          updateTasksRailBadge();
          renderTaskView();
        });
      });
    });
    layoutTaskCards();
  }

  function layoutTaskCards() {
    const direction = pageTurnDirection;
    pageTurnDirection = 0;
    window.miaMasonryGrid?.layout(els.tasksContent, ".task-card", { animate: direction });
  }

  function renderHistoryView() {
    const chipRow = document.getElementById("taskChipRow");
    const filterKey = state.taskHistoryFilter || "all";
    const allHistoryTasks = filterHistoryTasks(historyTasks(state.tasks), state.taskFilter);
    if (chipRow) {
      chipRow.hidden = false;
      const counts = Object.fromEntries(
        HISTORY_FILTERS.map((f) => [f.key, allHistoryTasks.filter((task) => f.match(latestRun(task))).length])
      );
      const renderKey = JSON.stringify({
        kind: "task-history-chips",
        filterKey,
        counts
      });
      const html = HISTORY_FILTERS.map((f) => `
        <button type="button" class="${f.key === filterKey ? "active" : ""}" data-history-filter="${f.key}">
          ${escapeHtml(f.label)}<span>${counts[f.key]}</span>
        </button>
      `).join("");
      if (chipRow.__miaRenderKey !== renderKey) {
        chipRow.innerHTML = html;
        chipRow.__miaRenderKey = renderKey;
        chipRow.querySelectorAll("[data-history-filter]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const next = btn.dataset.historyFilter || "all";
            if ((state.taskHistoryFilter || "all") === next) return;
            const fromIndex = Math.max(0, HISTORY_FILTERS.findIndex((item) => item.key === (state.taskHistoryFilter || "all")));
            const toIndex = Math.max(0, HISTORY_FILTERS.findIndex((item) => item.key === next));
            pageTurnDirection = toIndex >= fromIndex ? 1 : -1;
            window.miaMasonryGrid?.capture(els.tasksContent, pageTurnDirection);
            state.taskHistoryFilter = next;
            renderTaskView();
          });
        });
      }
    }
    const match = (HISTORY_FILTERS.find((f) => f.key === filterKey) || HISTORY_FILTERS[0]).match;
    const visible = allHistoryTasks.filter((task) => match(latestRun(task)));
    if (visible.length === 0) {
      setTasksContentHtml("task-history-empty", `<div class="tasks-empty"><p>当前筛选下没有任务记录</p></div>`);
      layoutTaskCards();
      return;
    }
    const html = visible.map(historyCardHtml).join("");
    setTasksContentHtml("task-history-cards", html, () => {
      els.tasksContent.querySelectorAll("[data-task-id]").forEach((btn) => {
        btn.addEventListener("click", () => {
          state.selectedTaskId = btn.dataset.taskId;
          state.tasksUnread.delete(state.selectedTaskId);
          updateTasksRailBadge();
          renderTaskView();
        });
      });
    });
    layoutTaskCards();
  }

  function cardHtml(task) {
    const badge = cardUnreadBadgeHtml(task);
    const dotClass = dotClassFor(task);
    const lastRun = (task.runs || [])[(task.runs || []).length - 1];
    const statusText = cardStatusText(task, lastRun);
    return `
      <button class="task-card" type="button" data-task-id="${escapeHtml(task.id)}">
        <div class="task-card-title">
          <span class="task-card-dot ${dotClass}"></span>
          <strong>${escapeHtml(task.title)}</strong>
        </div>
        <div class="task-card-meta">${escapeHtml(botName(task.botId))} · ${escapeHtml(scheduleText(task))}</div>
        <div class="task-card-foot">
          <em class="task-card-status">${escapeHtml(statusText)}</em>
          ${badge}
        </div>
      </button>
    `;
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

  function renderActiveEmpty() {
    return `
      <div class="tasks-empty tasks-empty-active">
        <div class="tasks-empty-lottie"
             data-lottie="task-schedule"
             data-lottie-path="./assets/lottie/task-schedule.tgs"
             data-lottie-format="tgs"
             data-lottie-trigger="loop"
             aria-hidden="true"></div>
        <h2>还没有活跃任务</h2>
        <p>需要 Mia 定时处理的事，可以从聊天开始，也可以手动新建。</p>
        <button class="secondary" type="button" data-action="new-task">＋ 手动新建任务</button>
      </div>
    `;
  }

  function historyCardHtml(task) {
    const run = latestRun(task);
    const runCount = (task.runs || []).length;
    const icon = runStatusIcon(run.status);
    const label = runStatusLabel(run.status);
    const badge = cardUnreadBadgeHtml(task);
    const detail = run.status === "missed"
      ? `离线期间错过 ${run.missedCount || 1} 次触发`
      : (run.outputText || run.error || "本次没有产生输出")
          .toString()
          .replace(/\s+/g, " ")
          .trim();
    return `
      <button class="task-card task-history-card" type="button" data-task-id="${escapeHtml(task.id)}">
        <div class="task-card-title">
          <span class="task-history-icon ${run.status}">${icon}</span>
          <strong>${escapeHtml(task.title)}</strong>
        </div>
        <div class="task-card-meta">${escapeHtml(detail)}</div>
        <div class="task-card-foot">
          <em class="task-card-status">${escapeHtml(label)} · ${escapeHtml(formatRunTime(run.firedAt))} · 执行 ${runCount} 次</em>
          ${badge}
          <em class="task-card-bot">${escapeHtml(botName(task.botId))}</em>
        </div>
      </button>
    `;
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
      const actions = document.getElementById("taskPreviewActions");
      if (actions) actions.innerHTML = "";
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
    const actions = document.getElementById("taskPreviewActions");
    if (actions) actions.innerHTML = "";
    hidePreviewDialog();
    renderTaskView();
  }

  function renderTaskDetail(task) {
    const body = document.getElementById("taskPreviewBody");
    const actions = document.getElementById("taskPreviewActions");
    if (!body) return;

    const runs = Array.isArray(task.runs)
      ? task.runs.slice().sort((a, b) => (a.firedAt || 0) - (b.firedAt || 0))
      : [];
    const conversationId = taskConversationId(task);

    setText(document.getElementById("taskPreviewTitle"), task.title);

    if (actions) {
      const pauseAction = task.status === "paused" ? "resume" : "pause";
      const pauseLabel = task.status === "paused" ? "恢复任务" : "暂停任务";
      const closed = task.status === "done" || task.status === "failed";
      actions.innerHTML = `
        <details class="task-more-menu">
          <summary class="icon-button" aria-label="更多操作" title="更多操作">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="5" cy="12" r="1.5" fill="currentColor"></circle>
              <circle cx="12" cy="12" r="1.5" fill="currentColor"></circle>
              <circle cx="19" cy="12" r="1.5" fill="currentColor"></circle>
            </svg>
          </summary>
          <div class="task-more-popover">
            ${closed ? "" : `<button type="button" data-action="${pauseAction}">${pauseLabel}</button>`}
            <button class="danger" type="button" data-action="delete">删除任务</button>
          </div>
        </details>
      `;
    }

    body.innerHTML = `
      <div class="task-detail-card">
        ${runs.length
          ? runs.map((run) => taskOutputHtml(task, run, conversationId)).join("")
          : taskOutputHtml(task, null, conversationId)}
      </div>
    `;
    __global.miaAvatar.hydrateAvatarMedia?.(body);
    attachTaskDetailHandlers(task);
  }

  function taskOutputHtml(task, run, conversationId) {
    if (!run) {
      return `
        <section class="task-output-pending">
          等待首次执行
        </section>
      `;
    }

    const outputText = String(run.outputText || "").trim();
    let output;
    if (run.status === "missed") {
      const range = run.firstMissedAt && run.lastMissedAt
        ? `（${formatRunTime(run.firstMissedAt)} – ${formatRunTime(run.lastMissedAt)}）`
        : "";
      output = `<div class="task-output-state missed">设备离线期间错过 ${escapeHtml(run.missedCount || 1)} 次触发${escapeHtml(range)}，未补跑。</div>`;
    } else if (!outputText) {
      const message = run.error ? `运行失败：${run.error}` : "本次没有产生输出。";
      output = `<div class="task-output-state ${run.error ? "failed" : "empty"}">${escapeHtml(message)}</div>`;
    } else {
      output = `<div class="bubble task-output-bubble">${window.miaMarkdown.renderMarkdown(outputText)}</div>`;
    }

    const jumpButton = conversationId
      ? `<button class="task-open-chat icon-button" type="button" data-jump-conversation="${escapeHtml(conversationId)}" aria-label="打开对话" title="打开对话">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M20 15a3 3 0 0 1-3 3H9l-5 3V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v8Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
            <path d="m13.5 9 2.5 2.5-2.5 2.5M16 11.5h-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
          </svg>
        </button>`
      : "";

    return `
      <section class="task-output-section">
        <div class="task-output-meta">
          <span>${escapeHtml(formatRunTime(run.firedAt))}</span>
          <span>${escapeHtml(runStatusLabel(run.status))}${escapeHtml(runStatusSuffix(run))}</span>
        </div>
        <div class="task-output-row message assistant">
          ${taskExecutorAvatarHtml(task)}
          ${output}
          ${jumpButton}
        </div>
      </section>
    `;
  }

  function attachTaskDetailHandlers(task) {
    const body = document.getElementById("taskPreviewBody");
    const actions = document.getElementById("taskPreviewActions");
    if (!body) return;
    for (const root of [body, actions].filter(Boolean)) root.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = btn.dataset.action;
        try {
          if (action === "pause")   await mia.tasks.pause(task.id, task.taskSource);
          if (action === "resume")  await mia.tasks.resume(task.id, task.taskSource);
          if (action === "delete") {
            if (!confirm(`删除任务「${task.title}」？已经发送的回复仍会保留在对话里。`)) return;
            await mia.tasks.delete(task.id, task.taskSource);
            state.selectedTaskId = "";
          }
        } catch (e) { console.warn("[task action]", action, e); }
        await loadTasksFromDaemon();
        renderTaskView();
      });
    });
    body.querySelectorAll("[data-jump-conversation]").forEach((btn) => {
      btn.addEventListener("click", () => { jumpToTaskConversation(task); });
    });
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

  let _taskCreateBound = false;

  function openTaskCreate() {
    const dialog = document.getElementById("taskCreateDialog");
    if (!dialog) return;
    const bots = ownedBots();
    const botSel = document.getElementById("ntBot");
    if (botSel) {
      if (bots.length === 0) {
        botSel.innerHTML = `<option value="">（请先在通讯录添加一个 Agent）</option>`;
      } else {
        const def = bots.some((f) => f.key === state.activeKey) ? state.activeKey : bots[0].key;
        botSel.innerHTML = bots
          .map((f) => `<option value="${escapeHtml(f.key)}"${f.key === def ? " selected" : ""}>${escapeHtml(botName(f.key))}</option>`)
          .join("");
      }
    }
    setFieldValue("ntName", "");
    setFieldValue("ntPrompt", "");
    updateCount("ntName", "ntNameCount", 50);
    updateCount("ntPrompt", "ntPromptCount", 8000);
    const freq = document.getElementById("ntFreq");
    if (freq) freq.value = "oneshot";
    renderTimeControls("oneshot");
    hideTaskError();
    bindTaskCreateHandlers();
    dialog.classList.remove("hidden");
    document.getElementById("ntName")?.focus();
  }

  function closeTaskCreate() {
    document.getElementById("taskCreateDialog")?.classList.add("hidden");
  }

  function setFieldValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value;
  }

  function updateCount(inputId, countId, max) {
    const input = document.getElementById(inputId);
    const out = document.getElementById(countId);
    if (input && out) out.textContent = `${input.value.length}/${max}`;
  }

  function hideTaskError() {
    const el = document.getElementById("ntError");
    if (el) { el.hidden = true; el.textContent = ""; }
  }

  function renderTimeControls(freq) {
    const host = document.getElementById("ntTimeControls");
    if (!host) return;
    const pad = (n) => String(n).padStart(2, "0");
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const timeInput = `<input type="time" id="ntTime" value="09:00">`;
    if (freq === "daily") {
      host.innerHTML = timeInput;
    } else if (freq === "weekly") {
      const days = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
      host.innerHTML = `<select id="ntWeekday">${days.map((d, i) => `<option value="${i}">${d}</option>`).join("")}</select>${timeInput}`;
    } else if (freq === "monthly") {
      let opts = "";
      for (let i = 1; i <= 28; i += 1) opts += `<option value="${i}">${i} 号</option>`;
      host.innerHTML = `<select id="ntDay">${opts}</select>${timeInput}`;
    } else {
      host.innerHTML = `<input type="date" id="ntDate" value="${todayStr}">${timeInput}`;
    }
  }

  function bindTaskCreateHandlers() {
    if (_taskCreateBound) return;
    _taskCreateBound = true;
    const dialog = document.getElementById("taskCreateDialog");
    document.getElementById("closeTaskCreate")?.addEventListener("click", closeTaskCreate);
    document.getElementById("cancelTaskCreate")?.addEventListener("click", closeTaskCreate);
    dialog?.addEventListener("click", (e) => { if (e.target === dialog) closeTaskCreate(); });
    document.getElementById("taskCreateForm")?.addEventListener("submit", (e) => {
      e.preventDefault(); submitTaskCreate();
    });
    document.getElementById("ntName")?.addEventListener("input", () => updateCount("ntName", "ntNameCount", 50));
    document.getElementById("ntPrompt")?.addEventListener("input", () => updateCount("ntPrompt", "ntPromptCount", 8000));
    document.getElementById("ntFreq")?.addEventListener("change", (e) => renderTimeControls(e.target.value));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !dialog?.classList.contains("hidden")) closeTaskCreate();
    });
  }

  async function submitTaskCreate() {
    const showError = (msg) => {
      const el = document.getElementById("ntError");
      if (el) { el.textContent = msg; el.hidden = false; }
    };
    const botId = document.getElementById("ntBot")?.value || "";
    const title = (document.getElementById("ntName")?.value || "").trim();
    const prompt = (document.getElementById("ntPrompt")?.value || "").trim();
    const freq = document.getElementById("ntFreq")?.value || "oneshot";

    if (!botId) return showError("请先选择执行的 Agent（去通讯录添加一个）。");
    if (!title) return showError("请填写任务名称。");
    if (!prompt) return showError("请填写要求说明。");

    const time = document.getElementById("ntTime")?.value || "";
    if (!time) return showError("请选择执行时间。");

    let timezone = "UTC";
    try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { /* keep UTC */ }

    const scheduleIntent = { kind: freq, time, timezone };
    if (freq === "oneshot") {
      const date = document.getElementById("ntDate")?.value || "";
      if (!date) return showError("请选择执行日期。");
      scheduleIntent.date = date;
    } else if (freq === "weekly") {
      scheduleIntent.weekday = Number(document.getElementById("ntWeekday")?.value || "0");
    } else if (freq === "monthly") {
      scheduleIntent.dayOfMonth = Number(document.getElementById("ntDay")?.value || "1");
    }

    let conversationId;
    try {
      conversationId = await resolveConversationForBot(botId);
    } catch (e) {
      return showError("无法为该 Agent 准备云端对话：" + (e?.message || e));
    }
    if (!conversationId) return showError("该 Agent 还没有可用云端对话，请先完成登录后重试。");

    try {
      const created = await mia.tasks.create({ title, botId, conversationId, instructions: prompt, scheduleIntent });
      closeTaskCreate();
      state.selectedTaskId = created?.id || "";
      await loadTasksFromDaemon();
      renderTaskView();
    } catch (e) {
      showError(taskCreateErrorMessage(e));
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
