// Pet generate dialog module
// Extracted from app.js (formerly lines 4490-4597). Mirrors the group.js /
// tasks-panel.js extraction pattern: IIFE + window.miaPetDialog namespace +
// initPetDialog for dependency injection.
(function () {
  "use strict";

  let state, els, mia;
  let botByKey, cryptoRandomId, avatarBackgroundStyle;
  let escapeHtml, setText, renderView, refreshRuntime, appendTransientChat;

  function initPetDialog(deps) {
    state = deps.state;
    els = deps.els;
    mia = deps.mia || (typeof window !== "undefined" ? window.mia : null);
    botByKey = deps.botByKey;
    cryptoRandomId = deps.cryptoRandomId;
    avatarBackgroundStyle = deps.avatarBackgroundStyle;
    escapeHtml = deps.escapeHtml;
    setText = deps.setText;
    renderView = deps.renderView;
    refreshRuntime = deps.refreshRuntime;
    appendTransientChat = deps.appendTransientChat;
  }

  function openPetGenerateDialog(botKey) {
    const bot = botByKey(botKey);
    if (!bot) return;
    state.petGenerateOpen = true;
    state.petGenerateBotKey = bot.key;
    const reference = bot.avatarImage || "";
    state.petReferences = reference ? [{ id: cryptoRandomId(), src: reference }] : [];
    if (els.petPrompt) els.petPrompt.value = "";
    if (els.petStylePreset) els.petStylePreset.value = "codex";
    renderView();
  }

  function closePetGenerateDialog() {
    state.petGenerateOpen = false;
    state.petGenerateBotKey = "";
    state.petReferences = [];
    renderView();
  }

  function renderPetGenerateDialog() {
    if (!els.petGenerateDialog || !state.petGenerateOpen) return;
    const bot = botByKey(state.petGenerateBotKey);
    if (!bot) return;
    setText(els.petGenerateTitle, `生成「${bot.name}」桌宠`);
    setText(els.petGenerateSubtitle, "会在后台调用 AlkakaPet/Hatch Pet 流程，耗时可能较长。");
    if (!els.petReferenceList) return;
    els.petReferenceList.innerHTML = state.petReferences.length
      ? state.petReferences.map((item) => `
        <div class="pet-reference-thumb" style="${avatarBackgroundStyle(item.src, { x: 50, y: 50, zoom: 1 }, "#eef0ff")}">
          <button type="button" data-remove-pet-reference="${escapeHtml(item.id)}" title="删除">×</button>
        </div>
      `).join("")
      : `<div class="pet-reference-empty">没有参考图片</div>`;
    els.petReferenceList.querySelectorAll("[data-remove-pet-reference]").forEach((button) => {
      button.addEventListener("click", () => {
        state.petReferences = state.petReferences.filter((item) => item.id !== button.dataset.removePetReference);
        renderPetGenerateDialog();
      });
    });
  }

  function readPetReferenceFile(file) {
    if (!file || !file.type?.startsWith("image/")) return;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      state.petReferences.push({ id: cryptoRandomId(), src: String(reader.result || "") });
      renderPetGenerateDialog();
    });
    reader.readAsDataURL(file);
  }

  async function refreshPetJobs() {
    try {
      state.petJobs = await window.mia.loadPetJobs();
      renderPetJobs();
      if (state.petJobs.some((job) => job.status === "completed")) {
        await refreshRuntime();
      }
    } catch (error) {
      console.error("Failed to load pet jobs", error);
    }
  }

  function renderPetJobs() {
    const jobs = state.petJobs?.length ? state.petJobs : (state.runtime?.petJobs || []);
    if (!els.petJobButton || !els.petJobPanel) return;
    const running = jobs.filter((job) => job.status === "running");
    const latest = jobs[0];
    const visible = running.length || latest;
    els.petJobButton.classList.toggle("hidden", !visible);
    if (!visible) {
      els.petJobPanel.classList.add("hidden");
      return;
    }
    els.petJobButton.textContent = running.length
      ? `桌宠生成中 ${running.length}`
      : latest.status === "completed"
        ? "桌宠已生成"
        : "桌宠生成失败";
    els.petJobPanel.classList.toggle("hidden", !state.petJobPanelOpen);
    if (!state.petJobPanelOpen) return;
    els.petJobPanel.innerHTML = jobs.slice(0, 5).map((job) => `
      <article class="pet-job-item ${escapeHtml(job.status)}">
        <strong>${escapeHtml(job.botName || job.fellowName || job.petId)}</strong>
        <span>${escapeHtml(job.status === "running" ? "生成中" : job.status === "completed" ? "已完成" : "失败")}</span>
        ${job.error ? `<p>${escapeHtml(job.error)}</p>` : ""}
        ${job.logPath ? `<small>${escapeHtml(job.logPath)}</small>` : ""}
      </article>
    `).join("");
  }

  async function placeBotPet(botKey) {
    try {
      await window.mia.placeFellowPet(botKey);
      await refreshRuntime();
    } catch (error) {
      appendTransientChat("assistant", `放进桌面失败: ${error.message}`);
    }
  }

  async function recallBotPet(botKey) {
    try {
      await window.mia.recallFellowPet(botKey);
      await refreshRuntime();
    } catch (error) {
      appendTransientChat("assistant", `收回桌宠失败: ${error.message}`);
    }
  }

  window.miaPetDialog = {
    initPetDialog,
    openPetGenerateDialog,
    closePetGenerateDialog,
    renderPetGenerateDialog,
    readPetReferenceFile,
    refreshPetJobs,
    renderPetJobs,
    placeBotPet,
    recallBotPet,
  };
})();
