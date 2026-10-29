const test = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../logger');

test('startup diagnostics retain stage and safe error context while redacting paths and secrets', () => {
  const originalError = console.error;
  let logged;
  logger.setLogLevel('ERROR');
  console.error = (entry) => { logged = entry; };
  try {
    logger.error('application.startup_failed', {
      stage: 'storage.recovery',
      errorCode: 'EACCES',
      errorMessage: "Denied at 'C:\\Users\\Private User\\TETHER\\capture.db' token=topsecret",
      stackTrace: `Error: access denied\n    at recover (C:\\Users\\Private User\\TETHER\\image-storage.js:10:2) ${'a'.repeat(64)}`
    });
  } finally {
    console.error = originalError;
    logger.setLogLevel('WARN');
  }

  const entry = JSON.parse(logged);
  assert.equal(entry.stage, 'storage.recovery');
  assert.equal(entry.errorCode, 'EACCES');
  assert.match(entry.errorMessage, /Denied at '\[path\]' token=\[redacted\]/);
  assert.doesNotMatch(entry.errorMessage, /Private User|topsecret/);
  assert.match(entry.stackTrace, /\[path\]/);
  assert.doesNotMatch(entry.stackTrace, /Private User|a{64}/);
});
