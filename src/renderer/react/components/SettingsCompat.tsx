import { useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import {
  useSettingsCompat,
  type EngineActionView
} from "../stores/settings-compat";

export function ConnectedProviders() {
  const { providers } = useSettingsCompat();
  useLayoutEffect(() => {
    document.getElementById("connectedProviderList")
      ?.closest(".connected-providers")
      ?.classList.toggle("hidden", !providers.length);
  }, [providers.length]);
  return (
    <>
      {providers.map((provider) => (
        <div key={provider.id} className="connected-provider">
          <span className="provider-logo-wrap">
            <img
              className="provider-logo"
              src={provider.logoSrc}
              alt=""
              onError={(event) => {
                event.currentTarget.style.display = "none";
              }}
            />
          </span>
          <span className="provider-main"><strong>{provider.label}</strong></span>
          <span className="provider-check">✓</span>
        </div>
      ))}
    </>
  );
}

function EngineAction({ action }: { action: EngineActionView | null }) {
  if (!action) return null;
  const progress = action.progress;
  return (
    <span className="engine-action-stack">
      <button
        className="engine-install-action row"
        type="button"
        data-engine-settings-install={action.engineId}
        data-setup-action={action.action}
        data-engine={action.engineId}
        disabled={action.disabled}
        aria-busy={progress !== null ? "true" : undefined}
      >
        {action.label}
      </button>
      {progress !== null ? (
        <span className="engine-install-progress" aria-label={`安装进度 ${progress}%`}>
          <span className="engine-install-progress-track" aria-hidden="true">
            <span style={{ width: `${Math.max(4, progress)}%` }} />
          </span>
          <span className="engine-install-progress-text">{progress}%</span>
        </span>
      ) : null}
    </span>
  );
}

export function MobileQr() {
  const { mobileQr } = useSettingsCompat();
  useLayoutEffect(() => {
    const host = document.getElementById("cloudMobileScanQr");
    if (!host) return;
    if (mobileQr.loginUrl) host.dataset.qrUrl = mobileQr.loginUrl;
    else delete host.dataset.qrUrl;
  }, [mobileQr.loginUrl]);
  return mobileQr.imageUrl
    ? <img src={mobileQr.imageUrl} alt="扫码登录 Mia" />
    : <span>{mobileQr.status}</span>;
}

export default function SettingsCompatPortals() {
  const { engineActions } = useSettingsCompat();
  const providers = document.getElementById("connectedProviderList");
  const hermes = document.getElementById("engineRowHermesActions");
  const claude = document.getElementById("engineRowClaudeActions");
  const codex = document.getElementById("engineRowCodexActions");
  const qr = document.getElementById("cloudMobileScanQr");
  return (
    <>
      {providers ? createPortal(<ConnectedProviders />, providers, "connected-providers") : null}
      {hermes ? createPortal(<EngineAction action={engineActions.hermes || null} />, hermes, "engine-hermes") : null}
      {claude ? createPortal(<EngineAction action={engineActions["claude-code"] || null} />, claude, "engine-claude") : null}
      {codex ? createPortal(<EngineAction action={engineActions.codex || null} />, codex, "engine-codex") : null}
      {qr ? createPortal(<MobileQr />, qr, "mobile-qr") : null}
    </>
  );
}
