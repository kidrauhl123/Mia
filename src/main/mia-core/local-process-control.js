"use strict";

const {
  createDaemonControlServer,
  daemonNeedsReplacement,
  shouldReuseDaemon
} = require("../daemon/control-server.js");
const { createDaemonTasksClient } = require("../daemon/tasks-client.js");
const { createLocalEventsClient } = require("../daemon/local-events-client.js");
const { createDaemonProcessLauncher } = require("../daemon/process-launcher.js");

module.exports = {
  createMiaCoreControlServer: createDaemonControlServer,
  createMiaCoreTasksClient: createDaemonTasksClient,
  createMiaCoreLocalEventsClient: createLocalEventsClient,
  createMiaCoreProcessLauncher: createDaemonProcessLauncher,
  coreNeedsReplacement: daemonNeedsReplacement,
  shouldReuseCore: shouldReuseDaemon
};
