// Tasks panel module
// Single full-width card-grid layout (mirrors skill-library): chip row +
// card grid in main content; task detail / run detail open in an overlay
// preview dialog (#taskPreviewDialog).
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
  // value must extend this map so historyRow, run detail header, and card
  // status all stay in sync.
  const RUN_STATUS_ICONS  = { ok: "✓", failed: "✗", missed: "⊘", skipped: "·" };
  const RUN_STATUS_LABELS = { ok: "完成", failed: "失败", missed: "错过", skipped: "跳过" };
  function runStatusIcon(status)  { return RUN_STATUS_ICONS[status]  || "·"; }
  function runStatusLabel(status) { return RUN_STATUS_LABELS[status] || status || "—"; }
  function runStatusSuffix(run) {
    if (run.status === "failed") return " 失败";
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

  function fellowName(botId) {
    const { resolveContact, IdentityKind } = contact();
    const bots = state.runtime?.bots || state.runtime?.personas || [];
    const resolved = resolveContact({ kind: IdentityKind?.Bot || "bot", ref: botId }, { bots });
    return resolved.displayName || botId;
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

  // 历史 view: flatten all runs from all tasks into one timeline.
  // Each run carries a back-pointer to its parent task for display + click-through.
  function allRuns(tasks) {
    const out = [];
    for (const task of tasks) {
      for (const run of (task.runs || [])) {
        out.push({ run, task });
      }
    }
    out.sort((a, b) => (b.run.firedAt || 0) - (a.run.firedAt || 0));
    return out;
  }

  function filterTasks(tasks, needle) {
    const q = (needle || "").trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter((t) => `${t.title} ${t.prompt}`.toLowerCase().includes(q));
  }
  function filterRuns(entries, needle) {
    const q = (needle || "").trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(({ task, run }) =>
      `${task.title} ${task.prompt} ${run.outputText || ""}`.toLowerCase().includes(q));
  }

  // ── Main render: chip row + card grid + preview dialog ────────────────────

  function renderTaskView() {
    if (!els.tasksContent) return;
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
    const historyEntries = allRuns(state.tasks);
    const counts = {
      active: active.length,
      history: historyEntries.length
    };
    const unreadCounts = {
      active: active.reduce((n, task) => n + taskUnreadCount(task), 0),
      history: state.tasks
        .filter((task) => (task.runs || []).length > 0)
        .reduce((n, task) => n + taskUnreadCount(task), 0)
    };
    host.innerHTML = MODES.map((m) => `
      <button type="button" role="tab" class="${m.key === mode ? "active" : ""}" data-mode="${m.key}">
        ${escapeHtml(m.label)}<span class="task-mode-count">${counts[m.key]}</span>${modeUnreadBadgeHtml(unreadCounts[m.key])}
      </button>
    `).join("");
    host.querySelectorAll("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (state.taskMode === btn.dataset.mode) return;
        state.taskMode = btn.dataset.mode;
        renderTaskView();
      });
    });
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

  function renderActiveView() {
    const chipRow = document.getElementById("taskChipRow");
    if (chipRow) { chipRow.innerHTML = ""; chipRow.hidden = true; }
    const tasks = filterTasks(activeTasks(state.tasks), state.taskFilter);
    if (tasks.length === 0) {
      els.tasksContent.innerHTML = renderActiveEmpty();
      els.tasksContent.querySelector("[data-action='new-task']")
        ?.addEventListener("click", openTaskCreate);
      return;
    }
    els.tasksContent.innerHTML = tasks.map(cardHtml).join("");
    els.tasksContent.querySelectorAll("[data-task-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.selectedTaskId = btn.dataset.taskId;
        state.selectedRunId = "";
        state.tasksUnread.delete(state.selectedTaskId);
        updateTasksRailBadge();
        renderTaskView();
      });
    });
  }

  function renderHistoryView() {
    const chipRow = document.getElementById("taskChipRow");
    const filterKey = state.taskHistoryFilter || "all";
    const allEntries = filterRuns(allRuns(state.tasks), state.taskFilter);
    if (chipRow) {
      chipRow.hidden = false;
      const counts = Object.fromEntries(
        HISTORY_FILTERS.map((f) => [f.key, allEntries.filter((e) => f.match(e.run)).length])
      );
      chipRow.innerHTML = HISTORY_FILTERS.map((f) => `
        <button type="button" class="${f.key === filterKey ? "active" : ""}" data-history-filter="${f.key}">
          ${escapeHtml(f.label)}<span>${counts[f.key]}</span>
        </button>
      `).join("");
      chipRow.querySelectorAll("[data-history-filter]").forEach((btn) => {
        btn.addEventListener("click", () => {
          state.taskHistoryFilter = btn.dataset.historyFilter;
          renderTaskView();
        });
      });
    }
    const match = (HISTORY_FILTERS.find((f) => f.key === filterKey) || HISTORY_FILTERS[0]).match;
    const visible = allEntries.filter((e) => match(e.run));
    if (visible.length === 0) {
      els.tasksContent.innerHTML = `<div class="tasks-empty"><p>当前筛选下没有运行记录</p></div>`;
      return;
    }
    els.tasksContent.innerHTML = visible.map(runCardHtml).join("");
    els.tasksContent.querySelectorAll("[data-run-card]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.selectedTaskId = btn.dataset.taskId;
        state.selectedRunId = btn.dataset.runId;
        state.tasksUnread.delete(state.selectedTaskId);
        updateTasksRailBadge();
        renderTaskView();
      });
    });
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
        <div class="task-card-meta">${escapeHtml(fellowName(task.botId))} · ${escapeHtml(scheduleText(task))}</div>
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
    if ((state.tasks || []).length === 0) {
      return `
        <div class="tasks-empty">
          <div class="tasks-empty-emoji">📅</div>
          <h2>还没有定时任务</h2>
          <p>回到任意聊天告诉 Mia：<br><em>"每天 9 点帮我做 X"</em><br>它会自动帮你建好任务。</p>
          <button class="secondary" type="button" data-action="new-task">＋ 手动新建任务</button>
        </div>
      `;
    }
    return `<div class="tasks-empty"><p>没有匹配的活跃任务</p></div>`;
  }

  function runCardHtml({ run, task }) {
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
      <button class="task-card task-run-card" type="button"
              data-run-card data-task-id="${escapeHtml(task.id)}" data-run-id="${escapeHtml(run.id)}">
        <div class="task-card-title">
          <span class="task-run-icon ${run.status}">${icon}</span>
          <strong>${escapeHtml(task.title)}</strong>
        </div>
        <div class="task-card-meta">${escapeHtml(detail)}</div>
        <div class="task-card-foot">
          <em class="task-card-status">${escapeHtml(label)} · ${escapeHtml(formatRunTime(run.firedAt))}</em>
          ${badge}
          <em class="task-card-fellow">${escapeHtml(fellowName(task.botId))}</em>
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
      hidePreviewDialog();
      return;
    }
    showPreviewDialog();
    if (state.selectedRunId) renderRunDetail(task);
    else renderTaskDetail(task);
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
    state.selectedRunId = "";
    hidePreviewDialog();
    renderTaskView();
  }

  function renderTaskDetail(task) {
    const body = document.getElementById("taskPreviewBody");
    if (!body) return;
    setText(document.getElementById("taskPreviewTitle"), task.title);
    setText(document.getElementById("taskPreviewMeta"),
      `${fellowName(task.botId)} · ${scheduleText(task)}`);

    const pauseLabel  = task.status === "paused" ? "启用" : "暂停";
    const pauseAction = task.status === "paused" ? "resume" : "pause";
    const closed = task.status === "done" || task.status === "failed";
    const statusText = ({ active: "进行中", paused: "已暂停", done: "已完成", failed: "已失败" })[task.status] || task.status;
    const nextText = task.status === "active" && task.nextFireAt
      ? `下次 ${formatRunTime(task.nextFireAt)}` : "没有待执行时间";
    const conversationId = taskConversationId(task);
    const runCount = (task.runs || []).length;
    const latestRun = (task.runs || [])[runCount - 1] || null;
    const statusClass = ({ active: "active", paused: "paused", failed: "failed", done: "done" })[task.status] || "done";

    body.innerHTML = `
      <div class="task-detail-shell">
        <aside class="task-detail-sidebar">
          <div class="task-status-panel">
            <span class="task-status-pill ${escapeHtml(statusClass)}">${escapeHtml(statusText)}</span>
            <strong>${escapeHtml(scheduleText(task))}</strong>
            <small>${escapeHtml(nextText)}</small>
          </div>
          <div class="task-side-meta">
            <div><small>执行者</small><span>${escapeHtml(fellowName(task.botId))}</span></div>
            <div><small>历史</small><span>${runCount} 次运行</span></div>
            ${latestRun ? `<div><small>最近一次</small><span>${escapeHtml(formatRunTime(latestRun.firedAt))}</span></div>` : ""}
          </div>
          <div class="task-primary-actions">
            <button class="task-action-primary" type="button" data-action="run-now">运行一次</button>
            ${closed ? "" : `<button class="secondary" type="button" data-action="${pauseAction}">${pauseLabel}</button>`}
            <button class="secondary" type="button" data-jump-conversation="${escapeHtml(conversationId)}">打开对话</button>
          </div>
          <button class="task-delete-action" type="button" data-action="delete">删除任务</button>
        </aside>

        <main class="task-detail-main">
          <section class="task-section task-section-prompt">
            <div class="task-section-head">
              <h3>要求说明</h3>
            </div>
            <p>${escapeHtml(task.prompt)}</p>
          </section>

          <section class="task-section">
            <div class="task-section-head">
              <h3>历史记录</h3>
              <span>${runCount}</span>
            </div>
            <div class="task-history-list">
              ${(task.runs || []).slice(-50).reverse().map(historyRowHtml).join("")}
              ${runCount === 0 ? `<div class="task-history-empty">还没有运行过</div>` : ""}
            </div>
          </section>
        </main>
      </div>
    `;
    attachTaskDetailHandlers(task);
  }

  function historyRowHtml(run) {
    return `
      <button class="task-history-row" type="button" data-run-id="${escapeHtml(run.id)}">
        <span>${runStatusIcon(run.status)}</span>
        <span>${escapeHtml(formatRunTime(run.firedAt))}</span>
        <span>${escapeHtml(runStatusLabel(run.status))}${escapeHtml(runStatusSuffix(run))}</span>
        <em>→ 查看输出</em>
      </button>
    `;
  }

  function renderRunDetail(task) {
    const body = document.getElementById("taskPreviewBody");
    if (!body) return;
    const run = (task.runs || []).find((r) => r.id === state.selectedRunId);
    if (!run) { state.selectedRunId = ""; renderTaskDetail(task); return; }

    setText(document.getElementById("taskPreviewTitle"),
      `${task.title} · ${formatRunTime(run.firedAt)} ${runStatusLabel(run.status)}`);
    setText(document.getElementById("taskPreviewMeta"),
      `${fellowName(task.botId)} · ${scheduleText(task)}`);

    const outputText = run.outputText || "";
    const missedSummary = run.status === "missed"
      ? `<div class="run-detail-empty">daemon 离线期间错过 ${run.missedCount} 次触发（${escapeHtml(formatRunTime(run.firstMissedAt))} ~ ${escapeHtml(formatRunTime(run.lastMissedAt))}），未补跑。</div>`
      : null;
    const outputHtml = missedSummary
      || (outputText
        ? `<div class="run-output-text">${window.miaMarkdown.renderMarkdown(outputText)}</div>`
        : `<div class="run-detail-empty">${run.error ? `运行失败：${escapeHtml(run.error)}` : "本次没有产生输出。"}</div>`);

    body.innerHTML = `
      <div class="task-detail-shell">
        <aside class="task-detail-sidebar">
          <div class="task-status-panel">
            <span class="task-status-pill ${escapeHtml(run.status || "done")}">${escapeHtml(runStatusLabel(run.status))}</span>
            <strong>${escapeHtml(formatRunTime(run.firedAt))}</strong>
            <small>${escapeHtml(runStatusSuffix(run).trim() || "运行记录")}</small>
          </div>
          <div class="task-side-meta">
            <div><small>任务</small><span>${escapeHtml(task.title)}</span></div>
            <div><small>执行者</small><span>${escapeHtml(fellowName(task.botId))}</span></div>
            <div><small>执行时间</small><span>${escapeHtml(scheduleText(task))}</span></div>
          </div>
          <div class="task-primary-actions">
            <button class="secondary" type="button" data-action="back-to-task">返回任务</button>
            <button class="secondary" type="button" data-action="open-conversation">打开对话</button>
            <button class="task-action-primary" type="button" data-action="run-now">运行一次</button>
          </div>
        </aside>

        <main class="task-detail-main">
          <section class="task-section run-detail-output">
            <div class="task-section-head">
              <h3>AI 输出</h3>
              <span>${escapeHtml(runStatusLabel(run.status))}</span>
            </div>
            <div class="run-output-shell">${outputHtml}</div>
          </section>
          <section class="task-section run-detail-prompt">
            <details>
              <summary>原始指令</summary>
              <pre>${escapeHtml(task.prompt)}</pre>
            </details>
          </section>
        </main>
      </div>
    `;

    body.querySelector("[data-action='back-to-task']")?.addEventListener("click", () => {
      state.selectedRunId = "";
      renderTaskView();
    });
    body.querySelector("[data-action='open-conversation']")?.addEventListener("click", () => {
      jumpToTaskConversation(task);
    });
    body.querySelector("[data-action='run-now']")?.addEventListener("click", async () => {
      try { await window.mia.tasks.runNow(task.id); } catch (e) { console.warn("run-now failed", e); }
      await loadTasksFromDaemon();
      renderTaskView();
    });
  }

  function attachTaskDetailHandlers(task) {
    const body = document.getElementById("taskPreviewBody");
    if (!body) return;
    body.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = btn.dataset.action;
        try {
          if (action === "run-now") await window.mia.tasks.runNow(task.id);
          if (action === "pause")   await window.mia.tasks.pause(task.id);
          if (action === "resume")  await window.mia.tasks.resume(task.id);
          if (action === "delete") {
            if (!confirm(`删除任务「${task.title}」？已发生的历史记录会保留在对话里。`)) return;
            await window.mia.tasks.delete(task.id);
            state.selectedTaskId = "";
            state.selectedRunId = "";
          }
        } catch (e) { console.warn("[task action]", action, e); }
        await loadTasksFromDaemon();
        renderTaskView();
      });
    });
    body.querySelectorAll("[data-run-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.selectedRunId = btn.dataset.runId;
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
    const fellowKey = task.botId || "";
    state.activeKey = "";
    state.activeContactKey = fellowKey;
    state.activeView = "chat";
    state.selectedTaskId = "";
    state.selectedRunId = "";
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
    state.selectedRunId = "";
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
    const bots = state.runtime?.bots || state.runtime?.personas || [];
    const fellowSel = document.getElementById("ntFellow");
    if (fellowSel) {
      if (bots.length === 0) {
        fellowSel.innerHTML = `<option value="">（请先在通讯录添加一个 Agent）</option>`;
      } else {
        const def = bots.some((f) => f.key === state.activeKey) ? state.activeKey : bots[0].key;
        fellowSel.innerHTML = bots
          .map((f) => `<option value="${escapeHtml(f.key)}"${f.key === def ? " selected" : ""}>${escapeHtml(fellowName(f.key))}</option>`)
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
    const botId = document.getElementById("ntFellow")?.value || "";
    const title = (document.getElementById("ntName")?.value || "").trim();
    const prompt = (document.getElementById("ntPrompt")?.value || "").trim();
    const freq = document.getElementById("ntFreq")?.value || "oneshot";

    if (!botId) return showError("请先选择执行的 Agent（去通讯录添加一个）。");
    if (!title) return showError("请填写任务名称。");
    if (!prompt) return showError("请填写要求说明。");

    const time = document.getElementById("ntTime")?.value || "";
    if (!time) return showError("请选择执行时间。");
    const [hh, mm] = time.split(":");
    const h = Number(hh); const m = Number(mm);

    let trigger;
    if (freq === "oneshot") {
      const date = document.getElementById("ntDate")?.value || "";
      if (!date) return showError("请选择执行日期。");
      const at = new Date(`${date}T${time}`);
      if (Number.isNaN(at.getTime())) return showError("执行时间无效。");
      if (at.getTime() <= Date.now()) return showError("执行时间必须在未来。");
      trigger = { type: "oneshot", at: at.toISOString() };
    } else if (freq === "daily") {
      trigger = { type: "cron", cron: `${m} ${h} * * *` };
    } else if (freq === "weekly") {
      const w = document.getElementById("ntWeekday")?.value || "0";
      trigger = { type: "cron", cron: `${m} ${h} * * ${w}` };
    } else {
      const d = document.getElementById("ntDay")?.value || "1";
      trigger = { type: "cron", cron: `${m} ${h} ${d} * *` };
    }

    let timezone = "UTC";
    try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { /* keep UTC */ }

    let conversationId;
    try {
      conversationId = await resolveConversationForFellow(botId);
    } catch (e) {
      return showError("无法为该 Agent 准备云端对话：" + (e?.message || e));
    }
    if (!conversationId) return showError("该 Agent 还没有可用云端对话，请先完成登录后重试。");

    try {
      const created = await window.mia.tasks.create({ title, botId, conversationId, prompt, trigger, timezone });
      closeTaskCreate();
      state.selectedTaskId = created?.id || "";
      state.selectedRunId = "";
      await loadTasksFromDaemon();
      renderTaskView();
    } catch (e) {
      showError("创建失败：" + (e?.message || e));
    }
  }

  async function resolveConversationForFellow(fellowKey) {
    const key = String(fellowKey || "").trim();
    if (!key) return null;
    const existing = __global.miaSocial?.fellowConversationForKey?.(key);
    if (existing?.id) return existing.id;
    const bots = state.runtime?.bots || state.runtime?.personas || [];
    const fellow = bots.find((item) => item?.key === key || item?.id === key) || { key };
    const conversation = await __global.miaSocial?.ensureFellowConversation?.(fellow);
    return conversation?.id || null;
  }

  // ── Data loading + SSE subscription ──────────────────────────────────────

  async function loadTasksFromDaemon() {
    try {
      state.tasks = await window.mia.tasks.list();
    } catch (e) {
      console.warn("load tasks failed", e);
      state.tasks = [];
    }
  }

  let _tasksUnsubscribe = null;
  function subscribeTaskEvents() {
    if (_tasksUnsubscribe) return;
    _tasksUnsubscribe = window.mia.tasks.subscribe(async (envelope) => {
      await loadTasksFromDaemon();
      // Count completions, failures, and offline-missed sweeps as unread —
      // user-facing meaning is "something happened on this task while you
      // weren't looking", regardless of outcome status.
      if (["finished", "failed", "missed"].includes(envelope.type)) {
        const taskId = envelope.payload?.taskId;
        if (taskId && state.selectedTaskId !== taskId) {
          state.tasksUnread.set(taskId, (state.tasksUnread.get(taskId) || 0) + 1);
        }
      }
      updateTasksRailBadge();
      if (state.activeView === "tasks") renderTaskView();
    });
  }

  function updateTasksRailBadge() {
    if (!els.tasksUnreadBadge) return;
    const total = [...state.tasksUnread.values()].reduce((a, b) => a + b, 0);
    if (total > 0) {
      els.tasksUnreadBadge.classList.remove("hidden");
      const badge = unreadShared().unreadBadgeHtml(total);
      const m = badge.match(/>([^<]*)</);
      els.tasksUnreadBadge.textContent = m ? m[1] : String(total);
    } else {
      els.tasksUnreadBadge.classList.add("hidden");
    }
  }

  window.miaTasksPanel = {
    initTasksPanel,
    bindCreateControls,
    openTaskCreate,
    renderTaskView,
    loadTasksFromDaemon,
    subscribeTaskEvents,
    updateTasksRailBadge
  };
})();
