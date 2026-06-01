// src/mobile/app.js — DOM 控制器,组合 shared + lib 模块。
// 不直接 fetch / new WebSocket,网络一律走 window.miaCloudClient。
(function () {
  "use strict";
  const DEFAULT_API_BASE = "https://app.mia.example"; // TODO 部署时改为真实生产域名
  const SS_KEY = "mia.mobile.session";
  const $ = (id) => document.getElementById(id);

  const state = {
    apiBase: DEFAULT_API_BASE,
    token: "",
    user: null,
    conversations: [],
    fellows: [],
    friends: [],
    settings: { readMarks: {}, pins: [], appearance: {} },
    activeConversationId: "",
    messagesByConv: {},   // convId -> [渲染行]
    membersByConv: {},
    lastEventSeq: 0,
    tab: "list"
  };

  let client = null;
  const approvals = window.miaApprovalQueue.createApprovalQueue();
  const { SenderKind } = window.miaConversationKinds;

  // ── 会话存取 ──
  function loadSession() {
    try {
      const p = JSON.parse(localStorage.getItem(SS_KEY) || "");
      if (p && p.token) { state.token = p.token; state.user = p.user || null; state.apiBase = p.apiBase || DEFAULT_API_BASE; }
    } catch {}
  }
  function saveSession() {
    localStorage.setItem(SS_KEY, JSON.stringify({ token: state.token, user: state.user, apiBase: state.apiBase }));
  }
  function clearSession() {
    state.token = ""; state.user = null; state.conversations = [];
    if (client) client.stopEvents();
    localStorage.removeItem(SS_KEY);
  }

  function makeClient() {
    client = window.miaCloudClient.createCloudClient({
      apiBase: state.apiBase,
      getToken: () => state.token
    });
  }

  // ── 视图切换 ──
  function setLoggedIn(on) {
    $("loginView").classList.toggle("hidden", on);
    $("mainView").classList.toggle("hidden", !on);
  }
  function showTab(tab) {
    state.tab = tab;
    const map = { list: "listScreen", contacts: "contactsScreen", me: "meScreen" };
    Object.values(map).forEach((id) => $(id).classList.add("hidden"));
    $("chatScreen").classList.add("hidden");
    $(map[tab]).classList.remove("hidden");
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  }

  function escapeHtml(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
  }
  function avatarText(title) { return (String(title || "?").trim()[0] || "?").toUpperCase(); }
  function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

  // ── 登录 ──
  async function doAuth(register) {
    const server = $("serverInput").value.trim();
    state.apiBase = server || DEFAULT_API_BASE;
    makeClient();
    const username = $("usernameInput").value.trim();
    const password = $("passwordInput").value;
    $("loginError").textContent = "";
    try {
      const path = register ? "/api/auth/register" : "/api/auth/login";
      const data = await client.api(path, { method: "POST", body: { username, password } });
      state.token = data.token; state.user = data.user || { username };
      saveSession();
      setLoggedIn(true);
      await bootstrap();
    } catch (err) {
      $("loginError").textContent = err.message || "登录失败";
    }
  }

  async function bootstrap() {
    try { const me = await client.api("/api/me?compact=1"); state.user = me.user || me; saveSession(); }
    catch { clearSession(); setLoggedIn(false); return; }
    await Promise.all([
      client.api("/api/conversations").then((d) => { state.conversations = d.conversations || []; }).catch(() => {}),
      client.api("/api/me/fellows?compact=1").then((d) => { state.fellows = d.fellows || []; }).catch(() => {}),
      client.api("/api/social/friends").then((d) => { state.friends = d.friends || []; }).catch(() => {}),
      client.api("/api/me/settings").then((d) => { if (d.settings) state.settings = d.settings; }).catch(() => {})
    ]);
    if ($("meName")) $("meName").textContent = state.user?.username || "";
    renderConversationList();
    renderContacts();
    startEvents();
  }

  // ── 会话列表 ──
  function renderConversationList() {
    const items = window.miaConversationListModel.buildConversationListItems({
      conversations: state.conversations,
      unreadByConversation: {} // MVP:未读后续接 shared/unread
    });
    const ul = $("conversationList");
    ul.innerHTML = "";
    items.forEach((it) => {
      const li = document.createElement("li");
      li.className = "conv-row";
      li.innerHTML = `<div class="conv-avatar">${avatarText(it.title)}</div>
        <div class="conv-text"><div class="conv-title">${escapeHtml(it.title)}</div>
        <div class="conv-sub">${escapeHtml(it.subtitle)}</div></div>
        ${it.unread ? `<span class="conv-badge">${it.unread}</span>` : ""}`;
      li.addEventListener("click", () => openConversation(it.id, it.title));
      ul.appendChild(li);
    });
  }

  function renderContacts() {
    const ul = $("contactsList");
    if (!ul) return;
    ul.innerHTML = "";
    const rows = []
      .concat((state.friends || []).map((f) => ({ title: f.username || f.id, sub: "好友" })))
      .concat((state.fellows || []).map((f) => ({ title: f.name || f.id, sub: "Fellow" })));
    rows.forEach((r) => {
      const li = document.createElement("li");
      li.className = "conv-row";
      li.innerHTML = `<div class="conv-avatar">${avatarText(r.title)}</div>
        <div class="conv-text"><div class="conv-title">${escapeHtml(r.title)}</div>
        <div class="conv-sub">${escapeHtml(r.sub)}</div></div>`;
      ul.appendChild(li);
    });
  }

  async function openConversation(id, title) {
    state.activeConversationId = id;
    $("chatTitle").textContent = title || "";
    $("chatScreen").classList.remove("hidden");
    document.querySelectorAll(".screen").forEach((s) => { if (s.id !== "chatScreen") s.classList.add("hidden"); });
    renderApprovalSheet();
    try {
      const d = await client.api(`/api/conversations/${encodeURIComponent(id)}/messages?limit=200`);
      state.messagesByConv[id] = (d.messages || []).map(normalizeServerRow);
      const m = await client.api(`/api/conversations/${encodeURIComponent(id)}`);
      state.membersByConv[id] = m.members || [];
    } catch {}
    renderChat();
  }

  // 把服务端消息行转成渲染用的最小结构(MVP)
  function normalizeServerRow(m, idx) {
    const isOwn = m.sender_kind === SenderKind.User && m.sender_ref === (state.user && state.user.id);
    return {
      messageId: m.id || `${state.activeConversationId}#${m.seq || idx}`,
      clientTraceId: m.client_trace_id || "",
      role: m.sender_kind === SenderKind.Fellow ? "assistant" : (m.sender_kind === SenderKind.System ? "system" : "user"),
      bodyMd: String(m.body_md || ""),
      trace: m.trace_json ? safeParse(m.trace_json) : null,
      isOwn, isPending: false, createdAt: m.created_at || ""
    };
  }

  // ── 聊天渲染 ──
  function renderChat() {
    const id = state.activeConversationId;
    const list = state.messagesByConv[id] || [];
    const box = $("chatMessages");
    box.innerHTML = "";
    list.forEach((m) => {
      const div = document.createElement("div");
      div.className = `msg ${m.isOwn ? "own" : ""} ${m.isPending ? "pending" : ""} ${m.failed ? "failed" : ""}`.replace(/\s+/g, " ").trim();
      let html = "";
      if (m.trace && window.miaTraceBlocks) {
        html += window.miaTraceBlocks.renderTraceBlocks({
          reasoning: m.trace.reasoning, tools: m.trace.tools, content: m.bodyMd, expanded: false, scopeKey: m.messageId
        });
      }
      html += `<span class="msg-text">${escapeHtml(m.bodyMd)}</span>`;
      div.innerHTML = html;
      box.appendChild(div);
    });
    box.scrollTop = box.scrollHeight;
    if (window.miaTraceBlocks?.markRenderedTraceBlocks) window.miaTraceBlocks.markRenderedTraceBlocks(box);
  }

  // ── 乐观发送 ──
  async function sendCurrent() {
    const id = state.activeConversationId;
    const input = $("composerInput");
    const text = input.value;
    let pending;
    try {
      pending = window.miaOptimisticSend.buildPendingMessage({ text }, { selfId: state.user?.id, members: state.membersByConv[id] });
    } catch { return; } // 空消息忽略
    input.value = "";
    (state.messagesByConv[id] ||= []).push(pending);
    renderChat();
    try {
      const res = await client.api(`/api/conversations/${encodeURIComponent(id)}/messages`, {
        method: "POST",
        body: { body_md: pending.bodyMd, client_trace_id: pending.clientTraceId, mentions: pending.mentions, attachments: pending.attachments }
      });
      const row = res.message || res;
      state.messagesByConv[id] = window.miaOptimisticSend.reconcilePending(state.messagesByConv[id], row);
    } catch {
      const m = (state.messagesByConv[id] || []).find((x) => x.clientTraceId === pending.clientTraceId);
      if (m) m.failed = true;
    }
    renderChat();
  }

  // ── WebSocket 实时 ──
  function startEvents() {
    client.connectEvents({
      sinceSeq: () => state.lastEventSeq,
      onStatus: (s) => { $("connBar").classList.toggle("hidden", s === "open"); },
      onEvent: handleEvent
    });
  }

  function handleEvent(env) {
    if (Number.isFinite(Number(env.seq)) && Number(env.seq) > state.lastEventSeq) state.lastEventSeq = Number(env.seq);
    const t = env.type || "";
    if (t === "message" || t === "message.created") {
      const row = env.message || env.data || {};
      const cid = row.conversation_id || env.conversation_id;
      if (cid) {
        state.messagesByConv[cid] = window.miaOptimisticSend.reconcilePending(state.messagesByConv[cid] || [], row);
        if (cid === state.activeConversationId) renderChat();
      }
    } else if (t === "approval.request") {
      approvals.onRequest({ conversationId: env.conversation_id, runId: env.run_id || env.runId, preview: approvalPreview(env) });
      renderApprovalSheet();
    } else if (t === "approval.responded") {
      approvals.onResponded(env.run_id || env.runId);
      renderApprovalSheet();
    }
  }

  function approvalPreview(env) {
    return env.preview || env.tool_name || (env.payload && env.payload.title) || "请求执行操作";
  }

  // ── 权限底部 sheet ──
  function renderApprovalSheet() {
    const active = approvals.active();
    const sheet = $("approvalSheet");
    if (!active) { sheet.classList.add("hidden"); return; }
    $("approvalPreview").textContent = active.preview || "";
    sheet.classList.remove("hidden");
  }

  async function decideApproval(decision) {
    const active = approvals.active();
    if (!active) return;
    const { decisionToHermesChoice } = window.miaAgentPermissions;
    approvals.resolve(active.runId);
    renderApprovalSheet();
    try {
      await client.api(`/api/conversations/${encodeURIComponent(active.conversationId)}/runs/${encodeURIComponent(active.runId)}/approval`, {
        method: "POST",
        body: { decision, choice: decisionToHermesChoice(decision) }
      });
    } catch {
      // run 可能已结束/失效:静默,sheet 已推进到下一条
    }
  }

  // ── 事件绑定 ──
  function bindUi() {
    $("loginBtn").addEventListener("click", () => doAuth(false));
    $("registerBtn").addEventListener("click", () => doAuth(true));
    $("logoutBtn")?.addEventListener("click", () => { clearSession(); setLoggedIn(false); });
    document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
    $("chatBack").addEventListener("click", () => { $("chatScreen").classList.add("hidden"); showTab("list"); });
    $("sendBtn").addEventListener("click", sendCurrent);
    $("composerInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendCurrent(); });
    document.querySelectorAll("#approvalSheet [data-decision]").forEach((b) =>
      b.addEventListener("click", () => decideApproval(b.dataset.decision)));
  }

  function init() {
    bindUi();
    loadSession();
    if (state.token) { makeClient(); setLoggedIn(true); bootstrap(); }
    else { setLoggedIn(false); }
  }
  document.addEventListener("DOMContentLoaded", init);
  window.__miaMobile = { state };
})();
