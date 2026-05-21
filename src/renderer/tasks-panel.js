// Tasks panel module
// Extracted from app.js (formerly lines 3973-4373). Mirrors the group.js
// extraction pattern: IIFE + window.aimashiTasksPanel namespace + initTasksPanel
// for dependency injection. Behavior is identical to the previous inline code.
(function () {
  "use strict";

  // Injected at init time. All functions below use these bare identifiers as
  // they did when inline in app.js — keeping diffs minimal.
  let state, els, aimashi;
  let escapeHtml, setText, formatRunTime, renderMessageHtml;
  let render, renderView, renderChat;

  function initTasksPanel(deps) {
    state = deps.state;
    els = deps.els;
    aimashi = deps.aimashi || (typeof window !== "undefined" ? window.aimashi : null);
    escapeHtml = deps.escapeHtml;
    setText = deps.setText;
    formatRunTime = deps.formatRunTime;
    renderMessageHtml = deps.renderMessageHtml;
    render = deps.render;
    renderView = deps.renderView;
    renderChat = deps.renderChat;
  }

  function fellowName(fellowId) {
    const fellows = state.runtime?.fellows || state.runtime?.personas || [];
    const f = fellows.find((x) => x.key === fellowId || x.id === fellowId);
    return f?.name || fellowId;
  }

  function formatNextTime(ms) {
    if (ms == null) return "—";
    const d = new Date(ms);
    return d.toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }

  function computeNextFireForUi(task) {
    return task.nextFireAt != null ? task.nextFireAt : null;
  }

  function isTodayMs(ms, now) {
    if (ms == null) return false;
    const a = new Date(ms);
    const b = new Date(now);
    return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
  }

  function groupTasksForSidebar(tasks, now = Date.now()) {
    const SEVEN_DAYS = 7 * 24 * 3600 * 1000;
    const today = [];
    const upcoming = [];
    const disabled = [];
    const history = [];

    for (const task of tasks) {
      if (task.status !== "active") {
        disabled.push(task);
        continue;
      }
      const next = computeNextFireForUi(task);
      if (next == null) {
        disabled.push(task);
        continue;
      }
      if (isTodayMs(next, now)) today.push({ task, nextFire: next });
      else if (next - now <= SEVEN_DAYS) upcoming.push({ task, nextFire: next });
      else upcoming.push({ task, nextFire: next });
    }
    today.sort((a, b) => a.nextFire - b.nextFire);
    upcoming.sort((a, b) => a.nextFire - b.nextFire);

    for (const task of tasks) {
      for (const run of (task.runs || []).slice(-50)) {
        history.push({ task, run });
      }
    }
    history.sort((a, b) => b.run.firedAt - a.run.firedAt);

    return { today, upcoming, history, disabled };
  }

  function renderTaskSidebar() {
    if (!els.tasksNav) return;
    const filter = state.taskFilter.trim().toLowerCase();
    const filtered = state.tasks.filter((t) =>
      !filter || `${t.title} ${t.prompt}`.toLowerCase().includes(filter)
    );
    const groups = groupTasksForSidebar(filtered);

    function row(task, label, dotClass, taskId) {
      const unread = state.tasksUnread.get(taskId) || 0;
      return `
        <button class="task-row${state.selectedTaskId === taskId && !state.selectedRunId ? " active" : ""}"
                type="button" data-task-id="${escapeHtml(taskId)}">
          <span class="task-dot ${dotClass}"></span>
          <span class="task-row-body">
            <strong>${escapeHtml(task.title)}</strong>
            <small>${escapeHtml(label)} · ${escapeHtml(fellowName(task.fellowId))}</small>
          </span>
          ${unread ? `<em class="task-unread">${unread}</em>` : ""}
        </button>
      `;
    }

    function historyRow(task, run) {
      const icon = run.status === "ok" ? "✓" : run.status === "failed" ? "✗" : "·";
      const selected = state.selectedRunId === run.id ? " active" : "";
      return `
        <button class="task-row history${selected}" type="button"
                data-task-id="${escapeHtml(task.id)}" data-run-id="${escapeHtml(run.id)}">
          <span class="task-status">${icon}</span>
          <span class="task-row-body">
            <strong>${escapeHtml(task.title)}</strong>
            <small>${escapeHtml(formatRunTime(run.firedAt))}${run.status === "failed" ? " 失败" : ""}</small>
          </span>
        </button>
      `;
    }

    let html = "";
    if (groups.today.length) {
      html += `<div class="task-group-head">今天 (${groups.today.length})</div>`;
      html += groups.today.map((g) => row(g.task, formatNextTime(g.nextFire), "active", g.task.id)).join("");
    }
    if (groups.upcoming.length) {
      html += `<div class="task-group-head">即将 (${groups.upcoming.length})</div>`;
      html += groups.upcoming.map((g) => row(g.task, formatNextTime(g.nextFire), "upcoming", g.task.id)).join("");
    }
    if (groups.history.length) {
      const open = state.historyExpanded;
      html += `<div class="task-group-head collapsible" data-toggle="history">历史 (${groups.history.length}) ${open ? "⌃" : "⌄"}</div>`;
      if (open) html += groups.history.slice(0, 50).map((g) => historyRow(g.task, g.run)).join("");
    }
    if (groups.disabled.length) {
      const open = state.disabledExpanded;
      html += `<div class="task-group-head collapsible" data-toggle="disabled">已停用 (${groups.disabled.length}) ${open ? "⌃" : "⌄"}</div>`;
      if (open) html += groups.disabled.map((t) => row(t, "暂停 / 已完成", "disabled", t.id)).join("");
    }
    if (!html) html = `<div class="task-empty-side">还没有定时任务</div>`;
    els.tasksNav.innerHTML = html;

    els.tasksNav.querySelectorAll("[data-task-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.selectedTaskId = btn.dataset.taskId;
        state.selectedRunId = btn.dataset.runId || "";
        state.tasksUnread.delete(state.selectedTaskId);
        updateTasksRailBadge();
        renderTaskSidebar();
        renderTaskView();
      });
    });
    els.tasksNav.querySelectorAll("[data-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.toggle === "history") state.historyExpanded = !state.historyExpanded;
        if (btn.dataset.toggle === "disabled") state.disabledExpanded = !state.disabledExpanded;
        renderTaskSidebar();
      });
    });
  }

  function renderTaskView() {
    if (!els.tasksContent) return;
    setText(els.tasksPageTitle, "任务");
    const activeCount = state.tasks.filter((t) => t.status === "active").length;
    setText(els.tasksPageMeta, `${activeCount} 个活跃`);
    if (!state.selectedTaskId) { renderTasksEmpty(); return; }
    const task = state.tasks.find((t) => t.id === state.selectedTaskId);
    if (!task) { renderTasksEmpty(); return; }
    if (state.selectedRunId) { renderRunDetail(task); return; }
    renderTaskDetail(task);
  }

  function renderTasksEmpty() {
    if ((state.tasks || []).length === 0) {
      els.tasksContent.innerHTML = `
        <div class="tasks-empty">
          <div class="tasks-empty-emoji">📅</div>
          <h2>还没有定时任务</h2>
          <p>回到任意聊天告诉 Aimashi：<br><em>"每天 9 点帮我做 X"</em><br>它会自动帮你建好任务。</p>
        </div>
      `;
      return;
    }
    els.tasksContent.innerHTML = `
      <div class="tasks-empty">
        <div class="tasks-empty-emoji">←</div>
        <p>选择左侧任务查看详情</p>
      </div>
    `;
  }

  function renderRunDetail(task) {
    const run = (task.runs || []).find((r) => r.id === state.selectedRunId);
    if (!run) {
      state.selectedRunId = "";
      renderTaskDetail(task);
      return;
    }
    const message = lookupMessage(task.sessionId, run.outputMessageId);
    const user = state.runtime?.user || { displayName: "Boss", avatarText: "B", avatarColor: "#111827" };
    const persona = (state.runtime?.fellows || state.runtime?.personas || []).find((f) => f.key === task.fellowId) || null;
    const messageHtml = message
      ? renderMessageHtml(message, {
          messageIndex: 0,
          user,
          persona,
          showTaskAffordance: false
        })
      : `<div class="run-detail-empty">本次输出消息已不在会话历史里${run.error ? `（失败：${escapeHtml(run.error)}）` : "（可能被清理过）"}</div>`;
    const statusLabel = run.status === "ok" ? "完成" : run.status === "failed" ? "失败" : "跳过";
    els.tasksContent.innerHTML = `
      <article class="run-detail">
        <header class="run-detail-head">
          <button class="link" type="button" data-action="back-to-task">← 返回任务</button>
          <h2>${escapeHtml(task.title)} · ${escapeHtml(formatRunTime(run.firedAt))} ${escapeHtml(statusLabel)}</h2>
          <div class="run-detail-actions">
            <button class="link" type="button" data-action="open-conversation">打开对话 →</button>
            <button class="secondary" type="button" data-action="run-now">运行一次</button>
          </div>
        </header>
        <details class="run-detail-prompt">
          <summary>原始指令</summary>
          <pre>${escapeHtml(task.prompt)}</pre>
        </details>
        <section class="run-detail-output">
          <h3>AI 输出</h3>
          <div class="run-output-shell">
            ${messageHtml}
          </div>
        </section>
      </article>
    `;
    els.tasksContent.querySelector("[data-action='back-to-task']")?.addEventListener("click", () => {
      state.selectedRunId = "";
      renderTaskSidebar();
      renderTaskView();
    });
    els.tasksContent.querySelector("[data-action='open-conversation']")?.addEventListener("click", () => {
      jumpToTaskSession(task);
    });
    els.tasksContent.querySelector("[data-action='run-now']")?.addEventListener("click", async () => {
      try { await window.aimashi.tasks.runNow(task.id); } catch (e) { console.warn("run-now failed", e); }
      await loadTasksFromDaemon();
      renderTaskView();
    });
  }

  function lookupMessage(sessionId, messageId) {
    if (!messageId) return null;
    const buckets = state.chatStore?.sessions || {};
    for (const key of Object.keys(buckets)) {
      const bucket = buckets[key];
      const arr = Array.isArray(bucket) ? bucket : (bucket?.sessions || []);
      for (const s of arr) {
        if (s.id !== sessionId) continue;
        return (s.messages || []).find((m) => m.id === messageId) || null;
      }
    }
    return null;
  }

  function jumpToTaskSession(task) {
    const fellowKey = findFellowForSession(task.sessionId) || task.fellowId;
    state.activeKey = fellowKey;
    state.activeContactKey = fellowKey;
    if (state.activeSessionIdByPersona) {
      state.activeSessionIdByPersona[fellowKey] = task.sessionId;
    }
    state.activeView = "chat";
    if (typeof render === "function") render();
    else { renderView(); if (typeof renderChat === "function") renderChat(); }
  }

  function renderTaskDetail(task) {
    const sessionTitle = lookupSessionTitle(task.sessionId) || task.sessionId;
    const pauseLabel = task.status === "paused" ? "启用" : "暂停";
    const pauseAction = task.status === "paused" ? "resume" : "pause";
    els.tasksContent.innerHTML = `
      <article class="task-detail">
        <header class="task-detail-head">
          <div class="task-detail-source">
            <small>来源会话</small>
            <strong>${escapeHtml(sessionTitle)} · ${escapeHtml(fellowName(task.fellowId))}</strong>
            <button class="link" type="button" data-jump-session="${escapeHtml(task.sessionId)}">[打开 →]</button>
          </div>
          <div class="task-detail-actions">
            <button class="secondary" type="button" data-action="run-now">运行一次</button>
            <button class="secondary" type="button" data-action="${pauseAction}">${pauseLabel}</button>
            <button class="danger" type="button" data-action="delete">删除</button>
          </div>
        </header>

        <section class="task-schedule">
          <h3>调度</h3>
          <div class="task-form-row">
            <label><input type="radio" name="triggerType" value="cron" ${task.trigger.type === "cron" ? "checked" : ""}>重复</label>
            <label><input type="radio" name="triggerType" value="oneshot" ${task.trigger.type === "oneshot" ? "checked" : ""}>一次性</label>
            <label class="disabled"><input type="radio" name="triggerType" value="event" disabled>事件触发（V1 不可用）</label>
          </div>
          <div class="task-form-row" ${task.trigger.type === "cron" ? "" : "hidden"}>
            <label>Cron <input id="taskCron" value="${escapeHtml(task.trigger.cron || "")}"></label>
          </div>
          <div class="task-form-row" ${task.trigger.type === "oneshot" ? "" : "hidden"}>
            <label>触发时间 <input id="taskAt" type="datetime-local" value="${task.trigger.at ? toLocalDatetimeInput(task.trigger.at) : ""}"></label>
          </div>
          <div class="task-form-row">
            <label>时区 <input id="taskTimezone" value="${escapeHtml(task.timezone || "UTC")}"></label>
          </div>
          <div class="task-form-row task-next">
            <small>下次: ${task.nextFireAt ? formatRunTime(task.nextFireAt) : "—"}</small>
          </div>
        </section>

        <section class="task-prompt">
          <h3>Prompt</h3>
          <textarea id="taskPrompt" rows="3">${escapeHtml(task.prompt)}</textarea>
        </section>

        <section class="task-history">
          <h3>历史记录 (${task.runs.length})</h3>
          ${(task.runs || []).slice(-20).reverse().map((run) => `
            <button class="task-history-row" type="button" data-run-id="${escapeHtml(run.id)}">
              <span>${run.status === "ok" ? "✓" : run.status === "failed" ? "✗" : "·"}</span>
              <span>${escapeHtml(formatRunTime(run.firedAt))}</span>
              <span>${run.status === "failed" ? "失败" : run.status === "skipped" ? "跳过" : "完成"}</span>
              <em>→ 查看本次输出</em>
            </button>
          `).join("")}
          ${(task.runs || []).length === 0 ? `<div class="task-history-empty">还没有运行过</div>` : ""}
        </section>
      </article>
    `;
    attachTaskDetailHandlers(task);
  }

  function lookupSessionTitle(sessionId) {
    const allSessions = state.chatStore?.sessions || {};
    for (const key of Object.keys(allSessions)) {
      const arr = allSessions[key];
      if (!Array.isArray(arr)) continue;
      const found = arr.find((s) => s.id === sessionId);
      if (found) return found.title || null;
    }
    return null;
  }

  function toLocalDatetimeInput(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function debounceTask(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function attachTaskDetailHandlers(task) {
    const save = debounceTask(async (patch) => {
      try {
        const updated = await window.aimashi.tasks.update(task.id, patch);
        const idx = state.tasks.findIndex((t) => t.id === task.id);
        if (idx >= 0) state.tasks[idx] = updated;
        renderTaskSidebar();
      } catch (e) {
        console.warn("update task failed", e);
      }
    }, 400);

    document.querySelectorAll("[name=triggerType]").forEach((r) => {
      r.addEventListener("change", () => {
        if (r.value === "event") return;
        save({ trigger: { type: r.value, cron: task.trigger.cron, at: task.trigger.at } });
      });
    });
    document.getElementById("taskCron")?.addEventListener("input", (e) => {
      save({ trigger: { ...task.trigger, type: "cron", cron: e.target.value } });
    });
    document.getElementById("taskAt")?.addEventListener("input", (e) => {
      const iso = new Date(e.target.value).toISOString();
      save({ trigger: { ...task.trigger, type: "oneshot", at: iso } });
    });
    document.getElementById("taskTimezone")?.addEventListener("input", (e) => {
      save({ timezone: e.target.value });
    });
    document.getElementById("taskPrompt")?.addEventListener("input", (e) => {
      save({ prompt: e.target.value });
    });
    els.tasksContent.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = btn.dataset.action;
        try {
          if (action === "run-now") await window.aimashi.tasks.runNow(task.id);
          if (action === "pause")   await window.aimashi.tasks.pause(task.id);
          if (action === "resume")  await window.aimashi.tasks.resume(task.id);
          if (action === "delete") {
            if (!confirm(`删除任务「${task.title}」？已发生的历史记录会保留在会话里。`)) return;
            await window.aimashi.tasks.delete(task.id);
            state.selectedTaskId = "";
          }
        } catch (e) { console.warn("[task action]", action, e); }
        await loadTasksFromDaemon();
        renderTaskSidebar();
        renderTaskView();
      });
    });
    els.tasksContent.querySelectorAll("[data-run-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.selectedRunId = btn.dataset.runId;
        renderTaskSidebar();
        renderTaskView();
      });
    });
    els.tasksContent.querySelectorAll("[data-jump-session]").forEach((btn) => {
      btn.addEventListener("click", () => {
        jumpToTaskSession(task);
      });
    });
  }

  function findFellowForSession(sessionId) {
    const fellows = state.runtime?.fellows || state.runtime?.personas || [];
    const allSessions = state.chatStore?.sessions || {};
    for (const f of fellows) {
      const arr = allSessions[f.key];
      if (!Array.isArray(arr)) continue;
      if (arr.some((s) => s.id === sessionId)) return f.key;
    }
    for (const key of Object.keys(allSessions)) {
      const arr = allSessions[key];
      if (Array.isArray(arr) && arr.some((s) => s.id === sessionId)) return key;
    }
    return null;
  }

  async function loadTasksFromDaemon() {
    try {
      state.tasks = await window.aimashi.tasks.list();
    } catch (e) {
      console.warn("load tasks failed", e);
      state.tasks = [];
    }
  }

  let _tasksUnsubscribe = null;
  function subscribeTaskEvents() {
    if (_tasksUnsubscribe) return;
    _tasksUnsubscribe = window.aimashi.tasks.subscribe(async (envelope) => {
      await loadTasksFromDaemon();
      if (envelope.type === "finished" || envelope.type === "failed") {
        const taskId = envelope.payload?.taskId;
        if (taskId && state.selectedTaskId !== taskId) {
          state.tasksUnread.set(taskId, (state.tasksUnread.get(taskId) || 0) + 1);
        }
      }
      updateTasksRailBadge();
      if (state.activeView === "tasks") {
        renderTaskSidebar();
        renderTaskView();
      }
    });
  }

  function updateTasksRailBadge() {
    if (!els.tasksUnreadBadge) return;
    const total = [...state.tasksUnread.values()].reduce((a, b) => a + b, 0);
    if (total > 0) {
      els.tasksUnreadBadge.classList.remove("hidden");
      els.tasksUnreadBadge.textContent = String(total > 99 ? "99+" : total);
    } else {
      els.tasksUnreadBadge.classList.add("hidden");
    }
  }

  window.aimashiTasksPanel = {
    initTasksPanel,
    renderTaskSidebar,
    renderTaskView,
    renderTaskDetail,
    renderRunDetail,
    renderTasksEmpty,
    loadTasksFromDaemon,
    subscribeTaskEvents,
    updateTasksRailBadge,
  };
})();
