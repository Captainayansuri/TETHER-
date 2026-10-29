const os = require('os');
const path = require('path');
const { DEFAULT_MAX_IMAGE_BYTES, getMaxImageBytes } = require('./image-upload');
const {
  DEFAULT_PAIRING_TOKEN_TTL_MS,
  getPairingTokenTtlMs
} = require('./pairing-auth');
const {
  DEFAULT_MAX_QUEUED_UPLOADS,
  DEFAULT_MAX_CAPTURE_STORAGE_BYTES,
  getMaxQueuedUploads
} = require('./image-storage');
const {
  DEFAULT_THUMBNAIL_CACHE_MAX_BYTES,
  DEFAULT_THUMBNAIL_MAX_AGE_MS,
  parseCacheLimit,
  parseMaxAge
} = require('./image-thumbnails');
const { DEFAULT_MAX_INTERVAL_MS, parseMaxInterval } = require('./public/mobile/reconnect-policy');

const MEBIBYTE = 1024 * 1024;

const PROFILES = Object.freeze({
  development: Object.freeze({
    serverPort: 8080,
    dashboardDevPort: 5173,
    uploadLimitBytes: DEFAULT_MAX_IMAGE_BYTES,
    pairingExpirationMs: DEFAULT_PAIRING_TOKEN_TTL_MS,
    queueSize: DEFAULT_MAX_QUEUED_UPLOADS,
    loggingLevel: 'DEBUG',
    thumbnailCacheBytes: DEFAULT_THUMBNAIL_CACHE_MAX_BYTES,
    thumbnailMaxAgeMs: DEFAULT_THUMBNAIL_MAX_AGE_MS,
    thumbnailWidth: 480,
    thumbnailHeight: 320,
    maxInputPixels: 40_000_000,
    maxCaptureStorageBytes: DEFAULT_MAX_CAPTURE_STORAGE_BYTES,
    connectionTimeoutMs: 5000,
    shutdownTimeoutMs: 30_000,
    maxConcurrentUploads: 4,
    heartbeatIntervalMs: 30_000,
    staleConnectionTimeoutMs: 120_000,
    maxClientConnections: 32,
    reconnectMaxIntervalMs: DEFAULT_MAX_INTERVAL_MS,
    portFallbackAttempts: 20
  }),
  test: Object.freeze({
    serverPort: 0,
    dashboardDevPort: 5173,
    uploadLimitBytes: DEFAULT_MAX_IMAGE_BYTES,
    pairingExpirationMs: 60_000,
    queueSize: 2,
    loggingLevel: 'SILENT',
    thumbnailCacheBytes: MEBIBYTE,
    thumbnailMaxAgeMs: 60_000,
    thumbnailWidth: 480,
    thumbnailHeight: 320,
    maxInputPixels: 40_000_000,
    maxCaptureStorageBytes: DEFAULT_MAX_CAPTURE_STORAGE_BYTES,
    connectionTimeoutMs: 1000,
    shutdownTimeoutMs: 1000,
    maxConcurrentUploads: 1,
    heartbeatIntervalMs: 1000,
    staleConnectionTimeoutMs: 5000,
    maxClientConnections: 4,
    reconnectMaxIntervalMs: 5000,
    portFallbackAttempts: 0
  }),
  production: Object.freeze({
    serverPort: 8080,
    dashboardDevPort: 5173,
    uploadLimitBytes: DEFAULT_MAX_IMAGE_BYTES,
    pairingExpirationMs: DEFAULT_PAIRING_TOKEN_TTL_MS,
    queueSize: DEFAULT_MAX_QUEUED_UPLOADS,
    loggingLevel: 'INFO',
    thumbnailCacheBytes: DEFAULT_THUMBNAIL_CACHE_MAX_BYTES,
    thumbnailMaxAgeMs: DEFAULT_THUMBNAIL_MAX_AGE_MS,
    thumbnailWidth: 480,
    thumbnailHeight: 320,
    maxInputPixels: 40_000_000,
    maxCaptureStorageBytes: DEFAULT_MAX_CAPTURE_STORAGE_BYTES,
    connectionTimeoutMs: 5000,
    shutdownTimeoutMs: 30_000,
    maxConcurrentUploads: 4,
    heartbeatIntervalMs: 30_000,
    staleConnectionTimeoutMs: 120_000,
    maxClientConnections: 32,
    reconnectMaxIntervalMs: DEFAULT_MAX_INTERVAL_MS,
    portFallbackAttempts: 20
  })
});

const LOG_LEVELS = new Set(['SILENT', 'ERROR', 'WARN', 'INFO', 'DEBUG']);

function parseInteger(value, name, { min, max, fallback }) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function envValue(env, name, fallback) {
  return env[name] === undefined || env[name] === '' ? fallback : env[name];
}

function resolveEnvironment(environment, isPackaged) {
  if (isPackaged) return 'production';
  const selected = environment || 'production';
  if (!Object.prototype.hasOwnProperty.call(PROFILES, selected)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }
  return selected;
}

function buildRuntimeConfig({
  environment,
  isPackaged = false,
  userDataPath = path.join(os.tmpdir(), 'image-tether'),
  env = process.env
} = {}) {
  const mode = resolveEnvironment(environment, isPackaged);
  const profile = PROFILES[mode];
  const serverPort = parseInteger(env.TETHER_PORT, 'TETHER_PORT', {
    min: 0,
    max: 65535,
    fallback: profile.serverPort
  });
  const dashboardDevPort = parseInteger(
    env.TETHER_DASHBOARD_DEV_PORT,
    'TETHER_DASHBOARD_DEV_PORT',
    { min: 1, max: 65535, fallback: profile.dashboardDevPort }
  );
  const uploadLimitBytes = getMaxImageBytes(
    envValue(env, 'TETHER_MAX_IMAGE_BYTES', profile.uploadLimitBytes)
  );
  const pairingExpirationMs = getPairingTokenTtlMs(
    envValue(env, 'TETHER_PAIRING_TOKEN_TTL_MS', profile.pairingExpirationMs)
  );
  const queueSize = getMaxQueuedUploads(
    envValue(env, 'TETHER_MAX_QUEUED_UPLOADS', profile.queueSize)
  );
  const loggingLevel = String(envValue(env, 'TETHER_LOG_LEVEL', profile.loggingLevel)).toUpperCase();
  if (!LOG_LEVELS.has(loggingLevel) || (loggingLevel === 'SILENT' && mode !== 'test')) {
    throw new Error('TETHER_LOG_LEVEL must be DEBUG, INFO, WARN, or ERROR');
  }

  const configuredCaptureDirectory = env.TETHER_CAPTURE_DIR;
  const defaultCaptureDirectory = path.join(
    userDataPath,
    mode === 'production' ? 'tether_captures' : `tether_captures-${mode}`
  );
  const captureDirectory = path.resolve(
    configuredCaptureDirectory || defaultCaptureDirectory
  );

  const config = {
    environment: mode,
    serverPort,
    dashboardDevPort,
    uploadLimitBytes,
    pairingExpirationMs,
    queueSize,
    captureDirectory,
    loggingLevel,
    thumbnailCacheBytes: parseCacheLimit(
      envValue(env, 'TETHER_THUMBNAIL_CACHE_MAX_BYTES', profile.thumbnailCacheBytes)
    ),
    thumbnailMaxAgeMs: parseMaxAge(
      envValue(env, 'TETHER_THUMBNAIL_CACHE_MAX_AGE_MS', profile.thumbnailMaxAgeMs)
    ),
    thumbnailWidth: parseInteger(env.TETHER_THUMBNAIL_WIDTH, 'TETHER_THUMBNAIL_WIDTH', {
      min: 64,
      max: 4096,
      fallback: profile.thumbnailWidth
    }),
    thumbnailHeight: parseInteger(env.TETHER_THUMBNAIL_HEIGHT, 'TETHER_THUMBNAIL_HEIGHT', {
      min: 64,
      max: 4096,
      fallback: profile.thumbnailHeight
    }),
    maxInputPixels: parseInteger(env.TETHER_MAX_INPUT_PIXELS, 'TETHER_MAX_INPUT_PIXELS', {
      min: 1_000_000,
      max: 100_000_000,
      fallback: profile.maxInputPixels
    }),
    maxCaptureStorageBytes: parseInteger(
      env.TETHER_MAX_CAPTURE_STORAGE_BYTES,
      'TETHER_MAX_CAPTURE_STORAGE_BYTES',
      { min: 1, max: 100 * 1024 * 1024 * 1024, fallback: profile.maxCaptureStorageBytes }
    ),
    connectionTimeoutMs: parseInteger(
      env.TETHER_CONNECTION_TIMEOUT_MS,
      'TETHER_CONNECTION_TIMEOUT_MS',
      { min: 1000, max: 120_000, fallback: profile.connectionTimeoutMs }
    ),
    shutdownTimeoutMs: parseInteger(
      env.TETHER_SHUTDOWN_TIMEOUT_MS,
      'TETHER_SHUTDOWN_TIMEOUT_MS',
      { min: 1000, max: 300_000, fallback: profile.shutdownTimeoutMs }
    ),
    maxConcurrentUploads: parseInteger(
      env.TETHER_MAX_CONCURRENT_UPLOADS,
      'TETHER_MAX_CONCURRENT_UPLOADS',
      { min: 1, max: 64, fallback: profile.maxConcurrentUploads }
    ),
    heartbeatIntervalMs: parseInteger(
      env.TETHER_HEARTBEAT_INTERVAL_MS,
      'TETHER_HEARTBEAT_INTERVAL_MS',
      { min: 1000, max: 300_000, fallback: profile.heartbeatIntervalMs }
    ),
    staleConnectionTimeoutMs: parseInteger(
      env.TETHER_STALE_CONNECTION_TIMEOUT_MS,
      'TETHER_STALE_CONNECTION_TIMEOUT_MS',
      { min: 1000, max: 3_600_000, fallback: profile.staleConnectionTimeoutMs }
    ),
    maxClientConnections: parseInteger(
      env.TETHER_MAX_CLIENT_CONNECTIONS,
      'TETHER_MAX_CLIENT_CONNECTIONS',
      { min: 1, max: 1024, fallback: profile.maxClientConnections }
    ),
    reconnectMaxIntervalMs: parseMaxInterval(
      env.TETHER_RECONNECT_MAX_INTERVAL_MS,
      profile.reconnectMaxIntervalMs
    ),
    portFallbackAttempts: parseInteger(
      env.TETHER_PORT_FALLBACK_ATTEMPTS,
      'TETHER_PORT_FALLBACK_ATTEMPTS',
      { min: 0, max: 100, fallback: profile.portFallbackAttempts }
    )
  };

  if (config.staleConnectionTimeoutMs < config.heartbeatIntervalMs) {
    throw new Error('TETHER_STALE_CONNECTION_TIMEOUT_MS must be at least TETHER_HEARTBEAT_INTERVAL_MS');
  }

  return Object.freeze(config);
}

module.exports = {
  PROFILES,
  buildRuntimeConfig
};
