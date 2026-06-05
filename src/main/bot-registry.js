function normalizedBotList(manifestOrBots = {}) {
  const bots = Array.isArray(manifestOrBots)
    ? manifestOrBots
    : manifestOrBots.bots;
  return Array.isArray(bots)
    ? bots.filter((bot) => bot && typeof bot === "object" && String(bot.key || bot.id || "").trim())
    : [];
}

function resolveBot(manifestOrBots = {}, key = "", options = {}) {
  const bots = normalizedBotList(manifestOrBots);
  const requestedKey = String(key || "").trim();
  const fallback = options.fallback !== false;
  const requested = requestedKey
    ? bots.find((bot) => String(bot.key || bot.id || "").trim() === requestedKey)
    : null;
  if (requested) {
    return {
      bot: requested,
      requestedKey,
      usedFallback: false
    };
  }
  return {
    bot: fallback ? bots[0] || null : null,
    requestedKey,
    usedFallback: Boolean(fallback && requestedKey && bots[0])
  };
}

function requireBot(manifestOrBots = {}, key = "", message = "Bot not found.", options = {}) {
  const resolved = resolveBot(manifestOrBots, key, options);
  if (!resolved.bot) throw new Error(message);
  return resolved;
}

module.exports = {
  normalizedBotList,
  requireBot,
  resolveBot
};
