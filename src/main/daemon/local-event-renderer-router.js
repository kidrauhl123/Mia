"use strict";

function rendererChannelForLocalEvent(envelope = {}, channels = {}) {
  if (String(envelope?.type || "") === "chat:event") {
    return channels.ChatEvent;
  }
  return channels.CloudEvent;
}

module.exports = {
  rendererChannelForLocalEvent
};
