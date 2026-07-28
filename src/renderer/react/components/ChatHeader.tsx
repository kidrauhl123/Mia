import { memo } from "react";
import { LegacySurface } from "./LegacySurface";

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
            <LegacySurface id="chatConversationList" />
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
              <LegacySurface id="sessionList" />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
