// -----------------------------------------------------------------------------
// The litter box as a Gladys device: features, state mapping, commands.
//
// Pure functions only (no I/O), so they are fully unit-tested. Feature keys
// are part of the external ids and therefore forever: never rename one.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { SERVICES, WORK_MODES, WORK_STATES, petPosition } from './protocol.js';

export const DEVICE_TYPE = 'litterbox';

export const COMMANDS = ['clean', 'level', 'pause', 'resume', 'bin_emptied', 'refresh'];
const COMMAND_LABELS = {
  clean: 'Clean now',
  level: 'Level the litter',
  pause: 'Pause',
  resume: 'Resume',
  bin_emptied: 'Waste bin emptied',
  refresh: 'Refresh state',
};

const feature = (ids, key, name, category, type, extra = {}) => ({
  name,
  external_id: ids.feature(key),
  category,
  type,
  min: 0,
  max: 1,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...extra,
});

/** Discovery payload of one box. */
export function buildDevice(gladys, box) {
  const ids = gladys.externalIds(DEVICE_TYPE, box.serial);
  const firmware = firmwareVersion(box.config);
  return {
    name: box.name,
    external_id: ids.device,
    params: [
      { name: 'SERIAL_NUMBER', value: box.serial },
      ...(firmware ? [{ name: 'FIRMWARE', value: firmware }] : []),
    ],
    features: [
      feature(ids, 'clean', 'Cleaning', C.SWITCH, T.SWITCH.BINARY, {
        read_only: false,
        has_feedback: true,
      }),
      feature(ids, 'level', 'Levelling', C.SWITCH, T.SWITCH.BINARY, {
        read_only: false,
        has_feedback: true,
      }),
      feature(ids, 'command', 'Command', C.TEXT, T.TEXT.SELECT, {
        max: 0,
        read_only: false,
        keep_history: false,
        supported_options: COMMANDS.map((value, index) => ({
          value,
          label: COMMAND_LABELS[value],
          sort_order: index + 1,
        })),
      }),
      feature(ids, 'status', 'Status', C.TEXT, T.TEXT.TEXT, { max: 0, keep_history: false }),
      feature(ids, 'cat_inside', 'Cat inside', C.MOTION_SENSOR, T.SENSOR.BINARY),
      feature(
        ids,
        'bin_level',
        'Waste bin level',
        C.LEVEL_SENSOR,
        T.LEVEL_SENSOR.LIQUID_LEVEL_PERCENT,
        {
          unit: U.PERCENT,
          max: 100,
        },
      ),
      feature(ids, 'bin_uses', 'Uses since bin emptied', C.COUNTER_SENSOR, T.SENSOR.INTEGER, {
        max: 1000,
      }),
      feature(ids, 'visits_24h', 'Visits in the last 24 h', C.COUNTER_SENSOR, T.SENSOR.INTEGER, {
        max: 100,
      }),
      feature(ids, 'last_visit_duration', 'Last visit duration', C.DURATION, T.DURATION.INTEGER, {
        unit: U.SECONDS,
        max: 3600,
      }),
      feature(ids, 'last_visit', 'Last visit', C.TEXT, T.TEXT.TEXT, {
        max: 0,
        keep_history: false,
      }),
      feature(ids, 'deodorant_days', 'Deodorant remaining', C.DURATION, T.DURATION.INTEGER, {
        unit: U.DAYS,
        max: 365,
      }),
      feature(ids, 'auto_clean', 'Auto clean after use', C.SWITCH, T.SWITCH.BINARY, {
        read_only: false,
        has_feedback: true,
        keep_history: false,
      }),
      feature(ids, 'auto_clean_delay', 'Auto clean delay', C.DURATION, T.DURATION.INTEGER, {
        unit: U.MINUTES,
        min: 1,
        max: 60,
        read_only: false,
        has_feedback: true,
        keep_history: false,
      }),
    ],
  };
}

/** Feature key of a feature external id ("ext:sel:litterbox:SN:clean" -> "clean"). */
export function featureKey(externalId) {
  return externalId.slice(externalId.lastIndexOf(':') + 1);
}

export function firmwareVersion(config) {
  const versions = new Set(
    (config?.boxFunctionVOList ?? []).map((part) => part?.firmwareVersion).filter(Boolean),
  );
  return [...versions].sort().join(', ') || undefined;
}

// --- states ------------------------------------------------------------------

/** Human-readable status line from the live work state. */
export function statusText(work, online) {
  if (online === false) return 'Offline';
  if (!work) return 'Unknown';
  const mode = WORK_MODES[work.w_mode] ?? `mode ${work.w_mode}`;
  if (mode === 'idle') return petPosition(work) === 'inside' ? 'Idle, cat inside' : 'Idle';
  const label = mode.charAt(0).toUpperCase() + mode.slice(1);
  const state = WORK_STATES[work.w_state];
  if (state === 'paused') return `${label}, paused`;
  if (state === 'blocked') return `${label}, blocked`;
  return label;
}

const isRunning = (work, mode) =>
  WORK_MODES[work?.w_mode] === mode && ['running', 'pending'].includes(WORK_STATES[work?.w_state]);

/** States derived from the live MQTT work state. */
export function workStates(work, online) {
  const states = { status: { text: statusText(work, online) } };
  if (work) {
    states.clean = isRunning(work, 'cleaning') ? 1 : 0;
    states.level = isRunning(work, 'levelling') ? 1 : 0;
    states.cat_inside = petPosition(work) === 'inside' ? 1 : 0;
  }
  return states;
}

const finite = (value) => {
  const number = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(number)
    ? number
    : undefined;
};

/** Timestamp (ms) of a visit record. */
export function recordTime(record) {
  let time = finite(record?.eventTime);
  if (time === undefined) return undefined;
  if (Math.abs(time) < 100_000_000_000) time *= 1000; // seconds
  return time;
}

/** One-line summary of a visit record, e.g. "Milo · 4.3 kg · 52 s". */
export function describeVisit(record) {
  const parts = [record.catNickname || 'Unknown cat'];
  const weight = finite(record.weight);
  if (weight !== undefined && weight > 0) parts.push(`${Math.round(weight * 10) / 10} kg`);
  const duration = finite(record.costTime);
  if (duration !== undefined) parts.push(`${Math.round(duration)} s`);
  return parts.join(' · ');
}

/** States derived from the REST snapshot of a box. */
export function snapshotStates(snapshot, now = Date.now()) {
  const states = {};
  const level = finite(snapshot.useTimes?.percentage);
  if (level !== undefined) states.bin_level = Math.max(0, Math.min(100, level));
  const uses = finite(snapshot.useTimes?.boxUseTimes);
  if (uses !== undefined) states.bin_uses = uses;
  const deodorant = finite(snapshot.deodorant?.remainingDays);
  if (deodorant !== undefined) states.deodorant_days = Math.max(0, deodorant);
  const autoClean = finite(snapshot.config?.sensorSwitch);
  if (autoClean !== undefined) states.auto_clean = autoClean === 1 ? 1 : 0;
  const delay = finite(snapshot.config?.lazyTime);
  if (delay !== undefined) states.auto_clean_delay = Math.round(delay / 60);

  if (Array.isArray(snapshot.records)) {
    const visits = snapshot.records.filter((r) => recordTime(r) !== undefined);
    states.visits_24h = visits.filter((r) => now - recordTime(r) <= 24 * 3600_000).length;
    const latest = visits.toSorted((a, b) => recordTime(b) - recordTime(a))[0];
    if (latest) {
      const duration = finite(latest.costTime);
      if (duration !== undefined) states.last_visit_duration = Math.round(duration);
      states.last_visit = { text: describeVisit(latest) };
    }
  }
  return states;
}

/** True when the waste bin is reported full. */
export function binFull(useTimes) {
  const level = finite(useTimes?.percentage);
  return level !== undefined && level >= 100;
}

/** Visits newer than `sinceMs`, oldest first. */
export function newVisits(records, sinceMs) {
  return (records ?? [])
    .filter((r) => recordTime(r) !== undefined && recordTime(r) > sinceMs)
    .sort((a, b) => recordTime(a) - recordTime(b));
}

// --- commands ----------------------------------------------------------------

export class CommandError extends Error {}

/**
 * Decide what a command means given the current work state.
 * @returns {{ service?: string, rest?: string, noop?: boolean }}
 */
export function planCommand(key, value, work) {
  const mode = WORK_MODES[work?.w_mode];
  const state = WORK_STATES[work?.w_state];
  const jobFor = { cleaning: 'clean', levelling: 'level' };
  const startOrResume = (job, jobMode) => {
    if (mode === jobMode && state === 'paused') return { service: `resume_${job}` };
    if (isRunning(work, jobMode)) return { noop: true };
    if (mode !== 'idle') throw new CommandError(`The box is busy (${statusText(work)})`);
    return { service: `start_${job}` };
  };

  switch (key) {
    case 'clean':
    case 'level': {
      const jobMode = key === 'clean' ? 'cleaning' : 'levelling';
      if (Number(value) === 1) return startOrResume(key, jobMode);
      return isRunning(work, jobMode) ? { service: `pause_${key}` } : { noop: true };
    }
    case 'command':
      switch (value) {
        case 'clean':
          return startOrResume('clean', 'cleaning');
        case 'level':
          return startOrResume('level', 'levelling');
        case 'pause':
          if (jobFor[mode] && isRunning(work, mode)) return { service: `pause_${jobFor[mode]}` };
          throw new CommandError('Nothing to pause');
        case 'resume':
          if (jobFor[mode] && state === 'paused') return { service: `resume_${jobFor[mode]}` };
          throw new CommandError('Nothing to resume');
        case 'bin_emptied':
          return { rest: 'reset_bin' };
        case 'refresh':
          return { rest: 'refresh' };
        default:
          throw new CommandError(`Unknown command ${value}`);
      }
    default:
      throw new CommandError(`Feature ${key} cannot be controlled`);
  }
}

/** True when the service makes the drum or rake move. */
export function serviceMoves(serviceId) {
  return Boolean(SERVICES[serviceId]?.moves);
}

/**
 * Movement is only allowed when the box reports no cat inside or near it. The
 * box has its own weight and infrared safety, this is a second barrier.
 */
export function assertSafeToMove(serviceId, work) {
  if (!serviceMoves(serviceId)) return;
  const position = petPosition(work);
  if (position === undefined) throw new CommandError('Box state unknown, not moving it');
  if (position === 'inside') throw new CommandError('A cat is inside the box, not moving it');
  if (position === 'nearby') throw new CommandError('A cat is near the box, not moving it');
}
