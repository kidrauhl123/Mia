import { memo, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import {
  useSkills,
  type SkillCardView,
  type SkillSourceLogo
} from "../stores/skills";

function syncPill(host: HTMLElement | null, scrollActive = false) {
  const active = host?.querySelector<HTMLButtonElement>("button.active");
  if (!host || !active) {
    host?.style.setProperty("--pill-ready", "0");
    return;
  }
  if (scrollActive && host.scrollWidth > host.clientWidth) {
    active.scrollIntoView({ block: "nearest", inline: "center", behavior: "auto" });
  }
  host.style.setProperty("--pill-x", `${active.offsetLeft}px`);
  host.style.setProperty("--pill-w", `${active.offsetWidth}px`);
  host.style.setProperty("--pill-ready", "1");
}

export function SkillModeToggle() {
  const { modeTabs } = useSkills();
  useLayoutEffect(() => syncPill(document.getElementById("skillModeToggle")), [modeTabs]);
  useEffect(() => {
    const update = () => syncPill(document.getElementById("skillModeToggle"));
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return (
    <>
      {modeTabs.map((tab) => (
        <button
          key={tab.id}
          className={tab.active ? "active" : ""}
          type="button"
          role="tab"
          aria-selected={tab.active}
          onClick={tab.select}
        >
          {tab.label}
        </button>
      ))}
    </>
  );
}

export function SkillChips() {
  const { chips, mode } = useSkills();
  useLayoutEffect(() => {
    const host = document.getElementById("skillChipRow");
    host?.classList.toggle("mcp-toolbar-row", mode === "mcp");
    host?.setAttribute("aria-label", mode === "mcp" ? "MCP 操作" : "Skill 分类");
    syncPill(host, true);
  }, [chips, mode]);
  useEffect(() => {
    const update = () => syncPill(document.getElementById("skillChipRow"), true);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return (
    <>
      {chips.map((chip) => (
        <button
          key={chip.id}
          className={chip.active ? "active" : ""}
          type="button"
          aria-label={chip.ariaLabel}
          onClick={chip.select}
        >
          {chip.label}
        </button>
      ))}
    </>
  );
}

function SourceLogo({ logo }: { logo: SkillSourceLogo }) {
  const className = `skill-source-logo skill-source-logo-${logo.key}`;
  if (logo.mask) {
    return (
      <span className={className} aria-hidden="true" title={logo.label}>
        <span className="skill-source-logo-mask" />
      </span>
    );
  }
  return (
    <span className={className} aria-hidden="true" title={logo.label}>
      <img src={logo.src} alt="" />
    </span>
  );
}

const SkillCard = memo(function SkillCard({ card }: { card: SkillCardView }) {
  return (
    <article
      className={["skill-card", card.className].filter(Boolean).join(" ")}
      onClick={card.open}
      onContextMenu={card.openContextMenu ? (event) => {
        event.preventDefault();
        card.openContextMenu?.(event.clientX, event.clientY);
      } : undefined}
    >
      <div className="skill-card-head">
        <div className="skill-card-titlerow">
          <strong>{card.title}</strong>
          {card.statusLabel ? (
            <span className={`mcp-connect-status mcp-connect-status-${card.statusClass}`}>
              {card.statusLabel}
            </span>
          ) : null}
        </div>
        <p>{card.description}</p>
      </div>
      {card.actions.length ? (
        <div className="mcp-card-actions" aria-label="MCP 服务操作" onClick={(event) => event.stopPropagation()}>
          <button
            className={card.actions[0].className}
            type="button"
            disabled={card.actions[0].disabled}
            onClick={() => card.actions[0].run()}
          >
            {card.actions[0].label}
          </button>
          {card.actions.length > 1 ? (
            <div className="mcp-card-secondary-actions">
              {card.actions.slice(1).map((action) => (
                <button
                  key={action.id}
                  className={action.className}
                  type="button"
                  disabled={action.disabled}
                  onClick={() => action.run()}
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <span className="skill-card-source">
          {card.sourceLogo ? <SourceLogo logo={card.sourceLogo} /> : null}
          <span className="skill-card-source-text">{card.sourceText}</span>
        </span>
      )}
    </article>
  );
});

export function SkillGrid() {
  const { cards, emptyText, pageDirection } = useSkills();
  useLayoutEffect(() => {
    const host = document.getElementById("skillCardGrid");
    if (host) window.miaMasonryGrid?.layout(host, ".skill-card", { animate: pageDirection });
  }, [cards, emptyText, pageDirection]);
  if (!cards.length) return <div className="skill-empty-state">{emptyText}</div>;
  return <>{cards.map((card) => <SkillCard key={card.id} card={card} />)}</>;
}

export default function SkillPortals() {
  const modeToggle = document.getElementById("skillModeToggle");
  const chips = document.getElementById("skillChipRow");
  const grid = document.getElementById("skillCardGrid");
  return (
    <>
      {modeToggle ? createPortal(<SkillModeToggle />, modeToggle, "skill-mode-toggle") : null}
      {chips ? createPortal(<SkillChips />, chips, "skill-chips") : null}
      {grid ? createPortal(<SkillGrid />, grid, "skill-grid") : null}
    </>
  );
}
