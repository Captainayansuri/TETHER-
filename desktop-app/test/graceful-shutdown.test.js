const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');
const { createGracefulShutdown } = require('../graceful-shutdown');

test('shutdown informs clients, drains writes, cleans up, persists, then closes peers', async () => {
  const steps = [];
  const shutdown = createGracefulShutdown({
    stopAccepting: () => { steps.push('stop-accepting'); },
    notifyClients: async () => { steps.push('notify-clients'); },
    stopQueueAdmission: () => { steps.push('stop-admission'); },
    drainQueue: async () => { steps.push('drain-queue'); },
    closeTransfers: async () => { steps.push('close-transfers'); },
    persistState: async () => { steps.push('persist-state'); },
    closeClients: async () => { steps.push('close-clients'); },
    timeoutMs: 100
  });

  const first = shutdown();
  const second = shutdown();
  assert.equal(first, second);
  await first;
  assert.deepEqual(steps, [
    'stop-accepting',
    'notify-clients',
    'stop-admission',
    'drain-queue',
    'close-clients',
    'close-transfers',
    'persist-state'
  ]);
});

test('shutdown timeouts still clean transfers and force peer/server closure', async () => {
  const steps = [];
  const timeouts = [];
  const shutdown = createGracefulShutdown({
    stopAccepting: () => new Promise(() => {}),
    notifyClients: () => { steps.push('notify'); },
    stopQueueAdmission: () => { steps.push('stop-admission'); },
    drainQueue: () => new Promise(() => {}),
    closeTransfers: () => { steps.push('close-transfers'); },
    persistState: () => { steps.push('persist-state'); },
    closeClients: () => new Promise(() => {}),
    forceCloseClients: () => { steps.push('force-clients'); },
    forceCloseServer: () => { steps.push('force-server'); },
    timeoutMs: 5,
    onTimeout: (stage) => timeouts.push(stage)
  });

  await shutdown();
  assert.deepEqual(steps, [
    'notify',
    'stop-admission',
    'force-clients',
    'close-transfers',
    'persist-state',
    'force-server'
  ]);
  assert.deepEqual(timeouts, ['drain_queue', 'close_clients', 'close_servers']);
});

test('shutdown reports failed steps and continues remaining cleanup', async () => {
  const completed = [];
  const errors = [];
  const shutdown = createGracefulShutdown({
    stopAccepting: () => {},
    notifyClients: () => { throw Object.assign(new Error('send failure'), { code: 'EIO' }); },
    stopQueueAdmission: () => { completed.push('stop-admission'); },
    drainQueue: () => {},
    closeTransfers: () => { completed.push('close-transfers'); },
    persistState: () => { completed.push('persist-state'); },
    closeClients: () => { completed.push('close-clients'); },
    timeoutMs: 100,
    onError: (stage, error) => errors.push([stage, error.code])
  });

  await shutdown();
  assert.deepEqual(errors, [['notify_clients', 'EIO']]);
  assert.deepEqual(completed, [
    'stop-admission',
    'close-clients',
    'close-transfers',
    'persist-state'
  ]);
});

test('real HTTP and WebSocket listeners close and release their port', async (context) => {
  const server = http.createServer((_request, response) => response.end('ok'));
  const webSocketServer = new WebSocketServer({ server });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  context.after(async () => {
    client.terminate();
    if (webSocketServer.clients.size) {
      await new Promise((resolve) => webSocketServer.close(resolve));
    } else if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await once(client, 'open');
  const notice = once(client, 'message');
  const closed = once(client, 'close');
  let httpClosed;
  let webSocketsClosed;
  const shutdown = createGracefulShutdown({
    stopAccepting: () => {
      httpClosed = new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      webSocketsClosed = new Promise((resolve, reject) => {
        webSocketServer.close((error) => error ? reject(error) : resolve());
      });
      return Promise.all([httpClosed, webSocketsClosed]);
    },
    notifyClients: () => {
      for (const socket of webSocketServer.clients) {
        socket.send(JSON.stringify({ type: 'server_shutdown', retryable: true }));
      }
    },
    stopQueueAdmission: () => {},
    drainQueue: () => Promise.resolve(),
    closeClients: () => new Promise((resolve) => {
      client.once('close', resolve);
      client.close(1001, 'Server shutting down');
    }),
    closeTransfers: () => Promise.resolve(),
    persistState: () => Promise.resolve(),
    timeoutMs: 500
  });

  await shutdown();
  const [message] = await notice;
  await closed;
  assert.equal(JSON.parse(message.toString()).type, 'server_shutdown');
  assert.equal(server.listening, false);
  assert.equal(webSocketServer.clients.size, 0);

  const portProbe = net.createServer();
  await new Promise((resolve, reject) => {
    portProbe.once('error', reject);
    portProbe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => portProbe.close(resolve));
});
