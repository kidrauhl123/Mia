const crypto = require("node:crypto");
const { MILLIPOINTS_PER_POINT, pointsToMillipoints, millipointsToPoints, toInteger } = require("./model-point-pricing.js");

const CAMPAIGN_STATUSES = new Set(["draft", "active", "paused", "ended"]);

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

function notFoundError(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}

function hasOwn(input, key) {
  return Object.prototype.hasOwnProperty.call(input || {}, key);
}

function normalizeGrantMillipoints(input = {}) {
  if (hasOwn(input, "grantMillipoints") || hasOwn(input, "deltaMillipoints")) {
    const value = Number(input.grantMillipoints ?? input.deltaMillipoints);
    if (!Number.isSafeInteger(value) || value <= 0) throw inputError("赠送毫积分必须是正整数。");
    return value;
  }
  const points = Number(input.points ?? input.grantPoints);
  const millipoints = pointsToMillipoints(points);
  if (!Number.isFinite(points) || !Number.isSafeInteger(millipoints) || millipoints <= 0) {
    throw inputError("赠送积分必须是正数。");
  }
  return millipoints;
}

function normalizeTimestamp(value, label, fallback = "") {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) throw inputError(`${label}无效。`);
  return new Date(timestamp).toISOString();
}

function normalizeMaxClaims(value) {
  if (value === undefined || value === null || String(value).trim() === "") return 0;
  const maxClaims = Number(value);
  if (!Number.isSafeInteger(maxClaims) || maxClaims < 0) {
    throw inputError("总名额必须是非负整数。");
  }
  return maxClaims;
}

function normalizeStatus(value, fallback = "draft") {
  const status = String(value ?? fallback).trim().toLowerCase() || fallback;
  if (!CAMPAIGN_STATUSES.has(status)) throw inputError("活动状态无效。");
  return status;
}

function normalizeName(value) {
  const name = String(value || "").trim().slice(0, 80);
  if (!name) throw inputError("请填写活动名称。");
  return name;
}

function isCampaignLive(row, currentTime = Date.now()) {
  if (row?.status !== "active") return false;
  const startsAt = Date.parse(row.starts_at || row.startsAt || "");
  const endsAt = String(row.ends_at ?? row.endsAt ?? "").trim();
  if (!Number.isFinite(startsAt) || startsAt > currentTime) return false;
  return !endsAt || Date.parse(endsAt) >= currentTime;
}

function rowToCampaign(row = {}) {
  const grantMillipoints = toInteger(row.grant_millipoints);
  const maxClaims = toInteger(row.max_claims);
  const claimedCount = toInteger(row.claimed_count);
  return {
    id: row.id || "",
    name: row.name || "",
    status: row.status || "draft",
    grantMillipoints,
    grantPoints: millipointsToPoints(grantMillipoints),
    startsAt: row.starts_at || "",
    endsAt: row.ends_at || "",
    grantExpiresAt: row.grant_expires_at || "",
    maxClaims,
    claimedCount,
    remainingClaims: maxClaims > 0 ? Math.max(0, maxClaims - claimedCount) : null,
    isLive: isCampaignLive(row),
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || ""
  };
}

function rowToClaim(row = {}) {
  const grantMillipoints = toInteger(row.grant_millipoints);
  return {
    campaignId: row.campaign_id || "",
    campaignName: row.campaign_name || "",
    grantMillipoints,
    grantPoints: millipointsToPoints(grantMillipoints),
    expiresAt: row.grant_expires_at || "",
    claimedAt: row.created_at || ""
  };
}

function campaignEligibilityReason(campaign, user, currentTime = Date.now()) {
  if (!campaign) return "not_found";
  if (campaign.status !== "active") return "not_active";
  const startsAt = Date.parse(campaign.starts_at || "");
  const endsAt = String(campaign.ends_at || "").trim();
  const registeredAt = Date.parse(user?.created_at || "");
  if (!Number.isFinite(startsAt) || !Number.isFinite(registeredAt)) return "invalid_window";
  if (startsAt > currentTime) return "not_started";
  if (endsAt && Date.parse(endsAt) < currentTime) return "ended";
  if (registeredAt < startsAt) return "not_new_user";
  return "";
}

function assertCampaignWindow({ startsAt, endsAt, grantExpiresAt }) {
  if (endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw inputError("活动结束时间必须晚于开始时间。");
  }
  if (grantExpiresAt && Date.parse(grantExpiresAt) <= Date.parse(startsAt)) {
    throw inputError("积分有效期必须晚于活动开始时间。");
  }
}

function createModelPointPromotionStore(db, modelBillingStore) {
  if (!db) throw new Error("model point promotion database required");
  if (!modelBillingStore?.grantPoints || !modelBillingStore?.withTransaction) {
    throw new Error("model point promotion billing store required");
  }

  const listCampaignsStmt = db.prepare(`
    SELECT c.*, COUNT(cl.user_id) AS claimed_count
    FROM model_point_campaigns c
    LEFT JOIN model_point_campaign_claims cl ON cl.campaign_id = c.id
    GROUP BY c.id
    ORDER BY
      CASE c.status
        WHEN 'active' THEN 0
        WHEN 'draft' THEN 1
        WHEN 'paused' THEN 2
        ELSE 3
      END,
      c.updated_at DESC
  `);
  const selectCampaignStmt = db.prepare(`
    SELECT *
    FROM model_point_campaigns
    WHERE id = ?
  `);
  const selectCampaignWithClaimsStmt = db.prepare(`
    SELECT c.*, COUNT(cl.user_id) AS claimed_count
    FROM model_point_campaigns c
    LEFT JOIN model_point_campaign_claims cl ON cl.campaign_id = c.id
    WHERE c.id = ?
    GROUP BY c.id
  `);
  const selectCurrentCampaignStmt = db.prepare(`
    SELECT *
    FROM model_point_campaigns
    WHERE status = 'active'
      AND starts_at <= ?
      AND (ends_at = '' OR ends_at >= ?)
    ORDER BY updated_at DESC
    LIMIT 1
  `);
  const selectUserStmt = db.prepare(`
    SELECT id, created_at
    FROM users
    WHERE id = ?
  `);
  const selectClaimStmt = db.prepare(`
    SELECT campaign_id, user_id, grant_millipoints, bucket_id, grant_expires_at, created_at
    FROM model_point_campaign_claims
    WHERE campaign_id = ? AND user_id = ?
  `);
  const countClaimsStmt = db.prepare(`
    SELECT COUNT(*) AS claimed_count
    FROM model_point_campaign_claims
    WHERE campaign_id = ?
  `);
  const insertCampaignStmt = db.prepare(`
    INSERT INTO model_point_campaigns (
      id, name, status, grant_millipoints, starts_at, ends_at,
      grant_expires_at, max_claims, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateCampaignStmt = db.prepare(`
    UPDATE model_point_campaigns
    SET name = ?, status = ?, grant_millipoints = ?, starts_at = ?,
        ends_at = ?, grant_expires_at = ?, max_claims = ?, updated_at = ?
    WHERE id = ?
  `);
  const pauseOtherCampaignsStmt = db.prepare(`
    UPDATE model_point_campaigns
    SET status = 'paused', updated_at = ?
    WHERE status = 'active' AND id <> ?
  `);
  const insertClaimStmt = db.prepare(`
    INSERT INTO model_point_campaign_claims (
      campaign_id, user_id, grant_millipoints, bucket_id, grant_expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const listUserClaimsStmt = db.prepare(`
    SELECT
      cl.campaign_id,
      c.name AS campaign_name,
      cl.grant_millipoints,
      cl.grant_expires_at,
      cl.created_at
    FROM model_point_campaign_claims cl
    JOIN model_point_campaigns c ON c.id = cl.campaign_id
    WHERE cl.user_id = ?
    ORDER BY cl.created_at DESC
    LIMIT ?
  `);

  function getCampaign(campaignId) {
    const id = String(campaignId || "").trim();
    if (!id) return null;
    const row = selectCampaignWithClaimsStmt.get(id);
    return row ? rowToCampaign(row) : null;
  }

  function listCampaigns() {
    return listCampaignsStmt.all().map(rowToCampaign);
  }

  function createCampaign(input = {}) {
    const timestamp = nowIso();
    const startsAt = normalizeTimestamp(input.startsAt ?? input.startAt, "活动开始时间", timestamp);
    const endsAt = normalizeTimestamp(input.endsAt ?? input.endAt, "活动结束时间");
    const grantExpiresAt = normalizeTimestamp(input.grantExpiresAt ?? input.expiresAt, "积分有效期");
    assertCampaignWindow({ startsAt, endsAt, grantExpiresAt });
    const id = randomId("mpc");
    insertCampaignStmt.run(
      id,
      normalizeName(input.name),
      "draft",
      normalizeGrantMillipoints(input),
      startsAt,
      endsAt,
      grantExpiresAt,
      normalizeMaxClaims(input.maxClaims),
      timestamp,
      timestamp
    );
    return getCampaign(id);
  }

  function updateCampaign(campaignId, input = {}) {
    const id = String(campaignId || "").trim();
    if (!id) throw inputError("缺少活动 ID。");
    const current = selectCampaignStmt.get(id);
    if (!current) throw notFoundError("活动不存在。");
    const hasGrant = hasOwn(input, "points") || hasOwn(input, "grantPoints")
      || hasOwn(input, "grantMillipoints") || hasOwn(input, "deltaMillipoints");
    const startsAt = hasOwn(input, "startsAt") || hasOwn(input, "startAt")
      ? normalizeTimestamp(input.startsAt ?? input.startAt, "活动开始时间", current.starts_at)
      : current.starts_at;
    const endsAt = hasOwn(input, "endsAt") || hasOwn(input, "endAt")
      ? normalizeTimestamp(input.endsAt ?? input.endAt, "活动结束时间")
      : current.ends_at;
    const grantExpiresAt = hasOwn(input, "grantExpiresAt") || hasOwn(input, "expiresAt")
      ? normalizeTimestamp(input.grantExpiresAt ?? input.expiresAt, "积分有效期")
      : current.grant_expires_at;
    assertCampaignWindow({ startsAt, endsAt, grantExpiresAt });
    const next = {
      name: hasOwn(input, "name") ? normalizeName(input.name) : current.name,
      status: hasOwn(input, "status") ? normalizeStatus(input.status) : current.status,
      grantMillipoints: hasGrant ? normalizeGrantMillipoints(input) : toInteger(current.grant_millipoints),
      startsAt,
      endsAt,
      grantExpiresAt,
      maxClaims: hasOwn(input, "maxClaims") ? normalizeMaxClaims(input.maxClaims) : toInteger(current.max_claims)
    };
    if (next.status === "active" && next.endsAt && Date.parse(next.endsAt) < Date.now()) {
      throw inputError("已结束的活动不能启用。");
    }
    const timestamp = nowIso();
    modelBillingStore.withTransaction(() => {
      if (next.status === "active") pauseOtherCampaignsStmt.run(timestamp, id);
      updateCampaignStmt.run(
        next.name,
        next.status,
        next.grantMillipoints,
        next.startsAt,
        next.endsAt,
        next.grantExpiresAt,
        next.maxClaims,
        timestamp,
        id
      );
    });
    return getCampaign(id);
  }

  function claimCampaignForUser(campaignId, userId) {
    const campaignKey = String(campaignId || "").trim();
    const accountId = String(userId || "").trim();
    if (!campaignKey || !accountId) return { claimed: false, reason: "invalid" };
    return modelBillingStore.withTransaction(() => {
      const campaign = selectCampaignStmt.get(campaignKey);
      const user = selectUserStmt.get(accountId);
      const reason = campaignEligibilityReason(campaign, user);
      if (reason) return { claimed: false, reason };
      const existing = selectClaimStmt.get(campaignKey, accountId);
      if (existing) return { claimed: false, reason: "already_claimed", claim: rowToClaim({
        ...existing,
        campaign_name: campaign.name,
        grant_expires_at: existing.grant_expires_at || campaign.grant_expires_at
      }) };
      const maxClaims = toInteger(campaign.max_claims);
      if (maxClaims > 0 && toInteger(countClaimsStmt.get(campaignKey)?.claimed_count) >= maxClaims) {
        return { claimed: false, reason: "limit_reached" };
      }
      const timestamp = nowIso();
      const grantMillipoints = toInteger(campaign.grant_millipoints);
      const bucketId = randomId("mpb");
      insertClaimStmt.run(
        campaignKey,
        accountId,
        grantMillipoints,
        bucketId,
        campaign.grant_expires_at,
        timestamp
      );
      const balance = modelBillingStore.grantPoints({
        userId: accountId,
        deltaMillipoints: grantMillipoints,
        sourceType: "event",
        sourceId: campaignKey,
        bucketId,
        expiresAt: campaign.grant_expires_at,
        reason: `promotion:${campaignKey}`
      });
      return {
        claimed: true,
        claim: rowToClaim({
          campaign_id: campaignKey,
          campaign_name: campaign.name,
          grant_millipoints: grantMillipoints,
          grant_expires_at: campaign.grant_expires_at,
          created_at: timestamp
        }),
        balance
      };
    });
  }

  function claimEligibleForUser(userId) {
    const accountId = String(userId || "").trim();
    if (!accountId) return [];
    const timestamp = nowIso();
    const campaign = selectCurrentCampaignStmt.get(timestamp, timestamp);
    if (!campaign) return [];
    const result = claimCampaignForUser(campaign.id, accountId);
    return result.claimed && result.claim ? [result.claim] : [];
  }

  function listUserClaims(userId, limit = 10) {
    const accountId = String(userId || "").trim();
    const normalizedLimit = Math.min(50, Math.max(1, toInteger(limit, 10)));
    if (!accountId) return [];
    return listUserClaimsStmt.all(accountId, normalizedLimit).map(rowToClaim);
  }

  return {
    createCampaign,
    getCampaign,
    listCampaigns,
    updateCampaign,
    claimEligibleForUser,
    listUserClaims
  };
}

module.exports = {
  MILLIPOINTS_PER_POINT,
  createModelPointPromotionStore
};
