const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createConnectionRegistry,
  getClientDescriptor
} = require('../connection-registry');

const CLIENT_IDS = [
  'e7384ed3-f66a-4caf-98e2-e6d26bc8f501',
  'e7384ed3-f66a-4caf-98e2-e6d26bc8f502',
  'e7384ed3-f66a-4caf-98e2-e6d26bc8f503'
];

function createSocket() {
  return { terminated: false, terminate() { this.terminated = true; } };
}

test('registry tracks three independent clients and removing one preserves the others', () => {
  const events = [];
  let currentTime = 1000;
  const registry = createConnectionRegistry({
    now: () => currentTime,
    onEvent: (event, client) => events.push({ event, client })
  });
  const sockets = CLIENT_IDS.map(createSocket);

  CLIENT_IDS.forEach((id, index) => {
    registry.register({
      id,
      name: `Device ${index + 1}`,
      platform: index === 0 ? 'Android' : 'Web',
      connection: sockets[index]
    });
    currentTime += 1;
  });

  assert.equal(registry.size, 3);
  assert.deepEqual(registry.list().map((client) => client.id), CLIENT_IDS);
  assert.equal(registry.remove(CLIENT_IDS[1]).state, 'DISCONNECTED');
  assert.equal(registry.size, 2);
  assert.ok(registry.get(CLIENT_IDS[0]));
  assert.equal(registry.get(CLIENT_IDS[1]), null);
  assert.ok(registry.get(CLIENT_IDS[2]));
  assert.equal(sockets[0].terminated, false);
  assert.equal(sockets[1].terminated, false);
  assert.equal(sockets[2].terminated, false);
  assert.equal(events.filter(({ event }) => event === 'client-connected').length, 3);
  assert.equal(events.filter(({ event }) => event === 'client-disconnected').length, 1);
  assert.equal(events.at(-1).client.id, CLIENT_IDS[1]);
});

test('connection metadata is independent, activity and state updates target only their client', () => {
  let currentTime = 1000;
  const events = [];
  const registry = createConnectionRegistry({
    now: () => currentTime,
    onEvent: (event, client) => events.push({ event, client })
  });
  for (const [index, id] of CLIENT_IDS.entries()) {
    registry.register({
      id,
      name: `Device ${index + 1}`,
      platform: `Platform ${index + 1}`,
      connection: createSocket()
    });
  }

  currentTime = 3000;
  registry.touch(CLIENT_IDS[2]);
  registry.setState(CLIENT_IDS[1], 'TRANSFERRING');

  assert.equal(registry.get(CLIENT_IDS[0]).state, 'CONNECTED');
  assert.equal(registry.get(CLIENT_IDS[0]).lastActivityAt, 1000);
  assert.equal(registry.get(CLIENT_IDS[1]).state, 'TRANSFERRING');
  assert.equal(registry.get(CLIENT_IDS[1]).connectedAt, 1000);
  assert.equal(registry.get(CLIENT_IDS[1]).lastActivityAt, 3000);
  assert.equal(registry.get(CLIENT_IDS[2]).state, 'CONNECTED');
  assert.equal(registry.get(CLIENT_IDS[2]).lastActivityAt, 3000);
  assert.equal('connection' in registry.get(CLIENT_IDS[0]), false);
  assert.equal(events.at(-1).client.id, CLIENT_IDS[1]);
  assert.equal(events.at(-1).client.state, 'TRANSFERRING');
});

test('stale cleanup terminates and removes only expired clients', () => {
  const events = [];
  const sockets = CLIENT_IDS.map(createSocket);
  const registry = createConnectionRegistry({
    staleConnectionMs: 10_000,
    activityEventIntervalMs: 0,
    now: () => 1000,
    onEvent: (event, client) => events.push({ event, client })
  });
  CLIENT_IDS.forEach((id, index) => registry.register({
    id,
    name: `Device ${index + 1}`,
    platform: 'Web',
    connection: sockets[index]
  }));

  registry.touch(CLIENT_IDS[1], 9000);
  const removedIds = registry.cleanupStale(11_000);

  assert.deepEqual(removedIds, [CLIENT_IDS[0], CLIENT_IDS[2]]);
  assert.equal(registry.size, 1);
  assert.ok(registry.get(CLIENT_IDS[1]));
  assert.equal(sockets[0].terminated, true);
  assert.equal(sockets[1].terminated, false);
  assert.equal(sockets[2].terminated, true);
  assert.deepEqual(
    events.filter(({ event }) => event === 'client-disconnected').map(({ client }) => client.id),
    [CLIENT_IDS[0], CLIENT_IDS[2]]
  );
});

test('repeated removal and duplicate IDs do not emit duplicate events or corrupt other clients', () => {
  const events = [];
  const registry = createConnectionRegistry({
    onEvent: (event, client) => events.push({ event, client })
  });
  const connection = createSocket();
  registry.register({
    id: CLIENT_IDS[0],
    name: 'First',
    platform: 'Web',
    connection
  });

  assert.throws(() => registry.register({
    id: CLIENT_IDS[0],
    name: 'Duplicate',
    platform: 'Web',
    connection: createSocket()
  }));
  assert.ok(registry.remove(CLIENT_IDS[0]));
  assert.equal(registry.remove(CLIENT_IDS[0]), null);
  assert.equal(events.filter(({ event }) => event === 'client-disconnected').length, 1);
});

test('graceful close sends a close frame instead of terminating registered clients', () => {
  const events = [];
  const connection = {
    closed: false,
    terminated: false,
    close(code, reason) {
      this.closed = true;
      this.code = code;
      this.reason = reason;
    },
    terminate() {
      this.terminated = true;
    }
  };
  const registry = createConnectionRegistry({
    onEvent: (event, client) => events.push({ event, client })
  });
  registry.register({
    id: CLIENT_IDS[0],
    name: 'First',
    platform: 'Web',
    connection
  });

  assert.deepEqual(
    registry.closeAll('server-shutdown', { graceful: true }),
    [CLIENT_IDS[0]]
  );
  assert.equal(connection.closed, true);
  assert.equal(connection.terminated, false);
  assert.equal(connection.code, 1001);
  assert.equal(connection.reason, 'server-shutdown');
  assert.equal(registry.size, 0);
  assert.equal(events.at(-1).event, 'client-disconnected');
});

test('user-agent detection labels Android, iOS, desktop, and generic browser clients', () => {
  assert.deepEqual(getClientDescriptor('TetherCam Android'), {
    name: 'Android Device',
    platform: 'Android'
  });
  assert.equal(getClientDescriptor('Mozilla/5.0 (iPhone)').platform, 'iOS');
  assert.equal(getClientDescriptor('Mozilla/5.0 (Windows NT 10.0)').platform, 'Windows');
  assert.equal(getClientDescriptor('').platform, 'Web');
});

test('dashboard bridge and device panel consume per-client snapshots and events', () => {
  const fs = require('fs');
  const path = require('path');
  const desktopDirectory = path.join(__dirname, '..');
  const preload = fs.readFileSync(path.join(desktopDirectory, 'preload.js'), 'utf8');
  const dashboardScript = fs.readFileSync(path.join(desktopDirectory, 'public', 'pairing-ui.js'), 'utf8');

  assert.match(preload, /getConnectedClients/);
  assert.match(preload, /onClientStateChanged/);
  assert.match(dashboardScript, /getConnectedClients\(\)/);
  assert.match(dashboardScript, /client-disconnected/);
  assert.match(dashboardScript, /client\.platform/);
  assert.match(dashboardScript, /client\.connectedAt/);
  assert.match(dashboardScript, /client\.lastActivityAt/);
  assert.match(dashboardScript, /textContent\s*=/);
});
