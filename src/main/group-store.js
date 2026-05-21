const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  normalizeMember,
  normalizeMembersList,
  memberKey,
  membersIncludeKey,
} = require("./group/member-model.js");

function atomicWrite(filePath, content) {
  const tmp = filePath + ".tmp." + crypto.randomBytes(6).toString("hex");
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* tmp may not exist */ }
    throw e;
  }
}

function readJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}

function createGroupStore(rootDir) {
  fs.mkdirSync(rootDir, { recursive: true });
  const manifestPath = path.join(rootDir, "manifest.json");

  function loadManifest() {
    return readJSON(manifestPath, { groups: [] });
  }

  function saveManifest(manifest) {
    atomicWrite(manifestPath, JSON.stringify(manifest, null, 2));
  }

  function groupPath(id) {
    return path.join(rootDir, id);
  }

  function groupJsonPath(id) {
    return path.join(groupPath(id), "group.json");
  }

  function messagesPath(id) {
    return path.join(groupPath(id), "messages.jsonl");
  }

  function contextCardPath(id) {
    return path.join(groupPath(id), "context-card.json");
  }

  function create({ name, members, hostMember, hostFellowId, avatar = null }) {
    const normalizedMembers = normalizeMembersList(members);
    if (normalizedMembers.length < 2 || normalizedMembers.length > 5) {
      throw new Error("group members must be between 2 and 5");
    }
    // Backward-compat: accept legacy hostFellowId if hostMember absent
    const hostInput = hostMember != null ? hostMember : hostFellowId;
    if (hostInput == null) throw new Error("hostMember is required");
    const normalizedHost = normalizeMember(hostInput);
    if (!membersIncludeKey(normalizedMembers, memberKey(normalizedHost))) {
      throw new Error("hostMember must be one of members");
    }
    const id = "g-" + crypto.randomBytes(8).toString("hex");
    const now = Date.now();
    const group = {
      id,
      name,
      avatar,
      members: normalizedMembers,
      hostMember: normalizedHost,
      decorations: { pinnedGoal: null, todos: [] },
      contextCard: null,
      createdAt: now,
      updatedAt: now,
    };
    fs.mkdirSync(groupPath(id), { recursive: true });
    atomicWrite(groupJsonPath(id), JSON.stringify(group, null, 2));
    fs.writeFileSync(messagesPath(id), "");
    const manifest = loadManifest();
    manifest.groups.push({ id, name, createdAt: now });
    saveManifest(manifest);
    return group;
  }

  function list() {
    return loadManifest().groups.map((entry) => get(entry.id)).filter(Boolean);
  }

  function migrateLegacyGroup(raw) {
    if (!raw) return raw;
    // Already new schema: pass through
    if (raw.hostMember && Array.isArray(raw.members) && raw.members.every((m) => m && m.kind === "fellow")) {
      return raw;
    }
    const normalizedMembers = Array.isArray(raw.members) ? raw.members.map(normalizeMember) : [];
    const hostSrc = raw.hostMember ?? raw.hostFellowId;
    const hostMember = hostSrc != null ? normalizeMember(hostSrc) : null;
    // Strip legacy field so callers never see it
    const { hostFellowId, ...rest } = raw;
    return { ...rest, members: normalizedMembers, hostMember };
  }

  function get(id) {
    const raw = readJSON(groupJsonPath(id), null);
    return migrateLegacyGroup(raw);
  }

  function updateGroup(id, patch) {
    const existing = get(id);
    if (!existing) throw new Error("group not found: " + id);
    const normalizedPatch = { ...patch };
    if (Object.prototype.hasOwnProperty.call(normalizedPatch, "members")) {
      normalizedPatch.members = normalizeMembersList(normalizedPatch.members);
    }
    // host field upgrade: prefer new hostMember; fall back to legacy hostFellowId
    if (normalizedPatch.hostMember != null) {
      normalizedPatch.hostMember = normalizeMember(normalizedPatch.hostMember);
    } else if (normalizedPatch.hostFellowId != null) {
      normalizedPatch.hostMember = normalizeMember(normalizedPatch.hostFellowId);
    }
    delete normalizedPatch.hostFellowId;
    const updated = { ...existing, ...normalizedPatch, updatedAt: Date.now() };
    atomicWrite(groupJsonPath(id), JSON.stringify(updated, null, 2));
    if (normalizedPatch.name) {
      const manifest = loadManifest();
      const entry = manifest.groups.find((g) => g.id === id);
      if (entry) entry.name = normalizedPatch.name;
      saveManifest(manifest);
    }
    if (normalizedPatch && Object.prototype.hasOwnProperty.call(normalizedPatch, "contextCard") && normalizedPatch.contextCard === null) {
      try { fs.unlinkSync(contextCardPath(id)); } catch { /* may not exist */ }
    }
    return updated;
  }

  function touchGroup(id, updatedAt = Date.now()) {
    const existing = get(id);
    if (!existing) throw new Error("group not found: " + id);
    const nextUpdatedAt = Number.isFinite(Number(updatedAt)) ? Number(updatedAt) : Date.now();
    const updated = { ...existing, updatedAt: nextUpdatedAt };
    atomicWrite(groupJsonPath(id), JSON.stringify(updated, null, 2));
    const manifest = loadManifest();
    const entry = manifest.groups.find((g) => g.id === id);
    if (entry) entry.updatedAt = nextUpdatedAt;
    saveManifest(manifest);
    return updated;
  }

  function deleteGroup(id) {
    const existing = get(id);
    if (!existing) throw new Error("group not found: " + id);
    const manifest = loadManifest();
    manifest.groups = (manifest.groups || []).filter((entry) => entry.id !== id);
    saveManifest(manifest);
    fs.rmSync(groupPath(id), { recursive: true, force: true });
    return true;
  }

  function appendMessage(id, message) {
    fs.appendFileSync(messagesPath(id), JSON.stringify(message) + "\n");
    return touchGroup(id, message?.createdAt || Date.now());
  }

  function listMessages(id) {
    let raw;
    try {
      raw = fs.readFileSync(messagesPath(id), "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  function saveContextCard(id, card) {
    atomicWrite(contextCardPath(id), JSON.stringify(card, null, 2));
    updateGroup(id, { contextCard: card });
  }

  return { create, list, get, updateGroup, deleteGroup, appendMessage, listMessages, saveContextCard };
}

module.exports = { createGroupStore };
