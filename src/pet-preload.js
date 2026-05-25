const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("miaPet", {
  onMessage: (callback) => {
    const listener = (_event, payload) => {
      try { callback(payload); } catch { /* pet renderer handler error swallowed */ }
    };
    ipcRenderer.on("pet:message", listener);
    return () => ipcRenderer.removeListener("pet:message", listener);
  }
});
