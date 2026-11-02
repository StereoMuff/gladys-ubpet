import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { CloudAuthError } from '../src/cloudApi.js';
import { normalizeConfig } from '../src/config.js';
import { Controller } from '../src/controller.js';
import { registerHandlers } from '../src/handlers.js';
import { buildDevice } from '../src/litterBox.js';

const SERIAL = 'UC20ABC1234';
const NOW = Date.now();

function fakeApi(overrides = {}) {
  const calls = [];
  const api = {
    calls,
    loginCount: 1,
    records: [{ catNickname: 'Milo', weight: 4.3, costTime: 50, eventTime: NOW - 3600_000 }],
    useTimes: { percentage: 40, boxUseTimes: 5 },
    async getDevices() {
      return [{ serialNumber: SERIAL, deviceName: 'Bathroom box' }];
    },
    async getAllConfig() {
      return { sensorSwitch: 1, lazyTime: 300 };
    },
    async getBoxUseTimes() {
      return api.useTimes;
    },
    async getDeodorantStatus() {
      return { remainingDays: 20 };
    },
    async getOnline() {
      return { online: true };
    },
    async getVisitRecords() {
      return api.records;
    },
    async resetBoxUseTimes(serial) {
      calls.push(['reset', serial]);
      api.useTimes = { percentage: 0, boxUseTimes: 0 };
    },
    async setAutoClean(...args) {
      calls.push(['autoClean', ...args]);
    },
    ...overrides,
  };
  return api;
}

class FakeSession extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.sent = [];
    this.loginCountAtConnect = 1;
  }
  async start() {}
  stop() {}
  restartSoon() {}
  hasBox() {
    return true;
  }
  publish(serial, service) {
    this.sent.push([serial, service]);
    // The box answers state requests.
    if (service === 'request_state' && this.reply)
      queueMicrotask(() => this.emit('state', serial, this.reply));
  }
}

async function setup({ created = true, api = fakeApi(), config = {} } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'ubpet-'));
  const probe = createFakeGladys();
  const device = buildDevice(probe, { serial: SERIAL, name: 'Bathroom box' });
  const gladys = createFakeGladys({
    devices: created ? [device] : [],
    config: { account: 'cat@example.com', password: 'pw', ...config },
  });
  const session = new FakeSession();
  const controller = new Controller({
    gladys,
    dataDir,
    createApi: () => api,
    createSession: () => session,
  });
  registerHandlers(gladys, controller);
  // The 'connected' handler starts the controller: wait for its first refresh.
  const started = new Promise((resolve) => {
    const original = controller.start.bind(controller);
    controller.start = async (c) => {
      await original(c);
      resolve();
    };
  });
  await gladys.connect();
  await started;
  const feature = (key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));
  const cleanup = async () => {
    await controller.stop();
    await gladys.disconnect();
    await rm(dataDir, { recursive: true, force: true });
  };
  return { gladys, controller, session, api, device, feature, dataDir, cleanup };
}

test('without credentials the integration asks for them and does nothing else', async () => {
  const gladys = createFakeGladys();
  await gladys.connect();
  const dataDir = await mkdtemp(join(tmpdir(), 'ubpet-'));
  const controller = new Controller({ gladys, dataDir, createApi: () => assert.fail('no api') });
  await controller.start(normalizeConfig({}));
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /account and password/);
  await gladys.disconnect();
  await rm(dataDir, { recursive: true, force: true });
});

test('start discovers the box and publishes its cloud states', async () => {
  const { gladys, device, cleanup, dataDir } = await setup();
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.equal(gladys.fake.discoveredDevices[0].name, 'Bathroom box');
  const id = (key) => device.features.find((f) => f.external_id.endsWith(`:${key}`)).external_id;
  assert.equal(gladys.fake.lastState(id('bin_level')), 40);
  assert.equal(gladys.fake.lastState(id('deodorant_days')), 20);
  assert.equal(gladys.fake.lastState(id('auto_clean_delay')), 5);
  assert.equal(gladys.fake.lastState(id('last_visit')), 'Milo · 4.3 kg · 50 s');
  assert.equal(gladys.fake.lastState(id('status')), 'Unknown');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.deepEqual(
    gladys.fake.transports.map((t) => t.transport),
    ['cloud'],
  );
  // An installation id was created and kept.
  const store = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'));
  assert.match(store.clientId, /^[0-9a-f]{32}$/);
  await cleanup();
});

test('live states update the switches, the status and the cat sensor', async () => {
  const { gladys, controller, feature, cleanup } = await setup();
  await controller.onWorkState(SERIAL, {
    w_mode: 2,
    w_state: 1,
    toilet_state: 0,
    foreign_state: 0,
  });
  assert.equal(gladys.fake.lastState(feature('clean').external_id), 1);
  assert.equal(gladys.fake.lastState(feature('status').external_id), 'Cleaning');
  await controller.onWorkState(SERIAL, {
    w_mode: 0,
    w_state: 0,
    toilet_state: 1,
    foreign_state: 0,
  });
  assert.equal(gladys.fake.lastState(feature('clean').external_id), 0);
  assert.equal(gladys.fake.lastState(feature('cat_inside').external_id), 1);
  assert.equal(gladys.fake.lastState(feature('status').external_id), 'Idle, cat inside');
  await cleanup();
});

test('turning cleaning on asks for the state first, then sends the command', async () => {
  const { gladys, session, device, feature, cleanup } = await setup();
  session.reply = { w_mode: 0, w_state: 0, toilet_state: 0, foreign_state: 0 };
  const ack = await gladys.fake.setValue(device, feature('clean'), 1);
  assert.equal(ack.success, true);
  assert.deepEqual(session.sent, [
    [SERIAL, 'request_state'],
    [SERIAL, 'start_clean'],
  ]);
  await cleanup();
});

test('a command is refused while a cat is inside', async () => {
  const { gladys, controller, session, device, feature, cleanup } = await setup();
  await controller.onWorkState(SERIAL, {
    w_mode: 0,
    w_state: 0,
    toilet_state: 1,
    foreign_state: 0,
  });
  const ack = await gladys.fake.setValue(device, feature('command'), 'clean');
  assert.equal(ack.success, false);
  assert.match(JSON.stringify(ack), /cat is inside/);
  assert.deepEqual(session.sent, []);
  await cleanup();
});

test('pause from the command select, bin emptied resets the counter', async () => {
  const { gladys, controller, session, api, device, feature, cleanup } = await setup();
  await controller.onWorkState(SERIAL, {
    w_mode: 3,
    w_state: 1,
    toilet_state: 0,
    foreign_state: 0,
  });
  assert.equal((await gladys.fake.setValue(device, feature('command'), 'pause')).success, true);
  assert.deepEqual(session.sent.at(-1), [SERIAL, 'pause_level']);
  assert.equal(
    (await gladys.fake.setValue(device, feature('command'), 'bin_emptied')).success,
    true,
  );
  assert.deepEqual(api.calls.at(-1), ['reset', SERIAL]);
  assert.equal(gladys.fake.lastState(feature('bin_uses').external_id), 0);
  await cleanup();
});

test('auto clean switch and delay write the cloud setting', async () => {
  const { gladys, api, device, feature, cleanup } = await setup();
  assert.equal((await gladys.fake.setValue(device, feature('auto_clean'), 0)).success, true);
  assert.deepEqual(api.calls.at(-1), ['autoClean', SERIAL, false, 300]);
  assert.equal((await gladys.fake.setValue(device, feature('auto_clean_delay'), 10)).success, true);
  assert.deepEqual(api.calls.at(-1), ['autoClean', SERIAL, false, 600]);
  assert.equal(gladys.fake.lastState(feature('auto_clean_delay').external_id), 10);
  assert.equal((await gladys.fake.setValue(device, feature('auto_clean_delay'), 0)).success, false);
  await cleanup();
});

test('new visits and a full bin fire scene events, history does not', async () => {
  const { gladys, controller, api, device, cleanup } = await setup();
  assert.equal(gladys.fake.sceneEvents.length, 0, 'the first sync only records where history ends');
  api.records = [
    { catNickname: 'Luna', weight: 3.9, costTime: 70, eventTime: NOW },
    ...api.records,
  ];
  api.useTimes = { percentage: 100, boxUseTimes: 30 };
  await controller.refresh();
  assert.deepEqual(gladys.fake.sceneEvents, [
    {
      key: 'cat_visit',
      data: { device: device.external_id, cat: 'Luna', weight: 3.9, duration: 70 },
    },
    { key: 'bin_full', data: { device: device.external_id, level: 100 } },
  ]);
  await controller.refresh();
  assert.equal(gladys.fake.sceneEvents.length, 2, 'nothing fires twice');
  await cleanup();
});

test('a blocked box fires its trigger once', async () => {
  const { gladys, controller, device, cleanup } = await setup();
  const blocked = { w_mode: 2, w_state: 2, w_cause: 7, toilet_state: 0, foreign_state: 0 };
  await controller.onWorkState(SERIAL, blocked);
  await controller.onWorkState(SERIAL, blocked);
  assert.deepEqual(gladys.fake.sceneEvents, [
    { key: 'box_blocked', data: { device: device.external_id, cause: 7 } },
  ]);
  await cleanup();
});

test('states wait for the user to create the device', async () => {
  const { gladys, controller, device, cleanup } = await setup({ created: false });
  assert.equal(gladys.fake.states.length, 0);
  await controller.onDeviceCreated(device);
  assert.ok(gladys.fake.states.length > 5);
  await cleanup();
});

test('a refused login stops and reports, a new password restarts', async () => {
  let attempts = 0;
  const api = fakeApi({
    async getDevices() {
      attempts += 1;
      throw new CloudAuthError('Wrong account or password');
    },
  });
  const { gladys, controller, cleanup } = await setup({ api });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /Wrong account or password/);
  api.getDevices = async () => [{ serialNumber: SERIAL }];
  await controller.reconfigure(normalizeConfig({ account: 'cat@example.com', password: 'new' }));
  assert.equal(attempts, 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  await cleanup();
});

test('the test action reports the boxes found', async () => {
  const { controller, cleanup } = await setup();
  const message = await controller.testConnection();
  assert.match(message.en, /1 box\(es\) found \(Bathroom box\), live link up/);
  assert.match(message.fr, /1 litière\(s\)/);
  await cleanup();
});
