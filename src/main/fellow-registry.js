function normalizedFellowList(manifestOrFellows = {}) {
  const fellows = Array.isArray(manifestOrFellows)
    ? manifestOrFellows
    : manifestOrFellows.fellows;
  return Array.isArray(fellows)
    ? fellows.filter((fellow) => fellow && typeof fellow === "object" && String(fellow.key || "").trim())
    : [];
}

function resolveFellow(manifestOrFellows = {}, key = "", options = {}) {
  const fellows = normalizedFellowList(manifestOrFellows);
  const requestedKey = String(key || "").trim();
  const fallback = options.fallback !== false;
  const requested = requestedKey
    ? fellows.find((fellow) => String(fellow.key || "").trim() === requestedKey)
    : null;
  if (requested) {
    return {
      fellow: requested,
      requestedKey,
      usedFallback: false
    };
  }
  return {
    fellow: fallback ? fellows[0] || null : null,
    requestedKey,
    usedFallback: Boolean(fallback && requestedKey && fellows[0])
  };
}

function requireFellow(manifestOrFellows = {}, key = "", message = "Fellow not found.", options = {}) {
  const resolved = resolveFellow(manifestOrFellows, key, options);
  if (!resolved.fellow) throw new Error(message);
  return resolved;
}

module.exports = {
  normalizedFellowList,
  requireFellow,
  resolveFellow
};
