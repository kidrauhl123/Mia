(function attachCloudClient(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaCloudClient = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildCloudClient() {
  function defaultIdFactory() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return `op_${crypto.randomUUID()}`;
    return `op_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function eventsUrlFor(apiBase, sinceSeq) {
    const base = String(apiBase || "").replace(/\/+$/, "");
    const wsBase = base.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    return `${wsBase}/api/events?since_seq=${Number(sinceSeq) || 0}`;
  }

  function backoffMs(attempt) {
    return Math.min(30000, 1000 * Math.pow(2, Math.max(0, attempt)));
  }

  function createCloudClient(deps = {}) {
    const apiBase = String(deps.apiBase || "").replace(/\/+$/, "");
    const fetchImpl = deps.fetchImpl || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
    const getToken = deps.getToken || (() => "");
    const idFactory = deps.idFactory || defaultIdFactory;
    const WS = deps.WebSocketImpl || (typeof WebSocket !== "undefined" ? WebSocket : null);
    const scheduleReconnect = deps.scheduleReconnect || ((fn, ms) => setTimeout(fn, ms || 1000));
    if (!fetchImpl) throw new Error("cloud-client: no fetch implementation");

    async function api(path, options = {}) {
      const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
      const token = getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      let body = options.body;
      const method = String(options.method || "GET").toUpperCase();
      const mutating = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
      if (mutating && body && typeof body === "object" && !body.clientOpId) {
        body = { ...body, clientOpId: idFactory() };
      }
      const response = await fetchImpl(`${apiBase}${path}`, {
        ...options,
        headers,
        body: body && typeof body !== "string" ? JSON.stringify(body) : body
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const err = new Error(data.error || `HTTP ${response.status}`);
        // Expose the HTTP status so callers can react to auth failures (401)
        // without string-matching the localized error message.
        err.status = response.status;
        throw err;
      }
      return data;
    }

    let socket = null;
    let stopped = false;
    let attempt = 0;

    function connectEvents(opts = {}) {
      stopped = false;
      const token = getToken();
      if (!token || !WS) return;
      disconnectEvents();
      let s;
      try {
        s = new WS(eventsUrlFor(apiBase, opts.sinceSeq ? opts.sinceSeq() : 0), [`mia-token.${token}`]);
      } catch {
        if (!stopped) scheduleReconnect(() => connectEvents(opts), backoffMs(attempt++));
        return;
      }
      socket = s;
      if (opts.onStatus) opts.onStatus("connecting");
      s.addEventListener("open", () => {
        attempt = 0;
        if (opts.onStatus) opts.onStatus("open");
      });
      s.addEventListener("message", (event) => {
        if (socket !== s) return;
        let envelope;
        try { envelope = JSON.parse(event.data); } catch { return; }
        opts.onEvent?.(envelope);
      });
      const onDown = () => {
        if (socket !== s) return;
        socket = null;
        if (opts.onStatus) opts.onStatus("down");
        if (!stopped) scheduleReconnect(() => connectEvents(opts), backoffMs(attempt++));
      };
      s.addEventListener("close", onDown);
      s.addEventListener("error", onDown);
    }

    function disconnectEvents() {
      const s = socket;
      socket = null;
      if (s) {
        try { s.close(); } catch {}
      }
    }

    function stopEvents() {
      stopped = true;
      disconnectEvents();
    }

    return { api, apiBase, connectEvents, disconnectEvents, stopEvents };
  }

  function createEventsClient(deps = {}) {
    const client = createCloudClient({
      ...deps,
      fetchImpl: deps.fetchImpl || (async () => ({ ok: true, status: 204, json: async () => ({}) }))
    });
    return {
      connect: client.connectEvents,
      disconnect: client.disconnectEvents,
      stop: client.stopEvents
    };
  }

  return { createCloudClient, createEventsClient, eventsUrlFor, backoffMs };
});
