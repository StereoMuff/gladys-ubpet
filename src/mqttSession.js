// -----------------------------------------------------------------------------
// Persistent connection to the vendor IM/MQTT broker.
//
// The boxes push every work-state change, new-visit signal and online change
// to the accounts they are shared with, so one long-lived connection gives
// real-time states; commands go out over the same connection.
//
// The broker allows one IM session per account. Another login on the account
// (the phone app) kicks us; reconnecting kicks it back. Repeated short
// sessions therefore back off from one minute to thirty, while a session ended
// by our own REST re-login (which also invalidates the IM session)
// reconnects within seconds.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import mqtt from 'mqtt';
import { createLogger } from '@gladysassistant/integration-sdk';
import {
  MQTT_KEEPALIVE_SECONDS,
  MQTT_PORT,
  buildServicePayload,
  classifyMessage,
} from './protocol.js';

const log = createLogger({ name: 'ubpet-mqtt' });

export const MIN_RECONNECT_S = 60;
export const MAX_RECONNECT_S = 1800;
export const STABLE_SESSION_S = 600;
export const OWN_LOGIN_RECONNECT_S = 5;

/** Seconds to wait before reconnecting after a session ended. */
export function reconnectDelay(previousS, { sessionS, ownLogin }) {
  if (ownLogin) return OWN_LOGIN_RECONNECT_S;
  if (sessionS >= STABLE_SESSION_S || previousS <= 0) return MIN_RECONNECT_S;
  return Math.min(previousS * 2, MAX_RECONNECT_S);
}

function accountUid(credentials, auth) {
  for (const key of ['uid', 'userId', 'imUserId', 'accountUid']) {
    const value = credentials[key];
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  if (auth?.userId !== undefined && auth?.userId !== null) return String(auth.userId);
  throw new Error('No IM sender id in the IM login answer');
}

/**
 * Events:
 *   'connected'                      session up (state requests already sent)
 *   'disconnected'                   session down
 *   'state'   (serial, state)        decoded work state of a box
 *   'record'  (serial)               a new visit record is on the cloud
 *   'config'  (serial)               the box settings changed
 *   'online'  (serial, online)
 */
export class MqttSession extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('./cloudApi.js').CloudApi} options.api
   * @param {() => string[]} options.serials serial numbers of the known boxes
   * @param {Function} [options.connect] mqtt.connect replacement (tests)
   */
  constructor({ api, serials, connect = mqtt.connect }) {
    super();
    this.api = api;
    this.serials = serials;
    this.connectFn = connect;
    this.client = null;
    this.connectedAt = null;
    this.delayS = 0;
    this.reconnectTimer = null;
    this.stopped = true;
    this.serialToUid = new Map();
    this.uidToSerial = new Map();
    this.loginCountAtConnect = 0;
  }

  get connected() {
    return this.connectedAt !== null;
  }

  start() {
    this.stopped = false;
    this.delayS = 0;
    return this.open();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.close();
  }

  /** Reconnect soon, e.g. after our own REST re-login invalidated the session. */
  restartSoon() {
    if (this.stopped) return;
    this.close();
    this.scheduleReconnect(OWN_LOGIN_RECONNECT_S);
  }

  hasBox(serial) {
    return this.serialToUid.has(serial);
  }

  publish(serial, serviceId) {
    const uid = this.serialToUid.get(serial);
    if (!this.client || !this.connected) {
      throw new Error('Not connected to the UPET cloud right now, try again in a minute');
    }
    if (!uid) throw new Error(`Box ${serial} is not among the account's IM contacts`);
    const payload = buildServicePayload(serviceId, { fromUid: this.fromUid, toUid: uid });
    this.client.publish(this.pubTopic, payload, { qos: 0 });
    log.debug(`Sent ${serviceId} to ${serial}`);
  }

  async open() {
    this.reconnectTimer = null;
    if (this.stopped) return;
    let credentials;
    let contacts;
    try {
      await this.api.ensureLogin();
      credentials = await this.api.getImCredentials();
      contacts = await this.api.getImContacts();
      this.fromUid = accountUid(credentials, this.api.auth);
    } catch (err) {
      if (err.name === 'CloudAuthError') {
        // Retrying a refused password risks locking the account: wait for a config change.
        log.warn(`MQTT not started: ${err.message}`);
        return;
      }
      log.warn(`MQTT session setup failed: ${err.message}`);
      this.scheduleReconnect(reconnectDelay(this.delayS, { sessionS: 0, ownLogin: false }));
      return;
    }

    const known = new Set(this.serials());
    this.serialToUid.clear();
    this.uidToSerial.clear();
    for (const contact of contacts) {
      if (contact?.userId && known.has(contact.userName)) {
        this.serialToUid.set(contact.userName, String(contact.userId));
        this.uidToSerial.set(String(contact.userId), contact.userName);
      }
    }
    this.pubTopic = credentials.pubTopic;
    this.loginCountAtConnect = this.api.loginCount;

    const client = this.connectFn(`mqtts://${this.api.hostname}:${MQTT_PORT}`, {
      clientId: credentials.clientId,
      username: credentials.mqttUserName,
      password: credentials.mqttPassword,
      protocolVersion: 4,
      keepalive: MQTT_KEEPALIVE_SECONDS,
      clean: true,
      reconnectPeriod: 0, // reconnects are ours, with fresh credentials and back-off
      connectTimeout: 15_000,
      servername: this.api.hostname,
    });
    this.client = client;
    client.on('connect', () => this.onConnect(client, credentials.subTopic));
    client.on('message', (_topic, payload) => this.onMessage(client, payload));
    client.on('close', () => this.onClose(client));
    client.on('error', (err) => log.warn(`MQTT error: ${err.message}`));
  }

  onConnect(client, subTopic) {
    if (client !== this.client) return;
    client.subscribe(subTopic, { qos: 1 }, (err) => {
      if (err) log.warn(`MQTT subscribe failed: ${err.message}`);
    });
    this.connectedAt = Date.now();
    log.info(`MQTT connected, ${this.serialToUid.size} box(es) reachable`);
    // The replies seed every box state; from then on the boxes push each change.
    for (const serial of this.serialToUid.keys()) {
      try {
        this.publish(serial, 'request_state');
      } catch (err) {
        log.warn(`State request for ${serial} failed: ${err.message}`);
      }
    }
    this.emit('connected');
  }

  onMessage(client, payload) {
    if (client !== this.client) return;
    const message = classifyMessage(payload);
    switch (message.type) {
      case 'kicked':
        log.info('MQTT session taken over by another login on the account');
        client.end(true);
        return;
      case 'online': {
        const serial = this.uidToSerial.get(String(message.uid));
        if (serial) this.emit('online', serial, message.online);
        return;
      }
      case 'state':
      case 'record':
      case 'config': {
        // Only a known box can change a box's state.
        const serial = this.uidToSerial.get(String(message.fromUid));
        if (!serial) return;
        if (message.type === 'state') this.emit('state', serial, message.state);
        else this.emit(message.type, serial);
        return;
      }
      default:
        if (message.reason !== 'receipt') log.debug(`MQTT message ignored: ${message.reason}`);
    }
  }

  onClose(client) {
    if (client !== this.client) return;
    const sessionS = this.connectedAt ? (Date.now() - this.connectedAt) / 1000 : 0;
    const ownLogin = this.api.loginCount !== this.loginCountAtConnect;
    this.client = null;
    const wasConnected = this.connectedAt !== null;
    this.connectedAt = null;
    if (wasConnected) {
      log.info(`MQTT disconnected after ${Math.round(sessionS)} s`);
      this.emit('disconnected');
    }
    if (!this.stopped) {
      this.scheduleReconnect(reconnectDelay(this.delayS, { sessionS, ownLogin }));
    }
  }

  scheduleReconnect(delayS) {
    if (this.stopped || this.reconnectTimer) return;
    this.delayS = delayS;
    log.info(`MQTT reconnecting in ${delayS} s`);
    this.reconnectTimer = setTimeout(() => this.open(), delayS * 1000);
    this.reconnectTimer.unref?.();
  }

  close() {
    const client = this.client;
    this.client = null;
    const wasConnected = this.connectedAt !== null;
    this.connectedAt = null;
    if (client) client.end(true);
    if (wasConnected) this.emit('disconnected');
  }
}
