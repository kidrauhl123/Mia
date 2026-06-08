// Hermes install source — resolves where `pip install` pulls the official
// hermes-agent package from. hermes-agent is published to PyPI, so we install
// it from a package index (not a Mia-hosted source archive): China-first mirror
// with the official PyPI index as fallback. No self-hosted source needed; the
// mirror (Tsinghua TUNA by default) carries hermes-agent and all its deps.

function clean(value) {
  return String(value || "").trim();
}

function createHermesInstallSourceService(deps = {}) {
  const env = deps.env || process.env;
  const officialPackage = clean(deps.officialPackage || env.MIA_ENGINE_PACKAGE || "hermes-agent");
  const officialExtras = clean(
    deps.officialExtras != null ? deps.officialExtras : (env.MIA_ENGINE_EXTRAS != null ? env.MIA_ENGINE_EXTRAS : "web")
  );
  const officialVersion = clean(deps.officialVersion || env.MIA_ENGINE_VERSION || "");
  // China-first index with the official PyPI index as fallback. Override the
  // mirror with MIA_ENGINE_INDEX_URL (e.g. an internal mirror).
  const indexUrl = clean(deps.indexUrl || env.MIA_ENGINE_INDEX_URL || "https://pypi.tuna.tsinghua.edu.cn/simple");
  const fallbackIndexUrl = clean(deps.fallbackIndexUrl || env.MIA_ENGINE_FALLBACK_INDEX_URL || "https://pypi.org/simple");

  function requirementFor(extras = officialExtras) {
    const extraPart = extras ? `[${extras}]` : "";
    const versionPart = officialVersion ? `==${officialVersion}` : "";
    return `${officialPackage}${extraPart}${versionPart}`;
  }

  function resolveInstallSource() {
    return {
      kind: "pypi",
      package: officialPackage,
      extras: officialExtras,
      version: officialVersion,
      requirement: requirementFor(officialExtras),
      baseRequirement: requirementFor(""),
      indexUrl,
      // Distinct indexes, mirror first; install retries the next on failure.
      indexUrls: [indexUrl, fallbackIndexUrl].filter((value, position, all) => value && all.indexOf(value) === position),
      fallbackIndexUrl
    };
  }

  return {
    requirementFor,
    resolveInstallSource
  };
}

module.exports = {
  createHermesInstallSourceService
};
