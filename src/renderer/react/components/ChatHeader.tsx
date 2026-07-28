import { memo, useEffect, useLayoutEffect, useRef } from "react";
import { useChatMenus, type ChatConversationMenuRow, type SessionMenuRow } from "../stores/chat-menus";
import type { AvatarView, StatusBadgeView } from "../stores/contacts";

const BackIcon = memo(function BackIcon() {
  return (
    <svg
      className="narrow-back-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.35"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M15 18L9 12L15 6" />
    </svg>
  );
});

const SessionHistoryIcon = memo(function SessionHistoryIcon() {
  return (
    <svg viewBox="0 0 48 48" fill="none" focusable="false">
      <path
        d="M5.81836 6.72729V14H13.0911"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 24C4 35.0457 12.9543 44 24 44V44C35.0457 44 44 35.0457 44 24C44 12.9543 35.0457 4 24 4C16.598 4 10.1351 8.02111 6.67677 13.9981"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M24.005 12L24.0038 24.0088L32.4832 32.4882"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
});

function Avatar({ avatar, className }: { avatar: AvatarView; className: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (ref.current) {
      window.miaAvatar?.applyAvatarMedia?.(
        ref.current,
        avatar.image,
        avatar.crop,
        avatar.color,
        avatar.text
      );
    }
  }, [avatar.color, avatar.crop, avatar.image, avatar.text]);
  return <span ref={ref} className={className} />;
}

function StatusBadge({ badge }: { badge: StatusBadgeView }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (badge.kind === "lottie" && ref.current) window.miaNameWithBadge?.initLottieBadges?.(ref.current);
  }, [badge]);
  if (badge.kind === "emoji") {
    return <span className="name-with-badge-badge name-with-badge-badge-emoji" title={badge.label}>{badge.emoji}</span>;
  }
  const assetId = badge.assetId || "";
  return (
    <span
      ref={ref}
      className={`name-with-badge-badge name-with-badge-badge-${badge.kind}`}
      title={badge.label}
      data-asset-id={assetId || undefined}
      data-collectible-id={badge.collectibleId || undefined}
      data-lottie={badge.kind === "lottie" ? assetId : undefined}
      data-lottie-trigger={badge.kind === "lottie" ? "loop" : undefined}
      data-lottie-renderer={badge.kind === "lottie" ? "canvas" : undefined}
      data-lottie-path={badge.kind === "lottie" ? window.miaNameWithBadge?.statusBadgeAssetUrl?.(assetId) : undefined}
      aria-hidden="true"
    />
  );
}

function ConversationAvatar({ row }: { row: ChatConversationMenuRow }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host || row.kind !== "group") return;
    if (row.customAvatar?.image) {
      window.miaAvatar?.applyAvatarMedia?.(
        host,
        row.customAvatar.image,
        row.customAvatar.crop,
        row.customAvatar.color,
        row.customAvatar.text
      );
      return;
    }
    window.miaGroupAvatar?.applyGroupAvatar?.(host, row.members);
  }, [row.customAvatar, row.kind, row.members]);
  if (row.kind === "private" && row.avatar) return <Avatar avatar={row.avatar} className="avatar bot-photo" />;
  return <span ref={ref} className="avatar group-avatar" />;
}

function PinIcon() {
  return (
    <svg className="icon-park-pin" viewBox="0 0 48 48" aria-hidden="true">
      <path d="M10.696 17.504c2.639-2.638 5.774-2.565 9.182-.696L32.62 9.745l-.721-4.958 11.314 11.314-4.947-.71-7.074 12.73c1.783 3.637 1.942 6.543-.697 9.182l-7.778-7.778L6.443 41.556l11.995-16.31-7.742-7.742Z" />
    </svg>
  );
}

function ChatConversationRow({ row }: { row: ChatConversationMenuRow }) {
  return (
    <div
      className={[
        "persona message-card chat-conversation-menu-row",
        row.kind === "group" ? "group-persona" : "private-message-card",
        row.active ? "active" : "",
        row.pinned ? "pinned" : ""
      ].filter(Boolean).join(" ")}
      role="option"
      tabIndex={0}
      aria-selected={row.active}
      onClick={row.open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          row.open();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        row.openContextMenu(event.clientX, event.clientY);
      }}
    >
      <ConversationAvatar row={row} />
      <span className="persona-main">
        <span className="persona-name-row">
          <span className="persona-name">
            <span className="name-with-badge">
              <span className="name-with-badge-text">{row.name}</span>
              {row.badge ? <StatusBadge badge={row.badge} /> : null}
            </span>
          </span>
          {row.muted ? (
            <svg className="persona-muted-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M13.7 21a2 2 0 0 1-3.4 0M18 8a6 6 0 0 0-9.8-4.6M6 8c0 7-3 7-3 9h14M3 3l18 18" />
            </svg>
          ) : null}
          <span className={`persona-type${row.kind === "group" ? " group" : ""}`}>{row.typeLabel}</span>
          <span className="persona-time">{row.time}</span>
          <span className={`persona-side${!row.pinned && !row.unread ? " empty" : ""}`}>
            <span className={`persona-pin${row.pinned ? "" : " hidden"}`} aria-label="置顶"><PinIcon /></span>
            <span className={`persona-unread${row.muted ? " muted" : ""}${row.unread ? "" : " hidden"}`}>
              {row.unread > 99 ? "99+" : row.unread || ""}
            </span>
          </span>
        </span>
      </span>
    </div>
  );
}

function ChatConversationList() {
  const { conversationRows } = useChatMenus();
  if (!conversationRows.length) return <div className="chat-conversation-menu-empty">暂无对话</div>;
  return <>{conversationRows.map((row) => <ChatConversationRow key={row.id} row={row} />)}</>;
}

function EditIcon() {
  return (
    <svg className="session-row-edit-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m15 5 4 4L8 20H4v-4L15 5Z" />
      <path d="m13 7 4 4" />
    </svg>
  );
}

function SessionRow({ row }: { row: SessionMenuRow }) {
  const inputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (row.rename && !row.saving) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [row.rename, row.saving]);
  if (row.rename) {
    return (
      <div className={`session-row${row.active ? " active" : ""} editing`} role="option" tabIndex={0}>
        <form className="session-row-rename" onSubmit={(event) => { event.preventDefault(); row.save(); }}>
          <input
            ref={inputRef}
            className="session-row-rename-input"
            value={row.draft}
            aria-label="会话名称"
            disabled={row.saving}
            onChange={(event) => row.setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                row.cancelRename();
              }
            }}
          />
          <button className="session-row-rename-save" type="submit" disabled={row.saving}>确定</button>
          <button className="session-row-rename-cancel" type="button" disabled={row.saving} onClick={row.cancelRename}>取消</button>
          {row.error ? <small className="session-row-rename-error">{row.error}</small> : null}
        </form>
      </div>
    );
  }
  return (
    <div
      className={`session-row${row.active ? " active" : ""}`}
      role="option"
      tabIndex={0}
      onClick={() => row.select()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          row.select();
        }
      }}
    >
      <span><strong>{row.title}</strong><small>{row.time}</small></span>
      <span className="session-row-actions">
        {row.unread ? <span className="session-row-unread" aria-label={`${row.unread} 条未读消息`}>{row.unread > 99 ? "99+" : row.unread}</span> : null}
        <button
          className="session-row-edit"
          type="button"
          title="重命名"
          aria-label="重命名会话"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            row.edit();
          }}
        >
          <EditIcon />
        </button>
      </span>
    </div>
  );
}

function SessionList() {
  const { sessionRows } = useChatMenus();
  return <>{sessionRows.map((row) => <SessionRow key={row.id} row={row} />)}</>;
}

/**
 * React owns the stable chat-header structure. The legacy controller currently
 * paints the avatar/title/meta leaves and wires the existing actions after this
 * root is mounted synchronously.
 */
export function ChatHeader() {
  return (
    <>
      <div className="group-title">
        <button
          className="narrow-back-button"
          type="button"
          data-narrow-back
          title="返回消息栏"
          aria-label="返回消息栏"
        >
          <BackIcon />
        </button>
        <div
          id="activeConversationMenuButton"
          className="active-conversation-menu-button"
          role="button"
          tabIndex={0}
          aria-label="切换对话"
          aria-haspopup="listbox"
          aria-expanded="false"
          aria-controls="chatConversationMenu"
        >
          <div id="activeChatAvatar" className="profile-avatar">A</div>
          <div className="group-title-copy">
            <h1><span id="activeChatName">Mia</span></h1>
            <p id="activeChatMeta">Bot</p>
          </div>
        </div>
        <div
          id="chatConversationMenu"
          className="chat-conversation-menu hidden"
          role="listbox"
          aria-label="切换对话"
        >
          <div id="chatConversationList" className="chat-conversation-list">
            <ChatConversationList />
          </div>
        </div>
      </div>
      <div className="top-actions">
        <button
          id="groupInfoButton"
          className="icon-button group-info-topbar-btn hidden"
          type="button"
          title="群信息"
          aria-label="群信息"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="8" />
            <path d="M12 10.5v5.5" />
            <path d="M12 7.5h.01" />
          </svg>
        </button>
        <div className="session-menu-wrap">
          <button
            id="sessionMenuButton"
            className="session-trigger"
            type="button"
            title="会话记录"
            aria-label="会话记录"
          >
            <span className="session-trigger-icon" aria-hidden="true">
              <SessionHistoryIcon />
            </span>
            <span id="currentSessionTitle" className="current-session-title">新对话</span>
            <span id="sessionUnreadBadge" className="session-trigger-unread hidden" aria-hidden="true" />
          </button>
          <button
            id="newSession"
            className="icon-button session-new-button"
            type="button"
            title="新建对话"
            aria-label="新建对话"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <div id="sessionMenu" className="session-menu hidden">
            <div id="sessionList" className="session-list">
              <SessionList />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

declare global {
  interface Window {
    miaGroupAvatar?: {
      applyGroupAvatar?(target: HTMLElement, members: readonly Readonly<Record<string, unknown>>[]): void;
    };
  }
}
