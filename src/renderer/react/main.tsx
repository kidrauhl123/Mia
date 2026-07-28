import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { lazy, Suspense } from "react";
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
import { useRendererShell } from "./hooks/useRendererShell";
import { useDialogs } from "./stores/dialogs";
import "./stores/conversation-list";
import "./stores/conversation-folders";
import "./stores/composer-content";
import "./stores/composer-menus";
import "./stores/message-list";
import "./stores/permission-banner";
import "./stores/bot-store";
import "./stores/contacts";
import "./stores/skills";
import "./stores/tasks";
import "./stores/settings-compat";
import "./stores/chat-menus";
import "./stores/dialogs";
import "./bridge";

const BotStorePortals = lazy(() => import("./components/BotStore"));
const ContactPortals = lazy(() => import("./components/Contacts"));
const SkillPortals = lazy(() => import("./components/Skills"));
const TaskPortals = lazy(() => import("./components/Tasks"));
const SettingsCompatPortals = lazy(() => import("./components/SettingsCompat"));
const DialogPortals = lazy(() => import("./components/Dialogs"));

function portal(id: string, component: React.ReactNode): React.ReactPortal | null {
  const host = document.getElementById(id);
  return host ? createPortal(component, host, id) : null;
}

function RendererApp() {
  const snapshot = useRendererShell();
  const dialogs = useDialogs();
  return (
    <>
      {portal("reactNavigationRoot", <NavigationRail />)}
      {portal("sidebarBottomNav", <BottomNavigation />)}
      {portal("reactChatHeaderRoot", <ChatHeader />)}
      {portal("reactComposerInputRoot", <ComposerInput />)}
      {portal("composerReply", <ComposerReply />)}
      {portal("composerAttachments", <ComposerAttachments />)}
      {portal("composerSkills", <ComposerSkills />)}
      {portal("composerAddMenu", <ComposerAddMenu />)}
      {portal("skillPickerBody", <SkillPickerBody />)}
      {portal("slashCommandMenu", <SlashCommandMenu />)}
      {portal("mentionMenu", <MentionMenu />)}
      {portal("reactComposerSelectMenuRoot", <ComposerSelectMenu />)}
      {portal("personaTagFilters", <ConversationFolderTabs />)}
      {portal("personaList", <ConversationList />)}
      {portal("discoverModeToggle", <DiscoverModeToggle />)}
      {portal("reactContactsExploreTabsRoot", <ExploreTabs className="explore-sidebar-tabs contacts-explore-tabs" />)}
      {portal("reactExploreTabsRoot", <ExploreTabs />)}
      {portal("reactTaskTabsRoot", <TaskTabs />)}
      {portal("reactSettingsSidebarTabsRoot", <SettingsSidebarTabs />)}
      {portal("reactSettingsWorkspaceTabsRoot", <SettingsWorkspaceTabs />)}
      {portal("chat", <MessageList />)}
      {portal("agentPermissionBanner", <PermissionBanner />)}
      <Suspense fallback={null}>
        {snapshot.activeView === "contacts" ? <ContactPortals /> : null}
        {snapshot.activeView === "bot-store" ? <BotStorePortals /> : null}
        {snapshot.activeView === "skills" ? <SkillPortals /> : null}
        {snapshot.activeView === "tasks" ? <TaskPortals /> : null}
        {snapshot.activeView === "settings" ? <SettingsCompatPortals /> : null}
        {dialogs.dialog.kind !== "closed" || dialogs.message ? <DialogPortals /> : null}
      </Suspense>
    </>
  );
}

const rootElement = document.getElementById("reactRendererRoot");
if (!rootElement) throw new Error("Missing #reactRendererRoot");
const root = createRoot(rootElement);
flushSync(() => root.render(<RendererApp />));

document.documentElement.dataset.rendererFramework = "react";
window.miaReactRenderer = {
  destroy() {
    root.unmount();
    delete document.documentElement.dataset.rendererFramework;
  }
};

const appScript = document.createElement("script");
appScript.src = "./app.js";
appScript.dataset.rendererEntry = "controller-adapters";
document.body.appendChild(appScript);
