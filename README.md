# PushStream JavaScript SDK

Real-time messaging SDK for JavaScript/Node.js applications.

## Installation

```bash
npm install @ceylonitsolutions/pushstream-js
```

## Quick Start

### Browser

```html
<script src="pushstream.js"></script>
<script>
  const client = new PushStream('your-app-key');
  
  client.connect().then(socketId => {
    console.log('Connected:', socketId);
    
    const channel = client.subscribe('my-channel');
    channel.bind('my-event', (data) => {
      console.log('Received:', data);
    });
  });
</script>
```

### Node.js

```javascript
const PushStream = require('@ceylonitsolutions/pushstream-js');

const client = new PushStream('your-app-key');

client.connect().then(socketId => {
  console.log('Connected:', socketId);
  
  const channel = client.subscribe('my-channel');
  channel.bind('my-event', (data) => {
    console.log('Received:', data);
  });
});
```

## Configuration

```javascript
const client = new PushStream('your-app-key', {
  wsUrl: 'wss://ws.pushstream.ceylonitsolutions.online',
  apiUrl: 'https://api.pushstream.ceylonitsolutions.online'
});
```

## API Reference

### Client Methods

#### `connect()`
Establishes WebSocket connection.

```javascript
client.connect()
  .then(socketId => console.log('Connected'))
  .catch(error => console.error('Failed to connect'));
```

#### `subscribe(channelName)`
Subscribe to a channel.

```javascript
const channel = client.subscribe('my-channel');
```

#### `unsubscribe(channelName)`
Unsubscribe from a channel.

```javascript
client.unsubscribe('my-channel');
```

#### `disconnect()`
Close the connection.

```javascript
client.disconnect();
```

#### `publish(appId, appSecret, channel, event, data)`
Publish events via REST API.

```javascript
await client.publish(
  'app-id',
  'app-secret',
  'my-channel',
  'my-event',
  { message: 'Hello' }
);
```

### Channel Methods

#### `bind(event, callback)`
Listen for events on the channel.

```javascript
channel.bind('my-event', (data) => {
  console.log(data);
});
```

#### `unbind(event, callback)`
Remove event listener.

```javascript
channel.unbind('my-event', callback);
```

#### `unsubscribe()`
Unsubscribe from the channel.

```javascript
channel.unsubscribe();
```

## Features

- WebSocket real-time messaging
- Automatic reconnection with exponential backoff
- Channel subscriptions
- Event binding
- REST API publishing
- Browser and Node.js support

## Requirements

- Node.js >= 14.0.0 (for Node.js usage)
- Modern browser with WebSocket support

## License

MIT

## Author

Ceylon IT Solutions
