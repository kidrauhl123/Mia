const crypto = require("node:crypto");

function clean(value) {
  return String(value || "").trim();
}

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function assertSha256(value) {
  const checksum = clean(value).toLowerCase();
  if (!checksum) return "";
  if (!/^[a-f0-9]{64}$/.test(checksum)) {
    throw new Error("Hermes archive checksum must be a 64-character sha256 hex string.");
  }
  return checksum;
}

function createHermesInstallSourceService(deps = {}) {
  const env = deps.env || process.env;
  const officialPackage = clean(deps.officialPackage || env.MIA_ENGINE_PACKAGE || "hermes-agent");
  const officialRepoUrl = clean(deps.officialRepoUrl || env.MIA_ENGINE_REPO || "https://github.com/NousResearch/hermes-agent").replace(/\/+$/, "");
  const officialRef = clean(deps.officialRef || env.MIA_ENGINE_REF || "main");
  const officialExtras = clean(deps.officialExtras || env.MIA_ENGINE_EXTRAS || "web");

  function officialUrl() {
    const explicit = clean(deps.officialUrl || env.MIA_ENGINE_URL);
    if (explicit) return explicit;
    return `${officialRepoUrl}/archive/${encodeURIComponent(officialRef)}.tar.gz`;
  }

  function requirementFor(url, extras = officialExtras) {
    const extraPart = extras ? `[${extras}]` : "";
    return `${officialPackage}${extraPart} @ ${url}`;
  }

  function resolveInstallSource() {
    const upstreamUrl = officialUrl();
    const mirrorUrl = clean(deps.mirrorUrl || env.MIA_ENGINE_MIRROR_URL);
    const checksum = assertSha256(deps.checksum || env.MIA_ENGINE_SHA256);
    const url = mirrorUrl || upstreamUrl;
    return {
      kind: mirrorUrl ? "mia-mirror" : "official-github-archive",
      package: officialPackage,
      repo: officialRepoUrl,
      ref: officialRef,
      extras: officialExtras,
      url,
      upstreamUrl,
      requirement: requirementFor(url),
      baseRequirement: requirementFor(url, ""),
      checksum
    };
  }

  function verifyChecksum(bytes, expected = "") {
    const checksum = assertSha256(expected);
    if (!checksum) return true;
    const actual = sha256Hex(bytes);
    if (actual !== checksum) {
      throw new Error(`Hermes archive checksum mismatch: expected ${checksum}, got ${actual}.`);
    }
    return true;
  }

  return {
    officialUrl,
    requirementFor,
    resolveInstallSource,
    verifyChecksum
  };
}

module.exports = {
  createHermesInstallSourceService,
  sha256Hex
};
