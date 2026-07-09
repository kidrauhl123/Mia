"use strict";

function defaultEventState(settings = {}) {
  return {
    connecting: false,
    connected: false,
    lastError: "",
    lastEventSeq: Number(settings.lastEventSeq) || 0
  };
}

function createCloudEventsClient({
  getSettings,
  startCloudEventsRequest,
  stopCloudEventsRequest,
  appendCloudLog
}) {
  let eventState = defaultEventState(settings());
  let pendingStart = null;

  function settings() {
    return typeof getSettings === "function" ? getSettings() : {};
  }

  function log(line) {
    if (typeof appendCloudLog === "function") appendCloudLog(line);
  }

  function coreEventsStatus(response) {
    if (response?.status?.events && typeof response.status.events === "object") {
      return response.status.events;
    }
    if (response?.events && typeof response.events === "object") return response.events;
    if (response && typeof response === "object") return response;
    return null;
  }

  function applyCoreStatus(response) {
    const next = coreEventsStatus(response);
    if (!next) return;
    const fallback = settings();
    eventState = {
      connecting: Boolean(next.connecting),
      connected: Boolean(next.connected),
      lastError: String(next.lastError || ""),
      lastEventSeq: Number(next.lastEventSeq) || Number(fallback.lastEventSeq) || 0
    };
  }

  function status() {
    const s = settings();
    return {
      enabled: Boolean(s.enabled && s.token),
      connecting: Boolean(eventState.connecting),
      connected: Boolean(eventState.connected),
      lastError: eventState.lastError,
      lastEventSeq: Number(eventState.lastEventSeq) || Number(s.lastEventSeq) || 0
    };
  }

  function start() {
    const s = settings();
    if (!s.enabled || !s.token) return status();
    if (pendingStart) return status();
    eventState = {
      ...eventState,
      connecting: true,
      connected: false,
      lastError: ""
    };
    pendingStart = Promise.resolve()
      .then(() => (typeof startCloudEventsRequest === "function" ? startCloudEventsRequest({}) : null))
      .then((response) => applyCoreStatus(response))
      .catch((error) => {
        eventState = {
          ...eventState,
          connecting: false,
          connected: false,
          lastError: String(error?.message || error)
        };
        log(`Cloud events Core start failed: ${eventState.lastError}`);
      })
      .finally(() => {
        pendingStart = null;
      });
    if (pendingStart && typeof pendingStart.catch === "function") {
      pendingStart.catch(() => {});
    }
    return status();
  }

  function stop() {
    eventState = {
      ...eventState,
      connecting: false,
      connected: false
    };
    Promise.resolve()
      .then(() => (typeof stopCloudEventsRequest === "function" ? stopCloudEventsRequest() : null))
      .then((response) => applyCoreStatus(response))
      .catch((error) => {
        eventState = {
          ...eventState,
          lastError: String(error?.message || error)
        };
        log(`Cloud events Core stop failed: ${eventState.lastError}`);
      });
    return status();
  }

  return {
    start,
    status,
    stop
  };
}

module.exports = {
  createCloudEventsClient
};
