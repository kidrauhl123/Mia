const { IpcChannel } = require("../../shared/ipc-channels");
const { CloudEvent } = require("../../shared/cloud-events.js");
const { SenderKind } = require("../../shared/conversation-kinds.js");

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

function dispatchPostedConversationMessage({ conversationId, result, fellowRuntimeDispatcher, log = () => {} }) {
  const message = result?.message || result?.data?.message || null;
  if (!conversationId || !message?.id || message.sender_kind !== SenderKind.User) return;
  const promise = fellowRuntimeDispatcher?.handleCloudEvent?.({
    type: CloudEvent.ConversationMessageAppended,
    conversationId,
    message
  });
  promise?.catch?.((error) => log(`Cloud conversation AI dispatch after post failed: ${error?.message || error}`));
}

function registerSocialIpc({ ipcMain, socialApi, fellowRuntimeDispatcher = null, log = () => {} }) {
  ipcMain.handle(IpcChannel.SocialSendFriendRequest, safeCall((toUsername) => socialApi.sendFriendRequest(toUsername)));
  ipcMain.handle(IpcChannel.SocialRespondFriendRequest, safeCall((requestId, action) => socialApi.respondFriendRequest(requestId, action)));
  ipcMain.handle(IpcChannel.SocialCancelFriendRequest, safeCall((requestId) => socialApi.cancelFriendRequest(requestId)));
  ipcMain.handle(IpcChannel.SocialListFriendRequests, safeCall((direction) => socialApi.listFriendRequests(direction)));
  ipcMain.handle(IpcChannel.SocialListFriends, safeCall(() => socialApi.listFriends()));
  ipcMain.handle(IpcChannel.SocialRemoveFriend, safeCall((userId) => socialApi.removeFriend(userId)));
  ipcMain.handle(IpcChannel.SocialListConversations, safeCall(() => socialApi.listConversations()));
  ipcMain.handle(IpcChannel.SocialListFellows, safeCall(() => socialApi.listFellows()));
  ipcMain.handle(IpcChannel.SocialSaveFellowIdentity, safeCall((fellowId, body) => socialApi.saveFellowIdentity(fellowId, body)));
  ipcMain.handle(IpcChannel.SocialDeleteFellow, safeCall((fellowId) => socialApi.deleteFellow(fellowId)));
  ipcMain.handle(IpcChannel.SocialListPlatformModels, safeCall(() => socialApi.listPlatformModels()));
  ipcMain.handle(IpcChannel.SocialGetConversation, safeCall((conversationId) => socialApi.getConversation(conversationId)));
  ipcMain.handle(IpcChannel.SocialListConversationMessages, safeCall((conversationId, sinceSeq, limit) => socialApi.listConversationMessages(conversationId, sinceSeq, limit)));
  ipcMain.handle(IpcChannel.SocialPostConversationMessage, safeCall(async (conversationId, body) => {
    const result = await socialApi.postConversationMessage(conversationId, body);
    dispatchPostedConversationMessage({ conversationId, result, fellowRuntimeDispatcher, log });
    return result;
  }));
  ipcMain.handle(IpcChannel.SocialDeleteConversationMessage, safeCall((conversationId, messageId) => socialApi.deleteConversationMessage(conversationId, messageId)));
  ipcMain.handle(IpcChannel.SocialCreateConversation, safeCall((payload) => socialApi.createConversation(payload)));
  ipcMain.handle(IpcChannel.SocialEnsureFellowConversation, safeCall((fellowId, body) => socialApi.ensureFellowConversation(fellowId, body)));
  ipcMain.handle(IpcChannel.SocialEnsureFellowSessionConversation, safeCall((sessionId, body) => socialApi.ensureFellowSessionConversation(sessionId, body)));
  ipcMain.handle(IpcChannel.SocialGetFellowRuntime, safeCall((fellowId, runtimeKind) => socialApi.getFellowRuntime(fellowId, runtimeKind)));
  ipcMain.handle(IpcChannel.SocialSaveFellowRuntime, safeCall((fellowId, body) => socialApi.saveFellowRuntime(fellowId, body)));
  ipcMain.handle(IpcChannel.SocialUpdateConversation, safeCall((conversationId, patch) => socialApi.updateConversation(conversationId, patch)));
  ipcMain.handle(IpcChannel.SocialDeleteConversation, safeCall((conversationId) => socialApi.deleteConversation(conversationId)));
  ipcMain.handle(IpcChannel.SocialAddConversationMember, safeCall((conversationId, member) => socialApi.addConversationMember(conversationId, member)));
  ipcMain.handle(IpcChannel.SocialRemoveConversationMember, safeCall((conversationId, member) => socialApi.removeConversationMember(conversationId, member)));
}

module.exports = { registerSocialIpc };
