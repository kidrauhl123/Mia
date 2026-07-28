import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { BottomNavigation, NavigationRail } from "./components/Navigation";
import { ChatHeader } from "./components/ChatHeader";
import { ComposerInput } from "./components/ComposerInput";
import {
  ComposerAddMenu,
  ComposerAttachments,
  ComposerReply,
  ComposerSkills,
  SkillPickerBody
} from "./components/ComposerContent";
import { MentionMenu, SlashCommandMenu } from "./components/ComposerMenus";
import { ComposerSelectMenu } from "./components/ComposerSelectMenu";
import { ConversationList } from "./components/ConversationList";
import { ConversationFolderTabs } from "./components/ConversationFolderTabs";
import {
  DiscoverModeToggle,
  ExploreTabs,
  SettingsSidebarTabs,
  SettingsWorkspaceTabs,
  TaskTabs
} from "./components/SectionTabs";
import { MessageList } from "./components/MessageList";
import { PermissionBanner } from "./components/PermissionBanner";
import { LegacySurface } from "./components/LegacySurface";
import "./stores/conversation-list";
import "./stores/conversation-folders";
import "./stores/composer-content";
import "./stores/composer-menus";
import "./stores/legacy-surface";
import "./stores/message-list";
import "./stores/permission-banner";
import "./bridge";

const roots: Root[] = [];

function mount(element: HTMLElement | null, component: React.ReactNode): void {
  if (!element) return;
  const root = createRoot(element);
  flushSync(() => root.render(component));
  roots.push(root);
}

mount(document.getElementById("reactNavigationRoot"), <NavigationRail />);
mount(document.getElementById("sidebarBottomNav"), <BottomNavigation />);
mount(document.getElementById("reactChatHeaderRoot"), <ChatHeader />);
mount(document.getElementById("reactComposerInputRoot"), <ComposerInput />);
mount(document.getElementById("composerReply"), <ComposerReply />);
mount(document.getElementById("composerAttachments"), <ComposerAttachments />);
mount(document.getElementById("composerSkills"), <ComposerSkills />);
mount(document.getElementById("composerAddMenu"), <ComposerAddMenu />);
mount(document.getElementById("skillPickerBody"), <SkillPickerBody />);
mount(document.getElementById("slashCommandMenu"), <SlashCommandMenu />);
mount(document.getElementById("mentionMenu"), <MentionMenu />);
mount(document.getElementById("reactComposerSelectMenuRoot"), <ComposerSelectMenu />);
mount(document.getElementById("personaTagFilters"), <ConversationFolderTabs />);
mount(document.getElementById("personaList"), <ConversationList />);
mount(document.getElementById("discoverModeToggle"), <DiscoverModeToggle />);
mount(document.getElementById("reactContactsExploreTabsRoot"), <ExploreTabs className="explore-sidebar-tabs contacts-explore-tabs" />);
mount(document.getElementById("reactExploreTabsRoot"), <ExploreTabs />);
mount(document.getElementById("reactTaskTabsRoot"), <TaskTabs />);
mount(document.getElementById("reactSettingsSidebarTabsRoot"), <SettingsSidebarTabs />);
mount(document.getElementById("reactSettingsWorkspaceTabsRoot"), <SettingsWorkspaceTabs />);
mount(document.getElementById("chat"), <MessageList />);
mount(document.getElementById("agentPermissionBanner"), <PermissionBanner />);

for (const id of [
  "contactList",
  "contactDetail",
  "skillModeToggle",
  "skillChipRow",
  "skillCardGrid",
  "botStoreCap",
  "botStoreGrid",
  "botStoreSheet",
  "taskModeToggle",
  "taskChipRow",
  "tasksContent",
  "taskPreviewActions",
  "taskPreviewBody",
  "connectedProviderList",
  "engineRowHermesActions",
  "engineRowClaudeActions",
  "engineRowCodexActions",
  "engineInstallActions",
  "cloudMobileScanQr"
]) {
  mount(document.getElementById(id), <LegacySurface id={id} />);
}

document.documentElement.dataset.rendererFramework = "react";
window.miaReactRenderer = {
  destroy() {
    for (const root of roots.splice(0)) root.unmount();
    delete document.documentElement.dataset.rendererFramework;
  }
};
