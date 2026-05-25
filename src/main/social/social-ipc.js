const { IpcChannel } = require("../../shared/ipc-channels");

function safeCall(fn) {
  return async (_event, ...args) => {
    try {
      const data = await fn(...args);
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: String(error?.message || error), status: error?.status || 500 };
    }
  };
}

function registerSocialIpc({ ipcMain, socialApi }) {
  ipcMain.handle(IpcChannel.SocialSendFriendRequest, safeCall((toUsername) => socialApi.sendFriendRequest(toUsername)));
  ipcMain.handle(IpcChannel.SocialRespondFriendRequest, safeCall((requestId, action) => socialApi.respondFriendRequest(requestId, action)));
  ipcMain.handle(IpcChannel.SocialCancelFriendRequest, safeCall((requestId) => socialApi.cancelFriendRequest(requestId)));
  ipcMain.handle(IpcChannel.SocialListFriendRequests, safeCall((direction) => socialApi.listFriendRequests(direction)));
  ipcMain.handle(IpcChannel.SocialListFriends, safeCall(() => socialApi.listFriends()));
  ipcMain.handle(IpcChannel.SocialRemoveFriend, safeCall((userId) => socialApi.removeFriend(userId)));
  ipcMain.handle(IpcChannel.SocialListRooms, safeCall(() => socialApi.listRooms()));
  ipcMain.handle(IpcChannel.SocialGetRoom, safeCall((roomId) => socialApi.getRoom(roomId)));
  ipcMain.handle(IpcChannel.SocialListRoomMessages, safeCall((roomId, sinceSeq, limit) => socialApi.listRoomMessages(roomId, sinceSeq, limit)));
  ipcMain.handle(IpcChannel.SocialPostRoomMessage, safeCall((roomId, body) => socialApi.postRoomMessage(roomId, body)));
  ipcMain.handle(IpcChannel.SocialDeleteRoomMessage, safeCall((roomId, messageId) => socialApi.deleteRoomMessage(roomId, messageId)));
  ipcMain.handle(IpcChannel.SocialCreateRoom, safeCall((payload) => socialApi.createRoom(payload)));
  ipcMain.handle(IpcChannel.SocialEnsureFellowRoom, safeCall((fellowId, body) => socialApi.ensureFellowRoom(fellowId, body)));
  ipcMain.handle(IpcChannel.SocialUpdateRoom, safeCall((roomId, patch) => socialApi.updateRoom(roomId, patch)));
  ipcMain.handle(IpcChannel.SocialDeleteRoom, safeCall((roomId) => socialApi.deleteRoom(roomId)));
  ipcMain.handle(IpcChannel.SocialAddRoomMember, safeCall((roomId, member) => socialApi.addRoomMember(roomId, member)));
  ipcMain.handle(IpcChannel.SocialRemoveRoomMember, safeCall((roomId, member) => socialApi.removeRoomMember(roomId, member)));
  ipcMain.handle(IpcChannel.SocialPostMessageAsFellow, safeCall((roomId, body) => socialApi.postRoomMessageAsFellow(roomId, body)));
}

module.exports = { registerSocialIpc };
