import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CloudApi,
  CloudAuthError,
  CloudError,
  CloudRevokedError,
  accountTypeCandidates,
  signHeader,
} from '../src/cloudApi.js';

const md5 = (s) => createHash('md5').update(s).digest('hex');

/** fetch stub answering from a list of handlers, recording every call. */
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const { pathname, search } = new URL(url);
    const call = {
      path: pathname + search,
      method: init.method,
      headers: init.headers,
      body: init.body && JSON.parse(init.body),
    };
    calls.push(call);
    const route = routes.find(
      (r) => call.path.startsWith(r.path) && (!r.method || r.method === init.method),
    );
    if (!route) return new Response(JSON.stringify({ code: 404 }), { status: 404 });
    const answer = typeof route.answer === 'function' ? route.answer(call, calls) : route.answer;
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  };
  return { fetch, calls };
}

const TIMESTAMP = {
  path: '/v1/client-auth-service/api/timestamp',
  answer: { body: { timestamp: 1_780_000_000 } },
};
const LOGIN_OK = {
  path: '/user-service-rest/v2/user/login',
  answer: {
    body: { token: { token: 'tok', expireAt: Date.now() + 86_400_000 }, user: { userId: 77 } },
  },
};

const makeApi = (fetch) =>
  new CloudApi({
    baseUrl: 'https://apis-eu.airrobo-home.com/',
    account: 'cat@example.com',
    password: 'secret',
    country: 'CH',
    appId: 'APPID',
    appKey: 'APPKEY',
    product: 'PROD',
    clientId: 'client123',
    fetch,
  });

test('sign header is md5(ts + key + nonce + client) ts nonce v2', () => {
  const header = signHeader({ appKey: 'K', clientId: 'C', nowMs: 1000, nonce: 'abcdefghij' });
  assert.equal(header, `${md5('1000Kabcdefghij' + 'C')} 1000 abcdefghij v2`);
});

test('account types: e-mail first for an address, phone first otherwise', () => {
  assert.deepEqual(accountTypeCandidates('a@b.c'), ['1', '0', '2']);
  assert.deepEqual(accountTypeCandidates('+41790000000'), ['0', '1', '2']);
});

test('login sends the hashed password and signed headers, then authorized calls carry the token', async () => {
  const { fetch, calls } = fakeFetch([
    TIMESTAMP,
    LOGIN_OK,
    {
      path: '/user-service-rest/v2/robot/common/device/list',
      answer: { body: { code: 0, data: [{ serialNumber: 'SN1' }] } },
    },
  ]);
  const api = makeApi(fetch);
  const devices = await api.getDevices();
  assert.deepEqual(devices, [{ serialNumber: 'SN1' }]);
  const login = calls.find((c) => c.path.includes('/login'));
  assert.deepEqual(login.body, {
    account: 'cat@example.com',
    password: md5('secret'),
    accountType: '1',
    areaCode: 'CH',
  });
  assert.equal(login.headers['x-ubt-appid'], 'APPID');
  assert.equal(login.headers['x-ubt-deviceid'], 'client123');
  assert.match(login.headers['x-ubt-sign'], /^[0-9a-f]{32} \d{13} [0-9a-f-]{10} v2$/);
  assert.equal(login.headers.authorization, undefined);
  const list = calls.at(-1);
  assert.equal(list.headers.authorization, 'tok');
  assert.equal(list.headers.product, 'PROD');
  assert.equal(api.loginCount, 1);
  assert.equal(api.hostname, 'apis-eu.airrobo-home.com');
});

test('a wrong password is an auth error after trying every account type', async () => {
  const { fetch, calls } = fakeFetch([
    TIMESTAMP,
    {
      path: '/user-service-rest/v2/user/login',
      answer: { status: 400, body: { code: 2002, message: 'bad' } },
    },
  ]);
  await assert.rejects(makeApi(fetch).login(), CloudAuthError);
  assert.equal(calls.filter((c) => c.path.includes('/login')).length, 3);
});

test('an expired token is renewed once, a revoked one is reported', async () => {
  let listCalls = 0;
  const { fetch } = fakeFetch([
    TIMESTAMP,
    LOGIN_OK,
    {
      path: '/catbox-server/box/config/box-use-times/',
      answer: () =>
        ++listCalls === 1
          ? { status: 401, body: {} }
          : { body: { code: 0, data: { boxUseTimes: 3 } } },
    },
  ]);
  const api = makeApi(fetch);
  await api.login();
  api.auth.loggedInAt -= 60 * 60_000; // logged in an hour ago: a 401 is a plain expiry
  assert.deepEqual(await api.getBoxUseTimes('SN1'), { boxUseTimes: 3 });
  assert.equal(api.loginCount, 2);

  const revoked = makeApi(
    fakeFetch([TIMESTAMP, LOGIN_OK, { path: '/catbox-server', answer: { status: 401, body: {} } }])
      .fetch,
  );
  // 401 right after our own login: someone else holds the account.
  await assert.rejects(revoked.getBoxUseTimes('SN1'), CloudRevokedError);
});

test('API error codes and unexpected answers surface as CloudError', async () => {
  const { fetch } = fakeFetch([
    TIMESTAMP,
    LOGIN_OK,
    {
      path: '/user-service-rest/v2/robot/common/device/list',
      answer: { body: { code: 5000, message: 'boom' } },
    },
    {
      path: '/catbox-server/web/box/record/new',
      answer: { body: { code: 0, data: { records: [{ a: 1 }, null] } } },
    },
  ]);
  const api = makeApi(fetch);
  await assert.rejects(
    api.getDevices(),
    (err) => err instanceof CloudError && /5000/.test(err.message),
  );
  assert.deepEqual(await api.getVisitRecords('SN1'), [{ a: 1 }]);
});

test('auto clean writes the switch with the delay in seconds', async () => {
  const { fetch, calls } = fakeFetch([
    TIMESTAMP,
    LOGIN_OK,
    {
      path: '/catbox-server/box/config/switch/update',
      method: 'PUT',
      answer: { body: { code: 0 } },
    },
  ]);
  await makeApi(fetch).setAutoClean('SN1', true, 300);
  assert.deepEqual(calls.at(-1).body, {
    serialNumber: 'SN1',
    functionType: 2,
    controlSwitch: 1,
    optionInt: 300,
  });
});
