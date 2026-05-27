"use strict";

const { CloudEvent } = require("../../shared/cloud-events.js");
const { buildInvocation } = require("./fellow-invocation.js");

function createMainFellowRuntimeDispatcher({
  shouldHandle = () => true,
  listFellows = () => [],
  localFellowResponder,
  mainGroupConductor,
  mainFellowConversationResponder,
  log = () => {}
} = {}) {
  function canHandle() {
    return typeof shouldHandle === "function" ? Boolean(shouldHandle()) : true;
  }

  async function invokeFellow(args = {}) {
    const runtimeKind = String(args.runtimeKind || "desktop-local").trim() || "desktop-local";
    if (runtimeKind !== "desktop-local") return false;
    if (!localFellowResponder || typeof localFellowResponder.respond !== "function") return false;
    return Boolean(await localFellowResponder.respond(args));
  }

  async function handleFellowInvocationRequested(message = {}) {
    if (!canHandle()) return false;
    const args = buildInvocation(message, listFellows());
    if (!args) return false;
    return invokeFellow(args);
  }

  async function handleConversationMessageAppended(message = {}) {
    if (!canHandle()) return false;
    const args = {
      conversationId: message.conversationId || message.conversation_id,
      message: message.message
    };
    const tasks = [];
    if (mainGroupConductor && typeof mainGroupConductor.handleConversationMessageAppended === "function") {
      tasks.push(
        mainGroupConductor.handleConversationMessageAppended(args)
          .catch((error) => log(`Cloud group conductor failed: ${error?.message || error}`))
      );
    }
    if (mainFellowConversationResponder && typeof mainFellowConversationResponder.handleConversationMessageAppended === "function") {
      tasks.push(
        mainFellowConversationResponder.handleConversationMessageAppended(args)
          .catch((error) => log(`Cloud fellow conversation responder failed: ${error?.message || error}`))
      );
    }
    await Promise.all(tasks);
    return tasks.length > 0;
  }

  async function handleCloudEvent(message = {}) {
    if (message.type === CloudEvent.ConversationFellowInvocationRequested) {
      try {
        return await handleFellowInvocationRequested(message);
      } catch (error) {
        log(`Cloud fellow invocation failed: ${error?.message || error}`);
        return false;
      }
    }
    if (message.type === CloudEvent.ConversationMessageAppended) {
      return handleConversationMessageAppended(message);
    }
    return false;
  }

  return {
    invokeFellow,
    handleCloudEvent,
    handleFellowInvocationRequested,
    handleConversationMessageAppended
  };
}

module.exports = { createMainFellowRuntimeDispatcher };
