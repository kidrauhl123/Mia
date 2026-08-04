"use strict";

function firstText(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function agentId(value) {
  const id = firstText(value).toLowerCase().replace(/_/g, "-");
  if (["claude", "claude-code"].includes(id)) return "claude-code";
  if (["codex", "openai-codex"].includes(id)) return "codex";
  return id === "hermes" ? "hermes" : "";
}

function compactBot(bot = {}) {
  const source = objectValue(bot);
  const intent = objectValue(source.targetIntent || source.target_intent || source.runtimeTarget || source.runtime_target);
  const config = objectValue(source.runtimeConfig || source.runtime_config || source.config);
  return {
    key: firstText(source.key),
    id: firstText(source.id),
    runtimeKind: firstText(source.runtimeKind, source.runtime_kind, source.sourceKind),
    agentEngine: firstText(source.agentEngine, source.agent_engine, source.engine),
    targetIntent: {
      runtimeKind: firstText(intent.runtimeKind, intent.runtime_kind),
      deviceId: firstText(intent.deviceId, intent.device_id),
      deviceName: firstText(intent.deviceName, intent.device_name),
      agentEngine: firstText(intent.agentEngine, intent.agent_engine, intent.engine)
    },
    targetDeviceId: firstText(source.targetDeviceId, source.target_device_id, source.deviceId, source.device_id),
    targetDeviceName: firstText(source.targetDeviceName, source.target_device_name, source.deviceName, source.device_name),
    runtimeStatus: firstText(source.runtimeStatus, source.runtime_status),
    runtimeLabel: firstText(source.runtimeLabel, source.runtime_label),
    runtimeConfig: {
      runtimeKind: firstText(config.runtimeKind, config.runtime_kind),
      deviceId: firstText(config.deviceId, config.device_id),
      deviceName: firstText(config.deviceName, config.device_name),
      agentEngine: firstText(config.agentEngine, config.agent_engine, config.engine)
    }
  };
}

function compactRuntime(runtime = {}) {
  const source = objectValue(runtime);
  const cloud = objectValue(source.cloud);
  const cloudAgent = objectValue(cloud.agentRuntime || cloud.agent_runtime || cloud.cloudAgent || cloud.cloud_agent || cloud.agent);
  const localDevice = objectValue(source.localDevice || source.local_device);
  const inventory = Array.isArray(source.agentInventory?.agents) ? source.agentInventory.agents : [];
  const statuses = objectValue(source.agentEngines);
  const projectStatus = (value) => {
    const status = objectValue(value);
    return {
      available: Boolean(status.available),
      installed: Boolean(status.installed),
      running: Boolean(status.running)
    };
  };
  const rawDevices = [cloud.devices, cloud.bridgeDevices, cloud.bridge_devices].find(Array.isArray) || [];
  return {
    cloud: {
      enabled: Boolean(cloud.enabled),
      deviceId: firstText(cloud.deviceId, cloud.device_id),
      deviceName: firstText(cloud.deviceName, cloud.device_name),
      agentRuntime: {
        runtimeKind: firstText(cloudAgent.runtimeKind, cloudAgent.runtime_kind, cloudAgent.kind),
        agentEngine: firstText(cloudAgent.agentEngine, cloudAgent.agent_engine, cloudAgent.engine, cloudAgent.defaultAgentEngine),
        available: cloudAgent.available !== false
      },
      devices: rawDevices.map((device) => {
        const item = objectValue(device);
        return {
          id: firstText(item.id, item.deviceId, item.device_id),
          deviceName: firstText(item.deviceName, item.device_name, item.name, item.targetDeviceName),
          status: firstText(item.status)
        };
      })
    },
    localDevice: {
      id: firstText(localDevice.id),
      name: firstText(localDevice.name, localDevice.deviceName, localDevice.device_name, localDevice.hostname)
    },
    agentInventory: {
      agents: inventory.map((agent) => {
        const item = objectValue(agent);
        return {
          id: agentId(firstText(item.id, item.engine)),
          usableInMia: Boolean(item.usableInMia ?? item.usable_in_mia)
        };
      }).filter((agent) => agent.id)
    },
    agentEngines: {
      hermes: projectStatus(statuses.hermes),
      claudeCode: projectStatus(statuses.claudeCode || statuses["claude-code"]),
      codex: projectStatus(statuses.codex)
    },
    engineInstalled: Boolean(source.engineInstalled),
    engineRunning: Boolean(source.engineRunning),
    preferredAgentEngine: firstText(source.preferredAgentEngine)
  };
}

function compactEngineCapabilities(engineCapabilities = {}) {
  const source = objectValue(engineCapabilities);
  const engines = objectValue(source.engines);
  const project = (value) => {
    const capability = objectValue(value);
    const result = { available: Boolean(capability.available) };
    for (const key of ["models", "permissionOptions", "permissionProfiles", "permissionModes", "effortLevels"]) {
      if (Array.isArray(capability[key]) && capability[key].length) result[key] = [true];
    }
    return result;
  };
  return {
    engines: {
      hermes: project(engines.hermes),
      "claude-code": project(engines["claude-code"] || engines.claudeCode),
      codex: project(engines.codex)
    }
  };
}

function compactRuntimeTargetRequest(input = {}) {
  const request = objectValue(input);
  return {
    bot: compactBot(request.bot),
    runtime: compactRuntime(request.runtime),
    engineCapabilities: compactEngineCapabilities(request.engineCapabilities || request.engine_capabilities),
    preferredAgentEngine: firstText(request.preferredAgentEngine, request.preferred_agent_engine)
  };
}

module.exports = {
  compactRuntimeTargetRequest
};
