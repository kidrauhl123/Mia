import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";

type ComposerSelectGroup = Readonly<{
  disabled: boolean;
  label: string;
  section: boolean;
  type: "group";
}>;

type ComposerSelectOption = Readonly<{
  disabled: boolean;
  label: string;
  placeholder: boolean;
  selected: boolean;
  selectKey: string;
  type: "option";
  value: string;
}>;

type ComposerSelectEntry = ComposerSelectGroup | ComposerSelectOption;

type ActiveMenu = Readonly<{
  combinedModelControls: boolean;
  entries: readonly ComposerSelectEntry[];
  select: HTMLSelectElement;
  selectTargets: ReadonlyMap<string, HTMLSelectElement>;
  selectedValue: string;
  trigger: HTMLElement;
}>;

type HermesConfiguration = Readonly<{
  approvalMode: string;
  sessionYoloActive: boolean;
  toggleYolo: ((enabled: boolean) => Promise<unknown> | unknown) | null;
}>;

type HermesPermissionMenuApi = {
  copyFor(entry: { label: string; title?: string; value: string }): {
    description: string;
    label: string;
  };
  getConfiguration(select: HTMLSelectElement): HermesConfiguration | null;
};

declare global {
  interface Window {
    miaHermesPermissionMenu?: HermesPermissionMenuApi;
    miaReactSelectMenu?: {
      close(select?: HTMLSelectElement): void;
    };
  }
}

let closeMountedMenu: (select?: HTMLSelectElement) => void = () => {};

window.miaReactSelectMenu = {
  close(select) {
    closeMountedMenu(select);
  }
};

function isCustomSelect(value: Element | null): value is HTMLSelectElement {
  return value instanceof HTMLSelectElement && !value.multiple && Number(value.size || 0) <= 1;
}

function triggerFor(select: HTMLSelectElement): HTMLElement {
  return select.closest<HTMLElement>(".model-switcher, .effort-switcher, .permission-switcher") || select;
}

function selectEntries(select: HTMLSelectElement): Array<Omit<ComposerSelectOption, "selectKey"> | ComposerSelectGroup> {
  const entries: Array<Omit<ComposerSelectOption, "selectKey"> | ComposerSelectGroup> = [];
  const pushOption = (option: HTMLOptionElement, groupDisabled = false) => {
    entries.push({
      disabled: Boolean(option.disabled || groupDisabled),
      label: String(option.label || option.textContent || option.value || "").trim(),
      placeholder: option.dataset.placeholder === "true",
      selected: option.selected,
      type: "option",
      value: option.value
    });
  };
  for (const child of Array.from(select.children)) {
    if (child instanceof HTMLOptGroupElement) {
      const options = Array.from(child.children).filter(
        (option): option is HTMLOptionElement => option instanceof HTMLOptionElement
      );
      if (!options.length) continue;
      const label = String(child.label || "").trim();
      if (label) {
        entries.push({
          disabled: Boolean(child.disabled),
          label,
          section: false,
          type: "group"
        });
      }
      for (const option of options) pushOption(option, Boolean(child.disabled));
      continue;
    }
    if (child instanceof HTMLOptionElement) pushOption(child);
  }
  return entries;
}

function menuFor(select: HTMLSelectElement): ActiveMenu | null {
  const primary = selectEntries(select).filter(
    (entry) => entry.type !== "option" || !entry.placeholder
  );
  const effortSelect = document.getElementById("effortSelect");
  const effort = select.id === "quickModelSelect"
    && effortSelect instanceof HTMLSelectElement
    && !effortSelect.disabled
    ? selectEntries(effortSelect).filter((entry) => entry.type !== "option" || !entry.placeholder)
    : [];
  const combinedModelControls = effort.some((entry) => entry.type === "option" && !entry.disabled);
  const sections = combinedModelControls
    ? [
      ...(primary.some((entry) => entry.type === "option")
        ? [{ label: "模型", select, entries: primary }]
        : []),
      { label: "推理强度", select: effortSelect as HTMLSelectElement, entries: effort }
    ]
    : [{ label: "", select, entries: primary }];
  const selectTargets = new Map<string, HTMLSelectElement>();
  const entries: ComposerSelectEntry[] = [];
  sections.forEach((section, index) => {
    const selectKey = String(section.select.id || `select-${index}`);
    selectTargets.set(selectKey, section.select);
    if (combinedModelControls) {
      entries.push({
        disabled: false,
        label: section.label,
        section: true,
        type: "group"
      });
    }
    for (const entry of section.entries) {
      entries.push(entry.type === "option" ? { ...entry, selectKey } : entry);
    }
  });
  const enabled = entries.filter(
    (entry): entry is ComposerSelectOption => entry.type === "option" && !entry.disabled
  );
  if (!enabled.length) return null;
  return {
    combinedModelControls,
    entries,
    select,
    selectTargets,
    selectedValue: String(select.value || enabled.find((option) => option.selected)?.value || enabled[0].value),
    trigger: triggerFor(select)
  };
}

function isSelected(entry: ComposerSelectOption, active: ActiveMenu): boolean {
  return entry.selected
    || (!active.combinedModelControls && entry.value === active.selectedValue);
}

export function ComposerSelectMenu() {
  const [active, setActive] = useState<ActiveMenu | null>(null);
  const [keyboardIndex, setKeyboardIndex] = useState(0);
  const [yoloPending, setYoloPending] = useState(false);
  const activeRef = useRef<ActiveMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback((select?: HTMLSelectElement) => {
    const current = activeRef.current;
    if (select && current?.select !== select) return;
    current?.trigger.classList.remove("select-open");
    activeRef.current = null;
    setActive(null);
    setYoloPending(false);
  }, []);

  const open = useCallback((select: HTMLSelectElement) => {
    if (select.disabled) return;
    const current = activeRef.current;
    if (current?.select === select) {
      close();
      return;
    }
    current?.trigger.classList.remove("select-open");
    const next = menuFor(select);
    if (!next) {
      close();
      return;
    }
    next.trigger.classList.add("select-open");
    activeRef.current = next;
    const enabled = next.entries.filter(
      (entry): entry is ComposerSelectOption => entry.type === "option" && !entry.disabled
    );
    const selectedIndex = enabled.findIndex((entry) => isSelected(entry, next));
    setKeyboardIndex(Math.max(0, selectedIndex));
    setYoloPending(false);
    setActive(next);
  }, [close]);

  const move = useCallback((delta: number) => {
    const current = activeRef.current;
    if (!current) return;
    const enabledCount = current.entries.filter(
      (entry) => entry.type === "option" && !entry.disabled
    ).length;
    if (!enabledCount) return;
    setKeyboardIndex((index) => (index + delta + enabledCount) % enabledCount);
  }, []);

  const choose = useCallback((option: ComposerSelectOption) => {
    const current = activeRef.current;
    if (!current || option.disabled) return;
    const target = current.selectTargets.get(option.selectKey) || current.select;
    if (!target.disabled && target.value !== option.value) {
      target.value = option.value;
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const focusTarget = current.select;
    close();
    focusTarget.focus({ preventScroll: true });
  }, [close]);

  const chooseKeyboardOption = useCallback(() => {
    const current = activeRef.current;
    if (!current) return;
    const options = current.entries.filter(
      (entry): entry is ComposerSelectOption => entry.type === "option" && !entry.disabled
    );
    const option = options[keyboardIndex] || options[0];
    if (option) choose(option);
  }, [choose, keyboardIndex]);

  useLayoutEffect(() => {
    closeMountedMenu = close;
    return () => {
      if (closeMountedMenu === close) closeMountedMenu = () => {};
    };
  }, [close]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const select = target?.closest("select") || null;
      if (isCustomSelect(select) && !select.disabled) {
        event.preventDefault();
        event.stopPropagation();
        select.focus({ preventScroll: true });
        open(select);
        return;
      }
      const current = activeRef.current;
      if (!current) return;
      if (menuRef.current?.contains(target)) return;
      if (current.trigger.contains(target)) return;
      close();
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const select = target?.closest("select") || null;
      if (!isCustomSelect(select) || select.disabled) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const select = event.target instanceof HTMLSelectElement && isCustomSelect(event.target)
        ? event.target
        : null;
      const current = activeRef.current;
      if (select && !select.disabled) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!current || current.select !== select) open(select);
          else move(event.key === "ArrowDown" ? 1 : -1);
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (!current || current.select !== select) open(select);
          else chooseKeyboardOption();
          return;
        }
        if (event.key === "Escape" && current?.select === select) {
          event.preventDefault();
          close();
          return;
        }
      }
      if (!current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        move(event.key === "ArrowDown" ? 1 : -1);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        chooseKeyboardOption();
      }
    };
    const onResize = () => close();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [chooseKeyboardOption, close, move, open]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || !active) return;
    const rect = active.trigger.getBoundingClientRect();
    const viewportPadding = 8;
    const triggerGap = 6;
    const maxWidth = Math.max(150, window.innerWidth - viewportPadding * 2);
    const width = Math.max(150, Math.min(maxWidth, Math.max(rect.width, menu.scrollWidth || rect.width)));
    const left = Math.max(viewportPadding, Math.min(window.innerWidth - width - viewportPadding, rect.left));
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - viewportPadding - triggerGap);
    const spaceAbove = Math.max(0, rect.top - viewportPadding - triggerGap);
    const wantedHeight = Math.min(menu.scrollHeight || 0, 320);
    const usefulHeight = Math.min(wantedHeight, 160);
    const openBelow = spaceBelow >= usefulHeight || spaceBelow >= spaceAbove;
    const availableHeight = openBelow ? spaceBelow : spaceAbove;
    menu.style.width = `${width}px`;
    menu.style.maxHeight = `${Math.min(320, Math.max(0, availableHeight))}px`;
    menu.style.left = `${left}px`;
    menu.style.top = openBelow ? `${rect.bottom + triggerGap}px` : "";
    menu.style.bottom = openBelow ? "" : `${window.innerHeight - rect.top + triggerGap}px`;
    menu.dataset.placement = openBelow ? "below" : "above";
    const selected = menu.querySelector<HTMLElement>(".composer-select-option.keyboard-active")
      || menu.querySelector<HTMLElement>(".composer-select-option.selected:not(:disabled)")
      || menu.querySelector<HTMLElement>(".composer-select-option:not(:disabled)");
    selected?.scrollIntoView({ block: "nearest" });
  }, [active, keyboardIndex]);

  if (!active) return null;
  const hermes = window.miaHermesPermissionMenu?.getConfiguration(active.select) || null;
  const role = active.combinedModelControls || hermes ? "menu" : "listbox";
  let enabledIndex = -1;

  return (
    <div
      ref={menuRef}
      id="composerSelectMenu"
      className={[
        "composer-select-menu",
        active.combinedModelControls ? "composer-model-controls-menu" : "",
        hermes ? "hermes-permission-menu" : ""
      ].filter(Boolean).join(" ")}
      role={role}
    >
      {hermes ? (
        <>
          <div className="hermes-permission-heading">
            <span>审批策略</span>
            <span className="hermes-permission-scope">持久化</span>
          </div>
          <div className="hermes-approval-options">
            {active.entries.filter(
              (entry): entry is ComposerSelectOption => entry.type === "option"
            ).map((entry) => {
              const copy = window.miaHermesPermissionMenu?.copyFor(entry) || {
                description: "",
                label: entry.label
              };
              const selected = entry.value === (active.selectedValue || hermes.approvalMode);
              return (
                <button
                  key={`${entry.selectKey}:${entry.value}`}
                  className={`composer-select-option hermes-approval-option${selected ? " selected" : ""}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  disabled={entry.disabled}
                  onClick={() => choose(entry)}
                >
                  <span className="hermes-approval-copy">
                    <span className="hermes-approval-label">{copy.label}</span>
                    <span className="hermes-approval-description">{copy.description}</span>
                  </span>
                  <span className="hermes-approval-check" aria-hidden="true">✓</span>
                </button>
              );
            })}
          </div>
          <div className="hermes-permission-separator" role="separator" />
          <button
            className={`hermes-session-yolo${yoloPending ? " pending" : ""}`}
            type="button"
            aria-pressed={hermes.sessionYoloActive}
            disabled={
              yoloPending
              || ["off", "yolo"].includes((active.selectedValue || hermes.approvalMode).trim().toLowerCase())
              || !hermes.toggleYolo
            }
            onClick={() => {
              if (!hermes.toggleYolo || yoloPending) return;
              setYoloPending(true);
              void Promise.resolve(hermes.toggleYolo(!hermes.sessionYoloActive))
                .finally(() => setYoloPending(false));
            }}
            onKeyDown={(event: ReactKeyboardEvent<HTMLButtonElement>) => {
              if (event.key === "Enter" || event.key === " ") event.stopPropagation();
            }}
          >
            <span className="hermes-yolo-copy">
              <span className="hermes-yolo-label">YOLO（仅本会话）</span>
              <span className="hermes-yolo-description">允许完全访问，危险操作不再询问</span>
            </span>
            <span className="hermes-yolo-switch" aria-hidden="true"><span /></span>
          </button>
        </>
      ) : active.entries.map((entry, index) => {
        if (entry.type === "group") {
          return (
            <div
              key={`group:${entry.label}:${index}`}
              className={[
                "composer-select-group",
                entry.section ? "composer-select-section" : "",
                entry.disabled ? "disabled" : ""
              ].filter(Boolean).join(" ")}
            >
              {entry.label}
            </div>
          );
        }
        if (!entry.disabled) enabledIndex += 1;
        const selected = isSelected(entry, active);
        const keyboardActive = !entry.disabled && enabledIndex === keyboardIndex;
        return (
          <button
            key={`${entry.selectKey}:${entry.value}:${index}`}
            className={[
              "composer-select-option",
              selected ? "selected" : "",
              keyboardActive ? "keyboard-active" : ""
            ].filter(Boolean).join(" ")}
            type="button"
            role={active.combinedModelControls ? "menuitemradio" : "option"}
            aria-checked={active.combinedModelControls ? selected : undefined}
            aria-selected={active.combinedModelControls ? undefined : selected}
            disabled={entry.disabled}
            data-select-key={entry.selectKey}
            data-value={entry.value}
            onClick={() => choose(entry)}
          >
            {entry.label}
          </button>
        );
      })}
    </div>
  );
}
