"use strict";

const assert = require("assert");
const registerPlugin = require("./index");

class FakeService {
  constructor(type) {
    this.type = type;
  }

  setCharacteristic() {
    return this;
  }

  getCharacteristic() {
    return {
      onGet() {
        return this;
      },
      onSet() {
        return this;
      },
    };
  }

  updateCharacteristic() {}
}

class FakeAccessory {
  constructor(name, uuid) {
    this.displayName = name;
    this.UUID = uuid;
    this.context = {};
    this.services = new Map([[Service.AccessoryInformation, new FakeService(Service.AccessoryInformation)]]);
  }

  getService(type) {
    return this.services.get(type);
  }

  addService(type) {
    const service = new FakeService(type);
    this.services.set(type, service);
    return service;
  }

  removeService(service) {
    this.services.delete(service.type);
  }
}

const Service = {
  AccessoryInformation: "AccessoryInformation",
  Lightbulb: "Lightbulb",
  Switch: "Switch",
};

const Characteristic = {
  Manufacturer: "Manufacturer",
  Model: "Model",
  SerialNumber: "SerialNumber",
  Name: "Name",
  On: "On",
  Brightness: "Brightness",
};

let DobissLanPlatform;
registerPlugin({
  hap: {
    Service,
    Characteristic,
    uuid: { generate: (value) => value },
  },
  registerPlatform(pluginName, platformName, platformClass) {
    DobissLanPlatform = platformClass;
  },
});

function createPlatform(light) {
  const api = {
    platformAccessory: FakeAccessory,
    on() {},
    registerPlatformAccessories() {},
    unregisterPlatformAccessories() {},
  };
  const log = {
    info() {},
    warn() {},
    debug() {},
  };
  return new DobissLanPlatform(log, {
    host: "192.0.2.1",
    pollIntervalSeconds: 0,
    lights: [light],
  }, api);
}

async function testDefaultSwitchOutputBecomesLight() {
  const light = { name: "Kitchen", type: "switch", module: 3, output: 0 };
  const platform = createPlatform(light);
  const uuid = "homebridge-dobiss-lan:192.0.2.1:switch:3:0";
  const accessory = new FakeAccessory(light.name, uuid);
  accessory.addService(Service.Switch);
  platform.configureAccessory(accessory);

  await platform.discoverDevices();

  assert(accessory.getService(Service.Lightbulb), "default switch output should have a Lightbulb service");
  assert.strictEqual(accessory.getService(Service.Switch), undefined, "obsolete Switch service should be removed");
  assert.strictEqual(accessory.context.device.type, "switch");
  assert.strictEqual(accessory.context.device.homeKitType, "light");
}

async function testExplicitSwitchPresentationIsPreserved() {
  const light = {
    name: "Pump",
    type: "switch",
    homeKitType: "switch",
    module: 3,
    output: 1,
  };
  const platform = createPlatform(light);

  await platform.discoverDevices();

  const uuid = "homebridge-dobiss-lan:192.0.2.1:switch:3:1";
  const accessory = platform.accessories.get(uuid);
  assert(accessory.getService(Service.Switch), "explicit switch output should have a Switch service");
  assert.strictEqual(accessory.getService(Service.Lightbulb), undefined);
  assert.strictEqual(accessory.context.device.homeKitType, "switch");
}

Promise.resolve()
  .then(testDefaultSwitchOutputBecomesLight)
  .then(testExplicitSwitchPresentationIsPreserved)
  .then(() => console.log("All tests passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

