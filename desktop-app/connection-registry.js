const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_ACTIVITY_EVENT_INTERVAL_MS = 1000;

function getClientDescriptor(userAgent = '') {
  const agent = typeof userAgent === 'string' ? userAgent : '';
  if (/TetherCam Android|Android/i.test(agent)) {
    const model = agent.match(/Android\s+[^;]+;\s*([^;)]+)/i)?.[1]?.trim();
    return { name: model || 'Android Device', platform: 'Android' };
  }
  if (/iPhone|iPad|iPod/i.test(agent)) return { name: 'iOS Device', platform: 'iOS' };
  if (/Windows/i.test(agent)) return { name: 'Windows Device', platform: 'Windows' };
  if (/Macintosh|Mac OS/i.test(agent)) return { name: 'Mac Device', platform: 'macOS' };
  if (/Linux/i.test(agent)) return { name: 'Linux Device', platform: 'Linux' };
  return { name: 'Mobile Web Receiver', platform: 'Web' };
}

function createConnectionRegistry({
  onEvent = () => {},
  staleConnectionMs = 120_000,
  activityEventIntervalMs = DEFAULT_ACTIVITY_EVENT_INTERVAL_MS,
  now = Date.now
} = {}) {
  if (typeof onEvent !== 'function' ||
      !Number.isSafeInteger(staleConnectionMs) || staleConnectionMs < 1 ||
      !Number.isSafeInteger(activityEventIntervalMs) || activityEventIntervalMs < 0 ||
      typeof now !== 'function') {
    throw new Error('Invalid connection registry configuration');
  }

  const clients = new Map();

  function snapshot(record) {
    return {
      id: record.id,
      name: record.name,
      platform: record.platform,
      state: record.state,
      connectedAt: record.connectedAt,
      lastActivityAt: record.lastActivityAt
    };
  }

  function publish(event, record) {
    const client = snapshot(record);
    onEvent(event, client);
  }

  return {
    register({ id, name, platform, connection, state = 'CONNECTED' }) {
      if (typeof id !== 'string' || !CLIENT_ID_PATTERN.test(id) ||
          typeof name !== 'string' || !name.trim() ||
          typeof platform !== 'string' || !platform.trim() ||
          !connection || typeof connection.terminate !== 'function') {
        throw new Error('Invalid client connection');
      }
      if (clients.has(id)) throw new Error('Client ID is already registered');
      const timestamp = now();
      const record = {
        id,
        name: name.trim(),
        platform: platform.trim(),
        state,
        connectedAt: timestamp,
        lastActivityAt: timestamp,
        lastActivityEventAt: timestamp,
        connection
      };
      clients.set(id, record);
      publish('client-connected', record);
      return snapshot(record);
    },

    touch(id, timestamp = now()) {
      const record = clients.get(id);
      if (!record) return null;
      record.lastActivityAt = timestamp;
      if (timestamp - record.lastActivityEventAt >= activityEventIntervalMs) {
        record.lastActivityEventAt = timestamp;
        publish('client-state-changed', record);
      }
      return snapshot(record);
    },

    setState(id, state, timestamp = now()) {
      const record = clients.get(id);
      if (!record) return null;
      const stateChanged = record.state !== state;
      record.state = state;
      record.lastActivityAt = timestamp;
      if (!stateChanged && timestamp - record.lastActivityEventAt < activityEventIntervalMs) {
        return snapshot(record);
      }
      record.lastActivityEventAt = timestamp;
      publish('client-state-changed', record);
      return snapshot(record);
    },

    remove(id, reason = 'closed') {
      const record = clients.get(id);
      if (!record) return null;
      clients.delete(id);
      const disconnected = {
        ...snapshot(record),
        state: 'DISCONNECTED',
        disconnectedAt: now(),
        reason
      };
      onEvent('client-disconnected', disconnected);
      return disconnected;
    },

    cleanupStale(timestamp = now()) {
      const staleIds = [];
      for (const record of clients.values()) {
        if (timestamp - record.lastActivityAt < staleConnectionMs) continue;
        staleIds.push(record.id);
      }
      for (const id of staleIds) {
        const record = clients.get(id);
        if (!record) continue;
        const connection = record.connection;
        this.remove(id, 'stale');
        connection.terminate();
      }
      return staleIds;
    },

    closeAll(reason = 'server-shutdown', { graceful = false } = {}) {
      const ids = Array.from(clients.keys());
      for (const id of ids) {
        const record = clients.get(id);
        if (!record) continue;
        const connection = record.connection;
        this.remove(id, reason);
        if (graceful && typeof connection.close === 'function') {
          connection.close(1001, reason);
        } else {
          connection.terminate();
        }
      }
      return ids;
    },

    get(id) {
      const record = clients.get(id);
      return record ? snapshot(record) : null;
    },

    list() {
      return Array.from(clients.values(), snapshot);
    },

    get size() {
      return clients.size;
    }
  };
}

module.exports = {
  CLIENT_ID_PATTERN,
  DEFAULT_ACTIVITY_EVENT_INTERVAL_MS,
  createConnectionRegistry,
  getClientDescriptor
};
