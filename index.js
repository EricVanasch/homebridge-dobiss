"use strict";

const net = require("net");

const PLUGIN_NAME = "homebridge-dobiss-lan";
const PLATFORM_NAME = "DobissLAN";
const TYPE_DIMMER = "dimmer";
const TYPE_SWITCH = "switch";
const HOMEKIT_TYPE_LIGHT = "light";
const HOMEKIT_TYPE_SWITCH = "switch";
const MODULE_TYPE_SWITCH = 0x08;
const MODULE_TYPE_DIMMER = 0x10;

let Service;
let Characteristic;
let UUIDGen;

module.exports = (homebridge) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;

  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, DobissLanPlatform);
};

class DobissLanPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = new Map();

    this.host = this.config.host || "192.168.68.164";
    this.port = this.config.port || 10001;
    this.timeoutMs = this.config.timeoutMs || 1500;
    this.sendInitFrame = this.config.sendInitFrame !== false;
    this.pollIntervalSeconds = normalizePollInterval(this.config.pollIntervalSeconds, 0);
    this.startupPollDelaySeconds = normalizePollInterval(this.config.startupPollDelaySeconds, 15);
    this.logStatusPolls = this.config.logStatusPolls === true;
    this.toggleOnStatusReadFailure = this.config.toggleOnStatusReadFailure !== false;
    this.aggressiveStatusRetries = this.config.aggressiveStatusRetries === true;
    this.autoDiscover = this.config.autoDiscover === true;
    this.discoveryModules = normalizeModuleList(this.config.discoveryModules, [1, 2, 3, 4, 5]);
    this.lights = Array.isArray(this.config.lights) ? this.config.lights : [];
    this.commandQueue = Promise.resolve();
    this.startedAt = Date.now();
    this.switchAccessoriesByModule = new Map();
    this.switchModulePollTimers = new Map();
    this.switchModulePollInProgress = new Set();
    this.lastModulePollWarning = new Map();

    if (!this.config.host) {
      this.log.warn("No Dobiss host configured; using default 192.168.68.164.");
    }

    if (this.api) {
      this.api.on("didFinishLaunching", () => {
        this.discoverDevices().catch((error) => {
          this.log.warn("Dobiss discovery failed; using configured accessories only: %s", error.message);
        });
      });
    }
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  async discoverDevices() {
    const seen = new Set();
    const configuredKeys = new Set();
    const configuredOutputKeys = new Set();
    const devices = [];

    for (const light of this.lights) {
      if (!isByte(light.module) || !isByte(light.output) || !light.name) {
        this.log.warn("Skipping invalid Dobiss light config: %j", light);
        continue;
      }

      const type = light.type === TYPE_SWITCH ? TYPE_SWITCH : TYPE_DIMMER;
      const homeKitType = normalizeHomeKitType(type, light.homeKitType);
      configuredKeys.add(deviceKey(type, light.module, light.output));
      configuredOutputKeys.add(moduleOutputKey(light.module, light.output));
      devices.push({
        name: light.name,
        type,
        homeKitType,
        module: light.module,
        output: light.output,
        initialBrightness: clampBrightness(light.initialBrightness || 100),
        source: "config",
      });
    }

    if (this.autoDiscover) {
      const discovered = await this.discoverDobissDevices(configuredKeys, configuredOutputKeys);
      devices.push(...discovered);
    }

    for (const light of devices) {
      const uuid = UUIDGen.generate(`${PLUGIN_NAME}:${this.host}:${light.type}:${light.module}:${light.output}`);
      seen.add(uuid);

      let accessory = this.accessories.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(light.name, uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
        this.log.info("Registered Dobiss %s: %s (%s/%s)", light.type, light.name, light.module, light.output);
      }

      accessory.context.device = {
        name: light.name,
        type: light.type,
        homeKitType: light.homeKitType,
        module: light.module,
        output: light.output,
        initialBrightness: clampBrightness(light.initialBrightness || 100),
      };

      if (light.type === TYPE_SWITCH) {
        new DobissSwitchAccessory(this, accessory);
      } else {
        new DobissDimmerAccessory(this, accessory);
      }
    }

    for (const [uuid, accessory] of this.accessories) {
      if (!seen.has(uuid) && !this.autoDiscover) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
        this.log.info("Removed stale Dobiss accessory: %s", accessory.displayName);
      }
    }
  }

  async discoverDobissDevices(configuredKeys, configuredOutputKeys) {
    const discovered = [];

    for (const moduleId of this.discoveryModules) {
      let moduleInfo;
      try {
        moduleInfo = await this.readModuleInfo(moduleId);
      } catch (error) {
        this.log.debug("No Dobiss module info for module %s: %s", moduleId, error.message);
        continue;
      }

      if (!moduleInfo) {
        continue;
      }

      if (moduleInfo.moduleType !== MODULE_TYPE_SWITCH && moduleInfo.moduleType !== MODULE_TYPE_DIMMER) {
        this.log.debug(
          "Skipping unsupported Dobiss module %s with type 0x%s",
          moduleId,
          moduleInfo.moduleType.toString(16).padStart(2, "0"),
        );
        continue;
      }

      const type = moduleInfo.moduleType === MODULE_TYPE_DIMMER ? TYPE_DIMMER : TYPE_SWITCH;
      const outputCount = type === TYPE_DIMMER ? 4 : 12;
      let outputNames;
      try {
        outputNames = await this.readOutputNames(moduleId, moduleInfo.moduleType, outputCount);
      } catch (error) {
        this.log.warn("Could not read Dobiss output names for module %s: %s", moduleId, error.message);
        continue;
      }

      for (let output = 0; output < outputNames.length; output++) {
        const name = outputNames[output];
        if (
          !shouldAutoAddName(name)
          || configuredKeys.has(deviceKey(type, moduleId, output))
          || configuredOutputKeys.has(moduleOutputKey(moduleId, output))
        ) {
          continue;
        }

        discovered.push({
          name,
          type,
          homeKitType: HOMEKIT_TYPE_LIGHT,
          module: moduleId,
          output,
          initialBrightness: 100,
          source: "discovery",
        });
      }
    }

    if (discovered.length) {
      this.log.info("Auto-discovered %s Dobiss accessories.", discovered.length);
    }
    return discovered;
  }

  async readModuleInfo(moduleId) {
    const payload = Buffer.from([
      0xaf,
      0x10,
      0xff,
      moduleId,
      0x00,
      0x00,
      0x10,
      0x01,
      0x10,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xaf,
    ]);

    const replies = await this.enqueueCommand(() => sendDobissCommand({
      host: this.host,
      port: this.port,
      timeoutMs: this.timeoutMs,
      payload,
      initPayload: null,
      log: this.log,
      collectReplies: true,
      settleDelayMs: 120,
    }));

    return parseModuleInfoReply(replies, payload);
  }

  async readOutputNames(moduleId, moduleType, outputCount) {
    const payload = Buffer.from([
      0xaf,
      0x10,
      moduleType,
      moduleId,
      0x01,
      0x00,
      0x20,
      outputCount,
      0x20,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xaf,
    ]);

    const replies = await this.enqueueCommand(() => sendDobissCommand({
      host: this.host,
      port: this.port,
      timeoutMs: this.timeoutMs,
      payload,
      initPayload: null,
      log: this.log,
      collectReplies: true,
      settleDelayMs: 180,
    }));

    return parseOutputNameReplies(replies, payload, outputCount);
  }

  async setLevel(moduleId, outputId, level) {
    const brightness = clampBrightness(level);
    const payload = Buffer.from([
      moduleId,
      outputId,
      0x01,
      0xff,
      0xff,
      brightness,
      0xff,
      0xff,
    ]);

    const initPayload = Buffer.from([
      0xaf,
      0x02,
      0xff,
      moduleId,
      0x00,
      0x00,
      0x08,
      0x01,
      0x08,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xaf,
    ]);

    return this.enqueueCommand(() => sendDobissCommand({
      host: this.host,
      port: this.port,
      timeoutMs: this.timeoutMs,
      payload,
      initPayload: this.sendInitFrame ? initPayload : null,
      log: this.log,
    }));
  }

  async readSwitchState(moduleId, outputId) {
    const statuses = await this.readSwitchStates(moduleId);
    if (statuses.length <= outputId || statuses[outputId] === null) {
      throw new Error(`No status byte found for module ${moduleId}, output ${outputId}`);
    }
    return statuses[outputId];
  }

  async readSwitchStates(moduleId) {
    const payload = Buffer.from([
      0xaf,
      0x01,
      0x08,
      moduleId,
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xaf,
    ]);

    const initPayload = Buffer.from([
      0xaf,
      0x02,
      0xff,
      moduleId,
      0x00,
      0x00,
      0x08,
      0x01,
      0x08,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xaf,
    ]);

    const attempts = this.aggressiveStatusRetries
      ? [
        { initPayload: null, initDelayMs: 0, settleDelayMs: 1200 },
        { initPayload, initDelayMs: 650, settleDelayMs: 1800 },
        { initPayload, initDelayMs: 1200, settleDelayMs: 2800 },
      ]
      : [
        { initPayload: null, initDelayMs: 0, settleDelayMs: 700 },
      ];
    let lastReplies = [];
    for (let attempt = 0; attempt < attempts.length; attempt++) {
      const attemptConfig = attempts[attempt];
      const replies = await this.enqueueCommand(() => sendDobissCommand({
        host: this.host,
        port: this.port,
        timeoutMs: Math.max(this.timeoutMs, attemptConfig.initDelayMs + attemptConfig.settleDelayMs + 1000),
        payload,
        initPayload: attemptConfig.initPayload,
        initDelayMs: attemptConfig.initDelayMs,
        log: this.log,
        collectReplies: true,
        settleDelayMs: attemptConfig.settleDelayMs,
      }));
      lastReplies = replies;

      const statuses = parseStatusReply(replies, payload);
      if (statuses.some((status) => status !== null)) {
        return statuses;
      }

      if (attempt < attempts.length - 1) {
        await delay(400);
      }
    }

    throw new Error(`No status bytes found for module ${moduleId}; replies=${summarizeReplies(lastReplies)}`);
  }

  registerSwitchAccessory(switchAccessory) {
    const moduleId = switchAccessory.device.module;
    if (!this.switchAccessoriesByModule.has(moduleId)) {
      this.switchAccessoriesByModule.set(moduleId, new Set());
    }
    this.switchAccessoriesByModule.get(moduleId).add(switchAccessory);
    this.startSwitchModulePolling(moduleId);
  }

  startSwitchModulePolling(moduleId) {
    const intervalMs = this.pollIntervalSeconds * 1000;
    if (!intervalMs || this.switchModulePollTimers.has(moduleId)) {
      return;
    }

    const initialDelayMs = (this.startupPollDelaySeconds * 1000) + (moduleId % 10) * 750;
    const initialTimer = setTimeout(() => {
      this.pollSwitchModule(moduleId, "poll").catch((error) => this.logModulePollWarning(moduleId, error));
    }, initialDelayMs);
    if (typeof initialTimer.unref === "function") {
      initialTimer.unref();
    }

    const intervalTimer = setInterval(() => {
      this.pollSwitchModule(moduleId, "poll").catch((error) => this.logModulePollWarning(moduleId, error));
    }, intervalMs);
    if (typeof intervalTimer.unref === "function") {
      intervalTimer.unref();
    }

    this.switchModulePollTimers.set(moduleId, intervalTimer);
  }

  async pollSwitchModule(moduleId, reason) {
    if (this.isStartupPollDelayActive()) {
      return;
    }

    if (this.switchModulePollInProgress.has(moduleId)) {
      return;
    }

    this.switchModulePollInProgress.add(moduleId);
    try {
      const statuses = await this.readSwitchStates(moduleId);
      if (this.logStatusPolls) {
        this.log.info("Dobiss module %s status: %s", moduleId, formatStatusList(statuses));
      }
      const accessories = this.switchAccessoriesByModule.get(moduleId) || [];
      for (const switchAccessory of accessories) {
        const status = statuses[switchAccessory.device.output];
        if (status === true || status === false) {
          switchAccessory.updateFromModuleState(status, reason);
        }
      }
    } finally {
      this.switchModulePollInProgress.delete(moduleId);
    }
  }

  isStartupPollDelayActive() {
    return Date.now() - this.startedAt < this.startupPollDelaySeconds * 1000;
  }

  logModulePollWarning(moduleId, error) {
    const now = Date.now();
    const lastWarning = this.lastModulePollWarning.get(moduleId) || 0;
    if (now - lastWarning < 60000) {
      return;
    }
    this.lastModulePollWarning.set(moduleId, now);
    this.log.warn(
      "Could not poll Dobiss switch module %s; keeping cached states: %s",
      moduleId,
      error.message,
    );
  }

  async toggleSwitch(moduleId, outputId) {
    const payload = Buffer.from([
      moduleId,
      outputId,
      0x02,
      0xff,
      0xff,
      0x64,
      0xff,
      0xff,
    ]);

    const initPayload = Buffer.from([
      0xaf,
      0x02,
      0xff,
      moduleId,
      0x00,
      0x00,
      0x08,
      0x01,
      0x08,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xaf,
    ]);

    return this.enqueueCommand(() => sendDobissCommand({
      host: this.host,
      port: this.port,
      timeoutMs: this.timeoutMs,
      payload,
      initPayload: this.sendInitFrame ? initPayload : null,
      log: this.log,
    }));
  }

  enqueueCommand(run) {
    const next = this.commandQueue.then(run, run);
    this.commandQueue = next.catch(() => undefined).then(() => delay(80));
    return next;
  }
}

class DobissDimmerAccessory {
  constructor(platform, accessory) {
    this.platform = platform;
    this.accessory = accessory;
    this.device = accessory.context.device;
    this.isOn = false;
    this.brightness = this.device.initialBrightness;

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, "Dobiss")
      .setCharacteristic(Characteristic.Model, "Ambiance Pro DO5435")
      .setCharacteristic(Characteristic.SerialNumber, `module-${this.device.module}-output-${this.device.output}`);

    this.service = accessory.getService(Service.Lightbulb) || accessory.addService(Service.Lightbulb);
    this.service.setCharacteristic(Characteristic.Name, this.device.name);

    this.service.getCharacteristic(Characteristic.On)
      .onGet(() => this.isOn)
      .onSet((value) => this.setOn(value));

    this.service.getCharacteristic(Characteristic.Brightness)
      .onGet(() => this.brightness)
      .onSet((value) => this.setBrightness(value));
  }

  async setOn(value) {
    const nextOn = Boolean(value);
    const level = nextOn ? this.brightness || this.device.initialBrightness : 0;

    await this.platform.setLevel(this.device.module, this.device.output, level);
    this.isOn = nextOn;
    if (nextOn && level > 0) {
      this.brightness = level;
    }
  }

  async setBrightness(value) {
    const level = clampBrightness(value);

    await this.platform.setLevel(this.device.module, this.device.output, level);
    this.brightness = level;
    this.isOn = level > 0;
    this.service.updateCharacteristic(Characteristic.On, this.isOn);
  }
}

class DobissSwitchAccessory {
  constructor(platform, accessory) {
    this.platform = platform;
    this.accessory = accessory;
    this.device = accessory.context.device;
    this.isOn = Boolean(accessory.context.lastKnownOn);

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, "Dobiss")
      .setCharacteristic(Characteristic.Model, "Ambiance Pro DO5435")
      .setCharacteristic(Characteristic.SerialNumber, `module-${this.device.module}-output-${this.device.output}`);

    const serviceType = this.device.homeKitType === HOMEKIT_TYPE_LIGHT
      ? Service.Lightbulb
      : Service.Switch;
    const obsoleteServiceType = this.device.homeKitType === HOMEKIT_TYPE_LIGHT
      ? Service.Switch
      : Service.Lightbulb;
    const obsoleteService = accessory.getService(obsoleteServiceType);
    if (obsoleteService) {
      accessory.removeService(obsoleteService);
    }
    this.service = accessory.getService(serviceType) || accessory.addService(serviceType);
    this.service.setCharacteristic(Characteristic.Name, this.device.name);

    this.service.getCharacteristic(Characteristic.On)
      .onGet(() => this.getOn())
      .onSet((value) => this.setOn(value));

    this.platform.registerSwitchAccessory(this);
  }

  getOn() {
    if (this.platform.pollIntervalSeconds > 0) {
      this.platform.pollSwitchModule(this.device.module, "read")
        .catch((error) => this.platform.logModulePollWarning(this.device.module, error));
    }
    return this.isOn;
  }

  updateFromModuleState(next, reason) {
    if (next !== this.isOn) {
      this.isOn = next;
      this.accessory.context.lastKnownOn = next;
      this.service.updateCharacteristic(Characteristic.On, next);
      if (reason === "poll") {
        this.platform.log.info(
          "Dobiss switch changed outside HomeKit: %s is now %s",
          this.device.name,
          next ? "on" : "off",
        );
      }
    } else {
      this.isOn = next;
      this.accessory.context.lastKnownOn = next;
    }
  }

  async setOn(value) {
    const desired = Boolean(value);
    let current = this.isOn;
    let statusReadFailed = false;

    try {
      current = await this.platform.readSwitchState(this.device.module, this.device.output);
    } catch (error) {
      statusReadFailed = true;
      this.platform.log.warn(
        "Could not read Dobiss switch state before write for %s; using cached state=%s: %s",
        this.device.name,
        current,
        error.message,
      );
    }

    const shouldToggle = statusReadFailed && this.platform.toggleOnStatusReadFailure
      ? true
      : current !== desired;

    if (shouldToggle) {
      if (statusReadFailed && current === desired) {
        this.platform.log.warn(
          "Dobiss switch state is uncertain for %s; sending one toggle anyway because toggleOnStatusReadFailure is enabled.",
          this.device.name,
        );
      }
      await this.platform.toggleSwitch(this.device.module, this.device.output);
    }

    this.isOn = desired;
    this.accessory.context.lastKnownOn = desired;
    this.service.updateCharacteristic(Characteristic.On, desired);
    if (this.platform.pollIntervalSeconds > 0) {
      setTimeout(() => {
        this.platform.pollSwitchModule(this.device.module, "write")
          .catch((error) => this.platform.logModulePollWarning(this.device.module, error));
      }, 500);
    }
  }
}

function sendDobissCommand({
  host,
  port,
  timeoutMs,
  payload,
  initPayload,
  initDelayMs = 150,
  log,
  collectReplies = false,
  settleDelayMs = 0,
}) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ host, port });
    let settled = false;
    let commandSent = false;
    let closeTimer;
    const replies = [];

    function settle(error) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(closeTimer);
      client.end();
      if (error) {
        reject(error);
      } else {
        resolve(collectReplies ? replies : undefined);
      }
    }

    client.setTimeout(timeoutMs);

    client.on("connect", () => {
      if (initPayload) {
        log.debug("Dobiss init: %s", formatHex(initPayload));
        client.write(initPayload);
        setTimeout(() => {
          commandSent = true;
          log.debug("Dobiss command: %s", formatHex(payload));
          client.write(payload);
        }, initDelayMs);
      } else {
        commandSent = true;
        log.debug("Dobiss command: %s", formatHex(payload));
        client.write(payload);
      }

      closeTimer = setTimeout(() => settle(), timeoutMs);
    });

    client.on("data", (data) => {
      log.debug("Dobiss reply: %s", formatHex(data));
      if (collectReplies) {
        replies.push(data);
      }
      if (commandSent && data.length >= payload.length && !collectReplies) {
        settle();
      }
      if (commandSent && collectReplies && settleDelayMs > 0) {
        clearTimeout(closeTimer);
        closeTimer = setTimeout(() => settle(), settleDelayMs);
      }
    });

    client.on("timeout", () => {
      if (commandSent) {
        settle();
      } else {
        settle(new Error("Timed out before Dobiss command was sent"));
      }
    });

    client.on("error", (error) => settle(error));
  });
}

function parseStatusReply(replies, requestPayload) {
  const data = Buffer.concat(dataFramesAfterEcho(replies, requestPayload, false));
  if (!data.length) {
    return [];
  }

  const padding = data.subarray(0, 16);
  const hasPadding = data.length > 16 && padding.every((value) => value === 0xff);
  const statusBytes = hasPadding ? data.subarray(16) : data;
  return [...statusBytes].map((value) => {
    if (value === 0x00) {
      return false;
    }
    if (value === 0x01) {
      return true;
    }
    return null;
  });
}

function parseModuleInfoReply(replies, requestPayload) {
  const data = dataFramesAfterEcho(replies, requestPayload);
  for (const frame of data) {
    if (frame.length < 16 || frame[0] === 0xff) {
      continue;
    }
    const moduleType = frame[14];
    if (moduleType === MODULE_TYPE_SWITCH || moduleType === MODULE_TYPE_DIMMER) {
      return { moduleType };
    }
  }
  return null;
}

function parseOutputNameReplies(replies, requestPayload, outputCount) {
  const names = [];
  const data = dataFramesAfterEcho(replies, requestPayload);

  for (const frame of data) {
    for (let offset = 0; offset + 32 <= frame.length && names.length < outputCount; offset += 32) {
      const record = frame.subarray(offset, offset + 32);
      if (record.every((value) => value === 0xff)) {
        continue;
      }
      names.push(decodeDobissName(record));
    }
  }

  return names;
}

function dataFramesAfterEcho(replies, requestPayload, useRepliesWithoutEcho = true) {
  const frames = [];
  let sawEcho = false;

  for (const reply of replies) {
    if (!sawEcho) {
      const index = reply.indexOf(requestPayload);
      if (index !== -1) {
        sawEcho = true;
        const afterEcho = reply.subarray(index + requestPayload.length);
        if (afterEcho.length) {
          frames.push(afterEcho);
        }
      }
      continue;
    }

    frames.push(reply);
  }

  return sawEcho ? frames : (useRepliesWithoutEcho ? replies : []);
}

function decodeDobissName(record) {
  return record
    .subarray(0, 30)
    .toString("latin1")
    .replace(/\0/g, "")
    .trim();
}

function shouldAutoAddName(name) {
  if (!name) {
    return false;
  }
  const normalized = name.trim().toLowerCase();
  if (!normalized || normalized === "reserve") {
    return false;
  }
  return !/^uitgang\s+\d+/i.test(name);
}

function deviceKey(type, moduleId, outputId) {
  return `${type}:${moduleId}:${outputId}`;
}

function moduleOutputKey(moduleId, outputId) {
  return `${moduleId}:${outputId}`;
}

function normalizeHomeKitType(type, value) {
  if (type === TYPE_DIMMER) {
    return HOMEKIT_TYPE_LIGHT;
  }
  return value === HOMEKIT_TYPE_LIGHT ? HOMEKIT_TYPE_LIGHT : HOMEKIT_TYPE_SWITCH;
}

function isByte(value) {
  return Number.isInteger(value) && value >= 0 && value <= 255;
}

function clampBrightness(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 100;
  }
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function normalizePollInterval(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.round(parsed));
}

function normalizeModuleList(value, fallback) {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const modules = value
    .map((moduleId) => Number(moduleId))
    .filter((moduleId) => isByte(moduleId));
  return modules.length ? [...new Set(modules)] : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatHex(buffer) {
  return buffer.toString("hex").match(/../g).join(" ");
}

function summarizeReplies(replies) {
  if (!replies.length) {
    return "none";
  }
  return replies
    .slice(0, 4)
    .map((reply) => formatHex(reply).slice(0, 160))
    .join(" | ");
}

function formatStatusList(statuses) {
  return statuses
    .slice(0, 12)
    .map((status, index) => {
      if (status === true) {
        return `${index}=on`;
      }
      if (status === false) {
        return `${index}=off`;
      }
      return `${index}=?`;
    })
    .join(" ");
}
