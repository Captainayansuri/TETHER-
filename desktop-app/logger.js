const LEVEL_PRIORITY = Object.freeze({
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  SILENT: 4
});

const SAFE_FIELDS = new Set([
  'environment',
  'isPackaged',
  'port',
  'clientPlatform',
  'authResult',
  'reason',
  'errorCode',
  'captureId',
  'transferState',
  'sizeBytes',
  'imageType',
  'durationMs',
  'bytesReceived',
  'chunkIndex',
  'queuePosition',
  'queueSize',
  'filename',
  'count',
  'attempt',
  'stage',
  'errorMessage',
  'stackTrace'
]);

let activeLevel = 'WARN';

function normalizeLevel(level) {
  if (typeof level !== 'string') throw new Error('Invalid logging level');
  const normalized = level.toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(LEVEL_PRIORITY, normalized)) {
    throw new Error('Logging level must be DEBUG, INFO, WARN, or ERROR');
  }
  return normalized;
}

function setLogLevel(level) {
  activeLevel = normalizeLevel(level);
}

function sanitizeFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {};
  const safe = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_FIELDS.has(key) || value === undefined || value === null) continue;
    if (typeof value === 'string') {
      const maxLength = key === 'stackTrace' ? 1800 : key === 'errorMessage' ? 400 : 160;
      let normalized = value.replace(/[\r\n\t]/g, ' ').slice(0, maxLength);
      if (key === 'errorMessage' || key === 'stackTrace') {
        normalized = normalized
          .replace(/(?:[A-Za-z]:\\|\\\\)[^'"\r\n)]*/g, '[path]')
          .replace(/https?:\/\/[^\s)]+/gi, '[url]')
          .replace(/\b(token|secret|password|passphrase|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
          .replace(/\b[a-f0-9]{64}\b/gi, '[redacted]');
      }
      if (key === 'stage' && !/^[A-Za-z0-9_.-]{1,80}$/.test(normalized)) continue;
      if (key === 'captureId' &&
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(normalized)) continue;
      if (key === 'authResult' && !/^(ACCEPTED|REJECTED)$/.test(normalized)) continue;
      if (key === 'reason' && !/^[A-Z0-9_-]{1,64}$/.test(normalized)) continue;
      if (key === 'errorCode' && !/^[A-Z0-9_-]{1,40}$/i.test(normalized)) continue;
      if (key === 'clientPlatform' && !/^[A-Za-z0-9_-]{1,32}$/.test(normalized)) continue;
      if (key === 'imageType' && !/^(jpeg|png|webp)$/i.test(normalized)) continue;
      if (key === 'transferState' && !/^[A-Z_]{1,32}$/.test(normalized)) continue;
      if (key === 'filename' && !/^capture_[a-f0-9-]{36}\.(jpg|png|webp)$/i.test(normalized)) continue;
      safe[key] = normalized;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      safe[key] = value;
    } else if (typeof value === 'boolean') {
      safe[key] = value;
    }
  }
  return safe;
}

function write(level, event, fields = {}) {
  const normalizedLevel = normalizeLevel(level);
  if (normalizedLevel === 'SILENT' || activeLevel === 'SILENT' ||
      LEVEL_PRIORITY[normalizedLevel] < LEVEL_PRIORITY[activeLevel]) return;
  const eventName = typeof event === 'string'
    ? event.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80)
    : '';
  if (!eventName) throw new Error('Log event name is required');
  const entry = {
    timestamp: new Date().toISOString(),
    level: normalizedLevel,
    event: eventName,
    ...sanitizeFields(fields)
  };
  const output = JSON.stringify(entry);
  const consoleMethod = normalizedLevel.toLowerCase();
  console[consoleMethod](output);
}

module.exports = {
  debug: (event, fields) => write('DEBUG', event, fields),
  error: (event, fields) => write('ERROR', event, fields),
  info: (event, fields) => write('INFO', event, fields),
  setLogLevel,
  warn: (event, fields) => write('WARN', event, fields)
};
