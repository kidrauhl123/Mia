(function (global) {
  "use strict";

  function getResponseMode(group) {
    const api = global.aimashiGroupResponseMode;
    if (api && typeof api.groupResponseMode === "function") return api.groupResponseMode(group);
    return group?.decorations?.responseMode || "conductor";
  }

  function ownsAFellow(myFellowKeys, member, myUserId) {
    return member.member_kind === "fellow"
      && (member.owner_id === myUserId || (myFellowKeys || []).includes(member.member_ref));
  }

  async function chooseDispatch({ group, members, myUserId, myFellowKeys, message, conductor, seenTurnIds }) {
    if (message.sender_kind && message.sender_kind !== "user") return { speak: [], skipped: "non-user-sender" };
    if (message.role && message.role !== "user") return { speak: [], skipped: "non-user-sender" };
    if (message.sender_ref === myUserId) return { speak: [], skipped: "own-message" };
    const turnId = message.turn_id || message.turnId;
    if (turnId && seenTurnIds && seenTurnIds.has(turnId)) return { speak: [], skipped: "duplicate-turn" };
    if (turnId && seenTurnIds) seenTurnIds.add(turnId);
    const myFellowMembers = (members || []).filter((m) => ownsAFellow(myFellowKeys, m, myUserId));
    if (myFellowMembers.length === 0) return { speak: [], skipped: "no-owned-fellows" };

    const mode = getResponseMode(group);
    if (mode === "mentions-only") {
      const mentionIds = (message.mentions || [])
        .filter((m) => m.kind === "fellow")
        .map((m) => m.fellowId);
      const speak = mentionIds.filter((id) => myFellowMembers.some((m) => m.member_ref === id));
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
    const speak = Array.isArray(dispatch?.speak) ? dispatch.speak.filter((id) => myFellowMembers.some((m) => m.member_ref === id)) : [];
    return { speak, mode, degraded: Boolean(dispatch?.degraded) };
  }

  global.aimashiGroupDispatch = { chooseDispatch };
})(typeof window !== "undefined" ? window : globalThis);
