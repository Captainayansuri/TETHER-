const test = require('node:test');
const assert = require('node:assert/strict');
const { hmacSha256Hex, sha256Hex } = require('../public/mobile/auth-crypto');

test('browser HMAC-SHA256 implementation matches the RFC 4231 test vector', () => {
  const key = String.fromCharCode(...Array(20).fill(0x0b));
  assert.equal(
    hmacSha256Hex(key, 'Hi There'),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'
  );
});

test('browser HMAC-SHA256 implementation matches the desktop proof format', () => {
  assert.equal(
    hmacSha256Hex('a'.repeat(64), 'b'.repeat(64)),
    require('crypto').createHmac('sha256', 'a'.repeat(64)).update('b'.repeat(64)).digest('hex')
  );
});

test('browser SHA-256 implementation produces transfer checksums', () => {
  assert.equal(
    sha256Hex(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});
