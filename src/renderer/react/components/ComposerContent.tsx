import { useLayoutEffect, type MouseEvent as ReactMouseEvent } from "react";
import {
  useComposerAddMenu,
  useComposerAttachments,
  useComposerReply,
  useComposerSkills,
  useSkillPicker
} from "../stores/composer-content";

function useHostVisibility(id: string, visible: boolean): void {
  useLayoutEffect(() => {
    document.getElementById(id)?.classList.toggle("hidden", !visible);
  }, [id, visible]);
}

export function ComposerAttachments() {
  const snapshot = useComposerAttachments();
  useHostVisibility("composerAttachments", snapshot.items.length > 0);

  return (
    <>
      {snapshot.items.map((attachment) => (
        <div
          key={attachment.id}
          className={`composer-attachment ${attachment.kind}`}
          title={attachment.title}
          onClick={() => snapshot.focus()}
        >
          {attachment.kind === "image" ? (
            <button
              className="composer-attachment-preview"
              type="button"
              aria-label="预览附件"
              onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
                event.preventDefault();
                event.stopPropagation();
                snapshot.preview(attachment.id);
              }}
            >
              <img className="composer-attachment-thumb" src={attachment.imageSrc} alt="" />
            </button>
          ) : (
            <span className="composer-attachment-kind" aria-hidden="true">{attachment.glyph}</span>
          )}
          <button
            className="composer-attachment-remove"
            type="button"
            title="移除附件"
            aria-label="移除附件"
            onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
              event.preventDefault();
              event.stopPropagation();
              snapshot.remove(attachment.id);
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                d="M6.75 6.75L17.25 17.25M17.25 6.75L6.75 17.25"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.1"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      ))}
    </>
  );
}

export function ComposerAddMenu() {
  const snapshot = useComposerAddMenu();
  useHostVisibility("composerAddMenu", snapshot.open);

  if (!snapshot.open) return null;
  return (
    <>
      <button
        type="button"
        data-composer-add="attachment"
        onClick={() => snapshot.addAttachment()}
        onPointerEnter={() => snapshot.scheduleSkillClose()}
      >
        添加附件
      </button>
      <button
        type="button"
        data-composer-add="skill"
        onClick={() => snapshot.openSkills()}
        onPointerEnter={() => snapshot.openSkills()}
        onPointerLeave={(event) => {
          if (!snapshot.shouldKeepSkillOpen(event.relatedTarget)) snapshot.scheduleSkillClose();
        }}
      >
        插件 / 技能
      </button>
    </>
  );
}

export function ComposerReply() {
  const snapshot = useComposerReply();
  useHostVisibility("composerReply", snapshot.visible);

  if (!snapshot.visible) return null;
  return (
    <>
      <div>
        <span>回复 {snapshot.author || "消息"}</span>
        <p>{snapshot.content}</p>
      </div>
      <button
        type="button"
        title="取消回复"
        aria-label="取消回复"
        onClick={() => snapshot.clear()}
      >
        ×
      </button>
    </>
  );
}

export function ComposerSkills() {
  const snapshot = useComposerSkills();
  useHostVisibility("composerSkills", snapshot.items.length > 0);

  return (
    <>
      {snapshot.items.map((skill) => (
        <span
          key={skill.id}
          className={`composer-skill${skill.selected ? " selected" : ""}`}
          title={skill.name}
        >
          {skill.name}
        </span>
      ))}
    </>
  );
}

export function SkillPickerBody() {
  const snapshot = useSkillPicker();

  if (!snapshot.items.length) {
    return <div className="skill-picker-empty">{snapshot.emptyText}</div>;
  }
  return (
    <section className="skill-picker-skills">
      <div className="skill-picker-list">
        {snapshot.items.map((skill) => (
          <button
            key={skill.key}
            className="skill-picker-item"
            type="button"
            data-skill-pick={skill.name}
            onClick={() => snapshot.select(skill.name)}
          >
            <strong>{skill.title}</strong>
            <small>{skill.description}</small>
          </button>
        ))}
      </div>
    </section>
  );
}
