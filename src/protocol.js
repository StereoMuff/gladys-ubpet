// -----------------------------------------------------------------------------
// UPET IM/MQTT wire protocol.
//
// Commands to the litter box and the state it pushes back travel over the
// vendor's MQTT broker as nested protobuf messages, with no schema shipped by
// the vendor. This module hand-encodes the few messages we need, so the
// integration has no protobuf dependency. Layers, outermost first:
//
//   rosa.im.protobuf.Message { cid, gid, created_at, from, to,
//     content: MessageContent { "custom", Any(BytesValue(
//       Command { protype, data: <RISP frame> })) }, "1.0.1" }
//
//   RISP frame = 0xDB | headerLen | Header | crc8(Header) | body | crc8(body)
//               (body and its CRC are absent when the body is empty)
//
// Reverse-engineered by the community Home Assistant integrations for UPET /
// Airrobo / Vividmoo boxes (CrazzyBerg/upet-hass and its forks,
// edied2002/vividmoo-ha). The RISP frames this module builds are tested
// byte-for-byte against frames captured from the official app.
// -----------------------------------------------------------------------------

export const MQTT_PORT = 21000;
export const MQTT_KEEPALIVE_SECONDS = 20;

const MESSAGE_PROTOCOL_VERSION = '1.0.1';
const BYTES_VALUE_TYPE_URL = 'type.googleapis.com/google.protobuf.BytesValue';
const RECEIPT_TYPE_URL = 'type.googleapis.com/rosa.im.protobuf.ReceiptNotification';
const ONLINE_STATUS_TYPE_URL = 'type.googleapis.com/rosa.im.protobuf.OnlineStatusNotification';
const FORCE_OFFLINE_TYPE_URL = 'type.googleapis.com/rosa.im.protobuf.ForceOfflineNotification';

// The UPET-family integrations send protype 2 and the boxes accept it.
const COMMAND_PROTYPE_RISP = 2;

const RISP_START_BYTE = 0xdb;
const RISP_DEV_LITTER_BOX = 0x02;
const RISP_ATTR_REQUEST = 1;
export const RISP_CMD = {
  OPERATION: 0x3fb, // 1019: start / pause / resume a job
  ALL_STATE: 0x3fd, // 1021: request (empty body) and its reply
  RECORD_PUSH: 0x3ff, // 1023: the box wrote a new visit or device record
  STATE_PUSH: 0x400, // 1024: unsolicited work-state change
  CONFIG_REQUEST: 0x9e7, // the box fetches its settings after a change
};

// Values of the operation request (what the app sends).
const OP_MODE = { clean: 1, level: 3 };
const OP_STATE = { start: 1, pause: 2, resume: 3 };

// Every command the integration can send, by service id.
export const SERVICES = {
  request_state: { kind: 'all-state' },
  start_clean: { kind: 'operation', opMode: OP_MODE.clean, opState: OP_STATE.start, moves: true },
  pause_clean: { kind: 'operation', opMode: OP_MODE.clean, opState: OP_STATE.pause, moves: false },
  resume_clean: { kind: 'operation', opMode: OP_MODE.clean, opState: OP_STATE.resume, moves: true },
  start_level: { kind: 'operation', opMode: OP_MODE.level, opState: OP_STATE.start, moves: true },
  pause_level: { kind: 'operation', opMode: OP_MODE.level, opState: OP_STATE.pause, moves: false },
  resume_level: { kind: 'operation', opMode: OP_MODE.level, opState: OP_STATE.resume, moves: true },
};

// Work mode and work state as reported by the box (state push numbering,
// which differs from the operation request numbering above).
export const WORK_MODES = {
  0: 'idle',
  1: 'resetting',
  2: 'cleaning',
  3: 'levelling',
  4: 'emptying',
  5: 'raking',
};
export const WORK_STATES = { 0: 'pending', 1: 'running', 2: 'blocked', 3: 'paused' };

const STATE_FIELDS = {
  1: 'w_mode',
  2: 'w_state',
  3: 'w_cause',
  4: 'toilet_state',
  5: 'foreign_state',
  6: 'weigh_state',
  7: 'lid_state',
  8: 'motor_state',
  9: 'key_state',
  10: 'object_state',
  11: 'camera_state',
  12: 'image_ctrl_state',
  13: 'pic_ctrl_state',
  14: 'update_state',
  15: 'hall_state',
  16: 'infrared_state',
  17: 'box_state',
  18: 'timestamp',
  19: 'weigh_sensor',
  20: 'led_state',
};

// --- protobuf primitives -----------------------------------------------------

/** Encode a non-negative integer (Number or BigInt) as a protobuf varint. */
export function encodeVarint(value) {
  let v = BigInt(value);
  if (v < 0n) throw new RangeError('varint must be non-negative');
  const out = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return Buffer.from(out);
}

function fieldVarint(number, value) {
  if (BigInt(value) === 0n) return Buffer.alloc(0);
  return Buffer.concat([encodeVarint((number << 3) | 0), encodeVarint(value)]);
}

function fieldBytes(number, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  if (bytes.length === 0) return Buffer.alloc(0);
  return Buffer.concat([encodeVarint((number << 3) | 2), encodeVarint(bytes.length), bytes]);
}

function decodeVarint(data, offset) {
  let value = 0n;
  let shift = 0n;
  for (;;) {
    if (offset >= data.length) throw new Error('truncated protobuf varint');
    const byte = data[offset];
    offset += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, offset];
    shift += 7n;
    if (shift >= 64n) throw new Error('protobuf varint too long');
  }
}

/** Decode a protobuf message into a flat list of { field, wire, value }. */
export function decodeFields(data) {
  const fields = [];
  let offset = 0;
  while (offset < data.length) {
    const [tag, next] = decodeVarint(data, offset);
    offset = next;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    let value;
    if (wire === 0) {
      const [v, after] = decodeVarint(data, offset);
      // Every field we read fits in a Number; larger values stay BigInt.
      value = v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
      offset = after;
    } else if (wire === 2) {
      const [len, after] = decodeVarint(data, offset);
      const end = after + Number(len);
      if (end > data.length) throw new Error('truncated protobuf bytes field');
      value = data.subarray(after, end);
      offset = end;
    } else if (wire === 1) {
      if (offset + 8 > data.length) throw new Error('truncated fixed64');
      value = data.readBigUInt64LE(offset);
      offset += 8;
    } else if (wire === 5) {
      if (offset + 4 > data.length) throw new Error('truncated fixed32');
      value = data.readUInt32LE(offset);
      offset += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
    fields.push({ field, wire, value });
  }
  return fields;
}

function first(fields, number, wire) {
  const found = fields.find((f) => f.field === number && (wire === undefined || f.wire === wire));
  return found ? found.value : undefined;
}

function firstString(fields, number) {
  const value = first(fields, number, 2);
  return Buffer.isBuffer(value) ? value.toString('utf8') : undefined;
}

// --- RISP frames -------------------------------------------------------------

/** CRC-8, poly 0x07, init 0, no reflection, xorout 0x55 (the app's libcrclib). */
export function crc8(data) {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc ^ 0x55;
}

export function buildRispFrame({ cmd, seq, body = Buffer.alloc(0) }) {
  const header = Buffer.concat([
    fieldVarint(1, RISP_DEV_LITTER_BOX),
    fieldVarint(2, cmd),
    fieldVarint(4, body.length),
    fieldVarint(5, RISP_ATTR_REQUEST),
    fieldVarint(7, seq),
  ]);
  const parts = [
    Buffer.from([RISP_START_BYTE, header.length]),
    header,
    Buffer.from([crc8(header)]),
  ];
  if (body.length > 0) parts.push(body, Buffer.from([crc8(body)]));
  return Buffer.concat(parts);
}

export function buildOperationBody(opMode, opState) {
  return Buffer.concat([fieldVarint(1, opMode), fieldVarint(2, opState)]);
}

/** Decode a RISP frame into { cmd, seq, attr, body }. CRCs are not enforced. */
export function parseRispFrame(frame) {
  if (frame.length < 3 || frame[0] !== RISP_START_BYTE) throw new Error('not a RISP frame');
  const headerEnd = 2 + frame[1];
  if (headerEnd >= frame.length) throw new Error('truncated RISP frame');
  const header = decodeFields(frame.subarray(2, headerEnd));
  const dataLen = Number(first(header, 4, 0) ?? 0);
  const bodyStart = headerEnd + 1;
  return {
    cmd: first(header, 2, 0),
    attr: first(header, 5, 0),
    seq: first(header, 7, 0),
    body: frame.subarray(bodyStart, bodyStart + dataLen),
  };
}

/** Decode the body of a state reply or state push into named fields. */
export function decodeStateBody(body) {
  const state = {};
  for (const { field, wire, value } of decodeFields(body)) {
    const name = STATE_FIELDS[field];
    if (name && wire === 0) state[name] = value;
  }
  // proto3 omits zero values: an absent field means 0.
  for (const key of ['w_mode', 'w_state', 'w_cause', 'toilet_state', 'foreign_state']) {
    state[key] ??= 0;
  }
  return state;
}

// --- IM envelope -------------------------------------------------------------

let nextSeq = 1 + Math.floor(Math.random() * 10000);
let gidCounter = Math.floor(Math.random() * 0xfffff);

function takeSeq() {
  const seq = nextSeq;
  nextSeq = nextSeq >= 0x7fff ? 1 : nextSeq + 1;
  return seq;
}

function generateCid(nowMs) {
  return `${nowMs}+${Math.floor((Math.random() * 9 + 1) * 100000)}`;
}

function generateGid(nowMs) {
  gidCounter = (gidCounter + 1) & 0xfffff;
  return ((BigInt(nowMs) << 20n) + BigInt(gidCounter)).toString();
}

/** Wrap a RISP frame in the IM message the broker routes from `fromUid` to `toUid`. */
export function encodeImMessage({ frame, fromUid, toUid, nowMs = Date.now() }) {
  const command = Buffer.concat([fieldVarint(1, COMMAND_PROTYPE_RISP), fieldBytes(2, frame)]);
  const bytesValue = fieldBytes(1, command);
  const any = Buffer.concat([fieldBytes(1, BYTES_VALUE_TYPE_URL), fieldBytes(2, bytesValue)]);
  const content = Buffer.concat([fieldBytes(1, 'custom'), fieldBytes(2, any)]);
  return Buffer.concat([
    fieldBytes(1, generateCid(nowMs)),
    fieldBytes(2, generateGid(nowMs)),
    fieldVarint(3, nowMs),
    fieldBytes(4, String(fromUid)),
    fieldBytes(5, String(toUid)),
    fieldBytes(7, content),
    fieldBytes(8, MESSAGE_PROTOCOL_VERSION),
  ]);
}

/** Build the MQTT payload for a service id (see SERVICES). */
export function buildServicePayload(serviceId, { fromUid, toUid, seq = takeSeq(), nowMs } = {}) {
  const service = SERVICES[serviceId];
  if (!service) throw new Error(`unknown service ${serviceId}`);
  const frame =
    service.kind === 'all-state'
      ? buildRispFrame({ cmd: RISP_CMD.ALL_STATE, seq })
      : buildRispFrame({
          cmd: RISP_CMD.OPERATION,
          seq,
          body: buildOperationBody(service.opMode, service.opState),
        });
  return encodeImMessage({ frame, fromUid, toUid, nowMs });
}

/**
 * Decode an incoming MQTT payload and say what it means:
 *   { type: 'state', fromUid, state }      work state of a box (reply or push)
 *   { type: 'record', fromUid }            a new visit/device record is on the cloud
 *   { type: 'config', fromUid }            the box picked up a settings change
 *   { type: 'online', uid, online }        a box went online/offline
 *   { type: 'kicked' }                     another login took our IM session
 *   { type: 'ignored', reason }
 */
export function classifyMessage(payload) {
  let fields;
  try {
    fields = decodeFields(payload);
    const fromUid = firstString(fields, 4);
    const content = first(fields, 7, 2);
    if (!Buffer.isBuffer(content)) return { type: 'ignored', reason: 'no content' };
    const contentFields = decodeFields(content);
    if (firstString(contentFields, 1) === 'receipt') return { type: 'ignored', reason: 'receipt' };
    const any = first(contentFields, 2, 2);
    if (!Buffer.isBuffer(any)) return { type: 'ignored', reason: 'no any' };
    const anyFields = decodeFields(any);
    const typeUrl = firstString(anyFields, 1);
    const value = first(anyFields, 2, 2);
    if (typeUrl === FORCE_OFFLINE_TYPE_URL) return { type: 'kicked' };
    if (typeUrl === RECEIPT_TYPE_URL) return { type: 'ignored', reason: 'receipt' };
    if (typeUrl === ONLINE_STATUS_TYPE_URL && Buffer.isBuffer(value)) {
      const status = decodeFields(value);
      const online = firstString(status, 1);
      if (online !== 'status/online' && online !== 'status/offline') {
        return { type: 'ignored', reason: 'unknown status' };
      }
      return { type: 'online', uid: firstString(status, 2), online: online === 'status/online' };
    }
    if (typeUrl !== BYTES_VALUE_TYPE_URL || !Buffer.isBuffer(value)) {
      return { type: 'ignored', reason: `type ${typeUrl}` };
    }
    const command = first(decodeFields(value), 1, 2);
    if (!Buffer.isBuffer(command)) return { type: 'ignored', reason: 'no command' };
    const frameBytes = first(decodeFields(command), 2, 2);
    if (!Buffer.isBuffer(frameBytes)) return { type: 'ignored', reason: 'no frame' };
    const frame = parseRispFrame(frameBytes);
    if (frame.cmd === RISP_CMD.STATE_PUSH || frame.cmd === RISP_CMD.ALL_STATE) {
      return { type: 'state', fromUid, state: decodeStateBody(frame.body) };
    }
    if (frame.cmd === RISP_CMD.RECORD_PUSH) return { type: 'record', fromUid };
    if (frame.cmd === RISP_CMD.CONFIG_REQUEST) return { type: 'config', fromUid };
    return { type: 'ignored', reason: `cmd ${frame.cmd}` };
  } catch (err) {
    return { type: 'ignored', reason: `decode error: ${err.message}` };
  }
}

/** Where the cat is, from a decoded state: 'inside' | 'nearby' | 'away'. */
export function petPosition(state) {
  if (!state) return undefined;
  if (state.toilet_state === 1) return 'inside';
  if (state.foreign_state === 1) return 'nearby';
  return 'away';
}
