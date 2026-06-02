(function attach(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaOptimisticSend = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function (root) {
  function sendPipeline() {
    if (root && root.miaSendPipeline) return root.miaSendPipeline;
    if (typeof require === "function") return require("./send-pipeline.js");
    throw new Error("optimistic-send: send-pipeline is not loaded");
  }

  function buildPendingMessage(input, ctx) {
    const { prepareOutgoingMessage } = sendPipeline();
    const prepared = prepareOutgoingMessage(input, { members: ctx && ctx.members });
    return {
      messageId: `pending:${prepared.clientTraceId}`,
      clientTraceId: prepared.clientTraceId,
      bodyMd: prepared.bodyMd,
      attachments: prepared.attachments,
      mentions: prepared.mentions,
      role: "user",
      isOwn: true,
      isPending: true,
      createdAt: ""
    };
  }

  function reconcilePending(list, serverRow) {
    const trace = serverRow.client_trace_id || serverRow.clientTraceId || "";
    const next = Array.isArray(list) ? list.slice() : [];
    const idx = trace ? next.findIndex((m) => m.clientTraceId && m.clientTraceId === trace) : -1;
    const merged = {
      messageId: serverRow.id || (trace ? `pending:${trace}` : ""),
      clientTraceId: trace,
      bodyMd: String(serverRow.body_md || serverRow.bodyMd || ""),
      role: "user",
      isOwn: true,
      isPending: false,
      createdAt: serverRow.created_at || ""
    };
    if (idx >= 0) next[idx] = { ...next[idx], ...merged };
    else next.push(merged);
    return next;
  }

  return { buildPendingMessage, reconcilePending };
});
