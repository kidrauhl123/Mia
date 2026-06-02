(function attach(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaApprovalQueue = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function () {
  function createApprovalQueue() {
    let items = [];
    function remove(runId) {
      items = items.filter((it) => it.runId !== runId);
    }
    return {
      onRequest(req) {
        if (!req || !req.runId) return;
        if (items.some((it) => it.runId === req.runId)) return;
        items.push({ conversationId: req.conversationId || "", runId: req.runId, preview: req.preview || "" });
      },
      onResponded(runId) {
        remove(runId);
      },
      resolve(runId) {
        remove(runId);
      },
      active() {
        return items.length ? items[0] : null;
      },
      size() {
        return items.length;
      }
    };
  }
  return { createApprovalQueue };
});
