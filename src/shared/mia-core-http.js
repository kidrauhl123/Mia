(function attachMiaCoreHttp(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaCoreHttp = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildMiaCoreHttp() {
  function miaCorePort(root = globalThis) {
    const port = Number(root && root.__miaCorePort);
    return Number.isInteger(port) && port > 0 ? port : 0;
  }

  function miaCoreBaseUrl(root = globalThis) {
    const port = miaCorePort(root);
    return port ? `http://127.0.0.1:${port}` : "";
  }

  function miaCoreWsUrl(root = globalThis) {
    const port = miaCorePort(root);
    if (port) return `ws://127.0.0.1:${port}/ws`;
    const location = root && root.location;
    const protocol = location?.protocol === "https:" ? "wss:" : "ws:";
    const host = location?.host || "127.0.0.1";
    return `${protocol}//${host}/ws`;
  }

  async function miaCoreHttpRequest(method, route, body, options = {}) {
    const fetchImpl = options.fetchImpl || fetch;
    const baseUrl = options.baseUrl || miaCoreBaseUrl(options.root);
    const response = await fetchImpl(`${baseUrl}${route}`, {
      method: String(method || "GET").toUpperCase(),
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text().catch(() => "");
    const parsed = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = new Error(`Mia Core ${method} ${route} failed (${response.status})`);
      error.status = response.status;
      error.body = parsed;
      throw error;
    }
    if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "data")) {
      return parsed.data;
    }
    return parsed;
  }

  function rendererEventForCoreEnvelope(envelope = {}) {
    const name = String(envelope.name || envelope.type || "");
    if (name.startsWith("conversation.")) {
      return { channel: "chat:event", payload: envelope };
    }
    if (name.startsWith("task.")) {
      return { channel: "tasks:event", payload: envelope };
    }
    if (name.startsWith("cloud.")) {
      return { channel: "cloud:event", payload: envelope };
    }
    return { channel: "cloud:event", payload: envelope };
  }

  function createMiaCoreEventBridge(options = {}) {
    const root = options.root || globalThis;
    const WebSocketImpl = options.WebSocketImpl || root.WebSocket;
    const dispatch = typeof options.dispatch === "function" ? options.dispatch : () => {};
    let socket = null;

    function start() {
      if (!WebSocketImpl) throw new Error("WebSocket implementation is required.");
      if (socket) return socket;
      socket = new WebSocketImpl(miaCoreWsUrl(root));
      socket.addEventListener("message", (event) => {
        let envelope;
        try {
          envelope = JSON.parse(String(event?.data || ""));
        } catch {
          return;
        }
        if (!envelope || typeof envelope !== "object") return;
        dispatch(rendererEventForCoreEnvelope(envelope));
      });
      return socket;
    }

    function stop() {
      if (!socket) return;
      const current = socket;
      socket = null;
      if (typeof current.close === "function") current.close();
    }

    return { start, stop };
  }

  return Object.freeze({
    createMiaCoreEventBridge,
    miaCoreBaseUrl,
    miaCoreHttpRequest,
    miaCorePort,
    miaCoreWsUrl,
    rendererEventForCoreEnvelope
  });
});
