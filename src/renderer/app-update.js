(() => {
  const VIEWPORT_MARGIN = 8;

  function initAppUpdate({ els, api, setText }) {
    if (!els || !api) return null;

    const writeText = typeof setText === "function"
      ? setText
      : (element, value) => { if (element) element.textContent = value == null ? "" : String(value); };
    const panelOffset = { x: 0, y: 0 };
    let panelDrag = null;

    function versionSuffix(version) {
      const text = String(version || "").trim();
      return text ? ` ${text}` : "";
    }

    function statusText(result = {}) {
      const version = versionSuffix(result.version);
      if (result.status === "available") return `发现新版本${version}。`;
      if (result.status === "deferred") return `已暂不更新${version}，可随时手动检查。`;
      if (result.status === "downloading") return `正在下载${version}`;
      if (result.status === "downloaded") return `正在安装${version}`;
      if (result.status === "installing") return `正在重启${version}`;
      if (result.status === "not-available") return "当前已经是最新版本。";
      if (result.status === "disabled") return "检查更新只在安装版桌面 App 中可用。";
      if (result.status === "error") return `检查失败：${result.error?.message || "请稍后再试"}`;
      return "已发起更新检查。";
    }

    function updatePercent(payload = {}) {
      const status = payload.status || payload.type || "";
      if (status === "downloaded" || status === "installing") return 100;
      const value = Number(payload.progress?.percent);
      if (!Number.isFinite(value)) return 0;
      return Math.max(0, Math.min(100, value));
    }

    function releaseNoteLines(payload = {}) {
      const raw = payload.releaseNotes;
      const source = Array.isArray(raw) ? raw : String(raw || "").split(/\r?\n/);
      const seen = new Set();
      const notes = [];
      for (const value of source) {
        let line = String(value || "").trim();
        if (!line || /^```/.test(line) || /^#{1,6}\s+Mia\b/i.test(line)) continue;
        line = line
          .replace(/^#{1,6}\s+/, "")
          .replace(/^[-*+]\s+/, "")
          .replace(/^\d+[.)]\s+/, "")
          .trim();
        if (!line || seen.has(line)) continue;
        seen.add(line);
        notes.push(line.length > 180 ? `${line.slice(0, 177)}...` : line);
        if (notes.length >= 5) break;
      }
      return notes;
    }

    function renderReleaseNotes(payload = {}) {
      const list = els.appUpdateReleaseNotes;
      if (!list) return;
      list.textContent = "";
      const notes = releaseNoteLines(payload);
      list.hidden = notes.length === 0;
      for (const note of notes) {
        const item = document.createElement("li");
        item.textContent = note;
        list.appendChild(item);
      }
    }

    function overlayCopy(payload = {}) {
      const status = payload.status || payload.type || "";
      const version = versionSuffix(payload.version);
      if (status === "available") {
        return {
          title: "发现新版本",
          detail: `Mia${version || ""} 已可用，你可以现在更新或稍后再说。`
        };
      }
      if (status === "downloaded") return { title: "正在安装", detail: "即将重启" };
      if (status === "installing") return { title: "正在重启", detail: "马上完成" };
      return { title: "正在下载", detail: `Mia${version || ""}` };
    }

    function setPanelOffset(x, y) {
      const panel = els.appUpdatePanel;
      if (!panel) return;
      panelOffset.x = Number.isFinite(x) ? x : 0;
      panelOffset.y = Number.isFinite(y) ? y : 0;
      panel.style.setProperty("--app-update-drag-x", `${Math.round(panelOffset.x)}px`);
      panel.style.setProperty("--app-update-drag-y", `${Math.round(panelOffset.y)}px`);
    }

    function resetPanelPosition() {
      const panel = els.appUpdatePanel;
      const drag = panelDrag;
      panelDrag = null;
      panelOffset.x = 0;
      panelOffset.y = 0;
      if (!panel) return;
      panel.classList.remove("dragging");
      panel.style.removeProperty("--app-update-drag-x");
      panel.style.removeProperty("--app-update-drag-y");
      if (drag) {
        try { panel.releasePointerCapture?.(drag.pointerId); } catch { /* best effort */ }
      }
    }

    function clampAxis(value, min, max) {
      if (min > max) return (min + max) / 2;
      return Math.max(min, Math.min(max, value));
    }

    function offsetWithinViewport(x, y, geometry) {
      const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
      const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
      return {
        x: clampAxis(x, VIEWPORT_MARGIN - geometry.originLeft, viewportWidth - VIEWPORT_MARGIN - geometry.width - geometry.originLeft),
        y: clampAxis(y, VIEWPORT_MARGIN - geometry.originTop, viewportHeight - VIEWPORT_MARGIN - geometry.height - geometry.originTop),
      };
    }

    function beginPanelDrag(event) {
      const panel = els.appUpdatePanel;
      if (!panel || (typeof event.button === "number" && event.button !== 0)) return;
      if (event.target?.closest?.("button, a, input, textarea, select, [contenteditable='true'], .app-update-notes")) return;
      const rect = panel.getBoundingClientRect();
      panelDrag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startOffsetX: panelOffset.x,
        startOffsetY: panelOffset.y,
        originLeft: rect.left - panelOffset.x,
        originTop: rect.top - panelOffset.y,
        width: rect.width,
        height: rect.height,
      };
      panel.classList.add("dragging");
      try { panel.setPointerCapture?.(event.pointerId); } catch { /* best effort */ }
      event.preventDefault();
    }

    function movePanelDrag(event) {
      const drag = panelDrag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const offset = offsetWithinViewport(
        drag.startOffsetX + event.clientX - drag.startX,
        drag.startOffsetY + event.clientY - drag.startY,
        drag
      );
      setPanelOffset(offset.x, offset.y);
      event.preventDefault();
    }

    function endPanelDrag(event) {
      const drag = panelDrag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      panelDrag = null;
      els.appUpdatePanel?.classList.remove("dragging");
      try { els.appUpdatePanel?.releasePointerCapture?.(drag.pointerId); } catch { /* best effort */ }
    }

    function keepPanelInViewport() {
      const panel = els.appUpdatePanel;
      if (!panel || els.appUpdateOverlay?.classList.contains("hidden")) return;
      const rect = panel.getBoundingClientRect();
      const offset = offsetWithinViewport(panelOffset.x, panelOffset.y, {
        originLeft: rect.left - panelOffset.x,
        originTop: rect.top - panelOffset.y,
        width: rect.width,
        height: rect.height,
      });
      setPanelOffset(offset.x, offset.y);
    }

    function renderOverlay(payload = {}, visible = true) {
      els.appUpdateOverlay?.classList.toggle("hidden", !visible);
      if (!visible) {
        els.appUpdateOverlay?.removeAttribute("data-update-status");
        resetPanelPosition();
        return;
      }
      const status = payload.status || payload.type || "";
      const awaitingChoice = status === "available";
      const copy = overlayCopy(payload);
      const percent = updatePercent(payload);
      els.appUpdateOverlay?.setAttribute("data-update-status", status);
      writeText(els.appUpdateOverlayTitle, copy.title);
      writeText(els.appUpdateOverlayDetail, copy.detail);
      renderReleaseNotes(payload);
      if (els.appUpdateActions) els.appUpdateActions.hidden = !awaitingChoice;
      if (els.appUpdateProgressBar) els.appUpdateProgressBar.hidden = awaitingChoice;
      if (els.appUpdateProgressText) els.appUpdateProgressText.hidden = awaitingChoice;
      if (awaitingChoice) {
        if (els.appUpdateDefer) els.appUpdateDefer.disabled = false;
        if (els.appUpdateInstall) {
          els.appUpdateInstall.disabled = false;
          els.appUpdateInstall.textContent = payload.downloaded ? "立即安装" : "立即更新";
        }
      }
      if (els.appUpdateProgressFill) els.appUpdateProgressFill.style.width = `${percent}%`;
      if (els.appUpdateProgressBar) els.appUpdateProgressBar.setAttribute("aria-valuenow", String(Math.round(percent)));
      writeText(els.appUpdateProgressText, `${Math.round(percent)}%`);
    }

    function handleEvent(payload = {}) {
      const status = payload.status || payload.type || "";
      if (["error", "not-available", "disabled", "deferred"].includes(status)) {
        renderOverlay(payload, false);
        writeText(els.appUpdateHint, statusText(payload));
        return;
      }
      if (status === "checking") {
        writeText(els.appUpdateHint, "正在检查更新...");
        return;
      }
      if (["available", "downloading", "downloaded", "installing"].includes(status)) {
        writeText(els.appUpdateHint, statusText(payload));
        renderOverlay(payload, true);
      }
    }

    function setActionsDisabled(disabled) {
      if (els.appUpdateDefer) els.appUpdateDefer.disabled = disabled;
      if (els.appUpdateInstall) els.appUpdateInstall.disabled = disabled;
    }

    api.onUpdateEvent?.((payload) => handleEvent(payload || {}));
    els.appUpdatePanel?.addEventListener("pointerdown", beginPanelDrag);
    els.appUpdatePanel?.addEventListener("pointermove", movePanelDrag);
    els.appUpdatePanel?.addEventListener("pointerup", endPanelDrag);
    els.appUpdatePanel?.addEventListener("pointercancel", endPanelDrag);
    window.addEventListener("resize", keepPanelInViewport);

    els.appUpdateDefer?.addEventListener("click", async () => {
      setActionsDisabled(true);
      try {
        handleEvent(await api.deferAppUpdate() || {});
      } catch (error) {
        writeText(els.appUpdateHint, `暂不更新失败：${error.message || error}`);
        setActionsDisabled(false);
      }
    });

    els.appUpdateInstall?.addEventListener("click", async () => {
      setActionsDisabled(true);
      writeText(els.appUpdateHint, "正在准备更新...");
      try {
        handleEvent(await api.downloadAppUpdate() || {});
      } catch (error) {
        writeText(els.appUpdateHint, `更新失败：${error.message || error}`);
        setActionsDisabled(false);
      }
    });

    els.checkUpdates?.addEventListener("click", async () => {
      els.checkUpdates.disabled = true;
      writeText(els.appUpdateHint, "正在检查更新...");
      try {
        handleEvent(await api.checkForUpdates() || {});
      } catch (error) {
        writeText(els.appUpdateHint, `检查失败：${error.message || error}`);
      } finally {
        els.checkUpdates.disabled = false;
      }
    });

    return { handleEvent, resetPanelPosition };
  }

  window.miaAppUpdate = { initAppUpdate };
})();
