// -----------------------------------------------------------------------------
// Orchestration: one cloud session, one MQTT session, a REST refresh loop, and
// the translation of all of it into Gladys devices, states and scene events.
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';
import { CloudApi, CloudAuthError, CloudRevokedError } from './cloudApi.js';
import { isConfigured, sessionKey } from './config.js';
import { MqttSession } from './mqttSession.js';
import { WORK_STATES } from './protocol.js';
import {
  CommandError,
  DEVICE_TYPE,
  assertSafeToMove,
  binFull,
  buildDevice,
  describeVisit,
  featureKey,
  newVisits,
  planCommand,
  recordTime,
  snapshotStates,
  workStates,
} from './litterBox.js';
import { vendorDefaults } from './vendorDefaults.js';

const log = createLogger({ name: 'ubpet' });

const STATE_WAIT_MS = 5_000;
const POST_COMMAND_CHECK_MS = 4_000;
const RECORD_REFRESH_DELAY_MS = 3_000;
const REVOKED_BACKOFF_MIN_MS = 5 * 60_000;
const REVOKED_BACKOFF_MAX_MS = 60 * 60_000;

const MESSAGES = {
  notConfigured: {
    en: 'Enter the UPET account and password to connect.',
    fr: 'Renseignez le compte et le mot de passe UPET pour vous connecter.',
  },
  auth: (detail) => ({
    en: `UPET login refused: ${detail}. Fix the configuration to retry.`,
    fr: `Connexion UPET refusée : ${detail}. Corrigez la configuration pour réessayer.`,
  }),
  revoked: {
    en: 'Another login on this UPET account took the session. Use a second account shared with the box.',
    fr: 'Une autre connexion sur ce compte UPET a pris la session. Utilisez un second compte partagé avec la litière.',
  },
  cloudDown: {
    en: 'UPET cloud unreachable, retrying.',
    fr: 'Cloud UPET injoignable, nouvel essai en cours.',
  },
  noLiveLink: {
    en: 'Live connection to the box is down, states may be late.',
    fr: 'La connexion temps réel à la litière est coupée, les états peuvent être en retard.',
  },
};

export class Controller {
  /**
   * @param {object} options
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} options.gladys
   * @param {string} [options.dataDir]
   * @param {(options: object) => CloudApi} [options.createApi]
   * @param {(options: object) => MqttSession} [options.createSession]
   */
  constructor({ gladys, dataDir = process.env.DATA_DIR || '/data', createApi, createSession }) {
    this.gladys = gladys;
    this.dataDir = dataDir;
    this.createApi = createApi ?? ((options) => new CloudApi(options));
    this.createSession = createSession ?? ((options) => new MqttSession(options));
    this.config = null;
    this.key = null;
    this.api = null;
    this.session = null;
    this.boxes = new Map(); // serial -> { serial, name, config, useTimes, deodorant, online, records, work }
    this.lastValues = new Map(); // feature external id -> last published value
    this.store = { clientId: null, lastVisitMs: {}, binFull: {} };
    this.timer = null;
    this.recordTimers = new Map();
    this.stateWaiters = new Map();
    this.revokedUntil = 0;
    this.revokedBackoffMs = 0;
    this.authError = null;
    this.refreshing = null;
    this.lastBoxSet = null;
  }

  // --- lifecycle -------------------------------------------------------------

  async start(config) {
    this.config = config;
    this.key = sessionKey(config);
    await this.loadStore();
    if (!isConfigured(config)) {
      await this.status(false, MESSAGES.notConfigured);
      return;
    }
    const defaults = vendorDefaults();
    this.api = this.createApi({
      baseUrl: config.baseUrl,
      account: config.account,
      password: config.password,
      country: config.country,
      appId: config.app_id || defaults.APP_ID,
      appKey: config.app_key || defaults.APP_KEY,
      product: config.product || defaults.PRODUCT,
      clientId: this.store.clientId,
    });
    this.authError = null;
    await this.refresh({ discover: true });
    if (this.authError) return;

    this.session = this.createSession({ api: this.api, serials: () => [...this.boxes.keys()] });
    this.session.on('state', (serial, work) => this.onWorkState(serial, work));
    this.session.on('record', (serial) => this.scheduleRecordRefresh(serial));
    this.session.on('config', (serial) => this.scheduleRecordRefresh(serial));
    this.session.on('online', (serial, online) => this.onOnline(serial, online));
    this.session.on('connected', () => this.publishTransports());
    this.session.on('disconnected', () => this.publishTransports());
    await this.session.start();
    this.schedule();
  }

  async stop() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const timer of this.recordTimers.values()) clearTimeout(timer);
    this.recordTimers.clear();
    this.session?.stop();
    this.session = null;
    this.api = null;
  }

  /** Apply a new configuration: a new session only when the account changed. */
  async reconfigure(config) {
    if (sessionKey(config) !== this.key || this.authError || !this.api) {
      await this.stop();
      this.boxes.clear();
      this.lastValues.clear();
      await this.start(config);
      return;
    }
    this.config = config;
    this.schedule();
  }

  schedule() {
    clearTimeout(this.timer);
    if (!this.api) return;
    this.timer = setTimeout(async () => {
      await this.refresh().catch((err) => log.error('Refresh failed', err));
      this.schedule();
    }, this.config.refresh_interval * 1000);
    this.timer.unref?.();
  }

  // --- cloud snapshot --------------------------------------------------------

  /** Serialized: a refresh asked while one runs waits for it. */
  refresh(options = {}) {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh(options).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  async doRefresh({ discover = false } = {}) {
    if (!this.api) return;
    if (Date.now() < this.revokedUntil) return;
    try {
      const devices = await this.api.getDevices();
      const seen = new Set();
      for (const device of devices) {
        const serial = device?.serialNumber;
        if (!serial) continue;
        seen.add(serial);
        const box = this.boxes.get(serial) ?? { serial, work: null };
        box.name = device.deviceName || `UBPet litter box ${serial.slice(-4)}`;
        box.deviceStatus = device.deviceStatus;
        this.boxes.set(serial, box);
      }
      for (const serial of [...this.boxes.keys()]) if (!seen.has(serial)) this.boxes.delete(serial);
      const boxSet = [...seen].sort().join(',');
      const boxesChanged = boxSet !== this.lastBoxSet;
      this.lastBoxSet = boxSet;

      for (const box of this.boxes.values()) await this.refreshBox(box);
      this.revokedBackoffMs = 0;

      if (discover || boxesChanged) await this.publishDiscovered();
      await this.publishAll();
      await this.publishTransports();
      await this.status(true);

      // Our own re-login invalidated the IM session: take it back now.
      // A box added to the account needs a fresh IM contact list.
      const missingBox = this.session && [...seen].some((serial) => !this.session.hasBox(serial));
      const ownLogin =
        this.session?.connected && this.api.loginCount !== this.session.loginCountAtConnect;
      if (ownLogin || (boxesChanged && missingBox)) this.session.restartSoon();
    } catch (err) {
      await this.handleCloudError(err);
    }
  }

  async refreshBox(box) {
    // Optional endpoints: one failing must not hide the others.
    const safe = async (fn, fallback) => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof CloudAuthError || err instanceof CloudRevokedError) throw err;
        log.debug(`Optional endpoint failed for ${box.serial}: ${err.message}`);
        return fallback;
      }
    };
    const { serial } = box;
    box.config = (await safe(() => this.api.getAllConfig(serial), box.config)) ?? box.config;
    box.useTimes =
      (await safe(() => this.api.getBoxUseTimes(serial), box.useTimes)) ?? box.useTimes;
    box.deodorant =
      (await safe(() => this.api.getDeodorantStatus(serial), box.deodorant)) ?? box.deodorant;
    const online = await safe(() => this.api.getOnline(serial), undefined);
    if (typeof online?.online === 'boolean') box.online = online.online;
    box.records = await safe(() => this.api.getVisitRecords(serial), box.records);
    await this.processVisits(box);
    await this.processBinFull(box);
  }

  async handleCloudError(err) {
    if (err instanceof CloudAuthError) {
      log.error(`Login refused: ${err.message}`);
      this.authError = err;
      this.session?.stop();
      clearTimeout(this.timer);
      this.timer = null;
      await this.status(false, MESSAGES.auth(err.message));
      return;
    }
    if (err instanceof CloudRevokedError) {
      this.revokedBackoffMs = Math.min(
        this.revokedBackoffMs ? this.revokedBackoffMs * 2 : REVOKED_BACKOFF_MIN_MS,
        REVOKED_BACKOFF_MAX_MS,
      );
      this.revokedUntil = Date.now() + this.revokedBackoffMs;
      log.warn(`${err.message}. Pausing for ${this.revokedBackoffMs / 60_000} min.`);
      await this.status(false, MESSAGES.revoked);
      return;
    }
    log.warn(`Cloud refresh failed: ${err.message}`);
    await this.status(false, MESSAGES.cloudDown);
  }

  async processVisits(box) {
    if (!Array.isArray(box.records)) return;
    const newest = Math.max(0, ...box.records.map((r) => recordTime(r) ?? 0));
    const since = this.store.lastVisitMs[box.serial];
    if (since === undefined) {
      // First sync of this box: remember where history ends, fire nothing.
      this.store.lastVisitMs[box.serial] = newest;
      await this.saveStore();
      return;
    }
    const visits = newVisits(box.records, since);
    if (visits.length === 0) return;
    const deviceId = this.deviceId(box.serial);
    for (const visit of visits) {
      log.info(`New visit on ${box.serial}: ${describeVisit(visit)}`);
      const weight = Number(visit.weight);
      const duration = Number(visit.costTime);
      await this.sceneEvent('cat_visit', {
        device: deviceId,
        cat: visit.catNickname || '',
        weight: Number.isFinite(weight) ? weight : null,
        duration: Number.isFinite(duration) ? duration : null,
      });
    }
    this.store.lastVisitMs[box.serial] = recordTime(visits.at(-1));
    await this.saveStore();
  }

  async processBinFull(box) {
    if (!box.useTimes) return;
    const full = binFull(box.useTimes);
    const was = this.store.binFull[box.serial];
    if (full === was) return;
    this.store.binFull[box.serial] = full;
    await this.saveStore();
    // Fire on a transition only, not on the first observation after an install.
    if (full && was === false) {
      await this.sceneEvent('bin_full', {
        device: this.deviceId(box.serial),
        level: Number(box.useTimes.percentage),
      });
    }
  }

  scheduleRecordRefresh(serial) {
    // The box pushes before the cloud serves the new record: give it a moment.
    if (this.recordTimers.has(serial)) return;
    const timer = setTimeout(async () => {
      this.recordTimers.delete(serial);
      const box = this.boxes.get(serial);
      if (!box || !this.api) return;
      try {
        await this.refreshBox(box);
        await this.publishBox(box);
      } catch (err) {
        await this.handleCloudError(err);
      }
    }, RECORD_REFRESH_DELAY_MS);
    timer.unref?.();
    this.recordTimers.set(serial, timer);
  }

  // --- live state ------------------------------------------------------------

  async onWorkState(serial, work) {
    const box = this.boxes.get(serial);
    if (!box) return;
    const previous = box.work;
    box.work = work;
    box.online = true;
    for (const resolve of this.stateWaiters.get(serial) ?? []) resolve();
    this.stateWaiters.delete(serial);
    if (WORK_STATES[work.w_state] === 'blocked' && WORK_STATES[previous?.w_state] !== 'blocked') {
      await this.sceneEvent('box_blocked', {
        device: this.deviceId(serial),
        cause: work.w_cause ?? null,
      });
    }
    await this.publishBox(box);
  }

  async onOnline(serial, online) {
    const box = this.boxes.get(serial);
    if (!box) return;
    box.online = online;
    await this.publishBox(box);
    await this.publishTransports();
  }

  waitForState(serial, timeoutMs = STATE_WAIT_MS) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      const waiters = this.stateWaiters.get(serial) ?? [];
      waiters.push(done);
      this.stateWaiters.set(serial, waiters);
    });
  }

  // --- commands ----------------------------------------------------------------

  serialOf(device) {
    const param = device.params?.find((p) => p.name === 'SERIAL_NUMBER')?.value;
    if (param) return param;
    // ext:<selector>:litterbox:<serial>
    const marker = `:${DEVICE_TYPE}:`;
    const index = device.external_id.indexOf(marker);
    return index >= 0 ? device.external_id.slice(index + marker.length) : undefined;
  }

  async setValue(device, feature, value) {
    const serial = this.serialOf(device);
    const box = this.boxes.get(serial);
    if (!box || !this.api)
      throw new CommandError('This box is not known to the UPET account (yet)');
    const key = featureKey(feature.external_id);

    if (key === 'auto_clean' || key === 'auto_clean_delay') {
      const enabled = key === 'auto_clean' ? Number(value) === 1 : box.config?.sensorSwitch === 1;
      const minutes = key === 'auto_clean_delay' ? Math.round(Number(value)) : undefined;
      if (minutes !== undefined && !(minutes >= 1 && minutes <= 60)) {
        throw new CommandError('The delay must be between 1 and 60 minutes');
      }
      const seconds = minutes !== undefined ? minutes * 60 : Number(box.config?.lazyTime) || 480;
      await this.api.setAutoClean(serial, enabled, seconds);
      box.config = { ...box.config, sensorSwitch: enabled ? 1 : 0, lazyTime: seconds };
      await this.publishBox(box);
      return;
    }

    // Movement decisions need a fresh work state.
    if (!box.work && this.session?.connected) {
      this.session.publish(serial, 'request_state');
      await this.waitForState(serial);
    }
    const plan = planCommand(key, value, box.work);
    if (plan.noop) {
      await this.publishBox(box, { force: true });
      return;
    }
    if (plan.rest === 'reset_bin') {
      await this.api.resetBoxUseTimes(serial);
      await this.refreshBox(box);
      await this.publishBox(box);
      return;
    }
    if (plan.rest === 'refresh') {
      if (this.session?.connected) this.session.publish(serial, 'request_state');
      await this.refreshBox(box);
      await this.publishBox(box, { force: true });
      return;
    }
    assertSafeToMove(plan.service, box.work);
    if (!this.session) throw new CommandError('Not connected to the UPET cloud');
    this.session.publish(serial, plan.service);
    log.info(`${plan.service} sent to ${serial}`);
    // The box pushes its new state; ask once more in case the push is lost.
    const check = setTimeout(() => {
      if (this.session?.connected) {
        try {
          this.session.publish(serial, 'request_state');
        } catch {
          // Next push or refresh will catch up.
        }
      }
    }, POST_COMMAND_CHECK_MS);
    check.unref?.();
  }

  // --- Gladys publishing ---------------------------------------------------------

  deviceId(serial) {
    return this.gladys.externalIds(DEVICE_TYPE, serial).device;
  }

  async publishDiscovered() {
    const devices = [...this.boxes.values()].map((box) => buildDevice(this.gladys, box));
    await this.gladys.publishDiscoveredDevices(devices);
  }

  /** A device the user just created gets all its current states. */
  async onDeviceCreated(device) {
    const serial = this.serialOf(device);
    const box = this.boxes.get(serial);
    if (box) await this.publishBox(box, { force: true, created: true });
  }

  createdDeviceIds() {
    return new Set((this.gladys.devices ?? []).map((d) => d.external_id));
  }

  async publishAll({ force = false } = {}) {
    for (const box of this.boxes.values()) await this.publishBox(box, { force });
  }

  /** Gladys came back (restart, network): it needs the devices and states again. */
  async onGladysReconnected() {
    if (!this.api || this.boxes.size === 0) return;
    await this.publishDiscovered();
    await this.publishAll({ force: true });
    await this.publishTransports();
  }

  async publishBox(box, { force = false, created = false } = {}) {
    const deviceId = this.deviceId(box.serial);
    if (!created && !this.createdDeviceIds().has(deviceId)) return;
    const ids = this.gladys.externalIds(DEVICE_TYPE, box.serial);
    const values = { ...snapshotStates(box), ...workStates(box.work, box.online) };
    const states = [];
    for (const [key, value] of Object.entries(values)) {
      const id = ids.feature(key);
      const comparable = typeof value === 'object' ? value.text : value;
      if (!force && this.lastValues.get(id) === comparable) continue;
      this.lastValues.set(id, comparable);
      states.push(
        typeof value === 'object'
          ? { device_feature_external_id: id, text: value.text }
          : { device_feature_external_id: id, state: value },
      );
    }
    if (states.length === 0) return;
    try {
      await this.gladys.publishStates(states);
    } catch (err) {
      // Forget what we think we sent, so the next publish retries.
      for (const state of states) this.lastValues.delete(state.device_feature_external_id);
      log.warn(`Publishing states failed: ${err.message}`);
    }
  }

  async publishTransports() {
    const created = this.createdDeviceIds();
    const entries = [...this.boxes.values()]
      .map((box) => ({ box, external_id: this.deviceId(box.serial) }))
      .filter(({ external_id: id }) => created.has(id))
      .map(({ box, external_id: id }) => {
        if (box.online === false) return { external_id: id, transport: 'unreachable' };
        if (this.session && !this.session.connected) {
          return {
            external_id: id,
            transport: 'cloud',
            degraded: true,
            message: MESSAGES.noLiveLink,
          };
        }
        return { external_id: id, transport: 'cloud' };
      });
    if (entries.length === 0) return;
    await this.gladys
      .publishTransports(entries)
      .catch((err) => log.warn(`Transports: ${err.message}`));
  }

  async sceneEvent(key, data) {
    await this.gladys
      .publishSceneEvent(key, data)
      .catch((err) => log.warn(`Scene event ${key}: ${err.message}`));
  }

  async status(connected, message) {
    await this.gladys
      .setConnectionStatus(connected, connected ? undefined : message)
      .catch((err) => log.warn(`Connection status: ${err.message}`));
  }

  // --- actions -------------------------------------------------------------------

  /** Configuration-screen "Test connection" button. */
  async testConnection() {
    if (!isConfigured(this.config ?? {})) throw new Error(MESSAGES.notConfigured.en);
    if (this.authError) throw this.authError;
    if (!this.api) throw new Error('Not started');
    await this.refresh({ discover: true });
    if (this.authError) throw this.authError;
    const names = [...this.boxes.values()].map((b) => b.name);
    const live = this.session?.connected ? 'live link up' : 'live link down';
    const frLive = this.session?.connected ? 'lien temps réel actif' : 'lien temps réel coupé';
    return {
      en: `Connected: ${names.length} box(es) found${names.length ? ` (${names.join(', ')})` : ''}, ${live}.`,
      fr: `Connecté : ${names.length} litière(s) trouvée(s)${names.length ? ` (${names.join(', ')})` : ''}, ${frLive}.`,
    };
  }

  // --- persistent store ------------------------------------------------------------

  async loadStore() {
    try {
      const raw = JSON.parse(await readFile(join(this.dataDir, 'state.json'), 'utf8'));
      this.store = {
        clientId: typeof raw.clientId === 'string' ? raw.clientId : null,
        lastVisitMs: raw.lastVisitMs && typeof raw.lastVisitMs === 'object' ? raw.lastVisitMs : {},
        binFull: raw.binFull && typeof raw.binFull === 'object' ? raw.binFull : {},
      };
    } catch {
      // First start, or unreadable file: start fresh.
    }
    if (!this.store.clientId) {
      // Stable per installation, like the phone's device id in the app.
      this.store.clientId = randomUUID().replace(/-/g, '');
      await this.saveStore();
    }
  }

  async saveStore() {
    try {
      await mkdir(this.dataDir, { recursive: true });
      await writeFile(join(this.dataDir, 'state.json'), JSON.stringify(this.store));
    } catch (err) {
      log.warn(`Could not save state: ${err.message}`);
    }
  }
}
