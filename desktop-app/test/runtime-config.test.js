const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { buildRuntimeConfig } = require('../runtime-config');
const logger = require('../logger');

test('development, testing, and production profiles remain distinct', () => {
  const userDataPath = path.resolve('tether-test-userdata');
  const development = buildRuntimeConfig({
    environment: 'development',
    userDataPath,
    env: {}
  });
  const testing = buildRuntimeConfig({
    environment: 'test',
    userDataPath,
    env: {}
  });
  const production = buildRuntimeConfig({
    environment: 'production',
    userDataPath,
    env: {}
  });

  assert.equal(development.serverPort, 8080);
  assert.equal(testing.serverPort, 0);
  assert.equal(testing.loggingLevel, 'SILENT');
  assert.equal(development.loggingLevel, 'DEBUG');
  assert.equal(production.loggingLevel, 'INFO');
  assert.notEqual(development.captureDirectory, testing.captureDirectory);
  assert.notEqual(testing.captureDirectory, production.captureDirectory);
  assert.equal(production.captureDirectory, path.resolve(userDataPath, 'tether_captures'));
  assert.equal(development.uploadLimitBytes, production.uploadLimitBytes);
  assert.equal(testing.maxConcurrentUploads, 1);
});

test('packaged applications always select production configuration', () => {
  const config = buildRuntimeConfig({
    environment: 'development',
    isPackaged: true,
    userDataPath: path.resolve('tether-test-userdata'),
    env: {}
  });

  assert.equal(config.environment, 'production');
  assert.equal(config.loggingLevel, 'INFO');
  assert.equal(
    config.captureDirectory,
    path.resolve('tether-test-userdata', 'tether_captures')
  );
});

test('environment overrides configure the server and storage without exposing secrets', () => {
  const config = buildRuntimeConfig({
    environment: 'production',
    userDataPath: path.resolve('tether-test-userdata'),
    env: {
      TETHER_PORT: '9090',
      TETHER_DASHBOARD_DEV_PORT: '5180',
      TETHER_MAX_IMAGE_BYTES: '8388608',
      TETHER_PAIRING_TOKEN_TTL_MS: '60000',
      TETHER_MAX_QUEUED_UPLOADS: '8',
      TETHER_CAPTURE_DIR: 'D:\\captures',
      TETHER_LOG_LEVEL: 'INFO',
      TETHER_THUMBNAIL_CACHE_MAX_BYTES: '2097152',
      TETHER_THUMBNAIL_CACHE_MAX_AGE_MS: '120000',
      TETHER_THUMBNAIL_WIDTH: '640',
      TETHER_THUMBNAIL_HEIGHT: '360',
      TETHER_CONNECTION_TIMEOUT_MS: '9000',
      TETHER_SHUTDOWN_TIMEOUT_MS: '45000',
      TETHER_MAX_CONCURRENT_UPLOADS: '2',
      TETHER_HEARTBEAT_INTERVAL_MS: '15000',
      TETHER_STALE_CONNECTION_TIMEOUT_MS: '60000',
      TETHER_MAX_CLIENT_CONNECTIONS: '12',
      TETHER_RECONNECT_MAX_INTERVAL_MS: '45000',
      TETHER_PORT_FALLBACK_ATTEMPTS: '3',
      TETHER_PAIRING_TOKEN: 'must-not-be-copied-to-runtime-config'
    }
  });

  assert.equal(config.serverPort, 9090);
  assert.equal(config.dashboardDevPort, 5180);
  assert.equal(config.uploadLimitBytes, 8 * 1024 * 1024);
  assert.equal(config.pairingExpirationMs, 60_000);
  assert.equal(config.queueSize, 8);
  assert.equal(config.captureDirectory, path.resolve('D:\\captures'));
  assert.equal(config.loggingLevel, 'INFO');
  assert.equal(config.thumbnailCacheBytes, 2 * 1024 * 1024);
  assert.equal(config.thumbnailMaxAgeMs, 120_000);
  assert.equal(config.thumbnailWidth, 640);
  assert.equal(config.thumbnailHeight, 360);
  assert.equal(config.connectionTimeoutMs, 9000);
  assert.equal(config.shutdownTimeoutMs, 45_000);
  assert.equal(config.maxConcurrentUploads, 2);
  assert.equal(config.heartbeatIntervalMs, 15000);
  assert.equal(config.staleConnectionTimeoutMs, 60000);
  assert.equal(config.maxClientConnections, 12);
  assert.equal(config.reconnectMaxIntervalMs, 45000);
  assert.equal(config.portFallbackAttempts, 3);
  assert.equal(Object.hasOwn(config, 'pairingToken'), false);
  assert.equal(JSON.stringify(config).includes('must-not-be-copied'), false);
  assert.equal(Object.isFrozen(config), true);
});

test('invalid profiles and out-of-range overrides fail at startup', () => {
  assert.throws(() => buildRuntimeConfig({ environment: 'staging', env: {} }), /NODE_ENV/);
  for (const env of [
    { TETHER_PORT: '65536' },
    { TETHER_DASHBOARD_DEV_PORT: '0' },
    { TETHER_MAX_IMAGE_BYTES: '0' },
    { TETHER_PAIRING_TOKEN_TTL_MS: 'not-a-duration' },
    { TETHER_MAX_QUEUED_UPLOADS: '513' },
    { TETHER_LOG_LEVEL: 'verbose' },
    { TETHER_THUMBNAIL_WIDTH: '20' },
    { TETHER_CONNECTION_TIMEOUT_MS: '999' },
    { TETHER_SHUTDOWN_TIMEOUT_MS: '999' },
    { TETHER_MAX_CONCURRENT_UPLOADS: '0' },
    { TETHER_RECONNECT_MAX_INTERVAL_MS: '999' },
    { TETHER_PORT_FALLBACK_ATTEMPTS: '-1' }
  ]) {
    assert.throws(() => buildRuntimeConfig({ environment: 'test', env }));
  }
  assert.throws(() => buildRuntimeConfig({
    environment: 'test',
    env: {
      TETHER_HEARTBEAT_INTERVAL_MS: '10000',
      TETHER_STALE_CONNECTION_TIMEOUT_MS: '5000'
    }
  }), /at least TETHER_HEARTBEAT_INTERVAL_MS/);
  assert.throws(() => buildRuntimeConfig({
    environment: 'production',
    env: { TETHER_LOG_LEVEL: 'SILENT' }
  }), /TETHER_LOG_LEVEL/);
});

test('configured structured logging filters levels and excludes sensitive fields', () => {
  const originalDebug = console.debug;
  const originalInfo = console.info;
  const originalError = console.error;
  const messages = [];
  console.debug = (...args) => messages.push(['DEBUG', ...args]);
  console.info = (...args) => messages.push(['INFO', ...args]);
  console.error = (...args) => messages.push(['ERROR', ...args]);
  try {
    logger.setLogLevel('INFO');
    logger.debug('hidden.event');
    logger.info('transfer.file_persisted', {
      captureId: '12345678-1234-4123-8123-123456789abc',
      sizeBytes: 4096,
      imageType: 'jpeg',
      authResult: 'REJECTED',
      token: 'secret-token',
      imageContents: 'image-binary',
      privateKey: 'private-key-material'
    });
    assert.equal(messages.length, 1);
    const entry = JSON.parse(messages[0][1]);
    assert.equal(entry.level, 'INFO');
    assert.equal(entry.event, 'transfer.file_persisted');
    assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(entry.captureId, '12345678-1234-4123-8123-123456789abc');
    assert.equal(entry.sizeBytes, 4096);
    assert.equal(entry.imageType, 'jpeg');
    assert.equal(entry.authResult, 'REJECTED');
    assert.equal(Object.hasOwn(entry, 'token'), false);
    assert.equal(Object.hasOwn(entry, 'imageContents'), false);
    assert.equal(Object.hasOwn(entry, 'privateKey'), false);

    messages.length = 0;
    logger.info('websocket.authentication', { authResult: 'secret-token' });
    assert.equal(Object.hasOwn(JSON.parse(messages[0][1]), 'authResult'), false);

    messages.length = 0;
    logger.setLogLevel('SILENT');
    logger.error('hidden.event');
    assert.deepEqual(messages, []);
  } finally {
    console.debug = originalDebug;
    console.info = originalInfo;
    console.error = originalError;
    logger.setLogLevel('WARN');
  }
});
