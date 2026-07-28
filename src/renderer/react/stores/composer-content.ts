import { flushSync } from "react-dom";
import { useSyncExternalStore } from "react";
import { measureReactCommit } from "../performance";

export type ComposerAttachmentItem = Readonly<{
  glyph: string;
  id: string;
  imageSrc: string;
  kind: "file" | "image";
  title: string;
}>;

export type ComposerAttachmentsPayload = Readonly<{
  focus: () => void;
  items: readonly ComposerAttachmentItem[];
  preview: (id: string) => void;
  remove: (id: string) => void;
}>;

export type ComposerAddMenuPayload = Readonly<{
  addAttachment: () => void;
  openSkills: () => void;
  open: boolean;
  scheduleSkillClose: () => void;
  shouldKeepSkillOpen: (target: EventTarget | null) => boolean;
}>;

export type ComposerReplyPayload = Readonly<{
  author: string;
  clear: () => void;
  content: string;
  messageId: string;
  visible: boolean;
}>;

export type ComposerSkillItem = Readonly<{
  id: string;
  name: string;
  selected: boolean;
}>;

export type ComposerSkillsPayload = Readonly<{
  items: readonly ComposerSkillItem[];
}>;

export type SkillPickerItem = Readonly<{
  description: string;
  key: string;
  name: string;
  title: string;
}>;

export type SkillPickerPayload = Readonly<{
  emptyText: string;
  items: readonly SkillPickerItem[];
  select: (name: string) => void;
}>;

type Snapshot<T> = T & Readonly<{
  fingerprint: string;
  revision: number;
}>;

type Listener = () => void;

const noop = () => {};
const attachmentListeners = new Set<Listener>();
const addMenuListeners = new Set<Listener>();
const replyListeners = new Set<Listener>();
const skillListeners = new Set<Listener>();
const skillPickerListeners = new Set<Listener>();

let attachmentSnapshot: Snapshot<ComposerAttachmentsPayload> = Object.freeze({
  fingerprint: "",
  focus: noop,
  items: Object.freeze([]),
  preview: noop,
  remove: noop,
  revision: 0
});

let addMenuSnapshot: Snapshot<ComposerAddMenuPayload> = Object.freeze({
  addAttachment: noop,
  fingerprint: "",
  open: false,
  openSkills: noop,
  revision: 0,
  scheduleSkillClose: noop,
  shouldKeepSkillOpen: () => false
});

let replySnapshot: Snapshot<ComposerReplyPayload> = Object.freeze({
  author: "",
  clear: noop,
  content: "",
  fingerprint: "",
  messageId: "",
  revision: 0,
  visible: false
});

let skillSnapshot: Snapshot<ComposerSkillsPayload> = Object.freeze({
  fingerprint: "",
  items: Object.freeze([]),
  revision: 0
});

let skillPickerSnapshot: Snapshot<SkillPickerPayload> = Object.freeze({
  emptyText: "",
  fingerprint: "",
  items: Object.freeze([]),
  revision: 0,
  select: noop
});

function publish<T>(
  name: string,
  payload: T,
  fingerprint: string,
  previous: Snapshot<T>,
  listeners: Set<Listener>,
  assign: (snapshot: Snapshot<T>) => void
): void {
  if (fingerprint === previous.fingerprint) {
    assign(Object.freeze({ ...previous, ...payload }));
    return;
  }
  measureReactCommit(name, () => flushSync(() => {
    assign(Object.freeze({
      ...payload,
      fingerprint,
      revision: previous.revision + 1
    }));
    for (const listener of [...listeners]) listener();
  }));
}

function publishAttachments(payload: ComposerAttachmentsPayload): void {
  const fingerprint = JSON.stringify(payload.items.map((item) => ({
    glyph: item.glyph,
    id: item.id,
    imageBytes: item.imageSrc.length,
    imageHead: item.imageSrc.slice(0, 48),
    imageTail: item.imageSrc.slice(-48),
    kind: item.kind,
    title: item.title
  })));
  publish(
    "react.commit.composerAttachments",
    { ...payload, items: Object.freeze([...payload.items]) },
    fingerprint,
    attachmentSnapshot,
    attachmentListeners,
    (snapshot) => { attachmentSnapshot = snapshot; }
  );
}

function publishAddMenu(payload: ComposerAddMenuPayload): void {
  publish(
    "react.commit.composerAddMenu",
    payload,
    payload.open ? "open" : "closed",
    addMenuSnapshot,
    addMenuListeners,
    (snapshot) => { addMenuSnapshot = snapshot; }
  );
}

function publishReply(payload: ComposerReplyPayload): void {
  publish(
    "react.commit.composerReply",
    payload,
    JSON.stringify({
      author: payload.author,
      content: payload.content,
      messageId: payload.messageId,
      visible: payload.visible
    }),
    replySnapshot,
    replyListeners,
    (snapshot) => { replySnapshot = snapshot; }
  );
}

function publishSkills(payload: ComposerSkillsPayload): void {
  publish(
    "react.commit.composerSkills",
    { items: Object.freeze([...payload.items]) },
    JSON.stringify(payload.items),
    skillSnapshot,
    skillListeners,
    (snapshot) => { skillSnapshot = snapshot; }
  );
}

function publishSkillPicker(payload: SkillPickerPayload): void {
  publish(
    "react.commit.skillPicker",
    { ...payload, items: Object.freeze([...payload.items]) },
    JSON.stringify({ emptyText: payload.emptyText, items: payload.items }),
    skillPickerSnapshot,
    skillPickerListeners,
    (snapshot) => { skillPickerSnapshot = snapshot; }
  );
}

function subscribe(listeners: Set<Listener>, listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useComposerAttachments(): Snapshot<ComposerAttachmentsPayload> {
  return useSyncExternalStore(
    (listener) => subscribe(attachmentListeners, listener),
    () => attachmentSnapshot,
    () => attachmentSnapshot
  );
}

function useComposerAddMenu(): Snapshot<ComposerAddMenuPayload> {
  return useSyncExternalStore(
    (listener) => subscribe(addMenuListeners, listener),
    () => addMenuSnapshot,
    () => addMenuSnapshot
  );
}

function useComposerReply(): Snapshot<ComposerReplyPayload> {
  return useSyncExternalStore(
    (listener) => subscribe(replyListeners, listener),
    () => replySnapshot,
    () => replySnapshot
  );
}

function useComposerSkills(): Snapshot<ComposerSkillsPayload> {
  return useSyncExternalStore(
    (listener) => subscribe(skillListeners, listener),
    () => skillSnapshot,
    () => skillSnapshot
  );
}

function useSkillPicker(): Snapshot<SkillPickerPayload> {
  return useSyncExternalStore(
    (listener) => subscribe(skillPickerListeners, listener),
    () => skillPickerSnapshot,
    () => skillPickerSnapshot
  );
}

export type MiaReactComposerContent = {
  publishAddMenu(payload: ComposerAddMenuPayload): void;
  publishAttachments(payload: ComposerAttachmentsPayload): void;
  publishReply(payload: ComposerReplyPayload): void;
  publishSkillPicker(payload: SkillPickerPayload): void;
  publishSkills(payload: ComposerSkillsPayload): void;
};

declare global {
  interface Window {
    miaReactComposerContent?: MiaReactComposerContent;
  }
}

window.miaReactComposerContent = {
  publishAddMenu,
  publishAttachments,
  publishReply,
  publishSkillPicker,
  publishSkills
};

export {
  useComposerAddMenu,
  useComposerAttachments,
  useComposerReply,
  useComposerSkills,
  useSkillPicker
};
