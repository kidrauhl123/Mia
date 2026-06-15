// Per-user conversation tags.
//
// Telegram models chat tags as a visual projection of chat filters/folders.
// Mia keeps the first version smaller: named, colored user-private tags plus
// conversation assignments. The shape is intentionally plain JSON so it can
// live inside user_settings and sync through the existing settings channel.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.miaConversationTags = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_TAGS = 48;
  const MAX_TAG_NAME = 24;
  const MAX_ASSIGNMENTS = 2000;
  const MAX_TAGS_PER_CONVERSATION = 3;
  const PALETTE = [
    "#2563eb",
    "#16a34a",
    "#dc2626",
    "#7c3aed",
    "#0891b2",
    "#ea580c",
    "#c026d3",
    "#64748b"
  ];

  function defaultConversationTags() {
    return { items: [], assignments: {} };
  }

  function cleanName(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_TAG_NAME);
  }

  function cleanId(value, fallback) {
    const raw = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
    return (raw || fallback || "").slice(0, 48);
  }

  function slugFromName(name) {
    const ascii = String(name || "")
      .trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24);
    return ascii || "tag";
  }

  function isCssColor(value) {
    const text = String(value || "").trim();
    return /^#[0-9a-f]{6}$/i.test(text);
  }

  function normalizeTagItem(item, index, usedIds) {
    if (!item || typeof item !== "object") return null;
    const name = cleanName(item.name);
    if (!name) return null;
    const fallback = `tag_${slugFromName(name)}_${index + 1}`;
    let id = cleanId(item.id, fallback);
    if (!id.startsWith("tag_")) id = `tag_${id}`;
    let candidate = id;
    let suffix = 2;
    while (usedIds.has(candidate)) {
      candidate = `${id}_${suffix++}`.slice(0, 48);
    }
    usedIds.add(candidate);
    return {
      id: candidate,
      name,
      color: isCssColor(item.color) ? String(item.color).trim() : PALETTE[index % PALETTE.length]
    };
  }

  function normalizeConversationTags(value) {
    const input = value && typeof value === "object" ? value : {};
    const usedIds = new Set();
    const items = (Array.isArray(input.items) ? input.items : [])
      .map((item, index) => normalizeTagItem(item, index, usedIds))
      .filter(Boolean)
      .slice(0, MAX_TAGS);
    const validIds = new Set(items.map((item) => item.id));
    const assignments = {};
    let count = 0;
    const rawAssignments = input.assignments && typeof input.assignments === "object" ? input.assignments : {};
    for (const [targetId, rawIds] of Object.entries(rawAssignments)) {
      if (count >= MAX_ASSIGNMENTS) break;
      const id = String(targetId || "").trim().slice(0, 180);
      if (!id) continue;
      const ids = (Array.isArray(rawIds) ? rawIds : [])
        .map((tagId) => cleanId(tagId, ""))
        .map((tagId) => (tagId && !tagId.startsWith("tag_") ? `tag_${tagId}` : tagId))
        .filter((tagId) => validIds.has(tagId));
      const unique = [...new Set(ids)].slice(0, MAX_TAGS_PER_CONVERSATION);
      if (!unique.length) continue;
      assignments[id] = unique;
      count += 1;
    }
    return { items, assignments };
  }

  function tagsForTarget(tags, targetId) {
    const normalized = normalizeConversationTags(tags);
    const ids = normalized.assignments[String(targetId || "").trim()] || [];
    const byId = new Map(normalized.items.map((item) => [item.id, item]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  function createTag(tags, name) {
    const normalized = normalizeConversationTags(tags);
    const clean = cleanName(name);
    if (!clean) return normalized;
    const existing = normalized.items.find((item) => item.name.toLowerCase() === clean.toLowerCase());
    if (existing) return normalized;
    const usedIds = new Set(normalized.items.map((item) => item.id));
    const item = normalizeTagItem({ id: `tag_${slugFromName(clean)}`, name: clean }, normalized.items.length, usedIds);
    if (!item) return normalized;
    return normalizeConversationTags({ ...normalized, items: [...normalized.items, item] });
  }

  function pruneUnusedTagItems(tags) {
    const normalized = normalizeConversationTags(tags);
    const usedIds = new Set(Object.values(normalized.assignments || {}).flatMap((ids) =>
      Array.isArray(ids) ? ids : []));
    if (!usedIds.size) return defaultConversationTags();
    return normalizeConversationTags({
      items: normalized.items.filter((item) => usedIds.has(item.id)),
      assignments: normalized.assignments
    });
  }

  function assignTagNames(tags, targetId, names) {
    const target = String(targetId || "").trim();
    if (!target) return normalizeConversationTags(tags);
    const cleanNames = [...new Set((Array.isArray(names) ? names : [])
      .map(cleanName)
      .filter(Boolean)
      .map((name) => name.slice(0, MAX_TAG_NAME)))].slice(0, MAX_TAGS_PER_CONVERSATION);
    let next = pruneUnusedTagItems(tags);
    for (const name of cleanNames) {
      next = createTag(next, name);
    }
    const ids = cleanNames
      .map((name) => next.items.find((item) => item.name.toLowerCase() === name.toLowerCase())?.id)
      .filter(Boolean);
    const assignments = { ...next.assignments };
    if (ids.length) assignments[target] = ids;
    else delete assignments[target];
    return pruneUnusedTagItems({ ...next, assignments });
  }

  return {
    defaultConversationTags,
    normalizeConversationTags,
    pruneUnusedTagItems,
    tagsForTarget,
    assignTagNames,
    palette: PALETTE
  };
});
