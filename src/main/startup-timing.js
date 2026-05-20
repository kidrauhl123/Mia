"use strict";

function nowMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function createStartupTimer({ scope = "startup", logger = console } = {}) {
  const startedAt = nowMs();
  const marks = [];

  const mark = (label, details = {}) => {
    const elapsedMs = Math.round(nowMs() - startedAt);
    const entry = {
      label: String(label || "unknown"),
      elapsedMs,
      at: new Date().toISOString(),
      ...(details && typeof details === "object" ? details : {})
    };
    marks.push(entry);
    const suffix = Object.keys(entry)
      .filter((key) => !["label", "elapsedMs", "at"].includes(key))
      .map((key) => `${key}=${entry[key]}`)
      .join(" ");
    const line = `[Aimashi:${scope}] ${entry.label} +${elapsedMs}ms${suffix ? ` ${suffix}` : ""}`;
    if (logger && typeof logger.info === "function") logger.info(line);
    else if (logger && typeof logger.log === "function") logger.log(line);
    return entry;
  };

  return {
    mark,
    snapshot: () => marks.slice()
  };
}

module.exports = {
  createStartupTimer
};
