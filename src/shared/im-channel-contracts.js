(function attachImChannelContracts(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaImChannelContracts = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildImChannelContracts() {
  const IM_CHANNEL_PROVIDERS = Object.freeze({
    feishu: Object.freeze({
      id: "feishu",
      label: "飞书",
      callbackPath: "feishu",
      availability: "available"
    }),
    wechat_clawbot: Object.freeze({
      id: "wechat_clawbot",
      label: "微信",
      callbackPath: "",
      availability: "available",
      transport: "device-relay"
    })
  });

  function normalizeImChannelProvider(value) {
    return String(value || "").trim().toLowerCase();
  }

  function getImChannelProvider(value) {
    return IM_CHANNEL_PROVIDERS[normalizeImChannelProvider(value)] || null;
  }

  function isSupportedImChannelProvider(value) {
    return getImChannelProvider(value)?.availability === "available";
  }

  function listImChannelProviders({ includePreview = true } = {}) {
    return Object.values(IM_CHANNEL_PROVIDERS).filter((provider) => (
      includePreview || provider.availability === "available"
    ));
  }

  return Object.freeze({
    IM_CHANNEL_PROVIDERS,
    getImChannelProvider,
    isSupportedImChannelProvider,
    listImChannelProviders,
    normalizeImChannelProvider
  });
});
