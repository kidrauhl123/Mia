import { useSyncExternalStore } from "react";
import type { SkillSourceLogo } from "./skills";
import type { AvatarView, StatusBadgeView } from "./contacts";

export type SkillDialogView = Readonly<{
  actionDisabled: boolean;
  actionInstalled: boolean;
  actionLabel: string;
  back: () => void;
  bodyHtml: string;
  bodyState: string;
  close: () => void;
  kind: "skill";
  meta: string;
  primary: () => void;
  showBody: boolean;
  sourceLogo: SkillSourceLogo | null;
  summary: string;
  title: string;
  toggleBody: () => void;
}>;

export type McpFormValues = Readonly<{
  args: string;
  bearerTokenEnvVar: string;
  command: string;
  description: string;
  env: string;
  headers: string;
  name: string;
  type: string;
  url: string;
}>;

export type McpFormDialogView = Readonly<{
  close: () => void;
  id: string;
  initial: McpFormValues;
  kind: "mcp-form";
  submit: (values: McpFormValues) => Promise<void>;
  title: string;
}>;

export type McpTemplateField = Readonly<{
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
}>;

export type McpTemplateDialogView = Readonly<{
  busy: boolean;
  close: () => void;
  copy: string;
  fields: readonly McpTemplateField[];
  id: string;
  kind: "mcp-template";
  submit: (values: Readonly<Record<string, string>>) => Promise<void>;
  title: string;
}>;

export type McpMessageView = Readonly<{
  close: () => void;
  text: string;
}>;

export type AddFriendRequestView = Readonly<{
  accept: (() => Promise<void>) | null;
  avatar: AvatarView;
  badge: StatusBadgeView | null;
  cancel: (() => Promise<void>) | null;
  id: string;
  name: string;
  reject: (() => Promise<void>) | null;
}>;

export type AddFriendDialogView = Readonly<{
  close: () => void;
  copyUid: () => Promise<void>;
  incoming: readonly AddFriendRequestView[];
  kind: "add-friend";
  myUid: string;
  outgoing: readonly AddFriendRequestView[];
  send: (uid: string) => Promise<string>;
}>;

export type TaskCreateValues = Readonly<{
  botId: string;
  date: string;
  dayOfMonth: number;
  frequency: "daily" | "monthly" | "oneshot" | "weekly";
  prompt: string;
  time: string;
  title: string;
  weekday: number;
}>;

export type TaskCreateDialogView = Readonly<{
  botId: string;
  bots: readonly Readonly<{ id: string; label: string }>[];
  close: () => void;
  kind: "task-create";
  submit: (values: TaskCreateValues) => Promise<string>;
}>;

export type GroupCreateMemberView = Readonly<{
  avatar: AvatarView;
  badge: StatusBadgeView | null;
  id: string;
  key: string;
  name: string;
}>;

export type GroupCreateDialogView = Readonly<{
  close: () => void;
  kind: "group-create";
  members: readonly GroupCreateMemberView[];
  submit: (memberKeys: readonly string[], name: string) => Promise<string>;
}>;

export type GroupInfoMemberView = Readonly<{
  avatar: AvatarView;
  badge: StatusBadgeView | null;
  canRemove: boolean;
  canSetHost: boolean;
  host: boolean;
  key: string;
  name: string;
  removeLabel: string;
  remove: () => Promise<string>;
  setHost: () => Promise<string>;
}>;

export type GroupInfoAddableMemberView = Readonly<{
  avatar: AvatarView;
  badge: StatusBadgeView | null;
  key: string;
  name: string;
  add: () => Promise<string>;
}>;

export type GroupInfoDialogView = Readonly<{
  addable: readonly GroupInfoAddableMemberView[];
  avatar: AvatarView | null;
  chooseAvatar: (dataUrl: string) => void;
  close: () => void;
  goal: string;
  kind: "group-info";
  members: readonly GroupInfoMemberView[];
  mosaic: readonly AvatarView[];
  name: string;
  publicId: string;
  resetAvatar: () => Promise<string>;
  resetContext: () => Promise<string>;
  saveGoal: (goal: string) => Promise<string>;
  saveName: (name: string) => Promise<string>;
}>;

export type IdentityBadgeChoiceView = Readonly<{
  badge: StatusBadgeView | null;
  label: string;
  value: string;
}>;

export type ProfileDialogView = Readonly<{
  avatar: AvatarView;
  badgeChoices: readonly IdentityBadgeChoiceView[];
  badgeValue: string;
  chooseAvatar: (file: File) => void;
  close: () => void;
  color: string;
  colors: readonly string[];
  kind: "profile";
  name: string;
  openAvatarEditor: () => void;
  setBadge: (value: string) => void;
  setColor: (value: string) => void;
  setName: (value: string) => void;
  uid: string;
}>;

export type BotRuntimeOptionView = Readonly<{
  disabled: boolean;
  label: string;
  title: string;
  value: string;
}>;

export type BotRuntimeGroupView = Readonly<{
  label: string;
  options: readonly BotRuntimeOptionView[];
}>;

export type BotDialogView = Readonly<{
  avatar: AvatarView;
  badgeChoices: readonly IdentityBadgeChoiceView[];
  badgeValue: string;
  chooseAvatar: (file: File) => void;
  close: () => void;
  color: string;
  colors: readonly string[];
  key: string;
  kind: "bot";
  mode: "create" | "edit";
  name: string;
  localAgentSetupRequired: boolean;
  openModelSettings: () => void;
  openAvatarEditor: () => void;
  persona: string;
  personaOpen: boolean;
  runtimeGroups: readonly BotRuntimeGroupView[];
  runtimeLoadError: string;
  runtimeLoading: boolean;
  runtimeSetupRequired: boolean;
  runtimeValue: string;
  retryRuntime: () => void;
  setBadge: (value: string) => void;
  setColor: (value: string) => void;
  setName: (value: string) => void;
  setPersona: (value: string) => void;
  setPersonaOpen: (open: boolean) => void;
  setRuntime: (value: string) => void;
  submit: () => Promise<string>;
  title: string;
}>;

export type AvatarCropDialogView = Readonly<{
  close: () => void;
  confirm: () => Promise<void>;
  crop: Readonly<Record<string, unknown>>;
  image: string;
  isVideo: boolean;
  kind: "avatar-crop";
  reset: () => void;
  update: (patch: Readonly<Record<string, unknown>>) => void;
}>;

export type PetGenerateDialogView = Readonly<{
  addReference: (file: File) => void;
  close: () => void;
  kind: "pet-generate";
  references: readonly Readonly<{ id: string; src: string }>[];
  removeReference: (id: string) => void;
  submit: (prompt: string, stylePreset: string) => Promise<string>;
  subtitle: string;
  title: string;
}>;

export type CloudLoginApprovalDialogView = Readonly<{
  close: () => void;
  copy: string;
  decide: (decision: "approve" | "deny") => Promise<string>;
  kind: "cloud-login-approval";
}>;

export type DialogView =
  | Readonly<{ kind: "closed" }>
  | SkillDialogView
  | McpFormDialogView
  | McpTemplateDialogView
  | AddFriendDialogView
  | TaskCreateDialogView
  | GroupCreateDialogView
  | GroupInfoDialogView
  | ProfileDialogView
  | BotDialogView
  | AvatarCropDialogView
  | PetGenerateDialogView
  | CloudLoginApprovalDialogView;

export type DialogsSnapshot = Readonly<{
  dialog: DialogView;
  message: McpMessageView | null;
  revision: number;
}>;

type DialogsPatch = Partial<Omit<DialogsSnapshot, "revision">>;
type Listener = () => void;

const initialSnapshot: DialogsSnapshot = {
  dialog: { kind: "closed" },
  message: null,
  revision: 0
};
let snapshot: DialogsSnapshot = Object.freeze(initialSnapshot);
const listeners = new Set<Listener>();

function publish(patch: DialogsPatch): void {
  snapshot = Object.freeze({
    ...snapshot,
    ...patch,
    revision: snapshot.revision + 1
  });
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDialogs(): DialogsSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

declare global {
  interface Window {
    miaReactDialogs?: {
      current(): DialogsSnapshot;
      publish(patch: DialogsPatch): void;
    };
  }
}

window.miaReactDialogs = {
  current: () => snapshot,
  publish
};
