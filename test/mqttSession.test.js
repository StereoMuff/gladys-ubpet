import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MqttSession, reconnectDelay } from '../src/mqttSession.js';
import {
  RISP_CMD,
  buildRispFrame,
  classifyMessage,
  decodeFields,
  encodeImMessage,
  parseRispFrame,
} from '../src/protocol.js';

class FakeClient extends EventEmitter {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.published = [];
    this.subscriptions = [];
    this.ended = false;
  }
  subscribe(topic, options, cb) {
    this.subscriptions.push({ topic, options });
    cb?.(null);
  }
  publish(topic, payload, options) {
    this.published.push({ topic, payload, options });
  }
  end() {
    this.ended = true;
    this.emit('close');
  }
}

function fakeApi() {
  return {
    hostname: 'apis-eu.airrobo-home.com',
    loginCount: 1,
    auth: { userId: 5 },
    async ensureLogin() {},
    async getImCredentials() {
      return {
        clientId: 'cid',
        mqttUserName: 'u',
        mqttPassword: 'p',
        pubTopic: 'pub/t',
        subTopic: 'sub/t',
        uid: '500',
      };
    },
    async getImContacts() {
      return [
        { userName: 'SN1', userId: 900 },
        { userName: 'OTHER', userId: 901 },
      ];
    },
  };
}

async function startSession() {
  const clients = [];
  const session = new MqttSession({
    api: fakeApi(),
    serials: () => ['SN1'],
    connect: (url, options) => {
      const client = new FakeClient(url, options);
      clients.push(client);
      return client;
    },
  });
  await session.start();
  return { session, clients };
}

/** Frame carried by a published payload. */
const frameOf = (payload) => {
  const content = decodeFields(payload).find((f) => f.field === 7).value;
  const any = decodeFields(content).find((f) => f.field === 2).value;
  const bytesValue = decodeFields(any).find((f) => f.field === 2).value;
  const command = decodeFields(bytesValue).find((f) => f.field === 1).value;
  return parseRispFrame(decodeFields(command).find((f) => f.field === 2).value);
};

test('reconnect delay: back off on repeated kicks, fast after our own login', () => {
  assert.equal(reconnectDelay(0, { sessionS: 5, ownLogin: false }), 60);
  assert.equal(reconnectDelay(60, { sessionS: 5, ownLogin: false }), 120);
  assert.equal(reconnectDelay(1600, { sessionS: 5, ownLogin: false }), 1800);
  assert.equal(reconnectDelay(1800, { sessionS: 900, ownLogin: false }), 60);
  assert.equal(reconnectDelay(1800, { sessionS: 5, ownLogin: true }), 5);
});

test('connects over TLS with the IM credentials, subscribes and asks each box for its state', async () => {
  const { session, clients } = await startSession();
  const [client] = clients;
  assert.equal(client.url, 'mqtts://apis-eu.airrobo-home.com:21000');
  assert.equal(client.options.clientId, 'cid');
  assert.equal(client.options.protocolVersion, 4);
  assert.equal(client.options.reconnectPeriod, 0);
  let connected = false;
  session.on('connected', () => (connected = true));
  client.emit('connect');
  assert.ok(connected && session.connected);
  assert.deepEqual(client.subscriptions, [{ topic: 'sub/t', options: { qos: 1 } }]);
  assert.equal(client.published.length, 1);
  assert.equal(client.published[0].topic, 'pub/t');
  assert.equal(frameOf(client.published[0].payload).cmd, RISP_CMD.ALL_STATE);
  // The other contact is not a known box: no state request for it.
  assert.ok(session.hasBox('SN1') && !session.hasBox('OTHER'));
  session.stop();
});

test('commands go to the box uid, from the account uid', async () => {
  const { session, clients } = await startSession();
  clients[0].emit('connect');
  session.publish('SN1', 'start_clean');
  const payload = clients[0].published.at(-1).payload;
  const fields = decodeFields(payload);
  assert.equal(fields.find((f) => f.field === 4).value.toString(), '500');
  assert.equal(fields.find((f) => f.field === 5).value.toString(), '900');
  assert.equal(frameOf(payload).cmd, RISP_CMD.OPERATION);
  assert.throws(() => session.publish('SN2', 'start_clean'), /IM contacts/);
  session.stop();
  assert.throws(() => session.publish('SN1', 'start_clean'), /Not connected/);
});

test('pushes from the box are routed by serial, strangers are ignored', async () => {
  const { session, clients } = await startSession();
  clients[0].emit('connect');
  const events = [];
  session.on('state', (serial, state) => events.push(['state', serial, state.w_mode]));
  session.on('record', (serial) => events.push(['record', serial]));
  const push = (cmd, from, body = Buffer.alloc(0)) =>
    clients[0].emit(
      'message',
      'sub/t',
      encodeImMessage({
        frame: buildRispFrame({ cmd, seq: 1, body }),
        fromUid: from,
        toUid: '500',
      }),
    );
  push(RISP_CMD.STATE_PUSH, '900', Buffer.from([0x08, 0x02]));
  push(RISP_CMD.RECORD_PUSH, '900');
  push(RISP_CMD.STATE_PUSH, '901', Buffer.from([0x08, 0x03]));
  assert.deepEqual(events, [
    ['state', 'SN1', 2],
    ['record', 'SN1'],
  ]);
  session.stop();
});

test('being kicked closes the session and schedules a reconnect', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, clients } = await startSession();
  clients[0].emit('connect');
  let disconnected = false;
  session.on('disconnected', () => (disconnected = true));
  const field = (n, b) => Buffer.concat([Buffer.from([(n << 3) | 2, b.length]), b]);
  const any = Buffer.concat([
    field(1, Buffer.from('type.googleapis.com/rosa.im.protobuf.ForceOfflineNotification')),
    field(2, Buffer.alloc(0)),
  ]);
  const kick = field(7, Buffer.concat([field(1, Buffer.from('custom')), field(2, any)]));
  assert.equal(classifyMessage(kick).type, 'kicked');
  clients[0].emit('message', 'sub/t', kick);
  assert.ok(clients[0].ended && disconnected && !session.connected);
  assert.ok(session.reconnectTimer, 'a reconnect is scheduled');
  t.mock.timers.tick(60_000);
  await new Promise(setImmediate);
  assert.equal(clients.length, 2, 'reconnected after the back-off');
  session.stop();
});
