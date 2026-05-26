(function () {
  "use strict";

  const SETUP_GUIDE_DISMISSED_KEY = "mia.setupGuideDismissed.v2";

  const fallbackSlashCommands = Object.freeze([
    { command: "/new", description: "Start a new session (fresh session ID + history)" },
    { command: "/topic", description: "Enable or inspect Telegram DM topic sessions" },
    { command: "/retry", description: "Retry the last message (resend to agent)" },
    { command: "/undo", description: "Remove the last user/assistant exchange" },
    { command: "/title", description: "Set a title for the current session" },
    { command: "/branch", description: "Branch the current session (explore a different path)" },
    { command: "/compress", description: "Manually compress conversation context" },
    { command: "/rollback", description: "List or restore filesystem checkpoints" },
    { command: "/commands", description: "Browse all commands and skills" },
    { command: "/help", description: "Show available commands" }
  ]);

  function readLocal(storage, key, fallback = "") {
    try {
      return storage?.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  }

  function cloneSlashCommands() {
    return fallbackSlashCommands.map((command) => ({ ...command }));
  }

  function createInitialState(options = {}) {
    const storage = options.localStorage || window.localStorage;
    const windowWidth = Number.isFinite(options.windowWidth) ? options.windowWidth : window.innerWidth;
    return {
      runtime: null,
      activeKey: "",
      chatStore: { schema_version: 1, readAt: {}, sessions: {} },
      activeSessionIdByPersona: {},
      generatingTitleIds: new Set(),
      generatedFiles: new Map(),
      startupTasks: [],
      firstRun: false,
      setupGuideDismissed: readLocal(storage, SETUP_GUIDE_DISMISSED_KEY) === "1",
      onboardingStep: readLocal(storage, "mia.onboardingStep", "engine"),
      onboardingPickedEngine: "",
      forceScrollToBottom: false,
      sessionMenuOpen: false,
      activeView: "chat",
      activeContactKey: "",
      narrowPane: "content",
      isNarrowWindow: windowWidth <= 720,
      sidebarWidth: options.sidebarWidth,
      sidebarResize: { dragging: false, startX: 0, startWidth: 0 },
      activeSettingsTab: "account",
      mobileLanLinkExpanded: false,
      mobileRelayLinkExpanded: false,
      personaFilter: "",
      contactFilter: "",
      skillFilter: "",
      skillCategoryFilter: "",
      skillMarketMode: false,
      skillMarket: { skills: [], categories: [], loading: false, loaded: false },
      installingSkillIds: new Set(),
      skillContextMenu: { open: false, x: 0, y: 0, skillId: "" },
      fellowContextMenu: { open: false, x: 0, y: 0, fellowKey: "" },
      messageContextMenu: { open: false, x: 0, y: 0, messageIndex: -1, selectionText: "" },
      replyDraft: null,
      fellowMenuOpen: false,
      contactMenuOpen: false,
      profileDialogOpen: false,
      fellowDialogOpen: false,
      fellowDialogMode: "create",
      fellowAvatarPresetGroup: "human",
      profileAvatarPresetGroup: "human",
      petGenerateOpen: false,
      petGenerateFellowKey: "",
      petReferences: [],
      petJobs: [],
      petJobPanelOpen: false,
      fellowAvatarDraft: {
        image: "",
        crop: { x: 50, y: 50, zoom: 1 }
      },
      profileAvatarDraft: {
        image: "",
        crop: { x: 50, y: 50, zoom: 1 }
      },
      avatarCropEditor: {
        open: false,
        target: "fellow",
        image: "",
        crop: { x: 50, y: 50, zoom: 1 },
        dragging: false,
        lastX: 0,
        lastY: 0
      },
      settingsOpen: false,
      modelCatalog: [],
      skillLibrary: { plugins: [], sources: [], extensions: [], connectors: [], skills: [], roots: [] },
      savingFellowCapabilities: new Set(),
      skillPickerOpen: false,
      skillPickerFilter: "",
      skillPickerPluginId: "",
      selectedSkillId: "",
      selectedSkillDetail: null,
      skillPreviewOpen: false,
      skillsLoading: false,
      slashCommands: cloneSlashCommands(),
      agentSlashCommands: { "claude-code": [], codex: [] },
      slashMenuOpen: false,
      composerAddMenuOpen: false,
      pendingAttachments: [],
      slashSelectedIndex: 0,
      slashFilter: "",
      isGenerating: false,
      streaming: null,
      openTraceKeys: new Set(),
      animatedTraceKeys: new Set(),
      codexModels: [],
      tasks: [],
      taskFilter: "",
      selectedTaskId: "",
      selectedRunId: "",
      historyExpanded: false,
      disabledExpanded: false,
      tasksUnread: new Map()
    };
  }

  window.miaAppState = {
    SETUP_GUIDE_DISMISSED_KEY,
    fallbackSlashCommands,
    createInitialState
  };
})();
