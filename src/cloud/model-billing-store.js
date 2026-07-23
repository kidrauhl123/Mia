const crypto = require("node:crypto");
const {
  MICRO_CNY,
  MILLIPOINTS_PER_POINT,
  MILLIPOINTS_PER_CNY_COST,
  pointsToMillipoints,
  millipointsToPoints,
  microcnyToMillipoints,
  priceForUsage,
  toInteger
} = require("./model-point-pricing.js");

const POINT_SOURCE_TYPES = new Set([
  "event",
  "subscription",
  "topup",
  "admin",
  "compensation",
  "legacy"
]);

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

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw inputError(`${label}必须是非负整数。`);
  return number;
}

function normalizePointGrant(args = {}) {
  if (args.deltaMillipoints !== undefined || args.grantMillipoints !== undefined) {
    return nonNegativeInteger(args.deltaMillipoints ?? args.grantMillipoints, "毫积分");
  }
  const points = Number(args.points ?? args.amount);
  const millipoints = pointsToMillipoints(points);
  if (!Number.isFinite(points) || !Number.isSafeInteger(millipoints) || millipoints < 0) {
    throw inputError("积分格式不对。");
  }
  return millipoints;
}

function normalizeSourceType(value) {
  const sourceType = String(value || "admin").trim().toLowerCase() || "admin";
  if (!POINT_SOURCE_TYPES.has(sourceType)) throw inputError("积分来源无效。");
  return sourceType;
}

function normalizeTimestamp(value, label = "积分有效期") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) throw inputError(`${label}无效。`);
  return new Date(timestamp).toISOString();
}

function rowToBalance(row) {
  const balanceMillipoints = toInteger(row?.balance_millipoints);
  return {
    userId: row?.user_id || "",
    balanceMillipoints,
    balancePoints: millipointsToPoints(balanceMillipoints),
    updatedAt: row?.updated_at || ""
  };
}

function rowToUsage(row) {
  if (!row) return null;
  const chargeMillipoints = toInteger(row.charge_millipoints);
  return {
    id: row.id,
    userId: row.user_id,
    modelId: row.model_id,
    upstreamModel: row.upstream_model,
    provider: row.provider,
    requestPath: row.request_path,
    promptTokens: toInteger(row.prompt_tokens),
    completionTokens: toInteger(row.completion_tokens),
    totalTokens: toInteger(row.total_tokens),
    promptCacheHitTokens: toInteger(row.prompt_cache_hit_tokens),
    promptCacheMissTokens: toInteger(row.prompt_cache_miss_tokens),
    chargeMillipoints,
    chargePoints: millipointsToPoints(chargeMillipoints),
    rateCardId: row.rate_card_id || "",
    rateCardVersion: toInteger(row.rate_card_version),
    status: row.status,
    error: row.error || "",
    createdAt: row.created_at
  };
}

function rowToAdminUsage(row) {
  const usage = rowToUsage(row);
  if (!usage) return null;
  const actualCostMicrocny = toInteger(row.actual_cost_microcny);
  return {
    ...usage,
    actualCostMicrocny,
    actualCostCny: actualCostMicrocny / MICRO_CNY
  };
}

function rowToAdminUser(row = {}) {
  const balanceMillipoints = toInteger(row.balance_millipoints);
  const chargeMillipoints = toInteger(row.charge_millipoints);
  const actualCostMicrocny = toInteger(row.actual_cost_microcny);
  return {
    user: {
      id: row.user_id || "",
      username: row.username || row.account || "",
      account: row.account || row.username || "",
      displayName: row.display_name || "",
      email: row.email || "",
      createdAt: row.user_created_at || ""
    },
    balance: {
      userId: row.user_id || "",
      balanceMillipoints,
      balancePoints: millipointsToPoints(balanceMillipoints),
      updatedAt: row.balance_updated_at || ""
    },
    usage: {
      requestCount: toInteger(row.request_count),
      succeededCount: toInteger(row.succeeded_count),
      failedCount: toInteger(row.failed_count),
      promptTokens: toInteger(row.prompt_tokens),
      completionTokens: toInteger(row.completion_tokens),
      totalTokens: toInteger(row.total_tokens),
      actualCostMicrocny,
      actualCostCny: actualCostMicrocny / MICRO_CNY,
      chargeMillipoints,
      chargePoints: millipointsToPoints(chargeMillipoints),
      lastUsedAt: row.last_used_at || ""
    }
  };
}

function rowToAdminTotals(row = {}) {
  const actualCostMicrocny = toInteger(row.actual_cost_microcny);
  const chargeMillipoints = toInteger(row.charge_millipoints);
  const balanceMillipoints = toInteger(row.balance_millipoints);
  return {
    userCount: toInteger(row.user_count),
    activeUserCount: toInteger(row.active_user_count),
    requestCount: toInteger(row.request_count),
    succeededCount: toInteger(row.succeeded_count),
    failedCount: toInteger(row.failed_count),
    promptTokens: toInteger(row.prompt_tokens),
    completionTokens: toInteger(row.completion_tokens),
    totalTokens: toInteger(row.total_tokens),
    actualCostMicrocny,
    actualCostCny: actualCostMicrocny / MICRO_CNY,
    chargeMillipoints,
    chargePoints: millipointsToPoints(chargeMillipoints),
    balanceMillipoints,
    balancePoints: millipointsToPoints(balanceMillipoints)
  };
}

function rowToAdminRecentUsage(row = {}) {
  const usage = rowToAdminUsage(row);
  if (!usage) return null;
  return {
    ...usage,
    user: {
      id: row.user_id || "",
      username: row.username || row.account || "",
      account: row.account || row.username || "",
      displayName: row.display_name || "",
      email: row.email || ""
    }
  };
}

function createModelBillingStore(db) {
  const ensureAccountStmt = db.prepare(`
    INSERT INTO model_accounts (user_id, balance_millipoints, updated_at)
    VALUES (?, 0, ?)
    ON CONFLICT(user_id) DO NOTHING
  `);
  const selectBalanceStmt = db.prepare(`
    SELECT user_id, balance_millipoints, updated_at
    FROM model_accounts
    WHERE user_id = ?
  `);
  const updateBalanceStmt = db.prepare(`
    UPDATE model_accounts
    SET balance_millipoints = balance_millipoints + ?, updated_at = ?
    WHERE user_id = ?
  `);
  const insertBalanceLedgerStmt = db.prepare(`
    INSERT INTO model_balance_ledger (
      id, user_id, delta_microusd, balance_after_microusd,
      delta_millipoints, balance_after_millipoints, reason, usage_id, created_at
    ) VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?)
  `);
  const insertBucketStmt = db.prepare(`
    INSERT INTO model_point_buckets (
      id, user_id, source_type, source_id, granted_millipoints,
      remaining_millipoints, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectExpiredBucketsStmt = db.prepare(`
    SELECT id, remaining_millipoints
    FROM model_point_buckets
    WHERE user_id = ?
      AND remaining_millipoints > 0
      AND expires_at <> ''
      AND expires_at <= ?
    ORDER BY expires_at, created_at, id
  `);
  const clearBucketStmt = db.prepare(`
    UPDATE model_point_buckets
    SET remaining_millipoints = 0, updated_at = ?
    WHERE id = ?
  `);
  const selectSpendableBucketsStmt = db.prepare(`
    SELECT id, remaining_millipoints
    FROM model_point_buckets
    WHERE user_id = ?
      AND remaining_millipoints > 0
      AND (expires_at = '' OR expires_at > ?)
    ORDER BY
      CASE source_type
        WHEN 'event' THEN 0
        WHEN 'subscription' THEN 1
        WHEN 'admin' THEN 2
        WHEN 'topup' THEN 3
        WHEN 'compensation' THEN 4
        ELSE 5
      END,
      CASE WHEN expires_at = '' THEN 1 ELSE 0 END,
      expires_at,
      created_at,
      id
  `);
  const consumeBucketStmt = db.prepare(`
    UPDATE model_point_buckets
    SET remaining_millipoints = remaining_millipoints - ?, updated_at = ?
    WHERE id = ?
  `);
  const insertBucketConsumptionStmt = db.prepare(`
    INSERT INTO model_point_bucket_consumptions (
      usage_id, bucket_id, consumed_millipoints, created_at
    ) VALUES (?, ?, ?, ?)
  `);
  const insertUsageStmt = db.prepare(`
    INSERT INTO model_usage_ledger (
      id, user_id, model_id, upstream_model, provider, request_path,
      prompt_tokens, completion_tokens, total_tokens,
      prompt_cache_hit_tokens, prompt_cache_miss_tokens,
      actual_cost_microcny, charge_millipoints, rate_card_id, rate_card_version,
      status, error, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectUsageStmt = db.prepare(`
    SELECT id, user_id, model_id, upstream_model, provider, request_path,
           prompt_tokens, completion_tokens, total_tokens,
           prompt_cache_hit_tokens, prompt_cache_miss_tokens,
           actual_cost_microcny, charge_millipoints, rate_card_id, rate_card_version,
           status, error, created_at
    FROM model_usage_ledger
    WHERE id = ?
  `);
  const listRecentUsageStmt = db.prepare(`
    SELECT id, user_id, model_id, upstream_model, provider, request_path,
           prompt_tokens, completion_tokens, total_tokens,
           prompt_cache_hit_tokens, prompt_cache_miss_tokens,
           actual_cost_microcny, charge_millipoints, rate_card_id, rate_card_version,
           status, error, created_at
    FROM model_usage_ledger
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `);
  const adminTotalsStmt = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) AS user_count,
      COUNT(DISTINCT CASE WHEN l.id IS NOT NULL THEN l.user_id END) AS active_user_count,
      COUNT(l.id) AS request_count,
      SUM(CASE WHEN l.status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded_count,
      SUM(CASE WHEN l.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
      COALESCE(SUM(l.prompt_tokens), 0) AS prompt_tokens,
      COALESCE(SUM(l.completion_tokens), 0) AS completion_tokens,
      COALESCE(SUM(l.total_tokens), 0) AS total_tokens,
      COALESCE(SUM(l.actual_cost_microcny), 0) AS actual_cost_microcny,
      COALESCE(SUM(l.charge_millipoints), 0) AS charge_millipoints,
      (SELECT COALESCE(SUM(balance_millipoints), 0) FROM model_accounts) AS balance_millipoints
    FROM model_usage_ledger l
  `);
  const adminUserSummaryStmt = db.prepare(`
    SELECT
      u.id AS user_id,
      u.account,
      u.username,
      u.display_name,
      u.email,
      u.created_at AS user_created_at,
      COALESCE(a.balance_millipoints, 0) AS balance_millipoints,
      COALESCE(a.updated_at, '') AS balance_updated_at,
      COUNT(l.id) AS request_count,
      SUM(CASE WHEN l.status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded_count,
      SUM(CASE WHEN l.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
      COALESCE(SUM(l.prompt_tokens), 0) AS prompt_tokens,
      COALESCE(SUM(l.completion_tokens), 0) AS completion_tokens,
      COALESCE(SUM(l.total_tokens), 0) AS total_tokens,
      COALESCE(SUM(l.actual_cost_microcny), 0) AS actual_cost_microcny,
      COALESCE(SUM(l.charge_millipoints), 0) AS charge_millipoints,
      COALESCE(MAX(l.created_at), '') AS last_used_at
    FROM users u
    LEFT JOIN model_accounts a ON a.user_id = u.id
    LEFT JOIN model_usage_ledger l ON l.user_id = u.id
    GROUP BY u.id
    ORDER BY (MAX(l.created_at) IS NULL) ASC, MAX(l.created_at) DESC, u.created_at DESC
    LIMIT ?
  `);
  const adminRecentUsageStmt = db.prepare(`
    SELECT l.id, l.user_id, l.model_id, l.upstream_model, l.provider, l.request_path,
           l.prompt_tokens, l.completion_tokens, l.total_tokens,
           l.prompt_cache_hit_tokens, l.prompt_cache_miss_tokens,
           l.actual_cost_microcny, l.charge_millipoints, l.rate_card_id, l.rate_card_version,
           l.status, l.error, l.created_at,
           u.account, u.username, u.display_name, u.email
    FROM model_usage_ledger l
    LEFT JOIN users u ON u.id = l.user_id
    ORDER BY l.created_at DESC
    LIMIT ?
  `);

  let transactionDepth = 0;

  function withTransaction(action) {
    if (transactionDepth > 0) return action();
    db.exec("BEGIN IMMEDIATE");
    transactionDepth += 1;
    try {
      const result = action();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    } finally {
      transactionDepth -= 1;
    }
  }

  function ensureAccountInTransaction(userId, timestamp) {
    const id = String(userId || "").trim();
    if (!id) throw new Error("model billing userId required");
    ensureAccountStmt.run(id, timestamp);
    return id;
  }

  function balanceForUserInTransaction(userId) {
    return rowToBalance(selectBalanceStmt.get(userId));
  }

  function appendBalanceLedgerInTransaction({ userId, deltaMillipoints, reason, usageId = "", timestamp }) {
    const balance = balanceForUserInTransaction(userId);
    insertBalanceLedgerStmt.run(
      randomId("mpl"),
      userId,
      deltaMillipoints,
      balance.balanceMillipoints,
      String(reason || "").trim().slice(0, 120),
      String(usageId || ""),
      timestamp
    );
    return balance;
  }

  function expireBucketsInTransaction(userId, timestamp) {
    const expired = selectExpiredBucketsStmt.all(userId, timestamp);
    for (const bucket of expired) {
      const remainingMillipoints = toInteger(bucket.remaining_millipoints);
      if (remainingMillipoints <= 0) continue;
      clearBucketStmt.run(timestamp, bucket.id);
      updateBalanceStmt.run(-remainingMillipoints, timestamp, userId);
      appendBalanceLedgerInTransaction({
        userId,
        deltaMillipoints: -remainingMillipoints,
        reason: "points_expired",
        timestamp
      });
    }
  }

  function ensureAccount(userId) {
    return withTransaction(() => {
      const timestamp = nowIso();
      const id = ensureAccountInTransaction(userId, timestamp);
      expireBucketsInTransaction(id, timestamp);
      return balanceForUserInTransaction(id);
    });
  }

  function getBalance(userId) {
    return ensureAccount(userId);
  }

  function grantPoints(args = {}) {
    const userId = String(args.userId || "").trim();
    if (!userId) throw new Error("grantPoints: userId required");
    const deltaMillipoints = normalizePointGrant(args);
    if (deltaMillipoints <= 0) throw inputError("发放积分必须大于零。");
    const sourceType = normalizeSourceType(args.sourceType);
    const sourceId = String(args.sourceId || "").trim().slice(0, 160);
    const expiresAt = normalizeTimestamp(args.expiresAt);
    return withTransaction(() => {
      const timestamp = nowIso();
      const id = ensureAccountInTransaction(userId, timestamp);
      expireBucketsInTransaction(id, timestamp);
      const bucketId = String(args.bucketId || randomId("mpb")).trim() || randomId("mpb");
      insertBucketStmt.run(
        bucketId,
        id,
        sourceType,
        sourceId,
        deltaMillipoints,
        deltaMillipoints,
        expiresAt,
        timestamp,
        timestamp
      );
      updateBalanceStmt.run(deltaMillipoints, timestamp, id);
      return appendBalanceLedgerInTransaction({
        userId: id,
        deltaMillipoints,
        reason: args.reason || `${sourceType}_grant`,
        usageId: args.usageId,
        timestamp
      });
    });
  }

  function hasPositiveBalance(userId) {
    return getBalance(userId).balanceMillipoints > 0;
  }

  function debitPointsInTransaction({ userId, chargeMillipoints, usageId, timestamp }) {
    let remaining = chargeMillipoints;
    const buckets = selectSpendableBucketsStmt.all(userId, timestamp);
    for (const bucket of buckets) {
      if (remaining <= 0) break;
      const available = toInteger(bucket.remaining_millipoints);
      const consumed = Math.min(available, remaining);
      if (consumed <= 0) continue;
      consumeBucketStmt.run(consumed, timestamp, bucket.id);
      insertBucketConsumptionStmt.run(usageId, bucket.id, consumed, timestamp);
      remaining -= consumed;
    }
    // A response may finish just beyond the user's remaining balance. Keep the
    // exact cost and block the next request instead of silently giving away the
    // overage or failing after the upstream response has already been produced.
    updateBalanceStmt.run(-chargeMillipoints, timestamp, userId);
    return appendBalanceLedgerInTransaction({
      userId,
      deltaMillipoints: -chargeMillipoints,
      reason: "model_usage",
      usageId,
      timestamp
    });
  }

  function recordUsage(args = {}) {
    const userId = String(args.userId || "").trim();
    if (!userId) throw new Error("recordUsage: userId required");
    const rateCard = args.rateCard || args.pricing;
    if (!rateCard) throw new Error("recordUsage: model rate card required");
    const calculated = priceForUsage(args.usage || {}, rateCard);
    const usageId = String(args.id || randomId("mpu"));
    const status = String(args.status || "succeeded");
    return withTransaction(() => {
      const timestamp = nowIso();
      const id = ensureAccountInTransaction(userId, timestamp);
      expireBucketsInTransaction(id, timestamp);
      const succeeded = status === "succeeded";
      insertUsageStmt.run(
        usageId,
        id,
        String(args.modelId || ""),
        String(args.upstreamModel || ""),
        String(args.provider || ""),
        String(args.requestPath || ""),
        calculated.promptTokens,
        calculated.completionTokens,
        calculated.totalTokens,
        calculated.cacheHitTokens,
        calculated.cacheMissTokens,
        succeeded ? calculated.actualCostMicrocny : 0,
        succeeded ? calculated.chargeMillipoints : 0,
        String(rateCard.id || ""),
        toInteger(rateCard.version),
        status,
        String(args.error || "").slice(0, 500),
        timestamp
      );
      if (succeeded && calculated.chargeMillipoints > 0) {
        debitPointsInTransaction({
          userId: id,
          chargeMillipoints: calculated.chargeMillipoints,
          usageId,
          timestamp
        });
      }
      return rowToUsage(selectUsageStmt.get(usageId));
    });
  }

  function recordExternalCost(args = {}) {
    const actualCostMicrocny = nonNegativeInteger(args.actualCostMicrocny, "实际成本");
    const rateCard = args.rateCard || {
      id: String(args.rateCardId || "external"),
      version: toInteger(args.rateCardVersion, 1),
      millipointsPerCnyCost: toInteger(args.millipointsPerCnyCost, MILLIPOINTS_PER_CNY_COST)
    };
    const chargeMillipoints = microcnyToMillipoints(actualCostMicrocny, rateCard.millipointsPerCnyCost);
    const userId = String(args.userId || "").trim();
    if (!userId) throw new Error("recordExternalCost: userId required");
    const usageId = String(args.id || randomId("mpu"));
    const status = String(args.status || "succeeded");
    return withTransaction(() => {
      const timestamp = nowIso();
      const id = ensureAccountInTransaction(userId, timestamp);
      expireBucketsInTransaction(id, timestamp);
      const succeeded = status === "succeeded";
      insertUsageStmt.run(
        usageId,
        id,
        String(args.modelId || ""),
        String(args.upstreamModel || ""),
        String(args.provider || ""),
        String(args.requestPath || ""),
        0, 0, 0, 0, 0,
        succeeded ? actualCostMicrocny : 0,
        succeeded ? chargeMillipoints : 0,
        String(rateCard.id || ""),
        toInteger(rateCard.version),
        status,
        String(args.error || "").slice(0, 500),
        timestamp
      );
      if (succeeded && chargeMillipoints > 0) {
        debitPointsInTransaction({ userId: id, chargeMillipoints, usageId, timestamp });
      }
      return rowToUsage(selectUsageStmt.get(usageId));
    });
  }

  function listRecentUsage(userId, limit = 20) {
    const normalizedLimit = Math.min(100, Math.max(1, toInteger(limit, 20)));
    return listRecentUsageStmt.all(String(userId || "").trim(), normalizedLimit).map(rowToUsage);
  }

  function adminUsageSummary(limit = 50) {
    const normalizedLimit = Math.min(200, Math.max(1, toInteger(limit, 50)));
    return {
      totals: rowToAdminTotals(adminTotalsStmt.get()),
      users: adminUserSummaryStmt.all(normalizedLimit).map(rowToAdminUser),
      recentUsage: adminRecentUsageStmt.all(Math.min(50, normalizedLimit)).map(rowToAdminRecentUsage).filter(Boolean)
    };
  }

  return {
    ensureAccount,
    getBalance,
    grantPoints,
    hasPositiveBalance,
    recordUsage,
    recordExternalCost,
    listRecentUsage,
    adminUsageSummary,
    withTransaction
  };
}

module.exports = {
  MILLIPOINTS_PER_POINT,
  createModelBillingStore,
  priceForUsage
};
