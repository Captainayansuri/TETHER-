const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPairingCredentials,
  createProof,
  getPairingTokenTtlMs,
  verifyProof
} = require('../pairing-auth');

test('pairing tokens are cryptographically random 256-bit values', () => {
  const first = createPairingCredentials(1000);
  const second = createPairingCredentials(1000);

  assert.match(first.token, /^[a-f0-9]{64}$/);
  assert.notEqual(first.token, second.token);
  assert.ok(first.expiresAt > Date.now());
});

test('challenge proofs authenticate the token without revealing it', () => {
  const token = 'a'.repeat(64);
  const challenge = 'b'.repeat(64);
  const proof = createProof(token, challenge);

  assert.match(proof, /^[a-f0-9]{64}$/);
  assert.ok(verifyProof(token, challenge, proof));
  assert.ok(!verifyProof('c'.repeat(64), challenge, proof));
  assert.ok(!verifyProof(token, 'd'.repeat(64), proof));
  assert.ok(!verifyProof(token, challenge, 'invalid'));
});

test('pairing token lifetime is configurable and validated', () => {
  assert.equal(getPairingTokenTtlMs('60000'), 60000);
  assert.throws(() => getPairingTokenTtlMs('0'), /integer from 1 to/);
  assert.throws(() => getPairingTokenTtlMs('not-a-number'), /integer from 1 to/);
  assert.throws(() => getPairingTokenTtlMs('2592000001'), /integer from 1 to/);
});
