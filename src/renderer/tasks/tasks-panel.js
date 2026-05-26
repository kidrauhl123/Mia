// Tasks panel module
// Extracted from app.js (formerly lines 3973-4373). Mirrors the group.js
// extraction pattern: IIFE + window.miaTasksPanel namespace + initTasksPanel
// for dependency injection. Behavior is identical to the previous inline code.
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

  // Injected at init time. All functions below use these bare identifiers as
  // they did when inline in app.js — keeping diffs minimal.
  let state, els, mia;
  let escapeHtml, setText, formatRunTime, renderMessageHtml;
  let render, renderView, renderChat;

  function initTasksPanel(deps) {
    state = deps.state;
    els = deps.els;
    mia = deps.mia || (typeof window !== "undefined" ? window.mia : null);
    escapeHtml = deps.escapeHtml;
    setText = deps.setText;
    formatRunTime = deps.formatRunTime;
    renderMessageHtml = deps.renderMessageHtml;
    render = deps.render;
    renderView = deps.renderView;
    renderChat = deps.renderChat;
  }

  function fellowName(fellowId) {
    const { resolveContact, ContactKind } = contact();
    const fellows = state.runtime?.fellows || state.runtime?.personas || [];
    const resolved = resolveContact({ kind: ContactKind.Fellow, ref: fellowId }, { fellows });
    return resolved.displayName || fellowId;
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
      const badge = unreadShared().unreadBadgeHtml(unread);
      const badgeHtml = badge
        ? badge.replace("<span ", "<em ").replace("</span>", "</em>").replace('class="unread-badge"', 'class="task-unread"')
        : "";
      return `
        <button class="task-row${state.selectedTaskId === taskId && !state.selectedRunId ? " active" : ""}"
                type="button" data-task-id="${escapeHtml(taskId)}">
          <span class="task-dot ${dotClass}"></span>
          <span class="task-row-body">
            <strong>${escapeHtml(task.title)}</strong>
            <small>${escapeHtml(label)} · ${escapeHtml(fellowName(task.fellowId))}</small>
          </span>
          ${badgeHtml}
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
          <p>回到任意聊天告诉 Mia：<br><em>"每天 9 点帮我做 X"</em><br>它会自动帮你建好任务。</p>
          <button class="secondary" type="button" data-action="new-task">＋ 手动新建任务</button>
        </div>
      `;
      els.tasksContent.querySelector("[data-action='new-task']")
        ?.addEventListener("click", openTaskCreate);
      return;
    }
    els.tasksContent.innerHTML = `
      <div class="tasks-empty">
        <div class="tasks-empty-emoji">←</div>
        <p>选择左侧任务查看详情</p>
      </div>
    `;
  }

  let _taskCreateBound = false;

  function openTaskCreate() {
    const dialog = document.getElementById("taskCreateDialog");
    if (!dialog) return;
    const fellows = state.runtime?.fellows || state.runtime?.personas || [];
    const fellowSel = document.getElementById("ntFellow");
    if (fellowSel) {
      if (fellows.length === 0) {
        fellowSel.innerHTML = `<option value="">（请先在通讯录添加一个 Agent）</option>`;
      } else {
        const def = fellows.some((f) => f.key === state.activeKey) ? state.activeKey : fellows[0].key;
        fellowSel.innerHTML = fellows
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

  // The 执行时间 row swaps its detail controls to match the chosen frequency:
  // a one-shot needs a date + time; recurring modes need a time plus an optional
  // weekday / day-of-month, which submitTaskCreate folds into a cron expression.
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
      e.preventDefault();
      submitTaskCreate();
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
    const fellowId = document.getElementById("ntFellow")?.value || "";
    const title = (document.getElementById("ntName")?.value || "").trim();
    const prompt = (document.getElementById("ntPrompt")?.value || "").trim();
    const freq = document.getElementById("ntFreq")?.value || "oneshot";

    if (!fellowId) return showError("请先选择执行的 Agent（去通讯录添加一个）。");
    if (!title) return showError("请填写任务名称。");
    if (!prompt) return showError("请填写要求说明。");

    const time = document.getElementById("ntTime")?.value || "";
    if (!time) return showError("请选择执行时间。");
    const [hh, mm] = time.split(":");
    const h = Number(hh);
    const m = Number(mm);

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

    let sessionId;
    try {
      sessionId = await resolveSessionForFellow(fellowId);
    } catch (e) {
      return showError("无法为该 Agent 准备会话：" + (e?.message || e));
    }
    if (!sessionId) return showError("该 Agent 还没有可用会话，请先和它聊一句。");

    try {
      const created = await window.mia.tasks.create({ title, fellowId, sessionId, prompt, trigger, timezone });
      closeTaskCreate();
      state.selectedTaskId = created?.id || "";
      state.selectedRunId = "";
      await loadTasksFromDaemon();
      renderTaskSidebar();
      renderTaskView();
    } catch (e) {
      showError("创建失败：" + (e?.message || e));
    }
  }

  // Bind the task to a session that ACTUALLY EXISTS in the store, so its output
  // lands in a conversation the user can find. activeSessionIdByPersona can point
  // at an unsaved/empty session that gets pruned → a phantom binding, so only
  // trust it when it's present in chatStore; otherwise use the fellow's latest
  // real session, and only create one when the fellow has none.
  async function resolveSessionForFellow(fellowKey) {
    const list = state.chatStore?.sessions?.[fellowKey];
    const active = state.activeSessionIdByPersona?.[fellowKey];
    if (Array.isArray(list) && list.length) {
      if (active && list.some((s) => s.id === active)) return active;
      return list[0].id;
    }
    state.chatStore = await window.mia.createChatSession({ personaKey: fellowKey });
    const created = state.chatStore?.sessions?.[fellowKey];
    return Array.isArray(created) && created.length ? created[0].id : null;
  }

  function renderRunDetail(task) {
    const run = (task.runs || []).find((r) => r.id === state.selectedRunId);
    if (!run) {
      state.selectedRunId = "";
      renderTaskDetail(task);
      return;
    }
    // Plain text, not a chat bubble — the run-detail is a report, not a conversation.
    // Prefer the race-free copy stored on the run; fall back to the session message.
    const outputText = run.outputText || lookupMessage(task.sessionId, run.outputMessageId)?.content || "";
    const outputHtml = outputText
      ? `<div class="run-output-text">${window.miaMarkdown.renderMarkdown(outputText)}</div>`
      : `<div class="run-detail-empty">${run.error ? `运行失败：${escapeHtml(run.error)}` : "本次没有产生输出。"}</div>`;
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
            ${outputHtml}
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
      try { await window.mia.tasks.runNow(task.id); } catch (e) { console.warn("run-now failed", e); }
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

  function renderTaskDetail(task) {
    const sessionTitle = lookupSessionTitle(task.sessionId) || task.sessionId;
    const pauseLabel = task.status === "paused" ? "启用" : "暂停";
    const pauseAction = task.status === "paused" ? "resume" : "pause";
    const closed = task.status === "done" || task.status === "failed";
    const statusText = { active: "进行中", paused: "已暂停", done: "已完成", failed: "已失败" }[task.status] || task.status;
    const nextText = task.status === "active" && task.nextFireAt ? ` · 下次 ${escapeHtml(formatRunTime(task.nextFireAt))}` : "";
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
            ${closed ? "" : `<button class="secondary" type="button" data-action="${pauseAction}">${pauseLabel}</button>`}
            <button class="secondary danger" type="button" data-action="delete">删除</button>
          </div>
        </header>

        <section class="task-meta">
          <div class="task-meta-item"><small>执行时间</small><span>${escapeHtml(scheduleText(task))}</span></div>
          <div class="task-meta-item"><small>状态</small><span>${escapeHtml(statusText)}${nextText}</span></div>
        </section>

        <section class="task-prompt-view">
          <small>要求说明</small>
          <p>${escapeHtml(task.prompt)}</p>
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

  function attachTaskDetailHandlers(task) {
    els.tasksContent.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = btn.dataset.action;
        try {
          if (action === "run-now") await window.mia.tasks.runNow(task.id);
          if (action === "pause")   await window.mia.tasks.pause(task.id);
          if (action === "resume")  await window.mia.tasks.resume(task.id);
          if (action === "delete") {
            if (!confirm(`删除任务「${task.title}」？已发生的历史记录会保留在会话里。`)) return;
            await window.mia.tasks.delete(task.id);
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
      state.tasks = await window.mia.tasks.list();
    } catch (e) {
      console.warn("load tasks failed", e);
      state.tasks = [];
    }
  }

  // The daemon owns the chat store and is the single writer. When it appends a
  // task's reply it broadcasts `sessions_changed`; the desktop just reloads the
  // authoritative store from disk and re-renders — no second writer, no merge
  // guesswork, so the reply reliably shows up in the executor's conversation.
  let _reloadRetry = null;
  async function reloadChatFromDisk() {
    // Never touch state.chatStore mid-stream: streaming render + the final append
    // re-resolve from it, so replacing it under an in-flight turn corrupts that
    // turn. Defer until generation finishes, then reload.
    if (state.isGenerating) {
      clearTimeout(_reloadRetry);
      _reloadRetry = setTimeout(reloadChatFromDisk, 1500);
      return;
    }
    try {
      const fresh = await window.mia.loadChatSessions();
      if (fresh && fresh.sessions) {
        state.chatStore = fresh;
        if (state.activeView === "chat" && typeof render === "function") render();
      }
    } catch (e) {
      console.warn("reload chat after task event failed", e);
    }
  }

  let _tasksUnsubscribe = null;
  function subscribeTaskEvents() {
    if (_tasksUnsubscribe) return;
    _tasksUnsubscribe = window.mia.tasks.subscribe(async (envelope) => {
      if (envelope.type === "sessions_changed") {
        await reloadChatFromDisk();
        return;
      }
      await loadTasksFromDaemon();
      if (envelope.type === "finished" || envelope.type === "failed") {
        // Reload chat too in case the sessions_changed event was missed (e.g. the
        // SSE reconnected after the daemon wrote).
        if (envelope.type === "finished") await reloadChatFromDisk();
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
      // Extract truncated text from the shared badge HTML so this rail
      // count uses the same "99+" boundary as every other unread display.
      const badge = unreadShared().unreadBadgeHtml(total);
      const m = badge.match(/>([^<]*)</);
      els.tasksUnreadBadge.textContent = m ? m[1] : String(total);
    } else {
      els.tasksUnreadBadge.classList.add("hidden");
    }
  }

  window.miaTasksPanel = {
    initTasksPanel,
    openTaskCreate,
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
