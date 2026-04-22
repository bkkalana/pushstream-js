# PushStream JavaScript SDK

Realtime client for PushStream-compatible websocket connections, with an optional server-side publish helper for Node.js.

## Installation

```bash
npm install @pushstream/pushstream-js
```

## Safe Defaults

- No hosted production URL is hard-coded.
- Browser clients resolve websocket and API origins from the current page unless you pass explicit endpoints.
- Secret-bearing publish calls are blocked by default in browser environments.
- Logging is disabled by default.

## Browser Realtime Client

```html
<script src="pushstream.js"></script>
<script>
  const client = new PushStream('your-app-key', {
    appId: 'your-app-id',
    wsUrl: 'wss://ws.pushstream.online',
    authEndpoint: 'https://api.pushstream.online/api/apps/your-app-id/auth'
  });

  client.connect().then(() => {
    const channel = client.subscribe('public-orders');
    channel.bind('order.created', (data) => console.log(data));
  });
</script>
```

For private or presence channels use `subscribeAuthenticated(channelName)`.

## Node.js Publish Helper

```javascript
const PushStream = require('@pushstream/pushstream-js');

const client = new PushStream('your-app-key', {
  apiUrl: 'https://api.pushstream.online',
});

await client.publish(
  'your-app-id',
  process.env.PUSHSTREAM_APP_SECRET,
  'public-orders',
  'order.created',
  { id: 1 }
);
```

`publish()` uses the current PushStream signing contract:

- `auth_key`
- `auth_timestamp`
- `auth_version`
- `body_md5`
- `auth_signature`

## Constructor

```javascript
new PushStream(appKey, {
  appId,
  wsUrl,
  apiUrl,
  authEndpoint,
  authHeaders,
  protocol,
  authVersion,
  client,
  version,
  maxReconnectAttempts,
  requestTimeoutMs,
  enableLogging,
  allowClientPublish
})
```

## Notes

- `subscribe()` is for public channels.
- `subscribeAuthenticated()` is for private and presence channels.
- Do not expose app secrets in browser code.

## Testing

```bash
npm test
```
