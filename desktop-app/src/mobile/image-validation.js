(function (root) {
  const DEFAULT_MAX_IMAGE_BYTES = 32 * 1024 * 1024;

  function detectImageType(bytes) {
    if (!bytes || typeof bytes.length !== 'number') return null;
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return 'jpeg';
    }
    if (bytes.length >= 8 &&
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
      return 'png';
    }
    if (bytes.length >= 12 &&
        String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'RIFF' &&
        String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === 'WEBP') {
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

  async function validateBlob(blob, maxBytes) {
    if (!blob || typeof blob.size !== 'number') {
      return { valid: false, message: 'Selected data is not a valid image.' };
    }
    if (blob.size > maxBytes) {
      return {
        valid: false,
        message: `Image exceeds the ${formatImageSize(maxBytes)} size limit.`
      };
    }

    const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const type = detectImageType(header);
    if (!type) {
      return { valid: false, message: 'Only JPEG, PNG, and WebP images are supported.' };
    }
    return { valid: true, type };
  }

  root.tetherImageValidation = { DEFAULT_MAX_IMAGE_BYTES, detectImageType, formatImageSize, validateBlob };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.tetherImageValidation;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
