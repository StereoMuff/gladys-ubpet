// -----------------------------------------------------------------------------
// UPET cloud REST client.
//
// Endpoints, signing and envelopes as reverse-engineered by the community
// Home Assistant integrations (CrazzyBerg/upet-hass and forks,
// edied2002/vividmoo-ha). Every request carries an X-UBT-Sign header:
//
//   md5(timestamp_ms + app_key + nonce + client_device_id) + " " + ts + " " + nonce + " v2"
//
// The vendor allows one session per account: logging in revokes the token and
// the MQTT session of any other login on the same account (the phone app
// included). That is why the integration logs in as rarely as possible and why
// the documentation recommends a second account the box is shared with.
// -----------------------------------------------------------------------------

import { createHash, randomUUID } from 'node:crypto';

// The API sits behind a filter that refuses unknown user agents.
const USER_AGENT = 'okhttp/4.10.0';
const REQUEST_TIMEOUT_MS = 20_000;
const SUCCESS_CODES = new Set([0, 200]);
const CODE_BAD_CREDENTIALS = 2002;
const CODE_UNKNOWN_USER = 2004;
const CODE_ILLEGAL_CLIENT = 1003;
// Re-login ahead of the token expiry.
const TOKEN_MARGIN_MS = 5 * 60_000;
// A 401 this soon after our own login means another login revoked the token.
const REVOKE_WINDOW_MS = 10 * 60_000;

/** Base error: network problems, unexpected answers. Retrying later may help. */
export class CloudError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'CloudError';
    this.status = status;
    this.code = code;
  }
}

/** The user has to act: wrong credentials, wrong region, rejected app identity. */
export class CloudAuthError extends CloudError {
  constructor(message, details) {
    super(message, details);
    this.name = 'CloudAuthError';
  }
}

/** Our token was revoked right after login: another login holds the account. */
export class CloudRevokedError extends CloudError {
  constructor(message, details) {
    super(message, details);
    this.name = 'CloudRevokedError';
  }
}

const md5 = (value) => createHash('md5').update(value, 'utf8').digest('hex');

export function signHeader({ appKey, clientId, nowMs, nonce = randomUUID().slice(0, 10) }) {
  return `${md5(`${nowMs}${appKey}${nonce}${clientId}`)} ${nowMs} ${nonce} v2`;
}

/** Account types the login endpoint knows (0 phone, 1 e-mail, 2 other), likeliest first. */
export function accountTypeCandidates(account) {
  return account.includes('@') ? ['1', '0', '2'] : ['0', '1', '2'];
}

export class CloudApi {
  /**
   * @param {object} options
   * @param {string} options.baseUrl regional API host
   * @param {string} options.account
   * @param {string} options.password
   * @param {string} options.country two-letter code sent as areaCode, may be empty
   * @param {string} options.appId
   * @param {string} options.appKey
   * @param {string} options.product
   * @param {string} options.clientId stable random id of this installation
   * @param {typeof fetch} [options.fetch]
   */
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.account = options.account;
    this.password = options.password;
    this.country = options.country;
    this.appId = options.appId;
    this.appKey = options.appKey;
    this.product = options.product;
    this.clientId = options.clientId;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.clockOffsetMs = 0;
    this.clockSynced = false;
    this.auth = null; // { token, expiresAt, userId, loggedInAt }
    this.loginCount = 0;
  }

  get hostname() {
    return new URL(this.baseUrl).hostname;
  }

  /** Make sure we hold a valid token; logs in when it is missing or expiring. */
  async ensureLogin() {
    const now = this.now();
    if (this.auth && (!this.auth.expiresAt || this.auth.expiresAt - now > TOKEN_MARGIN_MS)) {
      return this.auth;
    }
    return this.login();
  }

  async login() {
    await this.syncClock();
    let lastError;
    for (const accountType of accountTypeCandidates(this.account)) {
      try {
        const body = await this.request('PUT', '/user-service-rest/v2/user/login', {
          auth: false,
          json: {
            account: this.account,
            password: md5(this.password),
            accountType,
            ...(this.country ? { areaCode: this.country } : {}),
          },
          raw: true,
        });
        const payload = body?.token && typeof body.token === 'object' ? body : body?.data;
        const token = payload?.token?.token;
        if (typeof token !== 'string' || token.length === 0) {
          lastError = new CloudAuthError('Login answer contained no token');
          continue;
        }
        this.auth = {
          token,
          expiresAt: Number(payload.token.expireAt) || null,
          userId: payload.user?.userId ?? null,
          loggedInAt: this.now(),
        };
        this.loginCount += 1;
        return this.auth;
      } catch (err) {
        if (!(err instanceof CloudAuthError)) throw err;
        lastError = err;
      }
    }
    throw lastError ?? new CloudAuthError('Login failed');
  }

  /** Align the signing clock with the server (the app does the same). */
  async syncClock() {
    if (this.clockSynced) return;
    try {
      const data = await this.request('GET', '/v1/client-auth-service/api/timestamp', {
        auth: false,
        signed: false,
        raw: true,
      });
      const server = Number(data?.timestamp ?? data?.data);
      if (Number.isFinite(server) && server > 0) {
        const serverMs = server < 1e12 ? server * 1000 : server;
        this.clockOffsetMs = serverMs - Date.now();
      }
      this.clockSynced = true;
    } catch {
      // Local time is good enough when the endpoint is unavailable.
    }
  }

  async request(
    method,
    path,
    { json, auth = true, signed = true, raw = false, retried = false } = {},
  ) {
    const headers = {
      'user-agent': USER_AGENT,
      accept: 'application/json',
      'x-ubt-language': 'en',
    };
    if (signed) {
      headers['x-ubt-appid'] = this.appId;
      headers['x-ubt-deviceid'] = this.clientId;
      headers['x-ubt-sign'] = signHeader({
        appKey: this.appKey,
        clientId: this.clientId,
        nowMs: Date.now() + this.clockOffsetMs,
      });
    }
    if (auth) {
      await this.ensureLogin();
      headers.authorization = this.auth.token;
      headers.product = this.product;
    }
    if (json !== undefined) headers['content-type'] = 'application/json; charset=utf-8';

    let response;
    let text;
    try {
      response = await this.fetch(this.baseUrl + path, {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      text = await response.text();
    } catch (err) {
      throw new CloudError(
        `${method} ${path}: ${err.name === 'TimeoutError' ? 'timeout' : err.message}`,
      );
    }
    let body;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    const status = response.status;
    const code = body && typeof body === 'object' ? body.code : undefined;
    const message = body && typeof body === 'object' ? (body.message ?? body.msg) : undefined;

    if (status === 401 && auth) {
      const recentLogin = this.auth && this.now() - this.auth.loggedInAt < REVOKE_WINDOW_MS;
      this.auth = null;
      if (!retried && !recentLogin) {
        return this.request(method, path, { json, auth, signed, raw, retried: true });
      }
      throw new CloudRevokedError(
        'The cloud revoked our session, probably because the same account logged in elsewhere (the UPET app?)',
        { status },
      );
    }
    if (code === CODE_BAD_CREDENTIALS) {
      throw new CloudAuthError('Wrong account or password', { status, code });
    }
    if (code === CODE_UNKNOWN_USER) {
      throw new CloudAuthError('Unknown account on this server: check the region', {
        status,
        code,
      });
    }
    if (code === CODE_ILLEGAL_CLIENT) {
      throw new CloudAuthError('The cloud rejected the app identity (App ID / App key)', {
        status,
        code,
      });
    }
    if (status === 400 && path.includes('/login')) {
      throw new CloudAuthError(`Login refused (code ${code ?? 'none'})`, { status, code });
    }
    if (status >= 400) {
      throw new CloudError(`${method} ${path}: HTTP ${status}${message ? ` ${message}` : ''}`, {
        status,
        code,
      });
    }
    if (raw) return body;
    if (body && typeof body === 'object' && 'code' in body) {
      if (!SUCCESS_CODES.has(code)) {
        throw new CloudError(`${method} ${path}: code ${code}${message ? ` ${message}` : ''}`, {
          status,
          code,
        });
      }
      return body.data;
    }
    return body;
  }

  // --- endpoints -------------------------------------------------------------

  async getDevices() {
    const data = await this.request('GET', '/user-service-rest/v2/robot/common/device/list');
    if (!Array.isArray(data)) throw new CloudError('Unexpected device list');
    return data;
  }

  getAllConfig(serial) {
    return this.request(
      'GET',
      `/catbox-server/box/config/allConfig?serialNumber=${encodeURIComponent(serial)}`,
    );
  }

  getBoxUseTimes(serial) {
    return this.request(
      'GET',
      `/catbox-server/box/config/box-use-times/?serialNumber=${encodeURIComponent(serial)}`,
    );
  }

  resetBoxUseTimes(serial) {
    return this.request('PUT', '/catbox-server/box/config/box-use-times/reset', {
      json: { boxUseTimes: 0, serialNumber: serial },
    });
  }

  getDeodorantStatus(serial) {
    return this.request(
      'GET',
      `/catbox-server/app/deodorant-block/status?serialNumber=${encodeURIComponent(serial)}`,
    );
  }

  getOnline(serial) {
    return this.request(
      'GET',
      `/v1/ubtechinc-im-manager/im/online/device/?sn=${encodeURIComponent(serial)}`,
    );
  }

  /** Newest-first visit records (messageType 0). The server decides the page size. */
  async getVisitRecords(serial, size = 30) {
    const data = await this.request('POST', '/catbox-server/web/box/record/new', {
      json: { serialNumber: serial, size, messageType: 0 },
    });
    return Array.isArray(data?.records)
      ? data.records.filter((r) => r && typeof r === 'object')
      : [];
  }

  /** Auto clean after a visit: on/off and delay. The cloud stores the delay in seconds. */
  setAutoClean(serial, enabled, delaySeconds) {
    return this.request('PUT', '/catbox-server/box/config/switch/update', {
      json: {
        serialNumber: serial,
        functionType: 2,
        controlSwitch: enabled ? 1 : 0,
        optionInt: delaySeconds,
      },
    });
  }

  /** MQTT credentials of the account's IM identity. */
  async getImCredentials() {
    const data = await this.request('POST', '/v1/ubtechinc-im-manager/im/login', {
      json: { type: 2 },
    });
    for (const key of ['clientId', 'mqttUserName', 'mqttPassword', 'pubTopic', 'subTopic']) {
      if (!data?.[key]) throw new CloudError(`IM login answer has no ${key}`);
    }
    return data;
  }

  /** IM contacts: each box is a contact whose userName is its serial number. */
  async getImContacts() {
    const data = await this.request('GET', '/v1/ubtechinc-im-manager/im/friends');
    return Array.isArray(data) ? data : [];
  }
}
