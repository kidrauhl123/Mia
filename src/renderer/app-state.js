(function () {
  "use strict";

  const SETUP_GUIDE_DISMISSED_KEY = "mia.setupGuideDismissed.v2";
  const AGENT_SETUP_SKIPPED_KEY = "mia.agentSetupSkipped.v1";

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
      generatingTitleIds: new Set(),
      generatedFiles: new Map(),
      startupTasks: [],
      firstRun: false,
      setupGuideDismissed: readLocal(storage, SETUP_GUIDE_DISMISSED_KEY) === "1",
      agentSetupSkipped: readLocal(storage, AGENT_SETUP_SKIPPED_KEY) === "1",
      onboardingStep: readLocal(storage, "mia.onboardingStep", ""),
      onboardingPickedEngine: "",
      preferredAgentEngine: readLocal(storage, "mia.preferredAgentEngine.v1", "hermes"),
      hermesInstallError: "",
      agentSetupInstallInFlight: false,
      agentSetupInstallEngine: "",
      agentSetupInstallMessage: "",
      agentSetupInstallStage: "",
      agentSetupInstallPercent: 0,
      agentSetupInstallErrors: {},
      agentSetupInstallProgressTimer: 0,
      forceScrollToBottom: false,
      sessionMenuOpen: false,
      activeView: "chat",
      // 发现/联系人 section 上次停留的子页。联系人 rail 默认落到发现页；
      // 切到联系人子页时才启用中栏 + 详情的三槽布局。
      discoverSectionView: "bot-store",
      activeContactKey: "",
      narrowPane: "content",
      shellLayout: windowWidth <= 720 ? "single" : "dual",
      isNarrowWindow: windowWidth <= 720,
      sidebarCollapsed: options.sidebarCollapsed ?? readLocal(storage, "mia.sidebarCollapsed.v1") === "1",
      sidebarWidth: options.sidebarWidth,
      sidebarResize: { dragging: false, startX: 0, startWidth: 0 },
      activeSettingsTab: "account",
      personaFilter: "",
      personaSearchOpen: false,
      personaSearchLoading: false,
      personaSearchError: "",
      personaSearchQuery: "",
      personaSearchResults: [],
      personaSearchFocus: { conversationId: "", messageId: "" },
      contactFilter: "",
      skillFilter: "",
      skillCategoryFilter: "",
      skillCapabilityMode: "market",
      skillMarketMode: true,
      skillMarket: {
        skills: [],
        categories: [],
        loading: false,
        refreshing: false,
        loaded: false,
        cached: false,
        stale: false,
        queryKey: "",
        error: "",
        updatedAt: ""
      },
      mcp: {
        activeTab: "installed",
        servers: [],
        templates: [],
        loading: false,
        syncing: false,
        error: "",
        selectedId: "",
        formOpen: false,
        formMode: "create",
        formDraft: null,
        importOpen: false,
        importText: ""
      },
      installingSkillIds: new Set(),
      composerActiveSkills: [],
      composerSkillSelected: false,
      composerSkillsConversationId: "",
      skillContextMenu: { open: false, x: 0, y: 0, skillId: "" },
      botContextMenu: { open: false, x: 0, y: 0, botKey: "" },
      messageContextMenu: { open: false, x: 0, y: 0, messageIndex: -1, selectionText: "" },
      replyDraft: null,
      botMenuOpen: false,
      contactMenuOpen: false,
      profileDialogOpen: false,
      botDialogOpen: false,
      botDialogMode: "create",
      petGenerateOpen: false,
      petGenerateBotKey: "",
      petReferences: [],
      petJobs: [],
      petJobPanelOpen: false,
      botAvatarDraft: {
        image: "",
        crop: { x: 50, y: 50, zoom: 1, start: 0, duration: 3 }
      },
      profileAvatarDraft: {
        image: "",
        crop: { x: 50, y: 50, zoom: 1, start: 0, duration: 3 }
      },
      avatarCropEditor: {
        open: false,
        target: "bot",
        image: "",
        crop: { x: 50, y: 50, zoom: 1, start: 0, duration: 3 },
        dragging: false,
        lastX: 0,
        lastY: 0
      },
      modelCatalog: [],
      skillLibrary: { plugins: [], sources: [], extensions: [], connectors: [], skills: [], botPresets: [], roots: [] },
      savingBotCapabilities: new Set(),
      skillPickerOpen: false,
      skillPickerFilter: "",
      selectedSkillId: "",
      selectedSkillDetail: null,
      skillsLoading: false,
      slashCommands: cloneSlashCommands(),
      agentSlashCommands: { "claude-code": [], codex: [] },
      slashMenuOpen: false,
      composerAddMenuOpen: false,
      pendingAttachments: [],
      slashSelectedIndex: 0,
      slashFilter: "",
      mentionMenuOpen: false,
      mentionFilter: "",
      mentionSelectedIndex: 0,
      mentionStart: -1,
      mentionEnd: -1,
      openTraceKeys: new Set(),
      animatedTraceKeys: new Set(),
      codexModels: [],
      tasks: [],
      taskFilter: "",
      taskMode: "active",
      taskHistoryFilter: "all",
      selectedTaskId: "",
      selectedRunId: "",
      tasksUnread: new Map()
    };
  }

  window.miaAppState = {
    SETUP_GUIDE_DISMISSED_KEY,
    AGENT_SETUP_SKIPPED_KEY,
    fallbackSlashCommands,
    createInitialState
  };
})();
