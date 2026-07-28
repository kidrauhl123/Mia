import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent
} from "react";
import {
  type ConversationFolderItem,
  useConversationFolders
} from "../stores/conversation-folders";

const LONG_PRESS_MS = 260;

type DragState = {
  active: boolean;
  key: string;
  pointerId: number;
  startX: number;
  startY: number;
  timer: number;
};

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

export function ConversationFolderTabs() {
  const snapshot = useConversationFolders();
  const [order, setOrder] = useState<readonly string[]>([]);
  const [draggingKey, setDraggingKey] = useState("");
  const stripRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const orderRef = useRef<readonly string[]>([]);
  const scrollLeftRef = useRef(0);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);

  const sourceOrder = useMemo(() => snapshot.items.map(({ key }) => key), [snapshot.items]);
  useEffect(() => {
    setOrder((current) => {
      const next = sameOrder(current, sourceOrder) ? current : sourceOrder;
      orderRef.current = next;
      return next;
    });
  }, [sourceOrder]);
  useLayoutEffect(() => {
    orderRef.current = order;
  }, [order]);

  const itemByKey = useMemo(
    () => new Map(snapshot.items.map((item) => [item.key, item])),
    [snapshot.items]
  );
  const orderedItems = order
    .map((key) => itemByKey.get(key))
    .filter((item): item is ConversationFolderItem => Boolean(item));

  const applyScroll = useCallback((value: number): number => {
    const strip = stripRef.current;
    const track = trackRef.current;
    if (!strip || !track) return 0;
    const max = Math.max(0, track.scrollWidth - strip.clientWidth);
    const next = Math.max(0, Math.min(max, Math.round(value)));
    scrollLeftRef.current = next;
    strip.dataset.folderScrollX = String(next);
    track.style.setProperty("--tag-scroll-x", `${next}px`);
    return next;
  }, []);

  const updateIndicator = useCallback(() => {
    const strip = stripRef.current;
    const active = trackRef.current?.querySelector<HTMLElement>(".sidebar-tag-filter.active");
    const indicator = indicatorRef.current;
    if (!strip || !active || !indicator) {
      indicator?.style.setProperty("--tag-indicator-width", "0px");
      return;
    }
    const x = active.offsetLeft - scrollLeftRef.current;
    indicator.style.setProperty("--tag-indicator-x", `${Math.round(x)}px`);
    indicator.style.setProperty("--tag-indicator-width", `${Math.max(12, Math.round(active.offsetWidth))}px`);
  }, []);

  const centerActive = useCallback(() => {
    const strip = stripRef.current;
    const track = trackRef.current;
    const active = track?.querySelector<HTMLElement>(".sidebar-tag-filter.active");
    if (!strip || !track || !active) return;
    const next = active.offsetLeft + active.offsetWidth / 2 - strip.clientWidth / 2;
    applyScroll(next);
    updateIndicator();
  }, [applyScroll, updateIndicator]);

  useLayoutEffect(() => {
    centerActive();
    const frame = window.requestAnimationFrame(centerActive);
    return () => window.cancelAnimationFrame(frame);
  }, [centerActive, snapshot.fingerprint, order]);

  useEffect(() => {
    const onResize = () => centerActive();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [centerActive]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (!drag.active && distance > 8) {
        window.clearTimeout(drag.timer);
        dragRef.current = null;
        return;
      }
      if (!drag.active) return;
      event.preventDefault();
      const buttons = Array.from(
        trackRef.current?.querySelectorAll<HTMLElement>("[data-sidebar-tag-filter]") || []
      ).filter((button) => button.dataset.folderKey !== drag.key);
      const targetIndex = buttons.findIndex((button) => {
        const rect = button.getBoundingClientRect();
        return event.clientX < rect.left + rect.width / 2;
      });
      setOrder((current) => {
        const fromIndex = current.indexOf(drag.key);
        if (fromIndex < 0) return current;
        const next = [...current];
        next.splice(fromIndex, 1);
        const toIndex = targetIndex < 0 ? next.length : targetIndex;
        if (toIndex === fromIndex) return current;
        next.splice(Math.max(0, toIndex), 0, drag.key);
        orderRef.current = next;
        return next;
      });
    };
    const onPointerEnd = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      window.clearTimeout(drag.timer);
      if (drag.active) {
        event.preventDefault();
        suppressClickRef.current = true;
        snapshot.reorder(orderRef.current);
        window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      }
      dragRef.current = null;
      setDraggingKey("");
    };
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
    };
  }, [snapshot]);

  function beginDrag(item: ConversationFolderItem, event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    const button = event.currentTarget;
    const drag: DragState = {
      active: false,
      key: item.key,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      timer: 0
    };
    drag.timer = window.setTimeout(() => {
      if (dragRef.current !== drag) return;
      drag.active = true;
      setDraggingKey(item.key);
      try {
        button.setPointerCapture(event.pointerId);
      } catch {
        // Global pointer listeners keep the reorder usable without capture.
      }
    }, LONG_PRESS_MS);
    dragRef.current = drag;
  }

  function selectItem(item: ConversationFolderItem) {
    if (suppressClickRef.current || item.active) {
      centerActive();
      return;
    }
    const currentIndex = orderedItems.findIndex(({ active }) => active);
    const nextIndex = orderedItems.findIndex(({ key }) => key === item.key);
    snapshot.select(item.filterValue, nextIndex < currentIndex ? -1 : 1);
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    const strip = stripRef.current;
    const track = trackRef.current;
    if (!strip || !track || track.scrollWidth <= strip.clientWidth) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const unit = event.deltaMode === 1 ? 16 : (event.deltaMode === 2 ? strip.clientWidth : 1);
    applyScroll(scrollLeftRef.current + delta * unit);
    updateIndicator();
  }

  if (!snapshot.visible || !orderedItems.length) return null;
  return (
    <div
      ref={stripRef}
      className={`sidebar-tag-filter-strip${draggingKey ? " reordering" : ""}`}
      role="tablist"
      aria-label="\u5bf9\u8bdd\u5206\u7ec4"
      onWheel={handleWheel}
    >
      <div ref={trackRef} className="sidebar-tag-filter-track">
        {orderedItems.map((item) => (
          <button
            key={item.key}
            className={[
              "sidebar-tag-filter",
              item.type === "all" ? "all" : "",
              item.active ? "active" : "",
              draggingKey === item.key ? "dragging" : ""
            ].filter(Boolean).join(" ")}
            type="button"
            role="tab"
            data-sidebar-tag-filter
            data-tag-name={item.filterValue}
            data-folder-key={item.key}
            aria-selected={item.active}
            title={item.title}
            style={item.type === "tag" ? { "--tag-color": item.color } as CSSProperties : undefined}
            onClick={() => selectItem(item)}
            onPointerDown={(event) => beginDrag(item, event)}
          >
            <span className="sidebar-tag-filter-name">{item.name}</span>
          </button>
        ))}
      </div>
      <span ref={indicatorRef} className="sidebar-tag-filter-indicator" aria-hidden="true" />
    </div>
  );
}
