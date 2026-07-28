import { useLayoutEffect } from "react";
import {
  type PermissionDecision,
  usePermissionBanner
} from "../stores/permission-banner";

export function PermissionBanner() {
  const snapshot = usePermissionBanner();

  useLayoutEffect(() => {
    const host = document.getElementById("agentPermissionBanner");
    host?.classList.toggle("hidden", !snapshot.visible);
    if (!host) return;
    if (snapshot.requestId) host.dataset.requestId = snapshot.requestId;
    else delete host.dataset.requestId;
  }, [snapshot.requestId, snapshot.visible]);

  if (!snapshot.visible) return null;
  const decide = (decision: PermissionDecision) => snapshot.decide(decision);
  return (
    <>
      <div className="agent-permission-heading">
        <div className="agent-permission-source">
          <span className="agent-permission-kicker">{snapshot.kicker}</span>
        </div>
        <strong>{snapshot.title}</strong>
      </div>
      {snapshot.description ? (
        <p className="agent-permission-description">{snapshot.description}</p>
      ) : null}
      {snapshot.preview ? (
        <code className="agent-permission-preview">{snapshot.preview}</code>
      ) : null}
      <div className="agent-permission-actions">
        <button
          type="button"
          className="agent-permission-button ghost agent-permission-deny"
          data-permission-decision="deny"
          disabled={snapshot.pending}
          onClick={() => decide("deny")}
        >
          <span className="agent-permission-button-label">拒绝</span>
          <span className="agent-permission-key">esc</span>
        </button>
        <div className="agent-permission-allow-actions">
          <button
            type="button"
            className="agent-permission-button"
            data-permission-decision="allow_always"
            disabled={snapshot.pending}
            onClick={() => decide("allow_always")}
          >
            <span className="agent-permission-button-label">始终允许</span>
          </button>
          <button
            type="button"
            className="agent-permission-button primary"
            data-permission-decision="allow_once"
            aria-label="允许本次"
            disabled={snapshot.pending}
            onClick={() => decide("allow_once")}
          >
            <span className="agent-permission-button-label">允许</span>
            <span className="agent-permission-key">↵</span>
          </button>
        </div>
      </div>
    </>
  );
}
