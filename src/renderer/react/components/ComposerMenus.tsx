import { useLayoutEffect, type MouseEvent as ReactMouseEvent } from "react";
import {
  useMentionMenu,
  useSlashCommandMenu
} from "../stores/composer-menus";

function useMenuHostVisibility(id: string, visible: boolean): void {
  useLayoutEffect(() => {
    const host = document.getElementById(id);
    host?.classList.toggle("hidden", !visible);
  }, [id, visible]);
}

export function SlashCommandMenu() {
  const snapshot = useSlashCommandMenu();
  useMenuHostVisibility("slashCommandMenu", snapshot.open);

  if (!snapshot.open) return null;
  if (!snapshot.items.length) {
    return <div className="slash-command-empty">没有匹配的命令</div>;
  }
  return (
    <>
      {snapshot.items.map((item, index) => (
        <button
          key={item.command}
          type="button"
          className={`slash-command-item${index === snapshot.selectedIndex ? " active" : ""}`}
          data-command={item.command}
          data-slash-index={index}
          onMouseDown={(event: ReactMouseEvent<HTMLButtonElement>) => {
            event.preventDefault();
            snapshot.choose(item.command);
          }}
          onMouseMove={() => snapshot.highlight(index)}
        >
          <span className="slash-command-token">{item.command}</span>
          <span className="slash-command-description">{item.description}</span>
        </button>
      ))}
    </>
  );
}

export function MentionMenu() {
  const snapshot = useMentionMenu();
  useMenuHostVisibility("mentionMenu", snapshot.open);

  if (!snapshot.open) return null;
  if (!snapshot.items.length) {
    return <div className="mention-menu-empty">没有匹配的成员</div>;
  }
  return (
    <>
      {snapshot.items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`mention-menu-item${item.index === snapshot.selectedIndex ? " active" : ""}`}
          data-mention-index={item.index}
          onMouseDown={(event: ReactMouseEvent<HTMLButtonElement>) => {
            event.preventDefault();
            snapshot.choose(item.index);
          }}
          onMouseMove={() => snapshot.highlight(item.index)}
        >
          <span className="mention-menu-dot" style={{ background: item.color }} />
          <span className="mention-menu-name">{item.name}</span>
          <span className="mention-menu-kind">{item.kind}</span>
        </button>
      ))}
    </>
  );
}
