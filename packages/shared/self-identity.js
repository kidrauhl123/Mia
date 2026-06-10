(function attachSelfIdentity(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaSelfIdentity = api;
})(typeof window !== "undefined" ? window : globalThis, function buildSelfIdentity() {
  "use strict";

  function firstNonEmpty(...values) {
    for (const value of values) {
      const next = String(value || "").trim();
      if (next) return next;
    }
    return "";
  }

  function initialsOf(name) {
    return Array.from(String(name || "").trim()).slice(0, 2).join("");
  }

  // Canonical "who am I" resolver. The rail account button, the social adapter
  // context, and the contact card each used to assemble self from
  // runtime.cloud.user / runtime.user with different field precedence, so the
  // same user rendered as two different avatars. Everything self-related now
  // funnels through here so there is a single precedence that cannot drift.
  //
  // displayName rule: when signed into a cloud account, THAT account is who you
  // are — cloud identity wins (real display name → @handle). The local profile
  // (mia-user.json) is a single global file shared across every account, so it
  // cannot represent per-account identity; it only fills in when there is no
  // cloud account (offline / signed out). Without this a stale local name set
  // on one account leaks onto the next.
  //
  // Avatar image/crop/color are also cloud-first when signed in. The server
  // sends empty strings/nulls intentionally when a profile field is cleared, so
  // field presence matters: a present-but-empty cloud avatar must not fall back
  // to a stale local image from another device or account.
  // Avatar text is always the initials of the resolved displayName so it never
  // shows a stale cached avatarText.
  function resolveSelfIdentity(input = {}) {
    const cloudUser = input.cloudUser || {};
    const localUser = input.localUser || {};
    const hasCloudAccount = Boolean(firstNonEmpty(
      cloudUser.id,
      cloudUser.userId,
      cloudUser.user_id,
      cloudUser.username,
      cloudUser.account,
      cloudUser.email
    ));
    const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);
    const cloudOrLocal = (cloudKey, cloudSnakeKey, localKey) => {
      if (hasCloudAccount) {
        if (hasOwn(cloudUser, cloudKey)) return cloudUser[cloudKey];
        if (cloudSnakeKey && hasOwn(cloudUser, cloudSnakeKey)) return cloudUser[cloudSnakeKey];
      }
      return localUser[localKey];
    };
    const displayName = firstNonEmpty(
      cloudUser.displayName,
      cloudUser.display_name,
      cloudUser.name,
      cloudUser.username,
      cloudUser.account,
      localUser.displayName,
      localUser.name,
      localUser.username,
      localUser.account,
      cloudUser.email
    );
    const username = firstNonEmpty(
      cloudUser.username,
      cloudUser.account,
      input.myUsername,
      localUser.username,
      localUser.account
    );
    return {
      id: firstNonEmpty(cloudUser.id, cloudUser.userId, cloudUser.user_id, input.myUserId, localUser.id),
      displayName,
      username,
      account: firstNonEmpty(cloudUser.account, localUser.account),
      avatarText: initialsOf(displayName),
      avatarColor: String(cloudOrLocal("avatarColor", "avatar_color", "avatarColor") || ""),
      avatarImage: String(cloudOrLocal("avatarImage", "avatar_image", "avatarImage") || ""),
      avatarCrop: cloudOrLocal("avatarCrop", "avatar_crop", "avatarCrop") || null
    };
  }

  return { resolveSelfIdentity };
});
