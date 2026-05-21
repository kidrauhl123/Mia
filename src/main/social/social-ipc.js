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
  ipcMain.handle("social:send-friend-request", safeCall((toUsername) => socialApi.sendFriendRequest(toUsername)));
  ipcMain.handle("social:respond-friend-request", safeCall((requestId, action) => socialApi.respondFriendRequest(requestId, action)));
  ipcMain.handle("social:cancel-friend-request", safeCall((requestId) => socialApi.cancelFriendRequest(requestId)));
  ipcMain.handle("social:list-friend-requests", safeCall((direction) => socialApi.listFriendRequests(direction)));
  ipcMain.handle("social:list-friends", safeCall(() => socialApi.listFriends()));
  ipcMain.handle("social:remove-friend", safeCall((userId) => socialApi.removeFriend(userId)));
  ipcMain.handle("social:list-rooms", safeCall(() => socialApi.listRooms()));
  ipcMain.handle("social:get-room", safeCall((roomId) => socialApi.getRoom(roomId)));
  ipcMain.handle("social:list-room-messages", safeCall((roomId, sinceSeq, limit) => socialApi.listRoomMessages(roomId, sinceSeq, limit)));
  ipcMain.handle("social:post-room-message", safeCall((roomId, body) => socialApi.postRoomMessage(roomId, body)));
  ipcMain.handle("social:create-room", safeCall((payload) => socialApi.createRoom(payload)));
  ipcMain.handle("social:add-room-member", safeCall((roomId, member) => socialApi.addRoomMember(roomId, member)));
  ipcMain.handle("social:post-message-as-fellow", safeCall((roomId, body) => socialApi.postRoomMessageAsFellow(roomId, body)));
}

module.exports = { registerSocialIpc };
