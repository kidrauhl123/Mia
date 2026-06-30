"use strict";

const LOAD_SKILL_PATTERN = /\[LOAD_SKILL:\s*([^\]\n]+)\]/gi;

function cleanSkillId(value = "") {
  return String(value || "")
    .trim()
    .replace(/^["'`「『]+|["'`」』]+$/g, "")
    .trim();
}

function extractLoadSkillRequests(text = "") {
  const out = [];
  const seen = new Set();
  const input = String(text || "");
  for (const match of input.matchAll(LOAD_SKILL_PATTERN)) {
    const raw = String(match[1] || "");
    const parts = raw.split(/[,，;；]/g);
    for (const part of parts) {
      const id = cleanSkillId(part);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function stripLoadSkillRequests(text = "") {
  return String(text || "").replace(LOAD_SKILL_PATTERN, "").trim();
}

function createSkillLoadRequestGate(emit) {
  if (typeof emit !== "function") {
    return {
      emit: null,
      replay: () => {},
      discard: () => {}
    };
  }
  const buffered = [];
  let textPrefix = "";
  let passthrough = false;
  let discarded = false;
  const markerPrefix = "[LOAD_SKILL:";

  function replay() {
    if (discarded) return;
    for (const event of buffered.splice(0)) {
      emit(event.kind, event.data);
    }
    passthrough = true;
  }

  function discard() {
    discarded = true;
    buffered.length = 0;
  }

  function gatedEmit(kind, data = {}) {
    if (discarded) return;
    if (passthrough) {
      emit(kind, data);
      return;
    }
    buffered.push({ kind, data });
    if (kind !== "text_delta") return;
    textPrefix += String(data?.text || "");
    const probe = textPrefix.trimStart().toUpperCase();
    if (!probe) return;
    if (markerPrefix.startsWith(probe)) return;
    if (probe.startsWith(markerPrefix)) return;
    replay();
  }

  return {
    emit: gatedEmit,
    replay,
    discard
  };
}

module.exports = {
  createSkillLoadRequestGate,
  extractLoadSkillRequests,
  stripLoadSkillRequests
};
