const DEFAULT_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_ALLOWED_IMAGE_BYTES = 128 * 1024 * 1024;
const IMAGE_TYPES = Object.freeze({
  jpeg: { extension: 'jpg', mimeType: 'image/jpeg' },
  png: { extension: 'png', mimeType: 'image/png' },
  webp: { extension: 'webp', mimeType: 'image/webp' }
});

function getMaxImageBytes(value) {
  if (value === undefined || value === '') return DEFAULT_MAX_IMAGE_BYTES;

  const maxBytes = Number(value);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ALLOWED_IMAGE_BYTES) {
    throw new Error(`TETHER_MAX_IMAGE_BYTES must be an integer from 1 to ${MAX_ALLOWED_IMAGE_BYTES}`);
  }
  return maxBytes;
}

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;

  if (buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff) {
    return 'jpeg';
  }

  if (buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }

  if (buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp';
  }

  return null;
}

function formatImageSize(bytes) {
  const megabyte = 1024 * 1024;
  if (bytes < megabyte) return `${bytes} bytes`;
  const megabytes = bytes / megabyte;
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
}

function validateImageBuffer(buffer, maxBytes = DEFAULT_MAX_IMAGE_BYTES) {
  if (!Buffer.isBuffer(buffer)) {
    return { valid: false, code: 'INVALID_IMAGE', message: 'The uploaded data is not a valid image.' };
  }
  if (buffer.length > maxBytes) {
    return {
      valid: false,
      code: 'IMAGE_TOO_LARGE',
      message: `Image exceeds the ${formatImageSize(maxBytes)} size limit.`
    };
  }

  const type = detectImageType(buffer);
  if (!type) {
    return {
      valid: false,
      code: 'UNSUPPORTED_IMAGE_TYPE',
      message: 'Only JPEG, PNG, and WebP images are supported.'
    };
  }

  return { valid: true, type, ...IMAGE_TYPES[type] };
}

module.exports = {
  DEFAULT_MAX_IMAGE_BYTES,
  IMAGE_TYPES,
  MAX_ALLOWED_IMAGE_BYTES,
  detectImageType,
  formatImageSize,
  getMaxImageBytes,
  validateImageBuffer
};
