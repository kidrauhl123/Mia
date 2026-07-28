import { memo, type ReactNode } from "react";
import {
  bridge,
  type PrimaryNavigation,
  type RendererView
} from "../bridge";
import { useRendererShell } from "../hooks/useRendererShell";

type RailIconName = "chat" | "groups" | "extension" | "checklist" | "settings";

const LegacyPersonaCount = memo(function LegacyPersonaCount() {
  return <em id="personaCount">0</em>;
});

const LegacyProfileAvatar = memo(function LegacyProfileAvatar({ open }: { open: boolean }) {
  return (
    <>
      <div
        id="userAvatar"
        className="profile-avatar rail-avatar"
        role="button"
        tabIndex={0}
        title="个人资料"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="profileDialog"
      />
      <span id="userDisplayName" className="visually-hidden" />
    </>
  );
});

const LegacySidebarAvatar = memo(function LegacySidebarAvatar() {
  return <span id="sidebarUserAvatar" className="profile-avatar sidebar-bottom-avatar" aria-hidden="true" />;
});

function fallbackPath(name: RailIconName): ReactNode {
  if (name === "chat") {
    return <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />;
  }
  if (name === "groups") {
    return (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </>
    );
  }
  if (name === "extension") {
    return <path d="M12 7v14 M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />;
  }
  if (name === "checklist") {
    return (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M3 9h18 M8 3v4 M16 3v4 M8 13h3 M8 17h7" />
      </>
    );
  }
  return <path d="M4 6h16 M4 12h16 M4 18h16" />;
}

const RailLottie = memo(function RailLottie({ name }: { name: RailIconName }) {
  return (
    <span
      className="rail-lottie"
      data-lottie={name}
      data-lottie-rest="60"
      data-lottie-play="70,130"
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24">{fallbackPath(name)}</svg>
    </span>
  );
});

function UnreadBadge({ id, count, className }: { id: string; count: number; className: string }) {
  return (
    <span id={id} className={`${className}${count > 0 ? "" : " hidden"}`} aria-hidden="true">
      {count > 99 ? "99+" : count}
    </span>
  );
}

type RailButtonProps = {
  active: boolean;
  icon: RailIconName;
  label: string;
  view: RendererView;
  children?: ReactNode;
};

function RailButton({ active, icon, label, view, children }: RailButtonProps) {
  return (
    <button
      className={`rail-button${active ? " active" : ""}`}
      type="button"
      data-view={view}
      data-react-owned="true"
      title={label}
      aria-label={label}
      onClick={() => bridge.invoke("navigateView", view)}
    >
      <RailLottie name={icon} />
      <span className="rail-button-label" aria-hidden="true">{label}</span>
      {children}
    </button>
  );
}

export function NavigationRail() {
  const snapshot = useRendererShell();
  return (
    <>
      <div className="traffic-spacer" id="trafficSpacer" aria-hidden="true" />
      <LegacyProfileAvatar open={snapshot.profileDialogOpen} />
      <div className="rail-divider" />
      <RailButton active={snapshot.activeView === "chat"} icon="chat" label="消息" view="chat">
        <LegacyPersonaCount />
        <UnreadBadge id="chatUnreadBadge" className="rail-badge" count={snapshot.chatUnread} />
      </RailButton>
      <RailButton
        active={snapshot.activeView === "contacts" || snapshot.activeView === "bot-store"}
        icon="groups"
        label="联系人"
        view="contacts"
      >
        <UnreadBadge id="contactsUnreadBadge" className="rail-badge" count={snapshot.contactsUnread} />
      </RailButton>
      <RailButton active={snapshot.activeView === "skills"} icon="extension" label="技能" view="skills" />
      <RailButton active={snapshot.activeView === "tasks"} icon="checklist" label="任务" view="tasks">
        <UnreadBadge id="tasksUnreadBadge" className="rail-badge" count={snapshot.tasksUnread} />
      </RailButton>
      <div className="rail-spacer" />
      <button
        id="openSettings"
        className={`rail-button${snapshot.activeView === "settings" ? " active" : ""}`}
        type="button"
        data-react-owned="true"
        title="设置"
        aria-label="设置"
        onClick={() => bridge.invoke("openSettings")}
      >
        <RailLottie name="settings" />
      </button>
    </>
  );
}

type BottomIconName = Exclude<PrimaryNavigation, "me">;

function BottomIcon({ name }: { name: BottomIconName }) {
  if (name === "chat") {
    return (
      <svg viewBox="0 0 256 256">
        <path className="sidebar-bottom-icon-regular" d="M128,24A104,104,0,0,0,36.18,176.88L24.83,210.93a16,16,0,0,0,20.24,20.24l34.05-11.35A104,104,0,1,0,128,24Zm0,192a87.87,87.87,0,0,1-44.06-11.81,8,8,0,0,0-6.54-.67L40,216,52.47,178.6a8,8,0,0,0-.66-6.54A88,88,0,1,1,128,216Z" />
        <path className="sidebar-bottom-icon-fill" d="M232,128A104,104,0,0,1,79.12,219.82L45.07,231.17a16,16,0,0,1-20.24-20.24l11.35-34.05A104,104,0,1,1,232,128Z" />
      </svg>
    );
  }
  if (name === "explore") {
    return (
      <svg viewBox="0 0 256 256">
        <path className="sidebar-bottom-icon-regular" d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216ZM172.42,72.84l-64,32a8.05,8.05,0,0,0-3.58,3.58l-32,64A8,8,0,0,0,80,184a8.1,8.1,0,0,0,3.58-.84l64-32a8.05,8.05,0,0,0,3.58-3.58l32-64a8,8,0,0,0-10.74-10.74ZM138,138,97.89,158.11,118,118l40.15-20.07Z" />
        <path className="sidebar-bottom-icon-fill" d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm51.58,57.79-32,64a4.08,4.08,0,0,1-1.79,1.79l-64,32a4,4,0,0,1-5.37-5.37l32-64a4.08,4.08,0,0,1,1.79-1.79l64-32A4,4,0,0,1,179.58,81.79Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 256 256">
      <path className="sidebar-bottom-icon-regular" d="M208,32H184V24a8,8,0,0,0-16,0v8H88V24a8,8,0,0,0-16,0v8H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32ZM72,48v8a8,8,0,0,0,16,0V48h80v8a8,8,0,0,0,16,0V48h24V80H48V48ZM208,208H48V96H208V208Zm-38.34-85.66a8,8,0,0,1,0,11.32l-48,48a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L116,164.69l42.34-42.35A8,8,0,0,1,169.66,122.34Z" />
      <path className="sidebar-bottom-icon-fill" d="M208,32H184V24a8,8,0,0,0-16,0v8H88V24a8,8,0,0,0-16,0v8H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32ZM169.66,133.66l-48,48a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L116,164.69l42.34-42.35a8,8,0,0,1,11.32,11.32ZM48,80V48H72v8a8,8,0,0,0,16,0V48h80v8a8,8,0,0,0,16,0V48h24V80Z" />
    </svg>
  );
}

function BottomButton({
  active,
  label,
  navigation,
  count
}: {
  active: boolean;
  label: string;
  navigation: BottomIconName;
  count: number;
}) {
  const badgeId = navigation === "chat"
    ? "sidebarChatUnreadBadge"
    : navigation === "explore"
      ? "sidebarExploreUnreadBadge"
      : "sidebarTasksUnreadBadge";
  return (
    <button
      className={`sidebar-bottom-nav-button${active ? " active" : ""}`}
      type="button"
      data-primary-nav={navigation}
      data-react-owned="true"
      title={label}
      aria-label={label}
      onClick={() => bridge.invoke("showPrimaryNavigation", navigation)}
    >
      <span className="sidebar-bottom-icon" data-sidebar-bottom-icon={navigation} aria-hidden="true">
        <BottomIcon name={navigation} />
      </span>
      <span className="sidebar-bottom-label" aria-hidden="true">{label}</span>
      <UnreadBadge id={badgeId} className="sidebar-bottom-badge" count={count} />
    </button>
  );
}

export function BottomNavigation() {
  const snapshot = useRendererShell();
  const primary = snapshot.activeView === "chat"
    ? "chat"
    : snapshot.activeView === "tasks"
      ? "tasks"
      : snapshot.activeView === "settings"
        ? "me"
        : "explore";
  return (
    <>
      <BottomButton active={primary === "chat"} label="聊天" navigation="chat" count={snapshot.chatUnread} />
      <BottomButton active={primary === "explore"} label="探索" navigation="explore" count={snapshot.contactsUnread} />
      <BottomButton active={primary === "tasks"} label="任务" navigation="tasks" count={snapshot.tasksUnread} />
      <button
        className={`sidebar-bottom-nav-button sidebar-bottom-avatar-button${primary === "me" ? " active" : ""}`}
        type="button"
        data-primary-nav="me"
        data-react-owned="true"
        title="我"
        aria-label="我"
        onClick={() => bridge.invoke("showPrimaryNavigation", "me")}
      >
        <LegacySidebarAvatar />
      </button>
    </>
  );
}
