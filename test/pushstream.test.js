const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const PushStream = require('../pushstream.js');

test('buildWebSocketUrl includes protocol metadata and compatibility path', () => {
  const client = new PushStream('app-key', {
    appId: 'app-id',
    wsUrl: 'wss://ws.pushstream.online',
    client: 'test-client',
    version: '1.2.3',
  });

  const url = new URL(client.buildWebSocketUrl());

  assert.equal(url.origin, 'wss://ws.pushstream.online');
  assert.equal(url.pathname, '/app/app-key');
  assert.equal(url.searchParams.get('app_id'), 'app-id');
  assert.equal(url.searchParams.get('protocol'), 'pushstream-v1');
  assert.equal(url.searchParams.get('auth_version'), 'v1');
  assert.equal(url.searchParams.get('client'), 'test-client');
  assert.equal(url.searchParams.get('version'), '1.2.3');
});

test('signRequest produces backend-compatible query params', async () => {
  const client = new PushStream('public-key', {
    apiUrl: 'https://api.pushstream.online',
  });

  const body = JSON.stringify({
    name: 'order.created',
    channel: 'orders',
    data: JSON.stringify({ id: 1 }),
  });

  const query = await client.signRequest(
    'POST',
    '/api/apps/app-id/events',
    body,
    'public-key',
    'secret-key',
  );

  assert.equal(query.auth_key, 'public-key');
  assert.equal(query.auth_version, 'v1');
  assert.equal(query.body_md5, crypto.createHash('md5').update(body).digest('hex'));

  const canonical = ['auth_key', 'auth_timestamp', 'auth_version', 'body_md5']
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`)
    .join('&');
  const expected = crypto
    .createHmac('sha256', 'secret-key')
    .update(`POST\n/api/apps/app-id/events\n${canonical}`)
    .digest('hex');

  assert.equal(query.auth_signature, expected);
});

test('handleMessage tolerates malformed event payload strings', () => {
  const client = new PushStream('app-key', {
    wsUrl: 'wss://ws.pushstream.online',
  });

  const received = [];
  const channel = {
    handleEvent: (event, data) => received.push({ event, data }),
  };
  client.channels.set('orders', channel);

  client.handleMessage({
    channel: 'orders',
    event: 'order.created',
    data: '{not-json}',
  });

  assert.deepEqual(received, [
    { event: 'order.created', data: '{not-json}' },
  ]);
});

test('subscribeAuthenticated rejects invalid auth responses', async () => {
  const client = new PushStream('app-key', {
    wsUrl: 'wss://ws.pushstream.online',
    authEndpoint: 'https://api.pushstream.online/auth',
    fetch: async () => ({
      ok: true,
      json: async () => ({ invalid: true }),
    }),
  });

  client.socketId = '123.456';
  client.ws = { readyState: 1, send() {} };
  client.WebSocketImpl = { OPEN: 1 };

  await assert.rejects(
    client.subscribeAuthenticated('private-orders'),
    /Invalid channel auth response/,
  );
});

test('publish sends signed query and decodes success responses', async () => {
  let request;
  const client = new PushStream('public-key', {
    apiUrl: 'https://api.pushstream.online',
    fetch: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({ ok: true }),
      };
    },
  });

  const response = await client.publish('app-id', 'secret-key', 'public-orders', 'order.created', { id: 1 });

  assert.deepEqual(response, { ok: true });
  assert.match(request.url, /auth_signature=/);
  assert.equal(request.options.method, 'POST');
});

test('publish throws on non-2xx responses', async () => {
  const client = new PushStream('public-key', {
    apiUrl: 'https://api.pushstream.online',
    fetch: async () => ({
      ok: false,
      status: 422,
      text: async () => 'bad request',
    }),
  });

  await assert.rejects(
    client.publish('app-id', 'secret-key', 'public-orders', 'order.created', { id: 1 }),
    /HTTP 422/,
  );
});

test('reconnect notifies lifecycle callbacks and resubscribes stored channels', async () => {
  const sent = [];
  const states = [];
  const reconnects = [];
  const errors = [];
  let authCalls = 0;

  const client = new PushStream('app-key', {
    wsUrl: 'wss://ws.pushstream.online',
    authEndpoint: 'https://api.pushstream.online/auth',
    onStateChange: (state) => states.push(state),
    onReconnectAttempt: (attempt) => reconnects.push(attempt),
    onError: (error) => errors.push(error),
    fetch: async () => {
      authCalls += 1;
      return {
        ok: true,
        json: async () => ({ auth: 'app-key:signed', channel_data: '{"user_id":"1"}' }),
      };
    },
  });

  client.WebSocketImpl = { OPEN: 1 };
  client.ws = { readyState: 1, send: (message) => sent.push(JSON.parse(message)) };
  client.socketId = '123.456';

  client.channels.set('public-orders', { name: 'public-orders', type: 'public' });
  client.channels.set('presence-orders', {
    name: 'presence-orders',
    type: 'presence',
    authOptions: { payload: { tenant: 'org-1' }, headers: { Authorization: 'Bearer token' } },
  });

  client.attemptReconnect = () => {
    reconnects.push('scheduled');
  };

  client.notifyStateChange('connected', { socketId: '123.456' });
  await client.resubscribeChannels();

  assert.ok(states.includes('connected'));
  assert.equal(authCalls, 1);
  assert.equal(sent[0].event, 'pusher:subscribe');
  assert.equal(sent[0].data.channel, 'public-orders');
  assert.equal(sent[1].data.channel, 'presence-orders');
  assert.equal(sent[1].data.auth, 'app-key:signed');
  assert.deepEqual(errors, []);
});
