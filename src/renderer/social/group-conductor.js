// Cloud-room conductor. The "群里发非 @ 消息也有人接话" behavior the
// original local-group module used to provide. Triggered by the
// room.message_appended cloud event instead of a local send call:
//
//   user → POST /api/rooms/:id/messages (no @)
//   server → broadcast room.message_appended
//   ↳ this module decides, on the host fellow's owner client, who should
//     speak via dispatch.md; for each fellow we own, invoke the local
//     agent (handleFellowInvocation) which posts the response as that
//     fellow.
//
// Cross-owner fellows are skipped — their owner client receives the same
// room.message_appended event and runs its own conductor pass; the chosen
// fellow's owner handles invocation. Picking the same fellow on two
// clients is harmless because handleFellowInvocation dedups by message id.
//
// v1: dispatch only. No relay loop, no contextCard summarize — those can
// come back when the user asks for them.

(function (global) {
  "use strict";

  const { MemberKind, SenderKind } = (typeof window !== "undefined" && window.aimashiConversationKinds)
    || require("../../shared/conversation-kinds");

  let _prompts = null;
  let _socialCtx = null;
  // Dedup by triggering message id so reconnect / replay can't double-fire.
  const _processed = new Set();
  const _processedCap = 256;

  function attach(socialCtx) {
    _socialCtx = socialCtx;
  }

  async function ensurePrompts() {
    if (_prompts) return _prompts;
    if (!global.aimashi || !global.aimashi.conductor) return null;
    try {
      _prompts = await global.aimashi.conductor.loadPrompts();
    } catch (err) {
      console.warn("[conductor] loadPrompts failed:", err?.message || err);
    }
    return _prompts;
  }

  // —— prompt builders (ported from the old group-prompts.js) ——

  function fillTemplate(template, vars) {
    return String(template || "").replace(/\{\{(\w+)\}\}/g, (_, key) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : ""
    );
  }

  function formatMembers(members) {
    return members.map((m) => `- ${m.name} (id=${m.id})`).join("\n");
  }

  function formatMessages(messages, fellowNamesById) {
    return messages.map((m) => {
      if (m.sender_kind === SenderKind.User) {
        const name = m.sender_username || "用户";
        return `${name}: ${m.body_md}`;
      }
      const fname = fellowNamesById[m.sender_ref] || m.sender_ref || "Fellow";
      return `${fname}: ${m.body_md}`;
    }).join("\n");
  }

  function buildDispatchPrompt(template, ctx) {
    return fillTemplate(template, {
      members: formatMembers(ctx.members),
      summary: ctx.summary || "（暂无摘要）",
      recent: formatMessages(ctx.recentMessages, ctx.fellowNamesById),
      userMessage: ctx.userMessage,
    });
  }

  // —— dispatch decision ——

  function safeParseJSON(text) {
    if (!text || typeof text !== "string") return null;
    try {
      const match = text.match(/\{[^}]*"speak"[^}]*\}/);
      if (!match) return null;
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }

  function inferRoomType(room) {
    if (!room) return null;
    if (room.type) return room.type;
    if (room.id?.startsWith("dm:")) return "dm";
    if (room.id?.startsWith("fellow:")) return "fellow";
    if (room.id?.startsWith("g_") || room.id?.startsWith("g-")) return "group";
    return null;
  }

  function responseModeFor(room) {
    const mode = room?.decorations?.responseMode;
    return mode === "mentions-only" ? "mentions-only" : "conductor";
  }

  function hostFellowIdFor(room, ownFellowMembers) {
    const explicit = room?.decorations?.hostMember || room?.hostMember;
    if (explicit && explicit.kind === MemberKind.Fellow && explicit.fellowId) return explicit.fellowId;
    return ownFellowMembers[0]?.member_ref || null;
  }

  function markProcessed(messageId) {
    _processed.add(messageId);
    if (_processed.size > _processedCap) {
      const first = _processed.values().next().value;
      _processed.delete(first);
    }
  }

  async function handleRoomMessageAppended(payload) {
    const { roomId, message } = payload || {};
    if (!roomId || !message) return;
    if (!_socialCtx) return;
    if (message.sender_kind !== SenderKind.User) return;
    if (Array.isArray(message.mentions) && message.mentions.length > 0) return;
    if (_processed.has(message.id)) return;

    const { moduleState, roomMembersCache, deps } = _socialCtx;
    const room = moduleState.rooms.find((r) => r.id === roomId);
    if (!room) return;
    if (inferRoomType(room) !== "group") return;
    if (responseModeFor(room) !== "conductor") return;

    const members = roomMembersCache.get(roomId) || [];
    if (!members.length) return;
    const fellowMembers = members.filter((m) => m.member_kind === MemberKind.Fellow);
    if (!fellowMembers.length) return;
    const myUserId = moduleState.myUserId || "";
    const ownFellowMembers = fellowMembers.filter((m) => m.owner_id === myUserId);
    if (!ownFellowMembers.length) return;

    const hostFellowId = hostFellowIdFor(room, ownFellowMembers);
    // Only the host's owner runs dispatch — otherwise N owners would each
    // pick (possibly different) fellows and trample each other.
    const hostMember = fellowMembers.find((m) => m.member_ref === hostFellowId);
    if (!hostMember || hostMember.owner_id !== myUserId) return;

    markProcessed(message.id);

    const prompts = await ensurePrompts();
    if (!prompts || !prompts.dispatch) {
      console.warn("[conductor] dispatch prompt not loaded; skipping");
      return;
    }

    const runtimeState = deps && typeof deps.getState === "function" ? deps.getState() : {};
    const fellowsList = runtimeState.runtime?.fellows || runtimeState.runtime?.personas || [];
    const fellowNamesById = {};
    const memberFellowDescriptors = [];
    for (const m of fellowMembers) {
      const f = fellowsList.find((x) => (x.id || x.key) === m.member_ref);
      const name = f?.name || m.member_ref;
      fellowNamesById[m.member_ref] = name;
      memberFellowDescriptors.push({ id: m.member_ref, name });
    }

    const recentMessages = (moduleState.messageCache.get(roomId)?.messages || []).slice(-6);

    const dispatchPrompt = buildDispatchPrompt(prompts.dispatch, {
      members: memberFellowDescriptors,
      summary: room.contextCard?.summary || room.decorations?.pinnedGoal || null,
      recentMessages,
      fellowNamesById,
      userMessage: message.body_md || "",
    });

    let raw;
    try {
      const result = await global.aimashi.sendChatStateless({
        fellowKey: hostFellowId,
        systemPrompt: "你是群聊调度器，无人设。",
        userPrompt: dispatchPrompt,
      });
      raw = result && typeof result.content === "string" ? result.content : "";
    } catch (err) {
      console.warn("[conductor] dispatch engine call failed:", err?.message || err);
      return;
    }

    const parsed = safeParseJSON(raw);
    if (!parsed || !Array.isArray(parsed.speak) || parsed.speak.length === 0) return;

    const chosen = parsed.speak.filter((id) =>
      fellowMembers.some((m) => m.member_ref === id && m.owner_id === myUserId)
    );
    if (!chosen.length) return;

    const invocations = global.aimashiSocialGroups;
    if (!invocations || typeof invocations.handleFellowInvocation !== "function") return;

    for (const fellowId of chosen) {
      invocations.handleFellowInvocation({
        roomId,
        fellowId,
        invokedBy: { username: "conductor" },
        triggeringMessage: message,
        recentMessages,
      }).catch((err) => console.warn("[conductor] invocation failed for", fellowId, err?.message || err));
    }
  }

  global.aimashiGroupConductor = {
    attach,
    handleRoomMessageAppended,
  };

  if (global.aimashiSocial && global.aimashiSocial._internalCtx) {
    attach(global.aimashiSocial._internalCtx);
  }
})(typeof window !== "undefined" ? window : globalThis);
