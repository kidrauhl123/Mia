import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import {
  useDialogs,
  type AddFriendDialogView,
  type AddFriendRequestView,
  type AvatarCropDialogView,
  type BotDialogView,
  type CloudLoginApprovalDialogView,
  type GroupCreateDialogView,
  type GroupInfoAddableMemberView,
  type GroupInfoDialogView,
  type GroupInfoMemberView,
  type IdentityBadgeChoiceView,
  type McpFormDialogView,
  type McpFormValues,
  type McpTemplateDialogView,
  type PetGenerateDialogView,
  type ProfileDialogView,
  type TaskCreateDialogView,
  type TaskCreateValues
} from "../stores/dialogs";
import type { SkillSourceLogo } from "../stores/skills";
import type { AvatarView, StatusBadgeView } from "../stores/contacts";

function SourceLogo({ logo }: { logo: SkillSourceLogo | null }) {
  if (!logo) return null;
  const className = `skill-source-logo skill-source-logo-${logo.key}`;
  return logo.mask ? (
    <span className={className} aria-hidden="true" title={logo.label}>
      <span className="skill-source-logo-mask" />
    </span>
  ) : (
    <span className={className} aria-hidden="true" title={logo.label}>
      <img src={logo.src} alt="" />
    </span>
  );
}

function SkillDialog() {
  const { dialog } = useDialogs();
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    for (const link of bodyRef.current?.querySelectorAll<HTMLAnchorElement>("a[href]") || []) {
      link.target = "_blank";
      link.rel = "noreferrer";
    }
  }, [dialog.kind === "skill" ? dialog.bodyHtml : ""]);
  if (dialog.kind !== "skill") return null;
  return (
    <div className="skill-market-modal" role="dialog" aria-modal="true">
      <div className="smm-backdrop" onClick={dialog.close} />
      <div className="smm-panel">
        <button className="smm-close" type="button" onClick={dialog.close} aria-label="关闭">×</button>
        <div className={`smm-intro${dialog.showBody ? " hidden" : ""}`}>
          <div className="smm-source-logo"><SourceLogo logo={dialog.sourceLogo} /></div>
          <div className="smm-title">{dialog.title}</div>
          <div className="smm-meta">{dialog.meta}</div>
          <p className="smm-summary">{dialog.summary}</p>
        </div>
        <div className={`smm-body${dialog.showBody ? "" : " hidden"}`}>
          <button className="smm-back" type="button" onClick={dialog.back}>‹ 返回简介</button>
          <div
            ref={bodyRef}
            className="smm-body-content"
            dangerouslySetInnerHTML={dialog.bodyHtml ? { __html: dialog.bodyHtml } : undefined}
          >
            {!dialog.bodyHtml ? <div className="skill-empty-state">{dialog.bodyState}</div> : null}
          </div>
        </div>
        <div className="smm-actions">
          <button className="smm-body-toggle" type="button" onClick={dialog.toggleBody}>
            {dialog.showBody ? "收起正文" : "展开正文"}
          </button>
          <button
            className={`smm-add${dialog.actionInstalled ? " smm-add-installed" : ""}`}
            type="button"
            disabled={dialog.actionDisabled}
            onClick={dialog.primary}
          >
            {dialog.actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function McpFormDialog({ dialog }: { dialog: McpFormDialogView }) {
  const [values, setValues] = useState<McpFormValues>(dialog.initial);
  const set = (key: keyof McpFormValues, value: string) => setValues((current) => ({ ...current, [key]: value }));
  const stdio = values.type === "stdio";
  return (
    <section className="mcp-dialog" role="dialog" aria-modal="true" aria-label={dialog.title}>
      <div className="mcp-dialog-backdrop" onClick={dialog.close} />
      <form className="mcp-dialog-panel" onSubmit={(event) => { event.preventDefault(); dialog.submit(values); }}>
        <header className="mcp-dialog-head">
          <h2>{dialog.title}</h2>
          <button type="button" onClick={dialog.close} aria-label="关闭">×</button>
        </header>
        <label>名称<input name="name" value={values.name} onChange={(event) => set("name", event.currentTarget.value)} required /></label>
        <label>描述<input name="description" value={values.description} onChange={(event) => set("description", event.currentTarget.value)} /></label>
        <label>传输类型
          <select name="type" value={values.type} onChange={(event) => set("type", event.currentTarget.value)}>
            {["stdio", "http", "sse", "streamable_http"].map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
        {stdio ? (
          <>
            <label>命令<input name="command" value={values.command} onChange={(event) => set("command", event.currentTarget.value)} /></label>
            <label>参数<textarea name="args" value={values.args} onChange={(event) => set("args", event.currentTarget.value)} /></label>
            <label>环境变量<textarea name="env" value={values.env} onChange={(event) => set("env", event.currentTarget.value)} /></label>
          </>
        ) : (
          <>
            <label>URL<input name="url" value={values.url} onChange={(event) => set("url", event.currentTarget.value)} /></label>
            <label>Headers<textarea name="headers" value={values.headers} onChange={(event) => set("headers", event.currentTarget.value)} /></label>
            <label>Bearer Token 环境变量<input name="bearerTokenEnvVar" value={values.bearerTokenEnvVar} onChange={(event) => set("bearerTokenEnvVar", event.currentTarget.value)} /></label>
          </>
        )}
        <footer className="mcp-dialog-actions">
          <button type="button" onClick={dialog.close}>取消</button>
          <button className="mcp-dialog-primary" type="submit">{dialog.id ? "保存" : "添加"}</button>
        </footer>
      </form>
    </section>
  );
}

function McpTemplateDialog({ dialog }: { dialog: McpTemplateDialogView }) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const values = Object.fromEntries(dialog.fields.map((field) => [field.key, String(data.get(field.key) || "").trim()]));
    dialog.submit(values);
  };
  return (
    <section className="mcp-dialog" role="dialog" aria-modal="true" aria-label={`连接 ${dialog.title}`}>
      <div className="mcp-dialog-backdrop" onClick={dialog.close} />
      <form className="mcp-dialog-panel" onSubmit={submit}>
        <header className="mcp-dialog-head">
          <h2>{dialog.title}</h2>
          <button type="button" onClick={dialog.close} aria-label="关闭">×</button>
        </header>
        <p className="mcp-dialog-copy">{dialog.copy}</p>
        {dialog.fields.map((field) => (
          <label key={field.key}>
            {field.label}
            <input
              name={field.key}
              type={field.secret ? "password" : "text"}
              autoComplete="off"
              required={field.required}
              disabled={dialog.busy}
            />
          </label>
        ))}
        <footer className="mcp-dialog-actions">
          <button type="button" onClick={dialog.close} disabled={dialog.busy}>取消</button>
          <button className="mcp-dialog-primary" type="submit" disabled={dialog.busy}>{dialog.busy ? "连接中…" : "连接"}</button>
        </footer>
      </form>
    </section>
  );
}

function FriendAvatar({ avatar, className = "avatar request-avatar" }: { avatar: AvatarView; className?: string }) {
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

function FriendBadge({ badge }: { badge: StatusBadgeView }) {
  if (badge.kind === "emoji") {
    return <span className="name-with-badge-badge name-with-badge-badge-emoji" title={badge.label}>{badge.emoji}</span>;
  }
  return (
    <span
      className={`name-with-badge-badge name-with-badge-badge-${badge.kind}`}
      title={badge.label}
      data-asset-id={badge.assetId}
      data-collectible-id={badge.collectibleId}
      aria-hidden="true"
    />
  );
}

function FriendRequest({ request }: { request: AddFriendRequestView }) {
  const [pending, setPending] = useState("");
  const run = async (label: string, action: (() => Promise<void>) | null) => {
    if (!action || pending) return;
    setPending(label);
    try {
      await action();
    } finally {
      setPending("");
    }
  };
  return (
    <div className={`contact-request-row ${request.cancel ? "outgoing" : "incoming"}`}>
      <FriendAvatar avatar={request.avatar} />
      <span className="contact-request-main">
        <span className="name-with-badge">
          <span className="name-with-badge-text">{request.name}</span>
          {request.badge ? <FriendBadge badge={request.badge} /> : null}
        </span>
      </span>
      {request.accept ? (
        <>
          <button type="button" disabled={Boolean(pending)} className="button-primary contact-request-action" onClick={() => run("accept", request.accept)}>
            {pending === "accept" ? "处理中…" : "同意"}
          </button>
          <button type="button" disabled={Boolean(pending)} className="button-soft contact-request-action" onClick={() => run("reject", request.reject)}>
            {pending === "reject" ? "处理中…" : "拒绝"}
          </button>
        </>
      ) : (
        <button type="button" disabled={Boolean(pending)} className="button-soft contact-request-action" onClick={() => run("cancel", request.cancel)}>
          {pending === "cancel" ? "处理中…" : "撤回"}
        </button>
      )}
    </div>
  );
}

function AddFriendDialog({ dialog }: { dialog: AddFriendDialogView }) {
  const [uid, setUid] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [copyLabel, setCopyLabel] = useState("复制");
  const send = async () => {
    if (sending) return;
    setSending(true);
    try {
      const nextError = await dialog.send(uid);
      setError(nextError);
      if (!nextError) setUid("");
    } finally {
      setSending(false);
    }
  };
  const copy = async () => {
    await dialog.copyUid();
    setCopyLabel("已复制");
    window.setTimeout(() => setCopyLabel("复制"), 1200);
  };
  return (
    <section
      className="skill-preview-dialog"
      role="dialog"
      aria-modal="true"
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.close();
      }}
    >
      <div className="skill-preview-card group-create-card add-friend-card">
        <div className="skill-preview-toolbar">
          <div className="skill-preview-title"><h2>添加好友</h2></div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={dialog.close}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div className="group-create-body">
          <section className="group-create-section">
            <div className="group-create-section-header"><span className="group-create-section-title">我的 UID</span></div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
              <span style={{ fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{dialog.myUid || "—"}</span>
              <button type="button" className="button-soft" style={{ fontSize: 12, padding: "3px 8px" }} onClick={copy}>{copyLabel}</button>
            </div>
          </section>
          <section className="group-create-section">
            <div className="group-create-section-header"><span className="group-create-section-title">发送好友请求</span></div>
            <div className="add-friend-send-row">
              <input
                className="group-create-input"
                type="text"
                placeholder="对方的 UID"
                inputMode="numeric"
                style={{ flex: 1 }}
                value={uid}
                onChange={(event) => { setUid(event.currentTarget.value); setError(""); }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    send();
                  }
                }}
              />
              <button type="button" className="add-friend-icon-button" disabled={sending} title="发送好友请求" aria-label="发送好友请求" onClick={send}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7" /><path d="M9 7h8v8" /></svg>
              </button>
            </div>
            <p style={{ color: "#ff3b30", fontSize: 13, marginTop: 4, minHeight: 18 }}>{error}</p>
          </section>
          {dialog.incoming.length ? (
            <section className="group-create-section">
              <div className="group-create-section-header"><span className="group-create-section-title">收到的好友请求</span></div>
              <div>{dialog.incoming.map((request) => <FriendRequest key={request.id} request={request} />)}</div>
            </section>
          ) : null}
          {dialog.outgoing.length ? (
            <section className="group-create-section">
              <div className="group-create-section-header"><span className="group-create-section-title">我发出的请求</span></div>
              <div>{dialog.outgoing.map((request) => <FriendRequest key={request.id} request={request} />)}</div>
            </section>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function localDateValue() {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function TaskCreateDialog({ dialog }: { dialog: TaskCreateDialogView }) {
  const [values, setValues] = useState<TaskCreateValues>({
    botId: dialog.botId,
    date: localDateValue(),
    dayOfMonth: 1,
    frequency: "oneshot",
    prompt: "",
    time: "09:00",
    title: "",
    weekday: 0
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof TaskCreateValues>(key: K, value: TaskCreateValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setError("");
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      setError(await dialog.submit(values));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section
      className="bot-dialog task-create-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="taskCreateTitle"
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.close();
      }}
    >
      <form className="bot-form" onSubmit={submit}>
        <header className="bot-dialog-head">
          <div><h2 id="taskCreateTitle">新建自动任务</h2></div>
          <button className="icon-button" type="button" title="关闭" aria-label="关闭" onClick={dialog.close}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <label>
          <span>名称 <i className="req">*</i></span>
          <span className="task-field">
            <input maxLength={50} autoComplete="off" placeholder="请输入任务名称" value={values.title} onChange={(event) => set("title", event.currentTarget.value)} autoFocus />
            <em className="task-field-count">{values.title.length}/50</em>
          </span>
        </label>
        <label>
          <span>执行的 Agent <i className="req">*</i></span>
          <select value={values.botId} onChange={(event) => set("botId", event.currentTarget.value)}>
            {!dialog.bots.length ? <option value="">（请先在通讯录添加一个 Agent）</option> : null}
            {dialog.bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.label}</option>)}
          </select>
        </label>
        <label>
          <span>要求说明 <i className="req">*</i></span>
          <span className="task-field">
            <textarea maxLength={8000} placeholder="请输入任务要求说明" value={values.prompt} onChange={(event) => set("prompt", event.currentTarget.value)} />
            <em className="task-field-count task-field-count-area">{values.prompt.length}/8000</em>
          </span>
        </label>
        <label>
          <span>执行时间 <i className="req">*</i></span>
          <div className="task-time-row">
            <select
              value={values.frequency}
              onChange={(event) => set("frequency", event.currentTarget.value as TaskCreateValues["frequency"])}
            >
              <option value="oneshot">单次</option>
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
            </select>
            <div className="task-time-controls">
              {values.frequency === "oneshot" ? <input type="date" value={values.date} onChange={(event) => set("date", event.currentTarget.value)} /> : null}
              {values.frequency === "weekly" ? (
                <select value={values.weekday} onChange={(event) => set("weekday", Number(event.currentTarget.value))}>
                  {["周日", "周一", "周二", "周三", "周四", "周五", "周六"].map((day, index) => <option key={day} value={index}>{day}</option>)}
                </select>
              ) : null}
              {values.frequency === "monthly" ? (
                <select value={values.dayOfMonth} onChange={(event) => set("dayOfMonth", Number(event.currentTarget.value))}>
                  {Array.from({ length: 28 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1} 号</option>)}
                </select>
              ) : null}
              <input type="time" value={values.time} onChange={(event) => set("time", event.currentTarget.value)} />
            </div>
          </div>
        </label>
        {error ? <div className="task-create-error">{error}</div> : null}
        <footer className="bot-dialog-actions">
          <button className="secondary" type="button" onClick={dialog.close} disabled={saving}>取消</button>
          <button className="primary" type="submit" disabled={saving}>{saving ? "保存中…" : "确定"}</button>
        </footer>
      </form>
    </section>
  );
}

function GroupCreateDialog({ dialog }: { dialog: GroupCreateDialogView }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const toggle = (key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else if (next.size < 5) next.add(key);
      return next;
    });
    setError("");
  };
  const submit = async () => {
    if (!selected.size || saving) return;
    setSaving(true);
    try {
      setError(await dialog.submit([...selected], name));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section
      className="skill-preview-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="groupCreateTitle"
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.close();
      }}
    >
      <div className="skill-preview-card group-create-card">
        <div className="skill-preview-toolbar">
          <div className="skill-preview-title"><h2 id="groupCreateTitle">新建群聊</h2></div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={dialog.close}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div className="group-create-body">
          <section className="group-create-section">
            <div className="group-create-section-header">
              <span className="group-create-section-title">选择成员</span>
              <span className="group-create-section-meta"><span>{selected.size}</span> / 5</span>
            </div>
            <div className="group-create-members" role="listbox" aria-multiselectable="true">
              {!dialog.members.length ? <div className="group-create-members-empty">还没有联系人</div> : null}
              {dialog.members.map((member) => {
                const active = selected.has(member.key);
                return (
                  <button
                    key={member.key}
                    type="button"
                    className={`group-create-member-row${active ? " is-selected" : ""}`}
                    role="option"
                    aria-selected={active}
                    onClick={() => toggle(member.key)}
                  >
                    <FriendAvatar avatar={member.avatar} className="member-avatar" />
                    <span className="member-name">
                      <span className="name-with-badge">
                        <span className="name-with-badge-text">{member.name}</span>
                        {member.badge ? <FriendBadge badge={member.badge} /> : null}
                      </span>
                    </span>
                    <span className="member-check" aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          </section>
          <section className="group-create-section">
            <div className="group-create-section-header">
              <span className="group-create-section-title">群名</span>
              <span className="group-create-section-hint">留空则用成员名拼接</span>
            </div>
            <input className="group-create-input" type="text" maxLength={40} placeholder="未命名群聊" value={name} onChange={(event) => setName(event.currentTarget.value)} />
          </section>
          {error ? <p className="task-create-error">{error}</p> : null}
          <div className="group-create-actions">
            <button className="button-soft" type="button" onClick={dialog.close} disabled={saving}>取消</button>
            <button className="button-primary" type="button" onClick={submit} disabled={!selected.size || saving}>{saving ? "创建中…" : "创建"}</button>
          </div>
        </div>
      </div>
    </section>
  );
}

function GroupAvatar({ dialog }: { dialog: GroupInfoDialogView }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const target = ref.current;
    if (!target) return;
    if (dialog.avatar?.image) {
      target.className = "avatar";
      window.miaAvatar?.applyAvatarMedia?.(
        target,
        dialog.avatar.image,
        dialog.avatar.crop,
        dialog.avatar.color,
        dialog.avatar.text
      );
      target.removeAttribute("data-count");
      return;
    }
    target.className = "avatar group-avatar";
    target.style.cssText = "";
    window.miaGroupAvatar?.applyGroupAvatar?.(target, dialog.mosaic);
  }, [dialog.avatar, dialog.mosaic]);
  return <span ref={ref} className="avatar group-avatar" />;
}

function GroupInfoMember({
  member,
  reportError
}: {
  member: GroupInfoMemberView;
  reportError: (error: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    try {
      reportError(await action());
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="group-info-member-row">
      <span className="group-info-member-main">
        <FriendAvatar avatar={member.avatar} className="member-avatar" />
        <span className="group-info-member-name">
          <span className="name-with-badge">
            <span className="name-with-badge-text">{member.name}</span>
            {member.badge ? <FriendBadge badge={member.badge} /> : null}
          </span>
          {member.host ? <span className="group-info-host-badge">群主</span> : null}
        </span>
      </span>
      <span className="group-info-member-actions">
        <button
          type="button"
          className="group-info-member-action-button"
          aria-label="成员操作"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          ⋯
        </button>
        <span className={`group-info-member-action-menu${open ? "" : " hidden"}`}>
          {member.canSetHost ? (
            <button type="button" disabled={member.host || busy} onClick={() => run(member.setHost)}>设为群主</button>
          ) : null}
          <button type="button" disabled={!member.canRemove || busy} onClick={() => run(member.remove)}>
            {member.removeLabel}
          </button>
        </span>
      </span>
    </div>
  );
}

function GroupInfoAddableMember({
  member,
  reportError
}: {
  member: GroupInfoAddableMemberView;
  reportError: (error: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (busy) return;
    setBusy(true);
    try {
      reportError(await member.add());
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="group-info-addable-row" type="button" disabled={busy} onClick={add}>
      <FriendAvatar avatar={member.avatar} className="member-avatar" />
      <span className="name-with-badge">
        <span className="name-with-badge-text">{member.name}</span>
        {member.badge ? <FriendBadge badge={member.badge} /> : null}
      </span>
      <span>{busy ? "添加中…" : "添加"}</span>
    </button>
  );
}

function GroupInfoDialog({ dialog }: { dialog: GroupInfoDialogView }) {
  const [name, setName] = useState(dialog.name);
  const [goal, setGoal] = useState(dialog.goal);
  const [showAddable, setShowAddable] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setName(dialog.name), [dialog.name]);
  useEffect(() => setGoal(dialog.goal), [dialog.goal]);

  const reportError = (value: string) => setError(value);
  const chooseAvatar = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file?.type?.startsWith("image/")) return;
    const reader = new FileReader();
    reader.addEventListener("load", () => dialog.chooseAvatar(String(reader.result || "")));
    reader.readAsDataURL(file);
  };
  return (
    <section
      className="skill-preview-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="groupInfoTitle"
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.close();
      }}
    >
      <div className="skill-preview-card group-create-card group-info-card">
        <div className="skill-preview-toolbar">
          <div className="skill-preview-title">
            <h2 id="groupInfoTitle">群设置</h2>
            <p>成员、目标和 AI 回复方式</p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={dialog.close}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div className="group-info-body group-info-settings-card">
          <div className="settings-section-label">基础</div>
          <section className="settings-row settings-group-start">
            <div>
              <strong>群头像</strong>
              <p>默认按成员头像合成。点击可上传自定义图片，剪裁后保存。</p>
            </div>
            <div className="group-info-avatar-control">
              <button className="group-info-avatar-preview" type="button" aria-label="修改群头像" onClick={() => fileRef.current?.click()}>
                <GroupAvatar dialog={dialog} />
              </button>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={chooseAvatar} />
              <button className="button-soft" type="button" onClick={async () => reportError(await dialog.resetAvatar())}>恢复默认</button>
            </div>
          </section>
          <section className="settings-row">
            <div><strong>群名</strong><p>显示在会话列表和聊天顶部。</p></div>
            <input
              className="group-create-input"
              type="text"
              maxLength={40}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              onBlur={async () => reportError(await dialog.saveName(name))}
            />
          </section>
          <section className="settings-row settings-group-end">
            <div><strong>群号</strong><p>用于识别这个群聊，内部路由 ID 不直接展示。</p></div>
            <code className="group-info-public-id">{dialog.publicId}</code>
          </section>

          <div className="settings-section-label">成员</div>
          <section className="settings-row settings-group-start settings-group-end group-info-members-row">
            <div><strong>当前成员</strong><p>点右侧菜单可设群主或移除。</p></div>
            <div className="group-info-member-panel">
              <div className="group-info-members">
                {dialog.members.map((member) => <GroupInfoMember key={member.key} member={member} reportError={reportError} />)}
              </div>
              <button className="group-info-add-member-toggle" type="button" onClick={() => setShowAddable((value) => !value)}>
                {showAddable ? "收起" : "+ 添加成员"}
              </button>
              <div className={`group-info-addable${showAddable ? "" : " hidden"}`}>
                {dialog.addable.length
                  ? dialog.addable.map((member) => <GroupInfoAddableMember key={member.key} member={member} reportError={reportError} />)
                  : <div className="group-create-members-empty">没有可添加的联系人</div>}
              </div>
            </div>
          </section>

          <div className="settings-section-label">上下文</div>
          <section className="settings-row settings-group-start">
            <div><strong>目标</strong><p>给群聊一个长期方向，供 AI 协作时参考。</p></div>
            <textarea
              className="group-create-input group-info-goal-input"
              maxLength={200}
              placeholder="比如：今天把这个 PR 写完"
              value={goal}
              onChange={(event) => setGoal(event.currentTarget.value)}
              onBlur={async () => reportError(await dialog.saveGoal(goal))}
            />
          </section>
          <section className="settings-row settings-group-end">
            <div><strong>维护</strong><p>清掉已压缩的群上下文摘要，后续重新积累。</p></div>
            <button className="button-soft danger-soft" type="button" onClick={async () => reportError(await dialog.resetContext())}>重置群上下文</button>
          </section>
          {error ? <p className="task-create-error">{error}</p> : null}
        </div>
      </div>
    </section>
  );
}

function IdentityBadgeGlyph({ badge }: { badge: StatusBadgeView | null }) {
  if (!badge) {
    return (
      <span className="identity-badge-empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <circle className="identity-badge-empty-ring" cx="12" cy="12" r="8.25" />
          <circle className="identity-badge-empty-eye" cx="9.4" cy="10.5" r=".78" />
          <circle className="identity-badge-empty-eye" cx="14.6" cy="10.5" r=".78" />
          <path className="identity-badge-empty-smile" d="M8.9 14.3c1.4 1.5 4.8 1.5 6.2 0" />
        </svg>
      </span>
    );
  }
  return <FriendBadge badge={badge} />;
}

function IdentityBadgePicker({
  choices,
  setValue,
  value
}: {
  choices: readonly IdentityBadgeChoiceView[];
  setValue: (value: string) => void;
  value: string;
}) {
  const root = useRef<HTMLDetailsElement>(null);
  const selected = choices.find((choice) => choice.value === value) || choices[0] || null;
  useLayoutEffect(() => {
    if (root.current) window.miaNameWithBadge?.initLottieBadges?.(root.current);
  }, [choices, value]);
  return (
    <details ref={root} className="identity-badge-details accordion-details">
      <summary className={`identity-badge-trigger${selected?.badge ? "" : " empty"}`} aria-label="徽章">
        <IdentityBadgeGlyph badge={selected?.badge || null} />
      </summary>
      <div className="accordion-body identity-badge-panel">
        <div className="identity-badge-choices">
          {choices.map((choice) => (
            <button
              key={choice.value || "empty"}
              type="button"
              className={choice.value === value ? "active" : ""}
              aria-label={choice.value ? `${choice.label}徽章` : "无徽章"}
              onClick={(event) => {
                setValue(choice.value);
                event.currentTarget.closest("details")?.removeAttribute("open");
              }}
            >
              {choice.badge
                ? <span className="identity-badge-choice-preview"><IdentityBadgeGlyph badge={choice.badge} /></span>
                : <span className="identity-badge-choice-empty">无</span>}
            </button>
          ))}
        </div>
      </div>
    </details>
  );
}

function AvatarColors({
  color,
  colors,
  setColor
}: {
  color: string;
  colors: readonly string[];
  setColor: (value: string) => void;
}) {
  const normalized = color.toLowerCase();
  const preset = colors.some((value) => value.toLowerCase() === normalized);
  return (
    <div className="avatar-colors" role="radiogroup" aria-label="头像颜色">
      {colors.map((value) => (
        <button
          key={value}
          type="button"
          className={`avatar-color-chip${normalized === value.toLowerCase() ? " is-selected" : ""}`}
          style={{ background: value }}
          title={value}
          aria-label={value}
          onClick={() => setColor(value)}
        />
      ))}
      <label className={`avatar-color-chip avatar-color-custom${normalized && !preset ? " is-selected" : ""}`} title="自定义颜色">
        <span className="avatar-color-lottie" data-lottie="rainbow" data-lottie-trigger="loop" aria-hidden="true" />
        <input
          type="color"
          aria-label="自定义颜色"
          value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#5e5ce6"}
          onChange={(event) => setColor(event.currentTarget.value)}
        />
      </label>
    </div>
  );
}

function AvatarUpload({
  avatar,
  chooseAvatar,
  openEditor
}: {
  avatar: AvatarView;
  chooseAvatar: (file: File) => void;
  openEditor: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const open = () => {
    if (avatar.image) openEditor();
    else fileRef.current?.click();
  };
  return (
    <div
      className="avatar-upload-shell"
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types || []).includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        const file = event.dataTransfer.files?.[0];
        if (file) chooseAvatar(file);
      }}
    >
      <button className="avatar-crop-preview" type="button" onClick={open} aria-label="调整头像裁剪">
        <FriendAvatar avatar={avatar} className="avatar-crop-preview-media" />
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) chooseAvatar(file);
        }}
      />
      <button className="avatar-upload-button" type="button" title="选择图片" aria-label="选择图片" onClick={() => fileRef.current?.click()}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12" /></svg>
      </button>
    </div>
  );
}

function ProfileDialog({ dialog }: { dialog: ProfileDialogView }) {
  return (
    <section id="profileDialog" className="profile-popover is-open" role="dialog" aria-labelledby="profileDialogTitle">
      <form className="bot-form profile-popover-form" onSubmit={(event) => event.preventDefault()}>
        <header className="bot-dialog-head">
          <div><h2 id="profileDialogTitle">个人资料</h2></div>
          <button className="icon-button" type="button" title="关闭" aria-label="关闭" onClick={dialog.close}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <section className="dialog-identity-card">
          <AvatarUpload avatar={dialog.avatar} chooseAvatar={dialog.chooseAvatar} openEditor={dialog.openAvatarEditor} />
          <div className="dialog-identity-main">
            <div className="identity-name-line dialog-identity-name-line">
              <input
                className="identity-name-input"
                autoComplete="off"
                placeholder="例如 小明"
                value={dialog.name}
                onChange={(event) => dialog.setName(event.currentTarget.value)}
              />
              <IdentityBadgePicker choices={dialog.badgeChoices} value={dialog.badgeValue} setValue={dialog.setBadge} />
            </div>
            <p className="profile-uid-line">UID <span>{dialog.uid}</span></p>
          </div>
        </section>
        <AvatarColors color={dialog.color} colors={dialog.colors} setColor={dialog.setColor} />
      </form>
    </section>
  );
}

function BotDialog({ dialog }: { dialog: BotDialogView }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      setError(await dialog.submit());
    } finally {
      setSaving(false);
    }
  };
  return (
    <section
      id="botDialog"
      className="bot-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="botDialogTitle"
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.close();
      }}
    >
      <form className="bot-form" onSubmit={submit}>
        <header className="bot-dialog-head">
          <div><h2 id="botDialogTitle">{dialog.title}</h2></div>
          <button className="icon-button" type="button" title="关闭" aria-label="关闭" onClick={dialog.close}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <section className="dialog-identity-card">
          <AvatarUpload avatar={dialog.avatar} chooseAvatar={dialog.chooseAvatar} openEditor={dialog.openAvatarEditor} />
          <div className="dialog-identity-main">
            <div className="identity-name-line dialog-identity-name-line">
              <input
                className="identity-name-input"
                autoComplete="off"
                placeholder="输入姓名"
                value={dialog.name}
                onChange={(event) => dialog.setName(event.currentTarget.value)}
                autoFocus={dialog.mode === "create"}
              />
              <IdentityBadgePicker choices={dialog.badgeChoices} value={dialog.badgeValue} setValue={dialog.setBadge} />
            </div>
          </div>
        </section>
        <AvatarColors color={dialog.color} colors={dialog.colors} setColor={dialog.setColor} />
        {dialog.runtimeLoading ? (
          <label>
            运行位置和 Agent 内核
            <select value="" disabled aria-label="正在检测本机 Agent">
              <option value="">正在检测本机 Agent…</option>
            </select>
          </label>
        ) : dialog.runtimeGroups.length ? (
          <label>
            运行位置和 Agent 内核
            <select value={dialog.runtimeValue} onChange={(event) => dialog.setRuntime(event.currentTarget.value)}>
              {dialog.runtimeGroups.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.options.map((option) => (
                    <option key={option.value} value={option.value} disabled={option.disabled} title={option.title}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        ) : null}
        {dialog.localAgentSetupRequired || dialog.runtimeLoadError ? (
          <aside className="bot-runtime-setup" aria-live="polite">
            <div>
              <strong>{dialog.runtimeLoadError ? "暂时无法读取 Agent 状态" : "本机尚未启用 Agent"}</strong>
              <p>
                {dialog.runtimeLoadError
                  ? dialog.runtimeLoadError
                  : "请前往“设置 → 模型”启用 Mia 稳定版。"}
              </p>
            </div>
            <button className="secondary" type="button" onClick={dialog.openModelSettings}>
              前往模型设置
            </button>
          </aside>
        ) : null}
        <details className="persona-details accordion-details" open={dialog.personaOpen} onToggle={(event) => dialog.setPersonaOpen(event.currentTarget.open)}>
          <summary>人设</summary>
          <div className="accordion-body">
            <label>
              <span>这段人设保存在 Mia 的 Bot 身份里，会作为该 Bot 的原生会话上下文使用。</span>
              <textarea
                placeholder="可留空，后续在对话中慢慢形成"
                value={dialog.persona}
                onChange={(event) => dialog.setPersona(event.currentTarget.value)}
              />
            </label>
          </div>
        </details>
        {error ? <div className="task-create-error">{error}</div> : null}
        <footer className="bot-dialog-actions">
          <button className="secondary" type="button" disabled={saving} onClick={dialog.close}>取消</button>
          <button
            className="primary"
            type="submit"
            disabled={saving || dialog.runtimeLoading || dialog.runtimeSetupRequired}
          >
            {saving ? "保存中…" : "保存伙伴"}
          </button>
        </footer>
      </form>
    </section>
  );
}

function cropNumber(crop: Readonly<Record<string, unknown>>, key: string, fallback: number) {
  const value = Number(crop[key]);
  return Number.isFinite(value) ? value : fallback;
}

function AvatarCropDialog({ dialog }: { dialog: AvatarCropDialogView }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageDrag = useRef<{ x: number; y: number } | null>(null);
  const trimDrag = useRef<{ duration: number; mode: string; offset: number; start: number } | null>(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const start = cropNumber(dialog.crop, "start", 0);
  const duration = cropNumber(dialog.crop, "duration", 3);
  const total = Math.max(videoDuration, start + duration, 5);
  const startPct = total ? Math.max(0, Math.min(100, (start / total) * 100)) : 0;
  const endPct = total ? Math.max(startPct, Math.min(100, ((start + duration) / total) * 100)) : 100;

  useLayoutEffect(() => {
    const target = stageRef.current;
    if (!target) return;
    window.miaAvatar?.applyAvatarMedia?.(
      target,
      dialog.image,
      dialog.crop,
      "#eef0ff",
      "",
      { preserveChildren: true }
    );
  }, [dialog.crop, dialog.image]);

  const setTrimRange = (nextStart: number, nextDuration: number) => {
    const minDuration = 1;
    const maxDuration = Math.min(5, total || 5);
    const safeDuration = Math.max(minDuration, Math.min(maxDuration, nextDuration || maxDuration));
    const safeStart = Math.max(0, Math.min(Math.max(0, total - safeDuration), nextStart || 0));
    dialog.update({ start: safeStart, duration: safeDuration });
  };
  const secondsFromPointer = (event: React.PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return rect.width > 0 ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * total : 0;
  };
  return (
    <section id="avatarCropDialog" className="avatar-crop-dialog" role="dialog" aria-modal="true" aria-labelledby="avatarCropTitle">
      <div className="avatar-crop-card">
        <header className="avatar-crop-head">
          <h2 id="avatarCropTitle">调整头像</h2>
          <button className="icon-button" type="button" title="关闭" aria-label="关闭" onClick={dialog.close}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <div
          ref={stageRef}
          className="avatar-crop-stage"
          onPointerDown={(event) => {
            event.preventDefault();
            stageDrag.current = { x: event.clientX, y: event.clientY };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = stageDrag.current;
            if (!drag) return;
            const dx = event.clientX - drag.x;
            const dy = event.clientY - drag.y;
            drag.x = event.clientX;
            drag.y = event.clientY;
            const zoom = cropNumber(dialog.crop, "zoom", 1);
            const panRange = (event.currentTarget.clientWidth || 320) * Math.max(zoom - 1, 0);
            if (panRange < 0.5) return;
            const sensitivity = Math.min(100 / panRange, 3);
            dialog.update({
              x: cropNumber(dialog.crop, "x", 50) - dx * sensitivity,
              y: cropNumber(dialog.crop, "y", 50) - dy * sensitivity
            });
          }}
          onPointerUp={(event) => {
            stageDrag.current = null;
            event.currentTarget.releasePointerCapture?.(event.pointerId);
          }}
          onPointerCancel={() => { stageDrag.current = null; }}
          onWheel={(event) => {
            event.preventDefault();
            dialog.update({ zoom: cropNumber(dialog.crop, "zoom", 1) + (event.deltaY > 0 ? -0.03 : 0.03) });
          }}
        >
          <div className="avatar-crop-circle" />
        </div>
        {dialog.isVideo ? (
          <section className="avatar-trim-controls" aria-label="头像视频时间">
            <div
              className="avatar-trim-timeline"
              role="group"
              aria-label="头像视频截取时间"
              style={{ "--trim-start": `${startPct}%`, "--trim-end": `${endPct}%` } as React.CSSProperties}
              onPointerDown={(event) => {
                event.preventDefault();
                const seconds = secondsFromPointer(event);
                const mode = (event.target as HTMLElement)?.dataset?.avatarTrimHandle || "track";
                if (mode === "selection") trimDrag.current = { mode, start, duration, offset: seconds - start };
                else if (mode === "start" || mode === "end") trimDrag.current = { mode, start, duration, offset: 0 };
                else {
                  setTrimRange(seconds - duration / 2, duration);
                  trimDrag.current = { mode: "selection", start: seconds - duration / 2, duration, offset: duration / 2 };
                }
                event.currentTarget.setPointerCapture?.(event.pointerId);
              }}
              onPointerMove={(event) => {
                const drag = trimDrag.current;
                if (!drag) return;
                const seconds = secondsFromPointer(event);
                if (drag.mode === "start") {
                  const end = drag.start + drag.duration;
                  const nextStart = Math.max(0, Math.min(seconds, end - 1));
                  setTrimRange(nextStart, end - nextStart);
                } else if (drag.mode === "end") {
                  const nextEnd = Math.max(drag.start + 1, Math.min(seconds, drag.start + 5, total));
                  setTrimRange(drag.start, nextEnd - drag.start);
                } else {
                  setTrimRange(seconds - drag.offset, drag.duration);
                }
              }}
              onPointerUp={(event) => {
                trimDrag.current = null;
                event.currentTarget.releasePointerCapture?.(event.pointerId);
              }}
              onPointerCancel={() => { trimDrag.current = null; }}
            >
              <div className="avatar-trim-frames" aria-hidden="true">
                {Array.from({ length: 8 }, (_, index) => <span key={index} className="avatar-trim-frame placeholder" />)}
              </div>
              <video
                ref={videoRef}
                className="avatar-trim-preview"
                src={dialog.image}
                muted
                playsInline
                preload="metadata"
                aria-hidden="true"
                onLoadedMetadata={(event) => setVideoDuration(Number(event.currentTarget.duration) || 0)}
              />
              <div className="avatar-trim-mask avatar-trim-mask-left" aria-hidden="true" />
              <div className="avatar-trim-mask avatar-trim-mask-right" aria-hidden="true" />
              <div className="avatar-trim-selection" data-avatar-trim-handle="selection" aria-hidden="true">
                <span className="avatar-trim-handle avatar-trim-handle-start" data-avatar-trim-handle="start" />
                <span className="avatar-trim-handle avatar-trim-handle-end" data-avatar-trim-handle="end" />
              </div>
              <span className="avatar-trim-label">{start.toFixed(1)}s - {(start + duration).toFixed(1)}s</span>
            </div>
          </section>
        ) : null}
        <footer className="avatar-crop-actions">
          <button className="secondary" type="button" onClick={dialog.reset}>重置</button>
          <span>拖拽移动，滚轮缩放</span>
          <button className="primary" type="button" onClick={dialog.confirm}>使用头像</button>
        </footer>
      </div>
    </section>
  );
}

function PetGenerateDialog({ dialog }: { dialog: PetGenerateDialogView }) {
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState("codex");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      setError(await dialog.submit(prompt, style));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section id="petGenerateDialog" className="pet-generate-dialog" role="dialog" aria-modal="true" aria-labelledby="petGenerateTitle">
      <form className="pet-generate-card" onSubmit={submit}>
        <header className="bot-dialog-head">
          <div>
            <h2 id="petGenerateTitle">{dialog.title}</h2>
            <p>{dialog.subtitle}</p>
          </div>
          <button className="icon-button" type="button" title="关闭" aria-label="关闭" onClick={dialog.close}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <label>
          补充描述
          <textarea placeholder="可选：补充这个 Bot 的动作、气质或细节偏好" value={prompt} onChange={(event) => setPrompt(event.currentTarget.value)} />
        </label>
        <label>
          风格
          <select value={style} onChange={(event) => setStyle(event.currentTarget.value)}>
            <option value="codex">Codex 小桌宠风</option>
            <option value="alkaka">Alkaka Q版贴纸风</option>
            <option value="soft">柔和 Q 版</option>
          </select>
        </label>
        <section className="pet-reference-section">
          <div className="pet-reference-head">
            <strong>参考图片</strong>
            <button className="secondary" type="button" onClick={() => fileRef.current?.click()}>＋ 新图片</button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) dialog.addReference(file);
              }}
            />
          </div>
          <div className="pet-reference-list">
            {dialog.references.length ? dialog.references.map((item) => (
              <div key={item.id} className="pet-reference-thumb" style={{ backgroundImage: `url("${item.src.replaceAll('"', "%22")}")` }}>
                <button type="button" title="删除" onClick={() => dialog.removeReference(item.id)}>×</button>
              </div>
            )) : <div className="pet-reference-empty">没有参考图片</div>}
          </div>
        </section>
        {error ? <div className="task-create-error">{error}</div> : null}
        <footer className="bot-dialog-actions">
          <button className="secondary" type="button" disabled={saving} onClick={dialog.close}>取消</button>
          <button className="primary" type="submit" disabled={saving}>{saving ? "创建中…" : "开始生成"}</button>
        </footer>
      </form>
    </section>
  );
}

function CloudLoginApprovalDialog({ dialog }: { dialog: CloudLoginApprovalDialogView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const decide = async (decision: "approve" | "deny") => {
    if (busy) return;
    setBusy(true);
    try {
      setError(await dialog.decide(decision));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section id="cloudLoginApproveDialog" className="cloud-login-approve-dialog" role="dialog" aria-modal="true" aria-labelledby="cloudLoginApproveTitle">
      <div className="cloud-login-approve-backdrop" onClick={dialog.close} />
      <div className="cloud-login-approve-panel">
        <header className="bot-dialog-head">
          <div>
            <h2 id="cloudLoginApproveTitle">允许登录</h2>
            <p>{error ? `操作失败：${error}` : dialog.copy}</p>
          </div>
        </header>
        <div className="cloud-login-approve-actions">
          <button className="secondary" type="button" disabled={busy} onClick={() => decide("deny")}>取消</button>
          <button className="primary" type="button" disabled={busy} onClick={() => decide("approve")}>允许</button>
        </div>
      </div>
    </section>
  );
}

function PrimaryDialog() {
  const { dialog } = useDialogs();
  if (dialog.kind === "skill") return <SkillDialog />;
  if (dialog.kind === "mcp-form") return <McpFormDialog key={dialog.id || "create"} dialog={dialog} />;
  if (dialog.kind === "mcp-template") return <McpTemplateDialog key={dialog.id} dialog={dialog} />;
  if (dialog.kind === "add-friend") return <AddFriendDialog dialog={dialog} />;
  if (dialog.kind === "task-create") return <TaskCreateDialog dialog={dialog} />;
  if (dialog.kind === "group-create") return <GroupCreateDialog dialog={dialog} />;
  if (dialog.kind === "group-info") return <GroupInfoDialog dialog={dialog} />;
  if (dialog.kind === "profile") return <ProfileDialog dialog={dialog} />;
  if (dialog.kind === "bot") return <BotDialog dialog={dialog} />;
  if (dialog.kind === "avatar-crop") return <AvatarCropDialog dialog={dialog} />;
  if (dialog.kind === "pet-generate") return <PetGenerateDialog dialog={dialog} />;
  if (dialog.kind === "cloud-login-approval") return <CloudLoginApprovalDialog dialog={dialog} />;
  return null;
}

function MessageDialog() {
  const { message } = useDialogs();
  if (!message) return null;
  return (
    <section className="mcp-dialog mcp-message-dialog" role="alertdialog" aria-modal="true" aria-label="MCP 提示">
      <div className="mcp-dialog-backdrop" onClick={message.close} />
      <div className="mcp-dialog-panel mcp-message-panel">
        <p>{message.text}</p>
        <footer className="mcp-dialog-actions">
          <button className="mcp-dialog-primary" type="button" onClick={message.close} autoFocus>确定</button>
        </footer>
      </div>
    </section>
  );
}

export default function DialogPortals() {
  const host = document.getElementById("reactDialogRoot");
  const { dialog, message } = useDialogs();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (message) message.close();
      else if ("close" in dialog) dialog.close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dialog, message]);
  return host ? createPortal(
    <>
      <PrimaryDialog />
      <MessageDialog />
    </>,
    host,
    "dialogs"
  ) : null;
}
