(function initResourceCache(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.miaResourceCache = factory();
})(typeof globalThis !== "undefined" ? globalThis : window, function resourceCacheFactory() {
  "use strict";

  function touchMapValue(map, key) {
    if (!map?.has?.(key)) return undefined;
    const value = map.get(key);
    map.delete(key);
    map.set(key, value);
    return value;
  }

  function normalizeProtectedKeys(value) {
    if (value instanceof Set) return value;
    if (Array.isArray(value)) return new Set(value);
    return new Set();
  }

  function pruneMap(map, {
    maxEntries = Infinity,
    maxWeight = Infinity,
    weightOf = () => 1,
    protectedKeys,
    onEvict
  } = {}) {
    if (!map || typeof map.entries !== "function") return [];
    const keep = normalizeProtectedKeys(protectedKeys);
    const entryLimit = Number.isFinite(Number(maxEntries)) ? Math.max(0, Number(maxEntries)) : Infinity;
    const weightLimit = Number.isFinite(Number(maxWeight)) ? Math.max(0, Number(maxWeight)) : Infinity;
    let totalWeight = 0;
    for (const [key, value] of map.entries()) {
      totalWeight += Math.max(0, Number(weightOf(value, key)) || 0);
    }

    const evicted = [];
    for (const [key, value] of [...map.entries()]) {
      if (map.size <= entryLimit && totalWeight <= weightLimit) break;
      if (keep.has(key)) continue;
      const weight = Math.max(0, Number(weightOf(value, key)) || 0);
      if (!map.delete(key)) continue;
      totalWeight = Math.max(0, totalWeight - weight);
      evicted.push([key, value]);
      try {
        onEvict?.(value, key);
      } catch (error) {
        console.warn?.("[resource-cache] eviction cleanup failed", error);
      }
    }
    return evicted;
  }

  function trimRecentItems(items, {
    maxEntries = Infinity,
    isProtected = () => false
  } = {}) {
    const rows = Array.isArray(items) ? items : [];
    const limit = Number.isFinite(Number(maxEntries)) ? Math.max(0, Math.floor(Number(maxEntries))) : Infinity;
    if (rows.length <= limit) return rows;

    const protectedIndexes = new Set();
    rows.forEach((item, index) => {
      if (isProtected(item, index)) protectedIndexes.add(index);
    });
    const ordinaryAllowance = Math.max(0, limit - protectedIndexes.size);
    const ordinaryIndexes = rows
      .map((_, index) => index)
      .filter((index) => !protectedIndexes.has(index));
    const retainedOrdinary = new Set(ordinaryIndexes.slice(-ordinaryAllowance));
    return rows.filter((_, index) => protectedIndexes.has(index) || retainedOrdinary.has(index));
  }

  function estimateValueBytes(value, seen = new Set()) {
    if (value == null) return 0;
    if (typeof value === "string") {
      if (value.startsWith("data:")) {
        const comma = value.indexOf(",");
        const payloadLength = comma >= 0 ? value.length - comma - 1 : value.length;
        return Math.ceil(payloadLength * 0.75);
      }
      return value.length * 2;
    }
    if (typeof value === "number" || typeof value === "boolean") return 8;
    if (typeof value !== "object" || seen.has(value)) return 0;
    seen.add(value);
    if (ArrayBuffer.isView?.(value)) return Number(value.byteLength) || 0;
    if (value instanceof ArrayBuffer) return Number(value.byteLength) || 0;
    let bytes = 0;
    if (Array.isArray(value)) {
      for (const item of value) bytes += estimateValueBytes(item, seen);
      return bytes;
    }
    for (const [key, item] of Object.entries(value)) {
      bytes += key.length * 2;
      bytes += estimateValueBytes(item, seen);
    }
    return bytes;
  }

  return {
    estimateValueBytes,
    pruneMap,
    touchMapValue,
    trimRecentItems
  };
});
