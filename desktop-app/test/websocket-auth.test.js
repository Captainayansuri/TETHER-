const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket, WebSocketServer } = require('ws');
const {
  createPairingCredentials,
  createAcknowledgementProof,
  createProof,
  requireWebSocketAuthentication
} = require('../pairing-auth');

function startServer(credentials, timeoutMs = 5000) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const sessions = [];
  const authenticatedCredentials = [];
  server.on('connection', (socket) => {
    requireWebSocketAuthentication(socket, () =>
      typeof credentials === 'function' ? credentials() : credentials,
    (sessionId, acceptedCredentials) => {
      sessions.push(sessionId);
      authenticatedCredentials.push(acceptedCredentials);
      socket.send(JSON.stringify({ type: 'paired', sessionId }));
    }, timeoutMs);
  });
  return new Promise((resolve) => {
    server.once('listening', () => {
      const { port } = server.address();
      resolve({ server, sessions, authenticatedCredentials, url: `ws://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('unauthenticated binary WebSocket connections are rejected without a session', async (context) => {
  const credentials = createPairingCredentials(60_000);
  const { server, sessions, url } = await startServer(credentials);
  context.after(() => closeServer(server));

  const client = new WebSocket(url);
  const rejection = new Promise((resolve, reject) => {
    client.on('error', reject);
    client.on('message', (message) => {
      const data = JSON.parse(message.toString());
      if (data.type === 'challenge') {
        client.send(Buffer.from([1, 2, 3]));
      } else if (data.type === 'auth_error') {
        resolve(data);
      }
    });
  });

  const response = await rejection;
  assert.equal(response.code, 'AUTH_REQUIRED');
  assert.equal(sessions.length, 0);
});

test('expired pairing tokens are rejected', async (context) => {
  const credentials = { token: 'a'.repeat(64), expiresAt: Date.now() - 1 };
  const { server, sessions, url } = await startServer(credentials);
  context.after(() => closeServer(server));

  const client = new WebSocket(url);
  const rejection = new Promise((resolve, reject) => {
    client.on('error', reject);
    client.on('message', (message) => {
      const data = JSON.parse(message.toString());
      if (data.type === 'challenge') {
        client.send(JSON.stringify({
          type: 'authenticate',
          proof: createProof(credentials.token, data.nonce)
        }));
      } else if (data.type === 'auth_error') {
        resolve(data);
      }
    });
  });

  const response = await rejection;
  assert.equal(response.code, 'TOKEN_EXPIRED');
  assert.equal(sessions.length, 0);
});

test('invalid authentication proofs are rejected', async (context) => {
  const credentials = createPairingCredentials(60_000);
  const { server, sessions, url } = await startServer(credentials);
  context.after(() => closeServer(server));

  const client = new WebSocket(url);
  const rejection = new Promise((resolve, reject) => {
    client.on('error', reject);
    client.on('message', (message) => {
      const data = JSON.parse(message.toString());
      if (data.type === 'challenge') {
        client.send(JSON.stringify({ type: 'authenticate', proof: '0'.repeat(64) }));
      } else if (data.type === 'auth_error') {
        resolve(data);
      }
    });
  });

  const response = await rejection;
  assert.equal(response.code, 'AUTH_FAILED');
  assert.equal(sessions.length, 0);
});

test('a pairing token from before a desktop restart is rejected by the new process', async (context) => {
  const previousCredentials = createPairingCredentials(60_000);
  const currentCredentials = createPairingCredentials(60_000);
  const { server, sessions, url } = await startServer(currentCredentials);
  context.after(() => closeServer(server));

  const client = new WebSocket(url);
  const rejection = new Promise((resolve, reject) => {
    client.on('error', reject);
    client.on('message', (message) => {
      const data = JSON.parse(message.toString());
      if (data.type === 'challenge') {
        client.send(JSON.stringify({
          type: 'authenticate',
          proof: createProof(previousCredentials.token, data.nonce)
        }));
      } else if (data.type === 'auth_error') {
        resolve(data);
      }
    });
  });

  assert.equal((await rejection).code, 'AUTH_FAILED');
  assert.equal(sessions.length, 0);
});

test('credential refresh leaves an authenticated session using its original token', async (context) => {
  let currentCredentials = createPairingCredentials(60_000);
  const originalCredentials = currentCredentials;
  const { server, authenticatedCredentials, url } = await startServer(() => currentCredentials);
  context.after(() => closeServer(server));

  const client = new WebSocket(url);
  const paired = new Promise((resolve, reject) => {
    client.on('error', reject);
    client.on('message', (message) => {
      const data = JSON.parse(message.toString());
      if (data.type === 'challenge') {
        client.send(JSON.stringify({
          type: 'authenticate',
          proof: createProof(originalCredentials.token, data.nonce)
        }));
      } else if (data.type === 'paired') {
        resolve(data);
      } else if (data.type === 'auth_error') {
        reject(new Error(`Unexpected authentication error: ${data.code}`));
      }
    });
  });

  await paired;
  const sessionCredentials = authenticatedCredentials[0];
  currentCredentials = createPairingCredentials(60_000);
  const acknowledgement = {
    captureId: '12345678-1234-4123-8123-123456789abc',
    sha256: 'a'.repeat(64),
    size: 100,
    state: 'SAVED',
    persisted: true
  };

  assert.notEqual(currentCredentials.token, originalCredentials.token);
  assert.equal(sessionCredentials.token, originalCredentials.token);
  assert.equal(
    createAcknowledgementProof(sessionCredentials.token, acknowledgement),
    createAcknowledgementProof(originalCredentials.token, acknowledgement)
  );
  assert.notEqual(
    createAcknowledgementProof(sessionCredentials.token, acknowledgement),
    createAcknowledgementProof(currentCredentials.token, acknowledgement)
  );
  assert.equal(client.readyState, WebSocket.OPEN);
  client.close();
});

test('unauthenticated sockets are closed when the authentication deadline expires', async (context) => {
  const credentials = createPairingCredentials(60_000);
  const { server, sessions, url } = await startServer(credentials, 25);
  context.after(() => closeServer(server));

  const client = new WebSocket(url);
  const rejection = new Promise((resolve, reject) => {
    client.on('error', reject);
    client.on('message', (message) => {
      const data = JSON.parse(message.toString());
      if (data.type === 'auth_error') resolve(data);
    });
  });

  const response = await rejection;
  assert.equal(response.code, 'AUTH_TIMEOUT');
  assert.equal(sessions.length, 0);
});

test('valid pairing proofs receive distinct session IDs', async (context) => {
  const credentials = createPairingCredentials(60_000);
  const { server, sessions, url } = await startServer(credentials);
  context.after(() => closeServer(server));

  async function authenticateClient() {
    const client = new WebSocket(url);
    return new Promise((resolve, reject) => {
      client.on('error', reject);
      client.on('message', (message) => {
        const data = JSON.parse(message.toString());
        if (data.type === 'challenge') {
          client.send(JSON.stringify({
            type: 'authenticate',
            proof: createProof(credentials.token, data.nonce)
          }));
        } else if (data.type === 'paired') {
          client.close();
          resolve(data.sessionId);
        } else if (data.type === 'auth_error') {
          reject(new Error(`Unexpected authentication error: ${data.code}`));
        }
      });
    });
  }

  const firstSessionId = await authenticateClient();
  const secondSessionId = await authenticateClient();
  assert.match(firstSessionId, /^[0-9a-f-]{36}$/i);
  assert.match(secondSessionId, /^[0-9a-f-]{36}$/i);
  assert.notEqual(firstSessionId, secondSessionId);
  assert.deepEqual(sessions, [firstSessionId, secondSessionId]);
});
