const crypto = require('crypto');
const logger = require('./logger');

const DEFAULT_PAIRING_TOKEN_TTL_MS = 30 * 60 * 1000;
const MAX_PAIRING_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function getPairingTokenTtlMs(value) {
  if (value === undefined || value === '') {
    return DEFAULT_PAIRING_TOKEN_TTL_MS;
  }

  const ttlMs = Number(value);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_PAIRING_TOKEN_TTL_MS) {
    throw new Error('TETHER_PAIRING_TOKEN_TTL_MS must be an integer from 1 to 2592000000');
  }

  return ttlMs;
}

function createPairingCredentials(ttlMs = getPairingTokenTtlMs()) {
  return {
    token: crypto.randomBytes(32).toString('hex'),
    expiresAt: Date.now() + ttlMs
  };
}

function createProof(token, challenge) {
  return crypto.createHmac('sha256', token).update(challenge, 'utf8').digest('hex');
}

function createAcknowledgementProof(token, acknowledgement) {
  const payload = [
    acknowledgement.captureId,
    acknowledgement.sha256,
    String(acknowledgement.size),
    acknowledgement.state,
    String(acknowledgement.persisted)
  ].join('\n');
  return crypto.createHmac('sha256', token).update(payload, 'utf8').digest('hex');
}

function verifyProof(token, challenge, proof) {
  if (typeof proof !== 'string' || !/^[a-f0-9]{64}$/i.test(proof)) {
    return false;
  }

  const expected = Buffer.from(createProof(token, challenge), 'hex');
  const received = Buffer.from(proof, 'hex');
  return crypto.timingSafeEqual(expected, received);
}

function requireWebSocketAuthentication(
  ws,
  getCredentials,
  onAuthenticated,
  timeoutMs = 5000
) {
  const challenge = crypto.randomBytes(32).toString('hex');
  let authenticated = false;
  let rejected = false;
  const reportResult = (authResult, reason) => {
    const log = authResult === 'ACCEPTED' ? logger.info : logger.warn;
    log('websocket.authentication', {
      authResult,
      ...(reason ? { reason } : {})
    });
  };
  const timeout = setTimeout(() => reject('AUTH_TIMEOUT'), timeoutMs);

  function reject(code) {
    if (authenticated || rejected) return;
    rejected = true;
    clearTimeout(timeout);
    reportResult('REJECTED', code);
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'auth_error', code }));
    ws.close(1008, 'Authentication failed');
  }

  ws.on('message', (message, isBinary) => {
    if (authenticated) return;
    if (isBinary) {
      reject('AUTH_REQUIRED');
      return;
    }

    let authentication;
    try {
      authentication = JSON.parse(message.toString());
    } catch {
      reject('AUTH_REQUIRED');
      return;
    }

    if (authentication.type !== 'authenticate') {
      reject('AUTH_REQUIRED');
      return;
    }

    const credentials = getCredentials();
    if (!credentials || Date.now() >= credentials.expiresAt) {
      reject('TOKEN_EXPIRED');
      return;
    }
    if (!verifyProof(credentials.token, challenge, authentication.proof)) {
      reject('AUTH_FAILED');
      return;
    }

    authenticated = true;
    clearTimeout(timeout);
    reportResult('ACCEPTED');
    onAuthenticated(crypto.randomUUID(), credentials);
  });

  ws.once('close', () => clearTimeout(timeout));
  ws.send(JSON.stringify({ type: 'challenge', nonce: challenge }));
}

module.exports = {
  DEFAULT_PAIRING_TOKEN_TTL_MS,
  createPairingCredentials,
  createAcknowledgementProof,
  createProof,
  getPairingTokenTtlMs,
  requireWebSocketAuthentication,
  verifyProof
};
