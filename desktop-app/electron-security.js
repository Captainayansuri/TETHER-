function isTrustedDashboardUrl(candidate, {
  isDevelopment,
  dashboardFileUrl,
  developmentOrigin = 'http://localhost:5173'
}) {
  if (typeof candidate !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }

  if (parsed.username || parsed.password) return false;
  if (isDevelopment) {
    return parsed.protocol === 'http:' &&
      parsed.origin === developmentOrigin &&
      parsed.username === '' &&
      parsed.password === '';
  }
  return parsed.href === dashboardFileUrl;
}

function parseSafeExternalUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password) {
    return null;
  }
  return parsed;
}

function isValidPathArgument(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 32768 &&
    !value.includes('\0');
}

function isPlainObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

module.exports = {
  isPlainObject,
  isTrustedDashboardUrl,
  isValidPathArgument,
  parseSafeExternalUrl
};
