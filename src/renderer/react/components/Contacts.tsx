import {
  Fragment,
  useState,
  useEffect,
  useLayoutEffect,
  useRef
} from "react";
import { createPortal } from "react-dom";
import {
  useContacts,
  type AvatarView,
  type CapabilityOptionView,
  type ContactBotDetailView,
  type MemoryPanelView,
  type StatusBadgeView
} from "../stores/contacts";

function Avatar({ avatar, className }: { avatar: AvatarView; className: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    window.miaAvatar?.applyAvatarMedia?.(
      element,
      avatar.image,
      avatar.crop,
      avatar.color,
      avatar.text
    );
  }, [avatar.color, avatar.crop, avatar.image, avatar.text]);
  return <span ref={ref} className={className} />;
}

function StatusBadge({ badge }: { badge: StatusBadgeView }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (badge.kind === "lottie" && ref.current) {
      window.miaNameWithBadge?.initLottieBadges?.(ref.current);
    }
  }, [badge]);
  if (badge.kind === "emoji") {
    return <span className="name-with-badge-badge name-with-badge-badge-emoji" title={badge.label}>{badge.emoji}</span>;
  }
  const assetId = badge.assetId || "";
  const format = badge.kind === "lottie" ? window.miaNameWithBadge?.statusBadgeAssetFormat?.(assetId) : "";
  const path = badge.kind === "lottie" ? window.miaNameWithBadge?.statusBadgeAssetUrl?.(assetId) : "";
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
      data-lottie-format={format === "tgs" ? "tgs" : undefined}
      data-lottie-local={format === "tgs" ? "status-badge" : undefined}
      data-lottie-path={path || undefined}
      aria-hidden="true"
    />
  );
}

function NameWithBadge({ badge, name }: { badge: StatusBadgeView | null; name: string }) {
  return (
    <span className="name-with-badge">
      <span className="name-with-badge-text">{name}</span>
      {badge ? <StatusBadge badge={badge} /> : null}
    </span>
  );
}

export function ContactList() {
  const { emptyText, groups, requestCount, requestsActive, selectRequests } = useContacts();
  if (!groups.length && !requestCount) return <div className="contact-empty">{emptyText || "还没有联系人"}</div>;
  return (
    <>
      {requestCount ? (
        <button type="button" className={`contact-row${requestsActive ? " active" : ""}`} onClick={selectRequests}>
          <span className="avatar contact-request-avatar" aria-hidden="true">
            <svg className="contact-request-icon" viewBox="0 0 24 24">
              <path d="M15 19c0-2.76-2.69-5-6-5s-6 2.24-6 5" />
              <circle cx="9" cy="7" r="4" />
              <path d="M19 8v6M16 11h6" />
            </svg>
          </span>
          <span className="contact-row-main"><strong>新的好友</strong></span>
          <span className="contact-row-side"><span className="contact-request-badge">{requestCount > 99 ? "99+" : requestCount}</span></span>
        </button>
      ) : null}
      {groups.map((group) => (
        <Fragment key={group.key}>
          <button
            type="button"
            className={`contact-group-header contact-group-toggle${group.collapsed ? " collapsed" : ""}`}
            data-contact-group-key={group.key}
            aria-expanded={!group.collapsed}
            onClick={group.toggle}
          >
            <span>{group.label}</span>
            {group.rows.length ? <small>{group.rows.length}</small> : null}
          </button>
          {group.collapsed ? null : group.rows.map((row) => (
            <button
              key={row.key}
              type="button"
              className={`contact-row${row.active ? " active" : ""}`}
              onClick={row.select}
              onDoubleClick={row.open}
            >
              <Avatar avatar={row.avatar} className="avatar bot-photo" />
              <span className="contact-row-main">
                <strong><NameWithBadge name={row.name} badge={row.badge} /></strong>
                {row.deviceLabel ? <small>{row.deviceLabel}</small> : null}
              </span>
            </button>
          ))}
        </Fragment>
      ))}
    </>
  );
}

function EngineLogo({ kind }: { kind: string }) {
  const source = {
    hermes: "./assets/engine-icons/hermesagent.svg",
    claude: "./assets/engine-icons/claudecode.svg",
    codex: "./assets/engine-icons/codex-color.svg"
  }[kind];
  if (!source) return <span className={`engine-row-logo contact-engine-logo ${kind || "unknown"}`} aria-hidden="true" />;
  return (
    <span className={`engine-row-logo contact-engine-logo asset ${kind}`} aria-hidden="true">
      <img src={source} alt="" />
    </span>
  );
}

function CapabilityOption({ option, className }: { className: string; option: CapabilityOptionView }) {
  return (
    <label className={`capability-row ${className}`}>
      <input
        type="checkbox"
        checked={option.checked}
        onChange={(event) => option.setChecked(event.currentTarget.checked)}
      />
      <span className="capability-copy">
        <strong>{option.label}</strong>
        {option.originLabel ? <small>{option.originLabel}</small> : null}
      </span>
      <span className="capability-check" aria-hidden="true" />
    </label>
  );
}

function MemoryPanel({ memory }: { memory: MemoryPanelView }) {
  return (
    <details className="contact-memory accordion-details" open={memory.open} onToggle={(event) => memory.toggle(event.currentTarget.open)}>
      <summary>
        <div><strong>🧠 记忆</strong><p>{memory.summary}</p></div>
        <span className="runtime-target-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="accordion-body">
        {!memory.entries.length ? <p className="contact-memory-state">{memory.stateText}</p> : (
          <ol className="contact-memory-list">
            {memory.entries.map((entry) => (
              <li key={entry.index} className={`contact-memory-entry${entry.editing ? " editing" : ""}`}>
                <span className="contact-memory-index" aria-hidden="true">{entry.index + 1}</span>
                {entry.editing ? (
                  <div className="contact-memory-entry-editor">
                    <textarea
                      maxLength={2200}
                      aria-label={`编辑第 ${entry.index + 1} 条记忆`}
                      value={entry.draft}
                      onChange={(event) => memory.updateDraft(event.currentTarget.value)}
                    />
                    {entry.error ? <p className="contact-memory-editor-error" role="alert">{entry.error}</p> : null}
                    <div className="contact-memory-editor-actions">
                      <button className="secondary" type="button" disabled={entry.saving} onClick={memory.cancelEdit}>取消</button>
                      <button className="primary" type="button" disabled={entry.saving} onClick={memory.saveEdit}>
                        {entry.saving ? "保存中" : "保存"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p>{entry.text}</p>
                    <button
                      className="contact-memory-edit"
                      type="button"
                      title="编辑这条记忆"
                      aria-label={`编辑第 ${entry.index + 1} 条记忆`}
                      onClick={() => memory.edit(entry.index)}
                    >
                      <svg className="contact-memory-edit-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="m15 5 4 4L8 20H4v-4L15 5Z" />
                        <path d="m13 7 4 4" />
                      </svg>
                    </button>
                  </>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}

function BotDetail({ bot }: { bot: ContactBotDetailView }) {
  return (
    <article className="contact-profile">
      <header className="contact-profile-head">
        <button
          className="contact-profile-avatar"
          type="button"
          title={bot.canEdit ? "编辑联系人头像" : "联系人头像"}
          onClick={bot.canEdit ? bot.editContact : undefined}
        >
          <Avatar avatar={bot.avatar} className="avatar-media-host" />
        </button>
        <div className="contact-profile-title">
          <h2><NameWithBadge name={bot.name} badge={bot.badge} /></h2>
          <div className="contact-engine-badge" title="Agent 内核">
            <EngineLogo kind={bot.engineKind} />
            <span className="contact-engine-copy"><small>Agent</small><strong>{bot.engineLabel}</strong></span>
          </div>
          {bot.uid ? <p className="contact-profile-uid"><span>UID</span><code>{bot.uid}</code></p> : null}
        </div>
        <div className="contact-actions">
          <button className="primary contact-message-action" type="button" title="发消息" aria-label="发消息" onClick={bot.message}>
            <svg className="contact-action-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M21 12a8 8 0 0 1-8 8H6l-4 2 1.5-4A9 9 0 1 1 21 12Z" />
              <path d="M8 12h.01M12 12h.01M16 12h.01" />
            </svg>
          </button>
          {bot.canEdit ? <button className="secondary" type="button" onClick={bot.editContact}>编辑</button> : null}
          {bot.canDelete ? <button className="secondary danger" type="button" onClick={bot.deleteContact}>删除伙伴</button> : null}
        </div>
      </header>
      <section className="contact-info-card">
        <details className="contact-runtime-target accordion-details" open={bot.runtime.open} onToggle={(event) => bot.runtime.toggle(event.currentTarget.open)}>
          <summary>
            <div><strong>运行位置和 Agent 内核</strong><p>{bot.runtime.summary}</p></div>
            <span className="runtime-target-chevron" aria-hidden="true">⌄</span>
          </summary>
          <div className="accordion-body">
            <div className="runtime-target-list">
              {bot.runtime.groups.length ? bot.runtime.groups.map((group) => (
                <section key={group.key} className="runtime-device-group">
                  <div><strong>{group.label}</strong><small>{group.statusLabel}</small></div>
                  <div>
                    {group.options.length ? group.options.map((option, index) => (
                      <button
                        key={`${group.key}:${index}`}
                        type="button"
                        className={`runtime-target-option${option.selected ? " selected" : ""}`}
                        title={option.title}
                        disabled={option.disabled}
                        onClick={option.select}
                      >
                        <EngineLogo kind={option.engineKind} />
                        <span><strong>{option.label}</strong></span>
                      </button>
                    )) : <p className="runtime-target-empty">没有可用 Agent</p>}
                  </div>
                </section>
              )) : <p className="runtime-target-empty">正在同步运行目标…</p>}
            </div>
          </div>
        </details>
        {bot.capabilities ? (
          <details className="contact-capabilities accordion-details" open={bot.capabilities.open} onToggle={(event) => bot.capabilities?.toggle(event.currentTarget.open)}>
            <summary>
              <div><strong>能力</strong><p>{bot.capabilities.summary}</p></div>
              <span className="runtime-target-chevron" aria-hidden="true">⌄</span>
            </summary>
            <div className="accordion-body">
              <div className="capability-list capability-list-enabled">
                {bot.capabilities.enabled.length
                  ? bot.capabilities.enabled.map((option) => <CapabilityOption key={option.id} option={option} className="enabled" />)
                  : <div className="capability-empty">这个 Bot 还没有默认启用的技能</div>}
              </div>
              {bot.capabilities.addable.length ? (
                <details className="capability-add-details">
                  <summary><span aria-hidden="true">+</span><strong>添加技能</strong></summary>
                  <div className="capability-list capability-list-add">
                    {bot.capabilities.addable.map((option) => <CapabilityOption key={option.id} option={option} className="addable" />)}
                  </div>
                </details>
              ) : null}
            </div>
          </details>
        ) : null}
        <details className="contact-persona-card accordion-details" open={bot.persona.open} onToggle={(event) => bot.persona.toggle(event.currentTarget.open)}>
          <summary>
            <div><strong>人设</strong><p>{bot.persona.summary}</p></div>
            <span className="runtime-target-chevron" aria-hidden="true">⌄</span>
          </summary>
          <div className="accordion-body"><p className="contact-persona-text">{bot.persona.text}</p></div>
        </details>
        {bot.memory ? <MemoryPanel memory={bot.memory} /> : null}
      </section>
    </article>
  );
}

export function ContactDetail() {
  const { detail } = useContacts();
  if (detail.kind === "empty") return <div className="contact-empty detail-empty">{detail.text}</div>;
  if (detail.kind === "requests") {
    return (
      <article className="contact-profile contact-requests">
        <section className="contact-note contact-requests-card">
          <header className="contact-requests-head">
            <strong>收到的好友请求</strong>
            {detail.requests.length ? <span className="contact-requests-count">{detail.requests.length > 99 ? "99+" : detail.requests.length}</span> : null}
          </header>
          <div className="contact-request-list">
            {!detail.requests.length
              ? <p className="contact-request-empty">暂无新的好友请求</p>
              : detail.requests.map((request) => <FriendRequestRow key={request.id} request={request} />)}
          </div>
        </section>
      </article>
    );
  }
  return <BotDetail bot={detail.bot} />;
}

function FriendRequestRow({ request }: { request: import("../stores/contacts").FriendRequestView }) {
  const [pending, setPending] = useState<"accept" | "reject" | "">("");
  const respond = async (kind: "accept" | "reject") => {
    if (pending) return;
    setPending(kind);
    try {
      await request[kind]();
    } finally {
      setPending("");
    }
  };
  return (
    <div className="contact-request-row incoming">
      <Avatar avatar={request.avatar} className="avatar request-avatar" />
      <span className="contact-request-main"><NameWithBadge name={request.name} badge={request.badge} /></span>
      <button type="button" disabled={Boolean(pending)} className="button-primary contact-request-action" onClick={() => respond("accept")}>
        {pending === "accept" ? "处理中…" : "同意"}
      </button>
      <button type="button" disabled={Boolean(pending)} className="button-soft contact-request-action" onClick={() => respond("reject")}>
        {pending === "reject" ? "处理中…" : "拒绝"}
      </button>
    </div>
  );
}

export default function ContactPortals() {
  const list = document.getElementById("contactList");
  const detail = document.getElementById("contactDetail");
  return (
    <>
      {list ? createPortal(<ContactList />, list, "contact-list") : null}
      {detail ? createPortal(<ContactDetail />, detail, "contact-detail") : null}
    </>
  );
}

declare global {
  interface Window {
    miaAvatar?: {
      applyAvatarMedia?(
        target: HTMLElement,
        image: string,
        crop: Readonly<Record<string, unknown>> | null,
        color: string,
        text: string,
        options?: Readonly<Record<string, unknown>>
      ): void;
    };
    miaNameWithBadge?: {
      initLottieBadges?(root: HTMLElement): void;
      statusBadgeAssetFormat?(assetId: string): string;
      statusBadgeAssetUrl?(assetId: string): string;
    };
  }
}
