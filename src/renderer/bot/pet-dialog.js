// Pet generate dialog module
// Extracted from app.js (formerly lines 4490-4597). Mirrors the group.js /
// tasks-panel.js extraction pattern: IIFE + window.miaPetDialog namespace +
// initPetDialog for dependency injection.
(function () {
  "use strict";

  let state, els, mia;
  let botByKey, cryptoRandomId, avatarBackgroundStyle;
  let escapeHtml, setText, renderView, refreshRuntime, appendTransientChat;

  function initPetDialog(deps = {}) {
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
    const controls = els || {};
    const currentState = state || {};
    if (!controls.petGenerateDialog || !currentState.petGenerateOpen) return;
    const bot = typeof botByKey === "function" ? botByKey(currentState.petGenerateBotKey) : null;
    if (!bot) return;
    const writeText = typeof setText === "function" ? setText : (node, value) => { if (node) node.textContent = value; };
    const escape = typeof escapeHtml === "function" ? escapeHtml : (value) => String(value || "");
    const avatarStyle = typeof avatarBackgroundStyle === "function" ? avatarBackgroundStyle : () => "";
    writeText(controls.petGenerateTitle, `生成「${bot.name}」桌宠`);
    writeText(controls.petGenerateSubtitle, "会在后台调用 AlkakaPet/Hatch Pet 流程，耗时可能较长。");
    if (!controls.petReferenceList) return;
    const references = Array.isArray(currentState.petReferences) ? currentState.petReferences : [];
    controls.petReferenceList.innerHTML = references.length
      ? references.map((item) => `
        <div class="pet-reference-thumb" style="${avatarStyle(item.src, { x: 50, y: 50, zoom: 1 }, "#eef0ff")}">
          <button type="button" data-remove-pet-reference="${escape(item.id)}" title="删除">×</button>
        </div>
      `).join("")
      : `<div class="pet-reference-empty">没有参考图片</div>`;
    controls.petReferenceList.querySelectorAll("[data-remove-pet-reference]").forEach((button) => {
      button.addEventListener("click", () => {
        currentState.petReferences = references.filter((item) => item.id !== button.dataset.removePetReference);
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
    const controls = els || {};
    const currentState = state || {};
    const jobs = currentState.petJobs?.length ? currentState.petJobs : (currentState.runtime?.petJobs || []);
    if (!controls.petJobButton || !controls.petJobPanel) return;
    const escape = typeof escapeHtml === "function" ? escapeHtml : (value) => String(value || "");
    const running = jobs.filter((job) => job.status === "running");
    const latest = jobs[0];
    const visible = running.length || latest;
    controls.petJobButton.classList.toggle("hidden", !visible);
    if (!visible) {
      controls.petJobPanel.classList.add("hidden");
      return;
    }
    controls.petJobButton.textContent = running.length
      ? `桌宠生成中 ${running.length}`
      : latest.status === "completed"
        ? "桌宠已生成"
        : "桌宠生成失败";
    controls.petJobPanel.classList.toggle("hidden", !currentState.petJobPanelOpen);
    if (!currentState.petJobPanelOpen) return;
    controls.petJobPanel.innerHTML = jobs.slice(0, 5).map((job) => `
      <article class="pet-job-item ${escape(job.status)}">
        <strong>${escape(job.botName || job.petId)}</strong>
        <span>${escape(job.status === "running" ? "生成中" : job.status === "completed" ? "已完成" : "失败")}</span>
        ${job.error ? `<p>${escape(job.error)}</p>` : ""}
        ${job.logPath ? `<small>${escape(job.logPath)}</small>` : ""}
      </article>
    `).join("");
  }

  async function placeBotPet(botKey) {
    try {
      await window.mia.placeBotPet(botKey);
      await refreshRuntime();
    } catch (error) {
      appendTransientChat("assistant", `放进桌面失败: ${error.message}`);
    }
  }

  async function recallBotPet(botKey) {
    try {
      await window.mia.recallBotPet(botKey);
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
