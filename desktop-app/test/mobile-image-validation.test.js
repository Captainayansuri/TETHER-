const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_MAX_IMAGE_BYTES, detectImageType, validateBlob } =
  require('../public/mobile/image-validation');

function header(type) {
  if (type === 'jpeg') return Uint8Array.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  if (type === 'png') return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
}

function blobWithHeader(bytes, size) {
  let headerRead = false;
  return {
    size,
    get headerRead() {
      return headerRead;
    },
    slice(start, end) {
      assert.equal(start, 0);
      assert.equal(end, 12);
      headerRead = true;
      return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    }
  };
}

test('mobile validates JPEG, PNG, and WebP using file signatures', async () => {
  for (const type of ['jpeg', 'png', 'webp']) {
    const file = blobWithHeader(header(type), 12);
    assert.equal(detectImageType(header(type)), type);
    assert.deepEqual(await validateBlob(file, 12), { valid: true, type });
    assert.ok(file.headerRead);
  }

  assert.equal(detectImageType(new TextEncoder().encode('photo.jpg')), null);
});

test('mobile rejects oversized files before reading their contents', async () => {
  const oversized = blobWithHeader(header('jpeg'), DEFAULT_MAX_IMAGE_BYTES + 1);
  const result = await validateBlob(oversized, DEFAULT_MAX_IMAGE_BYTES);

  assert.equal(result.valid, false);
  assert.match(result.message, /size limit/);
  assert.equal(oversized.headerRead, false);
});

test('mobile accepts a file exactly at the configured size boundary', async () => {
  const atLimit = blobWithHeader(header('png'), 1024);
  assert.deepEqual(await validateBlob(atLimit, 1024), { valid: true, type: 'png' });
});
