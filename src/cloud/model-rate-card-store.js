const crypto = require("node:crypto");
const {
  MICRO_CNY,
  MILLIPOINTS_PER_POINT,
  MILLIPOINTS_PER_CNY_COST,
  toInteger
} = require("./model-point-pricing.js");

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function inputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function hasOwn(input, key) {
  return Object.prototype.hasOwnProperty.call(input || {}, key);
}

function normalizeProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9_.-]{2,80}$/.test(provider)) throw inputError("供应商格式不对。");
  return provider;
}

function normalizeModel(value) {
  const model = String(value || "").trim();
  if (!/^[A-Za-z0-9_.:/@-]{2,160}$/.test(model)) throw inputError("模型格式不对。");
  return model;
}

function nonNegativeSafeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw inputError(`${label}必须是非负整数。`);
  return number;
}

function microcnyFromInput(input, { microKey, cnyKey, label, fallback }) {
  if (hasOwn(input, microKey)) return nonNegativeSafeInteger(input[microKey], label);
  if (!hasOwn(input, cnyKey)) return fallback;
  const cny = Number(input[cnyKey]);
  const microcny = Math.round(cny * MICRO_CNY);
  if (!Number.isFinite(cny) || !Number.isSafeInteger(microcny) || microcny < 0) {
    throw inputError(`${label}格式不对。`);
  }
  return microcny;
}

function millipointsPerCnyFromInput(input, fallback) {
  if (hasOwn(input, "millipointsPerCnyCost")) {
    return nonNegativeSafeInteger(input.millipointsPerCnyCost, "每元成本折算毫积分");
  }
  if (!hasOwn(input, "pointsPerCnyCost")) return fallback;
  const points = Number(input.pointsPerCnyCost);
  const millipoints = Math.round(points * MILLIPOINTS_PER_POINT);
  if (!Number.isFinite(points) || !Number.isSafeInteger(millipoints) || millipoints <= 0) {
    throw inputError("每元成本折算积分必须是正数。");
  }
  return millipoints;
}

function rowToRateCard(row = {}) {
  const millipointsPerCnyCost = toInteger(row.millipoints_per_cny_cost, MILLIPOINTS_PER_CNY_COST);
  return {
    id: row.id || "",
    provider: row.provider || "",
    upstreamModel: row.upstream_model || "",
    version: toInteger(row.version, 1),
    cacheHitMicrocnyPerMillion: toInteger(row.cache_hit_microcny_per_million),
    cacheMissMicrocnyPerMillion: toInteger(row.cache_miss_microcny_per_million),
    outputMicrocnyPerMillion: toInteger(row.output_microcny_per_million),
    cacheHitCnyPerMillion: toInteger(row.cache_hit_microcny_per_million) / MICRO_CNY,
    cacheMissCnyPerMillion: toInteger(row.cache_miss_microcny_per_million) / MICRO_CNY,
    outputCnyPerMillion: toInteger(row.output_microcny_per_million) / MICRO_CNY,
    millipointsPerCnyCost,
    pointsPerCnyCost: millipointsPerCnyCost / MILLIPOINTS_PER_POINT,
    isActive: Number(row.is_active) !== 0,
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || ""
  };
}

function samePrice(left = {}, right = {}) {
  return left.cacheHitMicrocnyPerMillion === right.cacheHitMicrocnyPerMillion
    && left.cacheMissMicrocnyPerMillion === right.cacheMissMicrocnyPerMillion
    && left.outputMicrocnyPerMillion === right.outputMicrocnyPerMillion
    && left.millipointsPerCnyCost === right.millipointsPerCnyCost;
}

function createModelRateCardStore(db) {
  if (!db) throw new Error("model rate card database required");

  const selectActiveStmt = db.prepare(`
    SELECT *
    FROM model_rate_cards
    WHERE provider = ? AND upstream_model = ? AND is_active = 1
    ORDER BY version DESC
    LIMIT 1
  `);
  const listActiveStmt = db.prepare(`
    SELECT *
    FROM model_rate_cards
    WHERE is_active = 1
    ORDER BY provider, upstream_model, version DESC
  `);
  const deactivateStmt = db.prepare(`
    UPDATE model_rate_cards
    SET is_active = 0, updated_at = ?
    WHERE provider = ? AND upstream_model = ? AND is_active = 1
  `);
  const insertStmt = db.prepare(`
    INSERT INTO model_rate_cards (
      id, provider, upstream_model, version,
      cache_hit_microcny_per_million, cache_miss_microcny_per_million,
      output_microcny_per_million, millipoints_per_cny_cost,
      is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);

  function getActiveRateCard(provider, upstreamModel) {
    const row = selectActiveStmt.get(normalizeProvider(provider), normalizeModel(upstreamModel));
    return row ? rowToRateCard(row) : null;
  }

  function listActiveRateCards() {
    return listActiveStmt.all().map(rowToRateCard);
  }

  function saveRateCard(input = {}) {
    const provider = normalizeProvider(input.provider);
    const upstreamModel = normalizeModel(input.upstreamModel || input.model);
    const current = getActiveRateCard(provider, upstreamModel);
    const next = {
      provider,
      upstreamModel,
      cacheHitMicrocnyPerMillion: microcnyFromInput(input, {
        microKey: "cacheHitMicrocnyPerMillion",
        cnyKey: "cacheHitCnyPerMillion",
        label: "缓存命中输入成本",
        fallback: current?.cacheHitMicrocnyPerMillion ?? 0
      }),
      cacheMissMicrocnyPerMillion: microcnyFromInput(input, {
        microKey: "cacheMissMicrocnyPerMillion",
        cnyKey: "cacheMissCnyPerMillion",
        label: "缓存未命中输入成本",
        fallback: current?.cacheMissMicrocnyPerMillion ?? 0
      }),
      outputMicrocnyPerMillion: microcnyFromInput(input, {
        microKey: "outputMicrocnyPerMillion",
        cnyKey: "outputCnyPerMillion",
        label: "输出成本",
        fallback: current?.outputMicrocnyPerMillion ?? 0
      }),
      millipointsPerCnyCost: millipointsPerCnyFromInput(
        input,
        current?.millipointsPerCnyCost ?? MILLIPOINTS_PER_CNY_COST
      )
    };
    if (!next.cacheMissMicrocnyPerMillion && !next.outputMicrocnyPerMillion) {
      throw inputError("至少要填写缓存未命中输入或输出的上游成本。");
    }
    if (current && samePrice(current, next)) return current;

    const timestamp = nowIso();
    db.exec("BEGIN IMMEDIATE");
    try {
      const latest = selectActiveStmt.get(provider, upstreamModel);
      const version = toInteger(latest?.version, 0) + 1;
      deactivateStmt.run(timestamp, provider, upstreamModel);
      const id = randomId("mrc");
      insertStmt.run(
        id,
        provider,
        upstreamModel,
        version,
        next.cacheHitMicrocnyPerMillion,
        next.cacheMissMicrocnyPerMillion,
        next.outputMicrocnyPerMillion,
        next.millipointsPerCnyCost,
        timestamp,
        timestamp
      );
      db.exec("COMMIT");
      return getActiveRateCard(provider, upstreamModel);
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  return {
    getActiveRateCard,
    listActiveRateCards,
    saveRateCard,
    rowToRateCard
  };
}

module.exports = {
  createModelRateCardStore,
  rowToRateCard
};
