const MICRO_CNY = 1_000_000;
const MILLIPOINTS_PER_POINT = 1_000;

// Mia sells 20 points for ¥1. One point therefore represents at most ¥0.02
// of direct upstream usage, leaving room for Agent runtime, payments, support,
// retries, and price changes.
const POINTS_PER_CNY_COST = 50;
const MILLIPOINTS_PER_CNY_COST = POINTS_PER_CNY_COST * MILLIPOINTS_PER_POINT;
const MICROCNY_PER_POINT = MICRO_CNY / POINTS_PER_CNY_COST;

// Existing balances were stored as USD. Preserve their economic value exactly
// once during the schema migration rather than silently discarding them.
const LEGACY_USD_TO_CNY = 7.2;
const LEGACY_USD_TO_MILLIPOINTS = Math.round(
  LEGACY_USD_TO_CNY * MILLIPOINTS_PER_CNY_COST
);

const DEEPSEEK_RATE_CARD_SEEDS = [
  {
    provider: "deepseek",
    upstreamModel: "deepseek-v4-flash",
    version: 1,
    cacheHitMicrocnyPerMillion: 20_000,
    cacheMissMicrocnyPerMillion: 1_000_000,
    outputMicrocnyPerMillion: 2_000_000,
    millipointsPerCnyCost: MILLIPOINTS_PER_CNY_COST
  },
  {
    provider: "deepseek",
    upstreamModel: "deepseek-v4-pro",
    version: 1,
    cacheHitMicrocnyPerMillion: 25_000,
    cacheMissMicrocnyPerMillion: 3_000_000,
    outputMicrocnyPerMillion: 6_000_000,
    millipointsPerCnyCost: MILLIPOINTS_PER_CNY_COST
  },
  // DeepSeek keeps these names as compatibility aliases for V4 Flash through
  // their announced retirement window. Keep an explicit card so old gateway
  // settings cannot become free traffic during the transition.
  {
    provider: "deepseek",
    upstreamModel: "deepseek-chat",
    version: 1,
    cacheHitMicrocnyPerMillion: 20_000,
    cacheMissMicrocnyPerMillion: 1_000_000,
    outputMicrocnyPerMillion: 2_000_000,
    millipointsPerCnyCost: MILLIPOINTS_PER_CNY_COST
  },
  {
    provider: "deepseek",
    upstreamModel: "deepseek-reasoner",
    version: 1,
    cacheHitMicrocnyPerMillion: 20_000,
    cacheMissMicrocnyPerMillion: 1_000_000,
    outputMicrocnyPerMillion: 2_000_000,
    millipointsPerCnyCost: MILLIPOINTS_PER_CNY_COST
  }
];

function toInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function nonNegativeInteger(value, fallback = 0) {
  return Math.max(0, toInteger(value, fallback));
}

function pointsToMillipoints(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * MILLIPOINTS_PER_POINT);
}

function millipointsToPoints(value) {
  return toInteger(value) / MILLIPOINTS_PER_POINT;
}

function microcnyToMillipoints(value, millipointsPerCnyCost = MILLIPOINTS_PER_CNY_COST) {
  const cost = nonNegativeInteger(value);
  const rate = nonNegativeInteger(millipointsPerCnyCost, MILLIPOINTS_PER_CNY_COST);
  if (!cost || !rate) return 0;
  return Math.ceil((cost * rate) / MICRO_CNY);
}

function usageTokenCounts(usage = {}) {
  const promptTokens = nonNegativeInteger(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = nonNegativeInteger(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = nonNegativeInteger(usage.total_tokens, promptTokens + completionTokens);
  const cacheHitTokens = nonNegativeInteger(
    usage.prompt_cache_hit_tokens
      ?? usage.cache_read_input_tokens
      ?? usage.cache_hit_tokens
  );
  const suppliedCacheMissTokens = usage.prompt_cache_miss_tokens
    ?? usage.cache_creation_input_tokens
    ?? usage.cache_miss_tokens;
  const cacheMissTokens = suppliedCacheMissTokens === undefined || suppliedCacheMissTokens === null
    ? Math.max(0, promptTokens - cacheHitTokens)
    : nonNegativeInteger(suppliedCacheMissTokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheHitTokens,
    cacheMissTokens
  };
}

function priceForUsage(usage = {}, rateCard = {}) {
  const counts = usageTokenCounts(usage);
  const cacheHitRate = nonNegativeInteger(rateCard.cacheHitMicrocnyPerMillion);
  const cacheMissRate = nonNegativeInteger(rateCard.cacheMissMicrocnyPerMillion);
  const outputRate = nonNegativeInteger(rateCard.outputMicrocnyPerMillion);
  const actualCostMicrocny = Math.ceil(
    (
      counts.cacheHitTokens * cacheHitRate
      + counts.cacheMissTokens * cacheMissRate
      + counts.completionTokens * outputRate
    ) / 1_000_000
  );
  const chargeMillipoints = microcnyToMillipoints(
    actualCostMicrocny,
    rateCard.millipointsPerCnyCost
  );
  return {
    ...counts,
    actualCostMicrocny,
    chargeMillipoints
  };
}

module.exports = {
  MICRO_CNY,
  MILLIPOINTS_PER_POINT,
  POINTS_PER_CNY_COST,
  MILLIPOINTS_PER_CNY_COST,
  MICROCNY_PER_POINT,
  LEGACY_USD_TO_CNY,
  LEGACY_USD_TO_MILLIPOINTS,
  DEEPSEEK_RATE_CARD_SEEDS,
  toInteger,
  nonNegativeInteger,
  pointsToMillipoints,
  millipointsToPoints,
  microcnyToMillipoints,
  usageTokenCounts,
  priceForUsage
};
