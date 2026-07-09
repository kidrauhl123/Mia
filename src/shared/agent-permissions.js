(function attachAgentPermissions(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaAgentPermissions = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildAgentPermissions() {
  // Run-event kinds that carry an interactive tool-permission handshake. Rust
  // Core owns pending permission state; UI surfaces and cloud relays use these
  // names so the banner speaks one vocabulary regardless of engine.
  const PermissionEventKind = Object.freeze({
    Request: "permission_request",
    Resolved: "permission_resolved"
  });

  // Decisions accepted by the Rust Core permission response route and by the web banner.
  const PermissionDecision = Object.freeze({
    AllowOnce: "allow_once",
    AllowAlways: "allow_always",
    Deny: "deny"
  });

  // Hermes runs-API approval handshake (added upstream 526c0e01):
  //   SSE event "approval.request" pauses the run; POST /v1/runs/{id}/approval
  //   with one of these choices resumes it; "approval.responded" confirms.
  const HermesApprovalEvent = Object.freeze({
    Request: "approval.request",
    Responded: "approval.responded"
  });
  const HermesApprovalChoice = Object.freeze({
    Once: "once",
    Session: "session",
    Always: "always",
    Deny: "deny"
  });

  // The banner only knows allow_once / allow_always / deny — translate to the
  // Hermes choice when the request is backed by a Hermes run.
  function decisionToHermesChoice(decision) {
    if (decision === PermissionDecision.AllowAlways) return HermesApprovalChoice.Always;
    if (decision === PermissionDecision.AllowOnce) return HermesApprovalChoice.Once;
    return HermesApprovalChoice.Deny;
  }

  return {
    PermissionEventKind,
    PermissionDecision,
    HermesApprovalEvent,
    HermesApprovalChoice,
    decisionToHermesChoice
  };
});
