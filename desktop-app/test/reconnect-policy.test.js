const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_MAX_INTERVAL_MS,
  createReconnectBackoff,
  parseMaxInterval
} = require('../public/mobile/reconnect-policy');

test('repeated connection failures back off exponentially and stay within the configured maximum', () => {
  const backoff = createReconnectBackoff({
    baseIntervalMs: 1000,
    maxIntervalMs: 8000,
    random: () => 0.5
  });

  assert.deepEqual(
    Array.from({ length: 8 }, () => backoff.nextDelay()),
    [1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000]
  );
  assert.equal(backoff.attempt, 8);
});

test('backoff jitter is bounded, and successful connection resets its retry attempt', () => {
  const backoff = createReconnectBackoff({
    baseIntervalMs: 1000,
    maxIntervalMs: 10000,
    random: () => 1
  });
  assert.equal(backoff.nextDelay(), 1200);
  assert.equal(backoff.nextDelay(), 2400);
  backoff.reset();
  assert.equal(backoff.attempt, 0);
  assert.equal(backoff.nextDelay(), 1200);
});

test('reconnect maximum is configurable and rejects unsafe ranges', () => {
  assert.equal(parseMaxInterval(undefined), DEFAULT_MAX_INTERVAL_MS);
  assert.equal(parseMaxInterval('45000'), 45000);
  for (const invalid of ['999', '600001', '1.5', 'NaN', '-1']) {
    assert.throws(() => parseMaxInterval(invalid));
  }
});
