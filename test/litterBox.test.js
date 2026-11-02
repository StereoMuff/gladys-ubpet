import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  COMMANDS,
  CommandError,
  assertSafeToMove,
  binFull,
  buildDevice,
  describeVisit,
  featureKey,
  newVisits,
  planCommand,
  snapshotStates,
  statusText,
  workStates,
} from '../src/litterBox.js';

const IDLE = { w_mode: 0, w_state: 0, toilet_state: 0, foreign_state: 0 };
const CLEANING = { ...IDLE, w_mode: 2, w_state: 1 };
const CLEAN_PAUSED = { ...IDLE, w_mode: 2, w_state: 3 };
const LEVELLING = { ...IDLE, w_mode: 3, w_state: 1 };
const LEVEL_PAUSED = { ...IDLE, w_mode: 3, w_state: 3 };

const box = {
  serial: 'UC20ABC1234',
  name: 'Litter box',
  config: { boxFunctionVOList: [{ firmwareVersion: '1.2.3' }] },
};

test('Gladys accepts the discovery payload', async () => {
  const gladys = createFakeGladys();
  await gladys.publishDiscoveredDevices([buildDevice(gladys, box)]);
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.external_id, 'ext:test-integration:litterbox:UC20ABC1234');
  assert.ok(device.params.some((p) => p.name === 'SERIAL_NUMBER' && p.value === box.serial));
  assert.ok(device.params.some((p) => p.name === 'FIRMWARE' && p.value === '1.2.3'));
});

test('feature keys are unique and option labels are plain strings (core requirement)', () => {
  const gladys = createFakeGladys();
  const device = buildDevice(gladys, box);
  const keys = device.features.map((f) => featureKey(f.external_id));
  assert.equal(new Set(keys).size, keys.length);
  const command = device.features.find((f) => featureKey(f.external_id) === 'command');
  assert.deepEqual(
    command.supported_options.map((o) => o.value),
    COMMANDS,
  );
  for (const option of command.supported_options) assert.equal(typeof option.label, 'string');
});

test('status text follows mode and state', () => {
  assert.equal(statusText(IDLE), 'Idle');
  assert.equal(statusText({ ...IDLE, toilet_state: 1 }), 'Idle, cat inside');
  assert.equal(statusText(CLEANING), 'Cleaning');
  assert.equal(statusText(CLEAN_PAUSED), 'Cleaning, paused');
  assert.equal(statusText({ ...CLEANING, w_state: 2 }), 'Cleaning, blocked');
  assert.equal(statusText(CLEANING, false), 'Offline');
  assert.equal(statusText(null), 'Unknown');
});

test('work states drive the switches and the cat sensor', () => {
  assert.deepEqual(workStates(CLEANING), {
    status: { text: 'Cleaning' },
    clean: 1,
    level: 0,
    cat_inside: 0,
  });
  assert.equal(workStates(CLEAN_PAUSED).clean, 0);
  assert.equal(workStates(LEVELLING).level, 1);
  assert.equal(workStates({ ...IDLE, toilet_state: 1 }).cat_inside, 1);
  assert.deepEqual(workStates(null), { status: { text: 'Unknown' } });
});

test('switches start, resume and pause the right job', () => {
  assert.deepEqual(planCommand('clean', 1, IDLE), { service: 'start_clean' });
  assert.deepEqual(planCommand('clean', 1, CLEAN_PAUSED), { service: 'resume_clean' });
  assert.deepEqual(planCommand('clean', 1, CLEANING), { noop: true });
  assert.deepEqual(planCommand('clean', 0, CLEANING), { service: 'pause_clean' });
  assert.deepEqual(planCommand('clean', 0, IDLE), { noop: true });
  assert.deepEqual(planCommand('level', 1, IDLE), { service: 'start_level' });
  assert.deepEqual(planCommand('level', 0, LEVELLING), { service: 'pause_level' });
  assert.throws(() => planCommand('clean', 1, LEVELLING), CommandError);
});

test('the command select covers every operation', () => {
  assert.deepEqual(planCommand('command', 'clean', IDLE), { service: 'start_clean' });
  assert.deepEqual(planCommand('command', 'level', LEVEL_PAUSED), { service: 'resume_level' });
  assert.deepEqual(planCommand('command', 'pause', LEVELLING), { service: 'pause_level' });
  assert.deepEqual(planCommand('command', 'resume', CLEAN_PAUSED), { service: 'resume_clean' });
  assert.deepEqual(planCommand('command', 'bin_emptied', CLEANING), { rest: 'reset_bin' });
  assert.deepEqual(planCommand('command', 'refresh', null), { rest: 'refresh' });
  assert.throws(() => planCommand('command', 'pause', IDLE), /Nothing to pause/);
  assert.throws(() => planCommand('command', 'resume', CLEANING), /Nothing to resume/);
  assert.throws(() => planCommand('command', 'explode', IDLE), CommandError);
  assert.throws(() => planCommand('status', 1, IDLE), CommandError);
});

test('movement is refused with a cat inside, near, or an unknown state', () => {
  assert.doesNotThrow(() => assertSafeToMove('start_clean', IDLE));
  assert.throws(() => assertSafeToMove('start_clean', { ...IDLE, toilet_state: 1 }), /inside/);
  assert.throws(
    () => assertSafeToMove('resume_level', { ...LEVEL_PAUSED, foreign_state: 1 }),
    /near/,
  );
  assert.throws(() => assertSafeToMove('start_clean', null), /unknown/);
  // Pausing is always allowed: it stops movement.
  assert.doesNotThrow(() => assertSafeToMove('pause_clean', { ...CLEANING, toilet_state: 1 }));
});

test('snapshot states come from the REST data', () => {
  const now = Date.UTC(2026, 10, 2, 12);
  const records = [
    { catNickname: 'Milo', weight: 4.26, costTime: 52.4, eventTime: now - 3600_000 },
    { catNickname: 'Luna', weight: 3.9, costTime: 80, eventTime: now - 2 * 3600_000 },
    { catNickname: 'Milo', weight: 4.2, costTime: 40, eventTime: now - 30 * 3600_000 },
  ];
  const states = snapshotStates(
    {
      useTimes: { percentage: 42, boxUseTimes: 7 },
      deodorant: { remainingDays: 12 },
      config: { sensorSwitch: 1, lazyTime: 480 },
      records,
    },
    now,
  );
  assert.deepEqual(states, {
    bin_level: 42,
    bin_uses: 7,
    deodorant_days: 12,
    auto_clean: 1,
    auto_clean_delay: 8,
    visits_24h: 2,
    last_visit_duration: 52,
    last_visit: { text: 'Milo · 4.3 kg · 52 s' },
  });
  assert.deepEqual(snapshotStates({}), {});
});

test('visit helpers', () => {
  assert.equal(describeVisit({ costTime: 10 }), 'Unknown cat · 10 s');
  const t = 1_780_000_000_000;
  const records = [
    { eventTime: t + 3 },
    { eventTime: t + 1 },
    { eventTime: t + 2 },
    { eventTime: 'x' },
  ];
  assert.deepEqual(
    newVisits(records, t + 1).map((r) => r.eventTime),
    [t + 2, t + 3],
  );
  // Second-resolution timestamps are accepted too.
  assert.equal(newVisits([{ eventTime: 1_780_000_000 }], t - 1).length, 1);
  assert.equal(binFull({ percentage: 100 }), true);
  assert.equal(binFull({ percentage: 99 }), false);
  assert.equal(binFull({}), false);
});
