(function (global) {
  "use strict";

  function contact() {
    if (global.aimashiContact) return global.aimashiContact;
    if (typeof require !== "undefined") return require("../shared/contact");
    throw new Error("aimashiContact is not loaded");
  }

  const { MemberKind, SenderKind } = (typeof window !== "undefined" && window.aimashiConversationKinds) || require("../shared/conversation-kinds");

  function getResponseMode(group) {
    const api = global.aimashiGroupResponseMode;
    if (api && typeof api.groupResponseMode === "function") return api.groupResponseMode(group);
    return group?.decorations?.responseMode || "conductor";
  }

  function memberContact(member, ctx) {
    const { resolveContact, ContactKind } = contact();
    return resolveContact({ kind: ContactKind.Fellow, ref: member.member_ref }, ctx || {});
  }

  function mentionContact(mention, ctx) {
    const { resolveContact, ContactKind } = contact();
    return resolveContact({ kind: ContactKind.Fellow, ref: mention.fellowId }, ctx || {});
  }

  function ownsAFellow(myFellowKeys, member, myUserId, ctx) {
    if (member.member_kind !== MemberKind.Fellow) return false;
    const id = memberContact(member, ctx).id;
    return member.owner_id === myUserId || (myFellowKeys || []).includes(id);
  }

  async function chooseDispatch({ group, members, myUserId, myFellowKeys, message, conductor, seenTurnIds, ctx }) {
    const resolveCtx = ctx || {};
    if (message.sender_kind && message.sender_kind !== SenderKind.User) return { speak: [], skipped: "non-user-sender" };
    if (message.role && message.role !== "user") return { speak: [], skipped: "non-user-sender" };
    if (message.sender_ref === myUserId) return { speak: [], skipped: "own-message" };
    const turnId = message.turn_id || message.turnId;
    if (turnId && seenTurnIds && seenTurnIds.has(turnId)) return { speak: [], skipped: "duplicate-turn" };
    if (turnId && seenTurnIds) seenTurnIds.add(turnId);
    const myFellowMembers = (members || []).filter((m) => ownsAFellow(myFellowKeys, m, myUserId, resolveCtx));
    if (myFellowMembers.length === 0) return { speak: [], skipped: "no-owned-fellows" };

    const mode = getResponseMode(group);
    if (mode === "mentions-only") {
      const mentionIds = (message.mentions || [])
        .filter((m) => m.kind === MemberKind.Fellow)
        .map((m) => mentionContact(m, resolveCtx).id)
        .filter(Boolean);
      const speak = mentionIds.filter((id) => myFellowMembers.some((m) => memberContact(m, resolveCtx).id === id));
      return { speak, mode };
    }
    let dispatch;
    try {
      dispatch = await conductor.decideDispatch({
        group,
        members: myFellowMembers,
        fellowNamesById: {},
        userMessage: { id: message.id, role: "user", content: message.body_md || message.content || "", createdAt: message.created_at || message.createdAt },
        messages: []
      });
    } catch (err) {
      console.warn("[group-dispatch] conductor.decideDispatch threw:", err);
      return { speak: [], mode, degraded: true };
    }
    const speak = Array.isArray(dispatch?.speak)
      ? dispatch.speak.filter((id) => myFellowMembers.some((m) => memberContact(m, resolveCtx).id === id))
      : [];
    return { speak, mode, degraded: Boolean(dispatch?.degraded) };
  }

  global.aimashiGroupDispatch = { chooseDispatch };
})(typeof window !== "undefined" ? window : globalThis);
