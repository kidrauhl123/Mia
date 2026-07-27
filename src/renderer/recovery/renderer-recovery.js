(() => {
  "use strict";

  function retryTarget(search = "") {
    const params = new URLSearchParams(search);
    return params.get("target") === "onboarding"
      ? "../onboarding/onboarding.html"
      : "../index.html";
  }

  function initRendererRecoveryPage({
    documentRef = document,
    locationRef = location
  } = {}) {
    const retryButton = documentRef.getElementById("retry-button");
    if (!retryButton) return false;
    retryButton.addEventListener("click", () => {
      locationRef.replace(retryTarget(locationRef.search));
    });
    retryButton.focus();
    return true;
  }

  window.miaRendererRecovery = {
    initRendererRecoveryPage,
    retryTarget
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => initRendererRecoveryPage(), { once: true });
  } else {
    initRendererRecoveryPage();
  }
})();
