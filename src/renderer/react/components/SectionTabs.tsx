import {
  bridge,
  type RendererView,
  type SettingsTab,
  type TaskMode
} from "../bridge";
import { useLayoutEffect, useRef } from "react";
import { useRendererShell } from "../hooks/useRendererShell";

const exploreTabs: readonly [Extract<RendererView, "contacts" | "bot-store" | "skills">, string][] = [
  ["contacts", "联系人"],
  ["bot-store", "发现 AI 助手"],
  ["skills", "能力库"]
];

const settingsTabs: readonly [SettingsTab, string][] = [
  ["account", "账号与同步"],
  ["im", "IM 接入"],
  ["appearance", "外观"],
  ["model", "模型"],
  ["memory", "记忆"]
];

export function DiscoverModeToggle() {
  const snapshot = useRendererShell();
  const activeButtonRef = useRef<HTMLButtonElement | null>(null);

  useLayoutEffect(() => {
    const active = activeButtonRef.current;
    const host = active?.parentElement;
    if (!active || !host) return;
    const hostRect = host.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    if (!hostRect.width) return;
    host.style.setProperty("--pill-x", `${activeRect.left - hostRect.left}px`);
    host.style.setProperty("--pill-w", `${activeRect.width}px`);
    host.style.setProperty("--pill-ready", "1");
  }, [snapshot.activeView, snapshot.contactsUnread]);

  const modes: readonly [Extract<RendererView, "bot-store" | "contacts">, string][] = [
    ["bot-store", "\u53d1\u73b0 AI \u52a9\u624b"],
    ["contacts", "\u8054\u7cfb\u4eba"]
  ];

  return modes.map(([view, label]) => {
    const active = snapshot.activeView === view;
    const unread = view === "contacts" ? snapshot.contactsUnread : 0;
    const ariaLabel = unread > 0
      ? `\u8054\u7cfb\u4eba\uff0c${unread} \u4e2a\u65b0\u597d\u53cb\u8bf7\u6c42`
      : label;
    return (
      <button
        key={view}
        ref={active ? activeButtonRef : null}
        type="button"
        role="tab"
        className={active ? "active" : ""}
        data-discover-mode={view}
        data-react-owned="true"
        aria-label={ariaLabel}
        aria-selected={active}
        onClick={() => bridge.invoke("selectExploreView", view)}
      >
        <span className="discover-mode-label">{label}</span>
        {view === "contacts" ? (
          <span
            className={`discover-mode-unread${unread > 0 ? "" : " hidden"}`}
            data-discover-unread="contacts"
            aria-hidden="true"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>
    );
  });
}

export function ExploreTabs({ className = "explore-sidebar-tabs" }: { className?: string }) {
  const snapshot = useRendererShell();
  return (
    <div className={className} role="tablist" aria-label="探索分类">
      {exploreTabs.map(([view, label]) => (
        <button
          key={view}
          className={snapshot.activeView === view ? "active" : ""}
          type="button"
          data-explore-view={view}
          data-react-owned="true"
          onClick={() => bridge.invoke("selectExploreView", view)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function TaskTabs() {
  const snapshot = useRendererShell();
  const tabs: readonly [TaskMode, string][] = [["active", "活跃任务"], ["history", "历史"]];
  return (
    <div className="task-sidebar-tabs" role="tablist" aria-label="任务分类">
      {tabs.map(([mode, label]) => (
        <button
          key={mode}
          className={snapshot.taskMode === mode ? "active" : ""}
          type="button"
          data-task-sidebar-mode={mode}
          data-react-owned="true"
          onClick={() => bridge.invoke("selectTaskMode", mode)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function SettingsTabButtons() {
  const snapshot = useRendererShell();
  return settingsTabs.map(([tab, label]) => (
    <button
      key={tab}
      className={`settings-tab${snapshot.activeSettingsTab === tab ? " active" : ""}`}
      type="button"
      data-settings-tab={tab}
      data-react-owned="true"
      onClick={() => bridge.invoke("selectSettingsTab", tab)}
    >
      {label}
    </button>
  ));
}

export function SettingsSidebarTabs() {
  return (
    <div className="settings-sidebar-tabs" role="tablist" aria-label="设置分类">
      <SettingsTabButtons />
    </div>
  );
}

export function SettingsWorkspaceTabs() {
  return (
    <>
      <div className="settings-tabs-title">设置</div>
      <SettingsTabButtons />
    </>
  );
}
