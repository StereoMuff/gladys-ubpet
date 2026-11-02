import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RISP_CMD,
  buildOperationBody,
  buildRispFrame,
  buildServicePayload,
  classifyMessage,
  crc8,
  decodeFields,
  encodeImMessage,
  encodeVarint,
  parseRispFrame,
  petPosition,
} from '../src/protocol.js';

// Java logs bytes as signed integers.
const bytes = (signed) => Buffer.from(signed.map((x) => x & 0xff));

// Frames the official app sent, captured by edied2002/vividmoo-ha (2026-10-11).
const CAPTURED_APP_FRAMES = [
  {
    seq: 9568,
    mode: 1,
    state: 1,
    frame: [-37, 12, 8, 2, 16, -5, 7, 32, 4, 40, 1, 56, -32, 74, -26, 8, 1, 16, 1, -34],
  },
  {
    seq: 9569,
    mode: 1,
    state: 2,
    frame: [-37, 12, 8, 2, 16, -5, 7, 32, 4, 40, 1, 56, -31, 74, -13, 8, 1, 16, 2, -41],
  },
  {
    seq: 9570,
    mode: 1,
    state: 3,
    frame: [-37, 12, 8, 2, 16, -5, 7, 32, 4, 40, 1, 56, -30, 74, -52, 8, 1, 16, 3, -48],
  },
  {
    seq: 9573,
    mode: 3,
    state: 1,
    frame: [-37, 12, 8, 2, 16, -5, 7, 32, 4, 40, 1, 56, -27, 74, -89, 8, 3, 16, 1, 8],
  },
  {
    seq: 9574,
    mode: 3,
    state: 2,
    frame: [-37, 12, 8, 2, 16, -5, 7, 32, 4, 40, 1, 56, -26, 74, -104, 8, 3, 16, 2, 1],
  },
];

test('crc8 matches the pairs captured from the app', () => {
  assert.equal(crc8(Buffer.alloc(0)), 85);
  assert.equal(crc8(bytes([8, 1, 16, 1])), 222);
  assert.equal(crc8(bytes([8, 3, 16, 2])), 1);
  assert.equal(crc8(bytes([8, 2, 16, -5, 7, 32, 4, 40, 1, 56, -32, 74])), 230);
});

test('operation frames are byte-identical to the official app', () => {
  for (const { seq, mode, state, frame } of CAPTURED_APP_FRAMES) {
    const built = buildRispFrame({
      cmd: RISP_CMD.OPERATION,
      seq,
      body: buildOperationBody(mode, state),
    });
    assert.deepEqual(built, bytes(frame), `seq ${seq}`);
  }
});

test('frames match the Home Assistant UPET integration test vectors', () => {
  const clean = buildRispFrame({ cmd: RISP_CMD.OPERATION, seq: 1, body: buildOperationBody(1, 1) });
  assert.equal(clean.toString('hex'), 'db0b080210fb072004280138018b08011001de');
  const allState = buildRispFrame({ cmd: RISP_CMD.ALL_STATE, seq: 1 });
  assert.equal(allState.toString('hex'), 'db09080210fd0728013801f6');
});

test('a state push captured from a box decodes', () => {
  const push = bytes([
    -37, 14, 8, 2, 16, -128, 8, 24, 1, 32, 13, 40, 6, 56, -4, 8, 53, 8, 2, 16, 1, 24, 50, -112, 1,
    -82, -12, -82, -42, 6, -49,
  ]);
  const frame = parseRispFrame(push);
  assert.equal(frame.cmd, RISP_CMD.STATE_PUSH);
  const fields = decodeFields(frame.body);
  assert.deepEqual(
    fields.slice(0, 3).map((f) => f.value),
    [2, 1, 50],
  );
});

test('varints handle 64-bit values', () => {
  assert.deepEqual(encodeVarint(300), Buffer.from([0xac, 0x02]));
  const big = (BigInt(Date.now()) << 20n) + 12345n;
  const [{ value }] = decodeFields(Buffer.concat([Buffer.from([0x08]), encodeVarint(big)]));
  assert.equal(value, big);
});

function boxMessage(cmd, body, fromUid = 'box-uid') {
  const frame = buildRispFrame({ cmd, seq: 7, body });
  return encodeImMessage({ frame, fromUid, toUid: 'me' });
}

test('an IM message carrying a state push is classified with its state', () => {
  // w_mode 2 (cleaning), w_state 1 (running), toilet_state 0
  const body = Buffer.from([0x08, 0x02, 0x10, 0x01, 0x18, 0x32]);
  const message = classifyMessage(boxMessage(RISP_CMD.STATE_PUSH, body));
  assert.equal(message.type, 'state');
  assert.equal(message.fromUid, 'box-uid');
  assert.equal(message.state.w_mode, 2);
  assert.equal(message.state.w_state, 1);
  assert.equal(message.state.w_cause, 50);
  assert.equal(message.state.toilet_state, 0);
  assert.equal(petPosition(message.state), 'away');
});

test('cat inside and nearby are read from the state', () => {
  const inside = classifyMessage(boxMessage(RISP_CMD.ALL_STATE, Buffer.from([0x20, 0x01])));
  assert.equal(petPosition(inside.state), 'inside');
  const nearby = classifyMessage(boxMessage(RISP_CMD.ALL_STATE, Buffer.from([0x28, 0x01])));
  assert.equal(petPosition(nearby.state), 'nearby');
});

test('record and config pushes are classified', () => {
  assert.equal(classifyMessage(boxMessage(RISP_CMD.RECORD_PUSH, Buffer.alloc(0))).type, 'record');
  assert.equal(
    classifyMessage(boxMessage(RISP_CMD.CONFIG_REQUEST, Buffer.alloc(0))).type,
    'config',
  );
});

// Builds an IM message whose content is an Any of the given type.
function anyMessage(typeUrl, value) {
  const field = (n, b) => Buffer.concat([Buffer.from([(n << 3) | 2, b.length]), b]);
  const any = Buffer.concat([field(1, Buffer.from(typeUrl)), field(2, value)]);
  const content = Buffer.concat([field(1, Buffer.from('custom')), field(2, any)]);
  return Buffer.concat([field(4, Buffer.from('server')), field(7, content)]);
}

test('force-offline and online-status notifications are classified', () => {
  assert.equal(
    classifyMessage(
      anyMessage('type.googleapis.com/rosa.im.protobuf.ForceOfflineNotification', Buffer.alloc(0)),
    ).type,
    'kicked',
  );
  const field = (n, s) => Buffer.concat([Buffer.from([(n << 3) | 2, s.length]), Buffer.from(s)]);
  const status = Buffer.concat([field(1, 'status/offline'), field(2, 'box-uid')]);
  const message = classifyMessage(
    anyMessage('type.googleapis.com/rosa.im.protobuf.OnlineStatusNotification', status),
  );
  assert.deepEqual(message, { type: 'online', uid: 'box-uid', online: false });
});

test('garbage never throws', () => {
  assert.equal(classifyMessage(Buffer.from([0xff, 0xff, 0xff])).type, 'ignored');
  assert.equal(classifyMessage(Buffer.alloc(0)).type, 'ignored');
});

test('service payloads embed the expected frame and addresses', () => {
  const payload = buildServicePayload('pause_clean', { fromUid: '42', toUid: '99', seq: 3 });
  const fields = decodeFields(payload);
  const text = (n) => fields.find((f) => f.field === n).value.toString();
  assert.equal(text(4), '42');
  assert.equal(text(5), '99');
  assert.equal(text(8), '1.0.1');
  assert.ok(
    payload.includes(
      buildRispFrame({ cmd: RISP_CMD.OPERATION, seq: 3, body: buildOperationBody(1, 2) }),
    ),
  );
  assert.throws(() => buildServicePayload('self_destruct', { fromUid: '1', toUid: '2' }));
});
