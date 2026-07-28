import {
  memo,
  useEffect,
  useLayoutEffect,
  type CSSProperties
} from "react";
import { createPortal } from "react-dom";
import { useBotStore, type BotStoreCard, type BotStoreSheet } from "../stores/bot-store";

type CustomStyle = CSSProperties & Record<`--${string}`, string>;

function BotAvatar({
  className = "",
  emoji,
  primaryColor,
  surfaceColor
}: {
  className?: string;
  emoji: string;
  primaryColor: string;
  surfaceColor: string;
}) {
  return (
    <div
      className={`bot-store-avatar${className ? ` ${className}` : ""}`}
      style={{ background: surfaceColor, color: primaryColor }}
    >
      {emoji ? <span className="bot-store-avatar-emoji" aria-hidden="true">{emoji}</span> : "●"}
    </div>
  );
}

export function BotStoreCategories() {
  const { activeCategory, categories, selectCategory } = useBotStore();

  useLayoutEffect(() => {
    const root = document.getElementById("botStoreCap");
    const active = root?.querySelector<HTMLButtonElement>("button.active");
    if (!root || !active) return;
    root.style.setProperty("--pill-x", `${active.offsetLeft}px`);
    root.style.setProperty("--pill-w", `${active.offsetWidth}px`);
    root.style.setProperty("--pill-ready", "1");
    if (root.scrollWidth > root.clientWidth) {
      active.scrollIntoView({ block: "nearest", inline: "center", behavior: "auto" });
    }
  }, [activeCategory, categories]);

  useEffect(() => {
    const move = () => {
      const root = document.getElementById("botStoreCap");
      const active = root?.querySelector<HTMLButtonElement>("button.active");
      if (!root || !active) return;
      root.style.setProperty("--pill-x", `${active.offsetLeft}px`);
      root.style.setProperty("--pill-w", `${active.offsetWidth}px`);
    };
    window.addEventListener("resize", move);
    return () => window.removeEventListener("resize", move);
  }, []);

  return (
    <>
      {categories.map((category) => (
        <button
          key={category}
          type="button"
          className={category === activeCategory ? "active" : ""}
          onClick={() => selectCategory(category)}
        >
          {category}
        </button>
      ))}
    </>
  );
}

const AssistantCard = memo(function AssistantCard({
  card,
  open
}: {
  card: BotStoreCard;
  open: (key: string) => void;
}) {
  const style: CustomStyle = {
    "--bot-card-bg": card.surfaceColor,
    "--bot-card-fg": card.primaryColor
  };
  return (
    <div className="bot-store-card" data-key={card.key} style={style} onClick={() => open(card.key)}>
      <div className="bot-store-card-cover">
        <span className="bot-store-card-category">{card.category}</span>
        <BotAvatar
          className="bot-store-cover-avatar"
          emoji={card.emoji}
          primaryColor={card.primaryColor}
          surfaceColor={card.surfaceColor}
        />
      </div>
      <div className="bot-store-card-body">
        <div className="bot-store-card-head"><strong>{card.name}</strong></div>
        <p className="bot-store-card-description">{card.description}</p>
      </div>
    </div>
  );
});

export function BotStoreGrid() {
  const { cards, emptyText, openAssistant, pageDirection } = useBotStore();

  useLayoutEffect(() => {
    const root = document.getElementById("botStoreGrid");
    if (!root) return;
    window.miaMasonryGrid?.layout(root, ".bot-store-card", { animate: pageDirection });
  }, [cards, pageDirection]);

  if (!cards.length) return <div className="bot-store-empty">{emptyText}</div>;
  return (
    <>
      {cards.map((card) => <AssistantCard key={card.key} card={card} open={openAssistant} />)}
    </>
  );
}

function SheetCloseButton({ close }: { close: () => void }) {
  return (
    <button type="button" className="bot-store-sheet-close" aria-label="关闭" title="关闭" onClick={close}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M18 6 6 18" />
        <path d="M6 6l12 12" />
      </svg>
    </button>
  );
}

function DetailSheet({
  add,
  close,
  sheet
}: {
  add: () => void;
  close: () => void;
  sheet: BotStoreSheet;
}) {
  return (
    <>
      <SheetCloseButton close={close} />
      <div className="bot-store-sheet-head">
        <BotAvatar
          emoji={sheet.emoji}
          primaryColor={sheet.primaryColor}
          surfaceColor={sheet.surfaceColor}
        />
        <div><h2>{sheet.name}</h2></div>
      </div>
      <div className="bot-store-sheet-section">
        <span>描述</span>
        <p>{sheet.description}</p>
      </div>
      {sheet.skills.length ? (
        <div className="bot-store-sheet-section">
          <span>技能</span>
          <div className="bot-store-sheet-skills" aria-label="技能">
            {sheet.skills.map((skill) => (
              <span key={skill.id} className="bot-store-skill-chip" data-skill-id={skill.id}>{skill.label}</span>
            ))}
          </div>
        </div>
      ) : null}
      <div className="bot-store-actions">
        <button type="button" className="bot-store-btn ghost" onClick={close}>返回</button>
        <button type="button" className="bot-store-btn primary" onClick={add}>添加</button>
      </div>
    </>
  );
}

function EnrollSheet({
  close,
  confirm,
  returnToDetail,
  sheet
}: {
  close: () => void;
  confirm: () => void;
  returnToDetail: () => void;
  sheet: BotStoreSheet;
}) {
  const style: CustomStyle = {
    "--badge-accent": sheet.primaryColor,
    "--engine-accent": sheet.engineAccent
  };
  return (
    <>
      <SheetCloseButton close={close} />
      <div className="bot-store-enroll-console" style={style}>
        <div className="bot-store-enroll-bar">
          <span className="bot-store-enroll-light" aria-hidden="true" />
          <span>AI 助手入库</span>
          <span className="bot-store-enroll-status">{sheet.status}</span>
        </div>
        <div className="bot-store-badge-stage">
          <div className="bot-store-badge-card">
            <div className="bot-store-badge-title">MIA · AI 助手凭证</div>
            <div className="bot-store-badge-shimmer" aria-hidden="true" />
            <div className="bot-store-badge-main">
              <BotAvatar
                className="bot-store-badge-avatar"
                emoji={sheet.emoji}
                primaryColor={sheet.primaryColor}
                surfaceColor={sheet.surfaceColor}
              />
              <div className="bot-store-badge-id">
                <span>AI 助手</span>
                <strong>{sheet.name}</strong>
                <code>UID · {sheet.plannedKey}</code>
              </div>
            </div>
            <div className="bot-store-badge-fields">
              <div><span>分类</span><strong>{sheet.category}</strong></div>
              {sheet.skills.length ? (
                <div><span>技能</span><strong>{sheet.skills.map((skill) => skill.label).join(" / ")}</strong></div>
              ) : null}
              <div><span>运行位置 / Agent</span><strong>{sheet.engineSummary}</strong></div>
            </div>
            <div className="bot-store-badge-stamp" aria-hidden="true">
              <strong>已激活</strong>
              <span>ACTIVATED</span>
            </div>
          </div>
          <div className="bot-store-badge-flash" aria-hidden="true" />
        </div>
      </div>
      <div className="bot-store-actions">
        <button type="button" className="bot-store-btn ghost" disabled={sheet.adding} onClick={returnToDetail}>
          上一步
        </button>
        <button type="button" className="bot-store-btn primary" disabled={sheet.adding || sheet.stamped} onClick={confirm}>
          {sheet.adding ? "确认中…" : sheet.stamped ? "已添加" : "确认"}
        </button>
      </div>
    </>
  );
}

export function BotStoreSheet() {
  const {
    addAssistant,
    closeSheet,
    confirmAssistant,
    returnToDetail,
    sheet
  } = useBotStore();

  useLayoutEffect(() => {
    const host = document.getElementById("botStoreSheet");
    if (!host) return;
    host.classList.toggle("is-enrolling", sheet.mode === "enroll");
    host.classList.toggle("is-stamped", sheet.stamped);
    if (sheet.plannedKey) host.dataset.botKey = sheet.plannedKey;
    else delete host.dataset.botKey;
  }, [sheet.mode, sheet.plannedKey, sheet.stamped]);

  if (sheet.mode === "closed") return null;
  if (sheet.mode === "detail") {
    return <DetailSheet sheet={sheet} close={closeSheet} add={() => addAssistant(sheet.key)} />;
  }
  return (
    <EnrollSheet
      sheet={sheet}
      close={closeSheet}
      confirm={confirmAssistant}
      returnToDetail={returnToDetail}
    />
  );
}

export default function BotStorePortals() {
  const categories = document.getElementById("botStoreCap");
  const grid = document.getElementById("botStoreGrid");
  const sheet = document.getElementById("botStoreSheet");
  return (
    <>
      {categories ? createPortal(<BotStoreCategories />, categories, "bot-store-categories") : null}
      {grid ? createPortal(<BotStoreGrid />, grid, "bot-store-grid") : null}
      {sheet ? createPortal(<BotStoreSheet />, sheet, "bot-store-sheet") : null}
    </>
  );
}

declare global {
  interface Window {
    miaMasonryGrid?: {
      layout(
        grid: Element,
        itemSelector: string,
        options?: { animate?: number }
      ): void;
    };
  }
}
