"use strict";

// Pure-node helpers for building the /api/events WebSocket URL + subprotocols
// from cloud settings. Shared verbatim by the Electron main process (src/main.js)
// and Mia Core (src/core/mia-core.js) so there is exactly ONE definition of how
// the cloud events socket address + token protocol are derived (no fork).

// settings: { url, token, lastEventSeq }
function cloudWebSocketUrl(pathname, settings = {}) {
  const url = new URL(settings.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = pathname;
  url.search = "";
  return url;
}

function cloudWebSocketProtocols(settings = {}) {
  return [`mia-token.${settings.token}`];
}

function cloudEventsUrl(settings = {}) {
  const url = cloudWebSocketUrl("/api/events", settings);
  // Tell the server where we left off so it can replay any persisted events we
  // missed while disconnected. 0 == replay from the start (login / fresh install).
  url.searchParams.set("since_seq", String(Number(settings.lastEventSeq) || 0));
  return url.toString();
}

module.exports = {
  cloudWebSocketUrl,
  cloudWebSocketProtocols,
  cloudEventsUrl
};
