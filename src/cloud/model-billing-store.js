const crypto = require("node:crypto");

const MICRO_USD = 1_000_000;

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function toInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function moneyToMicrousd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * MICRO_USD);
}

function rowToBalance(row) {
  const balanceMicrousd = toInteger(row?.balance_microusd);
  return {
    userId: row?.user_id || "",
    balanceMicrousd,
    balanceUsd: balanceMicrousd / MICRO_USD,
    updatedAt: row?.updated_at || ""
  };
}

function rowToUsage(row) {
  if (!row) return null;
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
    costMicrousd: toInteger(row.cost_microusd),
    chargeMicrousd: toInteger(row.charge_microusd),
    status: row.status,
    error: row.error || "",
    createdAt: row.created_at
  };
}

function rowToAdminUser(row = {}) {
  const balanceMicrousd = toInteger(row.balance_microusd);
  const chargeMicrousd = toInteger(row.charge_microusd);
  const costMicrousd = toInteger(row.cost_microusd);
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
      balanceMicrousd,
      balanceUsd: balanceMicrousd / MICRO_USD,
      updatedAt: row.balance_updated_at || ""
    },
    usage: {
      requestCount: toInteger(row.request_count),
      succeededCount: toInteger(row.succeeded_count),
      failedCount: toInteger(row.failed_count),
      promptTokens: toInteger(row.prompt_tokens),
      completionTokens: toInteger(row.completion_tokens),
      totalTokens: toInteger(row.total_tokens),
      costMicrousd,
      costUsd: costMicrousd / MICRO_USD,
      chargeMicrousd,
      chargeUsd: chargeMicrousd / MICRO_USD,
      lastUsedAt: row.last_used_at || ""
    }
  };
}

function rowToAdminTotals(row = {}) {
  const costMicrousd = toInteger(row.cost_microusd);
  const chargeMicrousd = toInteger(row.charge_microusd);
  return {
    userCount: toInteger(row.user_count),
    activeUserCount: toInteger(row.active_user_count),
    requestCount: toInteger(row.request_count),
    succeededCount: toInteger(row.succeeded_count),
    failedCount: toInteger(row.failed_count),
    promptTokens: toInteger(row.prompt_tokens),
    completionTokens: toInteger(row.completion_tokens),
    totalTokens: toInteger(row.total_tokens),
    costMicrousd,
    costUsd: costMicrousd / MICRO_USD,
    chargeMicrousd,
    chargeUsd: chargeMicrousd / MICRO_USD,
    balanceMicrousd: toInteger(row.balance_microusd),
    balanceUsd: toInteger(row.balance_microusd) / MICRO_USD
  };
}

function rowToAdminRecentUsage(row = {}) {
  const usage = rowToUsage(row);
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

function usageTokenCounts(usage = {}) {
  const promptTokens = toInteger(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = toInteger(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = toInteger(usage.total_tokens, promptTokens + completionTokens);
  return { promptTokens, completionTokens, totalTokens };
}

function priceForUsage(usage = {}, pricing = {}) {
  const counts = usageTokenCounts(usage);
  const inputRate = toInteger(pricing.inputMicrousdPerMillion);
  const outputRate = toInteger(pricing.outputMicrousdPerMillion);
  const costMicrousd = Math.ceil((counts.promptTokens * inputRate + counts.completionTokens * outputRate) / 1_000_000);
  const markup = Number(pricing.markup || 1);
  const chargeMicrousd = Math.max(0, Math.ceil(costMicrousd * (Number.isFinite(markup) && markup > 0 ? markup : 1)));
  return { ...counts, costMicrousd, chargeMicrousd };
}

function createModelBillingStore(db) {
  const ensureAccountStmt = db.prepare(`
    INSERT INTO model_accounts (user_id, balance_microusd, updated_at)
    VALUES (?, 0, ?)
    ON CONFLICT(user_id) DO NOTHING
  `);
  const selectBalanceStmt = db.prepare(`
    SELECT user_id, balance_microusd, updated_at
    FROM model_accounts
    WHERE user_id = ?
  `);
  const updateBalanceStmt = db.prepare(`
    UPDATE model_accounts
    SET balance_microusd = balance_microusd + ?, updated_at = ?
    WHERE user_id = ?
  `);
  const insertBalanceLedgerStmt = db.prepare(`
    INSERT INTO model_balance_ledger (
      id, user_id, delta_microusd, balance_after_microusd, reason, usage_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUsageStmt = db.prepare(`
    INSERT INTO model_usage_ledger (
      id, user_id, model_id, upstream_model, provider, request_path,
      prompt_tokens, completion_tokens, total_tokens, cost_microusd,
      charge_microusd, status, error, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectUsageStmt = db.prepare(`
    SELECT id, user_id, model_id, upstream_model, provider, request_path,
           prompt_tokens, completion_tokens, total_tokens, cost_microusd,
           charge_microusd, status, error, created_at
    FROM model_usage_ledger
    WHERE id = ?
  `);
  const listRecentUsageStmt = db.prepare(`
    SELECT id, user_id, model_id, upstream_model, provider, request_path,
           prompt_tokens, completion_tokens, total_tokens, cost_microusd,
           charge_microusd, status, error, created_at
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
      COALESCE(SUM(l.cost_microusd), 0) AS cost_microusd,
      COALESCE(SUM(l.charge_microusd), 0) AS charge_microusd,
      (SELECT COALESCE(SUM(balance_microusd), 0) FROM model_accounts) AS balance_microusd
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
      COALESCE(a.balance_microusd, 0) AS balance_microusd,
      COALESCE(a.updated_at, '') AS balance_updated_at,
      COUNT(l.id) AS request_count,
      SUM(CASE WHEN l.status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded_count,
      SUM(CASE WHEN l.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
      COALESCE(SUM(l.prompt_tokens), 0) AS prompt_tokens,
      COALESCE(SUM(l.completion_tokens), 0) AS completion_tokens,
      COALESCE(SUM(l.total_tokens), 0) AS total_tokens,
      COALESCE(SUM(l.cost_microusd), 0) AS cost_microusd,
      COALESCE(SUM(l.charge_microusd), 0) AS charge_microusd,
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
           l.prompt_tokens, l.completion_tokens, l.total_tokens, l.cost_microusd,
           l.charge_microusd, l.status, l.error, l.created_at,
           u.account, u.username, u.display_name, u.email
    FROM model_usage_ledger l
    LEFT JOIN users u ON u.id = l.user_id
    ORDER BY l.created_at DESC
    LIMIT ?
  `);

  function ensureAccount(userId) {
    const id = String(userId || "").trim();
    if (!id) throw new Error("model billing userId required");
    ensureAccountStmt.run(id, nowIso());
    return getBalance(id);
  }

  function getBalance(userId) {
    const id = String(userId || "").trim();
    ensureAccountStmt.run(id, nowIso());
    return rowToBalance(selectBalanceStmt.get(id));
  }

  function grantBalance(args = {}) {
    const userId = String(args.userId || "").trim();
    const deltaMicrousd = toInteger(args.deltaMicrousd ?? moneyToMicrousd(args.amountUsd));
    if (!userId) throw new Error("grantBalance: userId required");
    if (!deltaMicrousd) throw new Error("grantBalance: deltaMicrousd required");
    const timestamp = nowIso();
    ensureAccountStmt.run(userId, timestamp);
    updateBalanceStmt.run(deltaMicrousd, timestamp, userId);
    const balance = getBalance(userId);
    insertBalanceLedgerStmt.run(
      randomId("mbl"),
      userId,
      deltaMicrousd,
      balance.balanceMicrousd,
      String(args.reason || "admin_grant").trim().slice(0, 120),
      String(args.usageId || ""),
      timestamp
    );
    return balance;
  }

  function hasPositiveBalance(userId) {
    return getBalance(userId).balanceMicrousd > 0;
  }

  function recordUsage(args = {}) {
    const userId = String(args.userId || "").trim();
    if (!userId) throw new Error("recordUsage: userId required");
    const calculated = priceForUsage(args.usage || {}, args.pricing || {});
    const usageId = String(args.id || randomId("mul"));
    const status = String(args.status || "succeeded");
    const timestamp = nowIso();
    ensureAccountStmt.run(userId, timestamp);
    insertUsageStmt.run(
      usageId,
      userId,
      String(args.modelId || ""),
      String(args.upstreamModel || ""),
      String(args.provider || ""),
      String(args.requestPath || ""),
      calculated.promptTokens,
      calculated.completionTokens,
      calculated.totalTokens,
      calculated.costMicrousd,
      status === "succeeded" ? calculated.chargeMicrousd : 0,
      status,
      String(args.error || "").slice(0, 500),
      timestamp
    );
    if (status === "succeeded" && calculated.chargeMicrousd > 0) {
      updateBalanceStmt.run(-calculated.chargeMicrousd, timestamp, userId);
      const balance = getBalance(userId);
      insertBalanceLedgerStmt.run(
        randomId("mbl"),
        userId,
        -calculated.chargeMicrousd,
        balance.balanceMicrousd,
        "model_usage",
        usageId,
        timestamp
      );
    }
    return rowToUsage(selectUsageStmt.get(usageId));
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
    grantBalance,
    hasPositiveBalance,
    recordUsage,
    listRecentUsage,
    adminUsageSummary
  };
}

module.exports = {
  MICRO_USD,
  createModelBillingStore,
  priceForUsage
};
