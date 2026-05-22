const { IpcChannel } = require("../../shared/ipc-channels");

function registerTasksIpc({ ipcMain, callDaemonTasks }) {
  ipcMain.handle(IpcChannel.TasksList, async () => (await callDaemonTasks("/api/tasks")).tasks);
  ipcMain.handle(IpcChannel.TasksGet, async (_event, id) => (await callDaemonTasks(`/api/tasks/${id}`)).task);
  ipcMain.handle(IpcChannel.TasksCreate, async (_event, input) => (await callDaemonTasks("/api/tasks", { method: "POST", body: JSON.stringify(input) })).task);
  ipcMain.handle(IpcChannel.TasksUpdate, async (_event, id, partial) => (await callDaemonTasks(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(partial) })).task);
  ipcMain.handle(IpcChannel.TasksDelete, async (_event, id) => callDaemonTasks(`/api/tasks/${id}`, { method: "DELETE" }));
  ipcMain.handle(IpcChannel.TasksPause, async (_event, id) => (await callDaemonTasks(`/api/tasks/${id}/pause`, { method: "POST" })).task);
  ipcMain.handle(IpcChannel.TasksResume, async (_event, id) => (await callDaemonTasks(`/api/tasks/${id}/resume`, { method: "POST" })).task);
  ipcMain.handle(IpcChannel.TasksRunNow, async (_event, id) => callDaemonTasks(`/api/tasks/${id}/run-now`, { method: "POST" }));
}

module.exports = { registerTasksIpc };
