const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createCloudStore } = require("../src/cloud/sqlite-store.js");
const { createModelBillingStore, priceForUsage } = require("../src/cloud/model-billing-store.js");
const { createCloudUser } = require("./helpers/cloud-auth.js");

function createTempStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-model-points-"));
  return { dataDir, dbPath: path.join(dataDir, "cloud.sqlite") };
}

test("point billing uses cache-aware costs, spends event points first, and expires event grants", () => {
  const paths = createTempStore();
  const store = createCloudStore(paths);
  try {
    const user = createCloudUser(store, "point-ledger");
    const billing = createModelBillingStore(store.getDb());
    const rateCard = {
      id: "test-rate-card",
      version: 7,
      cacheHitMicrocnyPerMillion: 20_000,
      cacheMissMicrocnyPerMillion: 1_000_000,
      outputMicrocnyPerMillion: 2_000_000,
      millipointsPerCnyCost: 50_000
    };

    const priced = priceForUsage({
      prompt_tokens: 1000,
      completion_tokens: 500,
      prompt_cache_hit_tokens: 900,
      prompt_cache_miss_tokens: 100
    }, rateCard);
    assert.equal(priced.actualCostMicrocny, 1118);
    assert.equal(priced.chargeMillipoints, 56);

    billing.grantPoints({ userId: user.id, points: 2, sourceType: "event", sourceId: "welcome" });
    billing.grantPoints({ userId: user.id, points: 5, sourceType: "topup", sourceId: "order_1" });
    const usage = billing.recordUsage({
      userId: user.id,
      modelId: "mia-auto",
      upstreamModel: "deepseek-v4-flash",
      provider: "deepseek",
      requestPath: "/chat/completions",
      usage: { prompt_tokens: 20_000, completion_tokens: 0 },
      rateCard
    });
    assert.equal(usage.chargePoints, 1);
    assert.equal(billing.getBalance(user.id).balancePoints, 6);

    const buckets = store.getDb().prepare(`
      SELECT source_type, remaining_millipoints
      FROM model_point_buckets
      WHERE user_id = ?
      ORDER BY source_type
    `).all(user.id);
    assert.deepEqual(buckets.map((bucket) => ({ ...bucket })), [
      { source_type: "event", remaining_millipoints: 1_000 },
      { source_type: "topup", remaining_millipoints: 5_000 }
    ]);

    billing.grantPoints({
      userId: user.id,
      points: 3,
      sourceType: "event",
      sourceId: "expired-campaign",
      expiresAt: new Date(Date.now() - 1_000).toISOString()
    });
    assert.equal(billing.getBalance(user.id).balancePoints, 6);
    const expired = store.getDb().prepare(`
      SELECT remaining_millipoints
      FROM model_point_buckets
      WHERE user_id = ? AND source_id = 'expired-campaign'
    `).get(user.id);
    assert.equal(expired.remaining_millipoints, 0);
  } finally {
    store.close();
    fs.rmSync(paths.dataDir, { recursive: true, force: true });
  }
});
