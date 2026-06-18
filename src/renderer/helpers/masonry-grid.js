(function () {
  "use strict";

  const globalObj = typeof window !== "undefined" ? window : globalThis;
  const grids = new Set();
  const state = new WeakMap();
  let resizeBound = false;
  let fontsBound = false;

  function scheduleFrame(fn) {
    if (typeof globalObj.requestAnimationFrame === "function") globalObj.requestAnimationFrame(fn);
    else globalObj.setTimeout(fn, 0);
  }

  function px(value, fallback = 0) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function gridColumns(styles) {
    const columns = String(styles.gridTemplateColumns || "")
      .trim()
      .split(/\s+/)
      .filter((track) => track && track !== "none");
    return Math.max(1, columns.length);
  }

  function resetLayout(grid, items = [...grid.children]) {
    grid.style.height = "";
    grid.style.position = "";
    for (const item of items) {
      item.style.position = "";
      item.style.width = "";
      item.style.transform = "";
      item.style.left = "";
      item.style.top = "";
    }
  }

  function liveGrids() {
    for (const grid of [...grids]) {
      if (!grid || !grid.isConnected) grids.delete(grid);
    }
    return [...grids];
  }

  function bindGlobalInvalidation() {
    if (!resizeBound && globalObj?.addEventListener) {
      resizeBound = true;
      globalObj.addEventListener("resize", () => {
        for (const grid of liveGrids()) layout(grid);
      });
    }

    if (!fontsBound && typeof document !== "undefined" && document.fonts?.ready) {
      fontsBound = true;
      document.fonts.ready.then(() => {
        for (const grid of liveGrids()) layout(grid);
      }).catch(() => {});
    }
  }

  function layout(grid, itemSelector, options = {}) {
    if (!grid) return;
    const entry = state.get(grid) || { frame: 0, selector: itemSelector || "" };
    if (itemSelector) entry.selector = itemSelector;
    if (options.animate) entry.animate = Number(options.animate) < 0 ? -1 : 1;
    state.set(grid, entry);
    grids.add(grid);
    bindGlobalInvalidation();

    if (entry.frame) return;
    entry.frame = 1;
    scheduleFrame(() => {
      entry.frame = 0;
      const animate = entry.animate || 0;
      entry.animate = 0;
      applyLayout(grid, entry.selector, animate);
    });
  }

  function capture(grid, direction = 1) {
    if (!grid || !grid.isConnected) return;
    const entry = state.get(grid) || { frame: 0, selector: "" };
    state.set(grid, entry);
    clearSnapshot(entry);
    if (globalObj.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;

    const items = [...grid.children].filter((item) => !item.hidden);
    if (!items.length) return;

    const parent = grid.parentElement;
    if (!parent) return;
    parent.classList.add("masonry-grid-stage");

    const snapshot = grid.cloneNode(true);
    snapshot.removeAttribute("id");
    snapshot.setAttribute("aria-hidden", "true");
    snapshot.classList.remove("page-enter-forward", "page-enter-back", "page-leave-forward", "page-leave-back");
    snapshot.classList.add("masonry-page-shadow");
    snapshot.style.top = `${grid.offsetTop}px`;
    snapshot.style.left = `${grid.offsetLeft}px`;
    snapshot.style.width = `${grid.offsetWidth}px`;
    snapshot.style.height = `${grid.offsetHeight}px`;
    snapshot.style.pointerEvents = "none";
    parent.appendChild(snapshot);
    entry.snapshot = snapshot;
    entry.snapshotDirection = Number(direction) < 0 ? -1 : 1;
  }

  function applyLayout(grid, itemSelector, animate) {
    if (!grid || !grid.isConnected || !itemSelector) return;
    const entry = state.get(grid) || {};
    const children = [...grid.children];

    const items = children.filter((item) => item.matches(itemSelector) && !item.hidden);
    if (!items.length) {
      resetLayout(grid, children);
      grid.classList.remove("masonry-grid");
      if (animate) turnPage(grid, animate);
      else clearSnapshot(entry);
      return;
    }

    grid.classList.add("masonry-grid");
    const styles = globalObj.getComputedStyle(grid);
    const columnCount = gridColumns(styles);
    const columnGap = Math.max(0, px(styles.columnGap || styles.gap, 0));
    const rowGap = Math.max(0, px(styles.rowGap || styles.gap, 0));
    const gridWidth = grid.clientWidth || grid.getBoundingClientRect().width;
    const columnWidth = (gridWidth - (columnCount - 1) * columnGap) / columnCount;
    if (!Number.isFinite(columnWidth) || columnWidth <= 0) return;

    grid.style.position = "relative";
    for (const item of children) {
      if (!items.includes(item)) {
        item.style.position = "";
        item.style.width = "";
        item.style.transform = "";
        item.style.left = "";
        item.style.top = "";
      }
    }
    for (const item of items) {
      item.style.position = "absolute";
      item.style.width = `${columnWidth}px`;
      item.style.left = "0";
      item.style.top = "0";
      item.style.transform = "translate3d(0, 0, 0)";
    }

    const columnHeights = Array(columnCount).fill(0);
    for (const item of items) {
      const column = columnHeights.indexOf(Math.min(...columnHeights));
      const x = column * (columnWidth + columnGap);
      const y = columnHeights[column];
      const height = item.getBoundingClientRect().height;
      item.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      columnHeights[column] += height + rowGap;
    }

    const height = Math.max(0, ...columnHeights) - rowGap;
    grid.style.height = `${Math.ceil(Math.max(0, height))}px`;

    if (animate) turnPage(grid, animate);
  }

  function turnPage(grid, direction) {
    if (globalObj.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
    const entry = state.get(grid) || {};
    const snapshot = entry.snapshot?.isConnected ? entry.snapshot : null;
    const dir = Number(direction || entry.snapshotDirection) < 0 ? -1 : 1;
    const enterCls = dir < 0 ? "page-enter-back" : "page-enter-forward";
    const leaveCls = dir < 0 ? "page-leave-back" : "page-leave-forward";

    grid.classList.remove("page-enter-forward", "page-enter-back");
    void grid.offsetWidth;
    grid.classList.add(enterCls);
    grid.addEventListener("animationend", () => grid.classList.remove(enterCls), { once: true });

    if (snapshot) {
      snapshot.classList.remove("page-leave-forward", "page-leave-back");
      snapshot.classList.add(leaveCls);
      snapshot.addEventListener("animationend", () => clearSnapshot(entry), { once: true });
    }
  }

  function clearSnapshot(entry) {
    if (entry?.snapshot?.parentElement) entry.snapshot.remove();
    if (entry) {
      entry.snapshot = null;
      entry.snapshotDirection = 0;
    }
  }

  globalObj.miaMasonryGrid = { capture, layout };
})();
