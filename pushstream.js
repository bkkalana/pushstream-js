class PushStream {
  constructor(appKey, options = {}) {
    this.appKey = appKey;
    this.appId = options.appId || null;
    this.apiUrl = this.resolveApiUrl(options.apiUrl);
    this.wsUrl = this.resolveWsUrl(options.wsUrl);
    this.authEndpoint = options.authEndpoint || null;
    this.authHeaders = options.authHeaders || {};
    this.protocol = options.protocol || 'pushstream-v1';
    this.authVersion = options.authVersion || 'v1';
    this.clientName = options.client || 'pushstream-js';
    this.clientVersion = options.version || '2.1.0';
    this.maxReconnectAttempts = Number.isInteger(options.maxReconnectAttempts) ? options.maxReconnectAttempts : 5;
    this.enableLogging = options.enableLogging === true;
    this.allowClientPublish = options.allowClientPublish === true;
    this.requestTimeoutMs = Number.isInteger(options.requestTimeoutMs) ? options.requestTimeoutMs : 10000;
    this.fetchImpl = options.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    this.WebSocketImpl = options.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : null;
    this.onError = typeof options.onError === 'function' ? options.onError : null;
    this.onReconnectAttempt = typeof options.onReconnectAttempt === 'function' ? options.onReconnectAttempt : null;
    this.ws = null;
    this.socketId = null;
    this.channels = new Map();
    this.reconnectAttempts = 0;
    this.pingInterval = null;
    this.manualDisconnect = false;
  }

  resolveApiUrl(apiUrl) {
    if (apiUrl) {
      return this.validateHttpUrl(apiUrl, 'apiUrl');
    }

    if (typeof window !== 'undefined' && window.location && window.location.origin) {
      return window.location.origin;
    }

    return null;
  }

  resolveWsUrl(wsUrl) {
    if (wsUrl) {
      return this.validateWsUrl(wsUrl, 'wsUrl');
    }

    if (typeof window !== 'undefined' && window.location) {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${window.location.host}`;
    }

    return null;
  }

  validateHttpUrl(url, fieldName) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`${fieldName} must use http or https`);
    }
    return parsed.toString().replace(/\/$/, '');
  }

  validateWsUrl(url, fieldName) {
    const parsed = new URL(url);
    if (!['ws:', 'wss:'].includes(parsed.protocol)) {
      throw new Error(`${fieldName} must use ws or wss`);
    }
    return parsed.toString().replace(/\/$/, '');
  }

  log(level, message, meta) {
    if (!this.enableLogging) {
      return;
    }

    const logger = typeof console !== 'undefined' ? console[level] || console.log : null;
    if (!logger) {
      return;
    }

    if (meta === undefined) {
      logger(`[PushStream] ${message}`);
      return;
    }

    logger(`[PushStream] ${message}`, meta);
  }

  notifyStateChange(state, meta) {
    this.log('info', `State changed: ${state}`, meta);
    if (this.onStateChange) {
      this.onStateChange(state, meta || {});
    }
  }

  notifyError(error) {
    this.log('error', error.message || String(error));
    if (this.onError) {
      this.onError(error);
    }
  }

  buildWebSocketUrl() {
    if (!this.wsUrl) {
      throw new Error('wsUrl is required outside a browser environment');
    }
    if (!this.appKey) {
      throw new Error('appKey is required');
    }

    const url = new URL(`/app/${this.appKey}`, this.wsUrl);
    url.searchParams.set('protocol', this.protocol);
    url.searchParams.set('auth_version', this.authVersion);
    url.searchParams.set('client', this.clientName);
    url.searchParams.set('version', this.clientVersion);

    if (this.appId) {
      url.searchParams.set('app_id', this.appId);
    }

    return url.toString();
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (!this.WebSocketImpl) {
        const error = new Error('WebSocket implementation is not available');
        this.notifyError(error);
        reject(error);
        return;
      }

      let settled = false;
      this.manualDisconnect = false;

      try {
        this.ws = new this.WebSocketImpl(this.buildWebSocketUrl());
      } catch (error) {
        this.notifyError(error);
        reject(error);
        this.attemptReconnect();
        return;
      }

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          const error = new Error('Connection timeout');
          this.notifyError(error);
          reject(error);
          this.attemptReconnect();
        }
      }, this.requestTimeoutMs);

      this.ws.onopen = () => {
        this.notifyStateChange('transport_open');
        this.reconnectAttempts = 0;
        this.startPingInterval();
      };

      this.ws.onmessage = (event) => {
        const message = this.safeJsonParse(event.data);
        if (!message) {
          this.log('warn', 'Ignored malformed websocket payload');
          return;
        }

        if (message.event === 'pusher:connection_established') {
          const data = this.safeJsonParse(message.data);
          if (!data || !data.socket_id) {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              const error = new Error('Invalid connection_established payload');
              this.notifyError(error);
              reject(error);
            }
            return;
          }

          this.socketId = data.socket_id;
          this.notifyStateChange('connected', { socketId: this.socketId });
          this.resubscribeChannels().catch((error) => this.notifyError(error));
          clearTimeout(timeout);
          if (!settled) {
            settled = true;
            resolve(this.socketId);
          }
          return;
        }

        if (message.event === 'pusher:error') {
          const errorPayload = this.safeJsonParse(message.data) || message.data;
          this.log('error', 'Realtime error', errorPayload);
          this.notifyError(errorPayload instanceof Error ? errorPayload : new Error(typeof errorPayload === 'string' ? errorPayload : 'Realtime error'));
          return;
        }

        this.handleMessage(message);
      };

      this.ws.onclose = (event) => {
        clearTimeout(timeout);
        this.stopPingInterval();
        this.socketId = null;
        this.notifyStateChange('disconnected', { code: event.code, reason: event.reason });

        if (!settled) {
          settled = true;
          const error = new Error(`WebSocket closed before handshake completed (${event.code})`);
          this.notifyError(error);
          reject(error);
        }

        if (!this.manualDisconnect) {
          this.attemptReconnect();
        }
      };

      this.ws.onerror = (error) => {
        clearTimeout(timeout);
        this.notifyError(error instanceof Error ? error : new Error('WebSocket error'));
        if (!settled) {
          settled = true;
          reject(error instanceof Error ? error : new Error('WebSocket error'));
        }
      };
    });
  }

  attemptReconnect() {
    if (this.manualDisconnect) {
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log('error', 'Max reconnection attempts reached');
      return;
    }

    const baseDelay = Math.min(1000 * (2 ** this.reconnectAttempts), 30000);
    const jitter = Math.floor(Math.random() * 250);
    this.reconnectAttempts += 1;

    if (this.onReconnectAttempt) {
      this.onReconnectAttempt(this.reconnectAttempts, baseDelay + jitter);
    }
    this.notifyStateChange('reconnecting', { attempt: this.reconnectAttempts, delayMs: baseDelay + jitter });
    setTimeout(() => {
      this.connect().catch(() => {});
    }, baseDelay + jitter);
  }

  subscribe(channelName) {
    if (!this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) {
      throw new Error('Not connected');
    }

    if ((channelName.startsWith('private-') || channelName.startsWith('presence-')) && !this.authEndpoint) {
      throw new Error('authEndpoint is required for private and presence channels');
    }

    const channel = new Channel(channelName, this, { type: 'public' });
    this.channels.set(channelName, channel);

    if (channelName.startsWith('private-') || channelName.startsWith('presence-')) {
      throw new Error('Use subscribeAuthenticated() for private and presence channels');
    }

    this.send({
      event: 'pusher:subscribe',
      data: { channel: channelName },
    });

    return channel;
  }

  async subscribeAuthenticated(channelName, authOptions = {}) {
    if (!this.socketId) {
      throw new Error('socketId is not available before authentication');
    }

    if (!this.authEndpoint) {
      throw new Error('authEndpoint is required');
    }

    const channel = new Channel(channelName, this, {
      type: channelName.startsWith('presence-') ? 'presence' : 'private',
      authOptions,
    });
    const authPayload = await this.authorizeChannel(channelName, authOptions);
    this.channels.set(channelName, channel);

    this.send({
      event: 'pusher:subscribe',
      data: {
        channel: channelName,
        auth: authPayload.auth,
        ...(authPayload.channel_data ? { channel_data: authPayload.channel_data } : {}),
      },
    });

    return channel;
  }

  async resubscribeChannels() {
    const channels = Array.from(this.channels.values());
    if (!this.socketId || channels.length === 0) {
      return;
    }

    for (const channel of channels) {
      if (channel.type === 'public') {
        this.send({
          event: 'pusher:subscribe',
          data: { channel: channel.name },
        });
        continue;
      }

      const authPayload = await this.authorizeChannel(channel.name, channel.authOptions || {});
      this.send({
        event: 'pusher:subscribe',
        data: {
          channel: channel.name,
          auth: authPayload.auth,
          ...(authPayload.channel_data ? { channel_data: authPayload.channel_data } : {}),
        },
      });
    }
  }

  async authorizeChannel(channelName, authOptions = {}) {
    if (!this.fetchImpl) {
      throw new Error('fetch implementation is not available');
    }

    const payload = {
      socket_id: this.socketId,
      channel_name: channelName,
      ...authOptions.payload,
    };

    const response = await this.fetchImpl(this.authEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
        ...(authOptions.headers || {}),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Channel auth failed with HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!data || typeof data.auth !== 'string') {
      throw new Error('Invalid channel auth response');
    }

    return data;
  }

  unsubscribe(channelName) {
    this.send({
      event: 'pusher:unsubscribe',
      data: { channel: channelName },
    });
    this.channels.delete(channelName);
  }

  send(data) {
    if (this.ws && this.ws.readyState === this.WebSocketImpl.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  handleMessage(message) {
    const channel = this.channels.get(message.channel);
    if (!channel) {
      return;
    }

    const eventData = typeof message.data === 'string'
      ? this.safeJsonParse(message.data) ?? message.data
      : message.data;

    channel.handleEvent(message.event, eventData);
  }

  startPingInterval() {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === this.WebSocketImpl.OPEN) {
        this.send({ event: 'pusher:ping', data: {} });
      }
    }, 30000);
  }

  stopPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  disconnect() {
    this.manualDisconnect = true;
    this.stopPingInterval();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.socketId = null;
  }

  async publish(appId, appSecret, channel, event, data, options = {}) {
    if (typeof window !== 'undefined' && !this.allowClientPublish) {
      throw new Error('Client-side publish is disabled by default because it requires an app secret');
    }

    if (!this.fetchImpl) {
      throw new Error('fetch implementation is not available');
    }

    if (!this.apiUrl) {
      throw new Error('apiUrl is required');
    }

    const body = JSON.stringify({
      name: event,
      channel,
      data: typeof data === 'string' ? data : JSON.stringify(data),
      ...(options.socketId ? { socket_id: options.socketId } : {}),
    });

    const path = `/api/apps/${appId}/events`;
    const query = await this.signRequest('POST', path, body, this.appKey, appSecret);
    const response = await this.fetchWithTimeout(`${this.apiUrl}${path}?${new URLSearchParams(query).toString()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    return response.json();
  }

  async signRequest(method, path, body, appKey, appSecret) {
    const query = {
      auth_key: appKey,
      auth_timestamp: String(Math.floor(Date.now() / 1000)),
      auth_version: this.authVersion,
    };

    if (body !== '') {
      query.body_md5 = await this.md5(body);
    }

    const sortedKeys = Object.keys(query).sort();
    const canonicalQuery = sortedKeys
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`)
      .join('&');

    query.auth_signature = await this.hmacSha256(`${method.toUpperCase()}\n${path}\n${canonicalQuery}`, appSecret);
    return query;
  }

  async fetchWithTimeout(url, options) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller
      ? setTimeout(() => controller.abort(), this.requestTimeoutMs)
      : null;

    try {
      return await this.fetchImpl(url, {
        ...options,
        ...(controller ? { signal: controller.signal } : {}),
      });
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  safeJsonParse(value) {
    if (typeof value !== 'string') {
      return value;
    }

    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  async md5(message) {
    if (typeof window === 'undefined') {
      const crypto = require('crypto');
      return crypto.createHash('md5').update(message).digest('hex');
    }

    throw new Error('MD5 hashing for publish signing is only supported in server-side JavaScript');
  }

  async hmacSha256(message, secret) {
    if (typeof window === 'undefined') {
      const crypto = require('crypto');
      return crypto.createHmac('sha256', secret).update(message).digest('hex');
    }

    throw new Error('HMAC signing for publish requests is only supported in server-side JavaScript');
  }
}

class Channel {
  constructor(name, client, options = {}) {
    this.name = name;
    this.client = client;
    this.type = options.type || 'public';
    this.authOptions = options.authOptions || null;
    this.eventHandlers = new Map();
  }

  bind(event, callback) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event).push(callback);
    return this;
  }

  unbind(event, callback) {
    if (!this.eventHandlers.has(event)) {
      return this;
    }

    if (callback) {
      const handlers = this.eventHandlers.get(event);
      const index = handlers.indexOf(callback);
      if (index > -1) {
        handlers.splice(index, 1);
      }
      return this;
    }

    this.eventHandlers.delete(event);
    return this;
  }

  handleEvent(event, data) {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) {
      return;
    }

    handlers.forEach((handler) => handler(data));
  }

  unsubscribe() {
    this.client.unsubscribe(this.name);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PushStream;
}

if (typeof window !== 'undefined') {
  window.PushStream = PushStream;
}
