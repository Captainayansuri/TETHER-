(function initializeReconnectPolicy(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.tetherReconnectPolicy = api;
})(typeof globalThis === 'object' ? globalThis : this, function createReconnectPolicy() {
  const DEFAULT_BASE_INTERVAL_MS = 1000;
  const DEFAULT_MAX_INTERVAL_MS = 30000;

  function parseMaxInterval(value, fallback = DEFAULT_MAX_INTERVAL_MS) {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1000 || parsed > 600000) {
      throw new Error('Reconnect maximum interval must be an integer from 1000 to 600000 ms');
    }
    return parsed;
  }

  function createReconnectBackoff({
    baseIntervalMs = DEFAULT_BASE_INTERVAL_MS,
    maxIntervalMs = DEFAULT_MAX_INTERVAL_MS,
    random = Math.random
  } = {}) {
    if (!Number.isSafeInteger(baseIntervalMs) || baseIntervalMs < 1 ||
        !Number.isSafeInteger(maxIntervalMs) || maxIntervalMs < baseIntervalMs ||
        typeof random !== 'function') {
      throw new Error('Invalid reconnect backoff configuration');
    }
    let attempt = 0;

    return {
      nextDelay() {
        const ceiling = Math.min(maxIntervalMs, baseIntervalMs * (2 ** Math.min(attempt, 30)));
        attempt += 1;
        return Math.min(maxIntervalMs, Math.round(ceiling * (0.8 + random() * 0.4)));
      },
      reset() {
        attempt = 0;
      },
      get attempt() {
        return attempt;
      }
    };
  }

  return {
    DEFAULT_BASE_INTERVAL_MS,
    DEFAULT_MAX_INTERVAL_MS,
    createReconnectBackoff,
    parseMaxInterval
  };
});
