import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTasks, type TaskPreviewRun } from "../stores/tasks";
import type { AvatarView } from "../stores/contacts";

function syncPill(host: HTMLElement | null) {
  const active = host?.querySelector<HTMLButtonElement>("button.active");
  if (!host || !active) return;
  host.style.setProperty("--pill-x", `${active.offsetLeft}px`);
  host.style.setProperty("--pill-w", `${active.offsetWidth}px`);
  host.style.setProperty("--pill-ready", "1");
}

function UnreadBadge({ className, unread }: { className: string; unread: number }) {
  if (!unread) return null;
  return <span className={className}>{unread > 99 ? "99+" : unread}</span>;
}

export function TaskModeToggle() {
  const { modeTabs } = useTasks();
  useLayoutEffect(() => syncPill(document.getElementById("taskModeToggle")), [modeTabs]);
  useEffect(() => {
    const update = () => syncPill(document.getElementById("taskModeToggle"));
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return (
    <>
      {modeTabs.map((tab) => (
        <button key={tab.id} type="button" role="tab" className={tab.active ? "active" : ""} onClick={tab.select}>
          {tab.label}<span className="task-mode-count">{tab.count}</span>
          <UnreadBadge className="task-mode-unread" unread={tab.unread} />
        </button>
      ))}
    </>
  );
}

export function TaskChips() {
  const { chips } = useTasks();
  useLayoutEffect(() => {
    const host = document.getElementById("taskChipRow");
    if (host) host.hidden = !chips.length;
  }, [chips]);
  return (
    <>
      {chips.map((chip) => (
        <button key={chip.id} type="button" className={chip.active ? "active" : ""} onClick={chip.select}>
          {chip.label}<span>{chip.count}</span>
        </button>
      ))}
    </>
  );
}

export function TaskCards() {
  const { cards, emptyKind, newTask, pageDirection } = useTasks();
  useLayoutEffect(() => {
    const host = document.getElementById("tasksContent");
    if (!host) return;
    window.miaMasonryGrid?.layout(host, ".task-card", { animate: pageDirection });
    window.miaLottieIcons?.init?.(host);
  }, [cards, emptyKind, pageDirection]);
  if (emptyKind === "active") {
    return (
      <div className="tasks-empty tasks-empty-active">
        <div
          className="tasks-empty-lottie"
          data-lottie="task-schedule"
          data-lottie-path="./assets/lottie/task-schedule.tgs"
          data-lottie-format="tgs"
          data-lottie-trigger="loop"
          aria-hidden="true"
        />
        <h2>还没有活跃任务</h2>
        <p>需要 Mia 定时处理的事，可以从聊天开始，也可以手动新建。</p>
        <button className="secondary" type="button" onClick={newTask}>＋ 手动新建任务</button>
      </div>
    );
  }
  if (emptyKind === "history") return <div className="tasks-empty"><p>当前筛选下没有任务记录</p></div>;
  return (
    <>
      {cards.map((card) => (
        <button
          key={card.id}
          className={`task-card${card.type === "history" ? " task-history-card" : ""}`}
          type="button"
          onClick={card.open}
        >
          <div className="task-card-title">
            {card.type === "history"
              ? <span className={`task-history-icon ${card.historyStatus}`}>{card.historyIcon}</span>
              : <span className={`task-card-dot ${card.dotClass}`} />}
            <strong>{card.title}</strong>
          </div>
          <div className="task-card-meta">{card.meta}</div>
          <div className="task-card-foot">
            <em className="task-card-status">{card.statusText}</em>
            <UnreadBadge className="task-card-unread" unread={card.unread} />
            {card.type === "history" ? <em className="task-card-bot">{card.botLabel}</em> : null}
          </div>
        </button>
      ))}
    </>
  );
}

function Avatar({ avatar, label }: { avatar: AvatarView; label: string }) {
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
  return <span ref={ref} className="avatar task-output-avatar" role="img" aria-label={label} title={label} />;
}

function PreviewOutput({ run }: { run: TaskPreviewRun }) {
  if (run.pending) return <section className="task-output-pending">等待首次执行</section>;
  return (
    <section className="task-output-section">
      <div className="task-output-meta"><span>{run.timeText}</span><span>{run.statusText}</span></div>
      <div className="task-output-row message assistant">
        <Avatar avatar={run.avatar} label={run.avatarLabel} />
        {run.outputHtml
          ? <div className="bubble task-output-bubble" dangerouslySetInnerHTML={{ __html: run.outputHtml }} />
          : <div className={`task-output-state ${run.outputClass}`}>{run.outputText}</div>}
        {run.jump ? (
          <button className="task-open-chat icon-button" type="button" onClick={run.jump} aria-label="打开对话" title="打开对话">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M20 15a3 3 0 0 1-3 3H9l-5 3V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v8Z" />
              <path d="m13.5 9 2.5 2.5-2.5 2.5M16 11.5h-6" />
            </svg>
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function TaskPreviewActions() {
  const { preview } = useTasks();
  if (!preview) return null;
  return (
    <details className="task-more-menu">
      <summary className="icon-button" aria-label="更多操作" title="更多操作">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="5" cy="12" r="1.5" fill="currentColor" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" />
          <circle cx="19" cy="12" r="1.5" fill="currentColor" />
        </svg>
      </summary>
      <div className="task-more-popover">
        {preview.canPause ? <button type="button" onClick={preview.pauseTask}>{preview.pauseLabel}</button> : null}
        <button className="danger" type="button" onClick={preview.deleteTask}>删除任务</button>
      </div>
    </details>
  );
}

export function TaskPreviewBody() {
  const { preview } = useTasks();
  if (!preview) return null;
  return <div className="task-detail-card">{preview.runs.map((run, index) => <PreviewOutput key={index} run={run} />)}</div>;
}

export default function TaskPortals() {
  const mode = document.getElementById("taskModeToggle");
  const chips = document.getElementById("taskChipRow");
  const cards = document.getElementById("tasksContent");
  const actions = document.getElementById("taskPreviewActions");
  const preview = document.getElementById("taskPreviewBody");
  return (
    <>
      {mode ? createPortal(<TaskModeToggle />, mode, "task-mode") : null}
      {chips ? createPortal(<TaskChips />, chips, "task-chips") : null}
      {cards ? createPortal(<TaskCards />, cards, "task-cards") : null}
      {actions ? createPortal(<TaskPreviewActions />, actions, "task-preview-actions") : null}
      {preview ? createPortal(<TaskPreviewBody />, preview, "task-preview-body") : null}
    </>
  );
}

declare global {
  interface Window {
    miaLottieIcons?: {
      init?(root: HTMLElement): void;
    };
  }
}
