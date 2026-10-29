const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_MAX_IMAGE_BYTES,
  detectImageType,
  getMaxImageBytes,
  validateImageBuffer
} = require('../image-upload');

function imageWithHeader(type, size) {
  const buffer = Buffer.alloc(size);
  if (type === 'jpeg') Buffer.from([0xff, 0xd8, 0xff]).copy(buffer);
  if (type === 'png') Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  if (type === 'webp') {
    Buffer.from('RIFF').copy(buffer, 0);
    buffer.writeUInt32LE(size - 8, 4);
    Buffer.from('WEBP').copy(buffer, 8);
  }
  return buffer;
}

test('image limit defaults to 32 MiB and accepts a configured bounded integer', () => {
  assert.equal(getMaxImageBytes(undefined), DEFAULT_MAX_IMAGE_BYTES);
  assert.equal(getMaxImageBytes('8388608'), 8 * 1024 * 1024);
  assert.throws(() => getMaxImageBytes('0'), /TETHER_MAX_IMAGE_BYTES/);
  assert.throws(() => getMaxImageBytes('not-a-number'), /TETHER_MAX_IMAGE_BYTES/);
  assert.throws(() => getMaxImageBytes(String(128 * 1024 * 1024 + 1)), /TETHER_MAX_IMAGE_BYTES/);
});

test('JPEG, PNG, and WebP are detected from their binary signatures', () => {
  for (const type of ['jpeg', 'png', 'webp']) {
    const validation = validateImageBuffer(imageWithHeader(type, 32), 32);
    assert.equal(validation.valid, true);
    assert.equal(validation.type, type);
  }
  assert.equal(detectImageType(Buffer.from('not really a jpeg.jpg')), null);
  assert.equal(validateImageBuffer(Buffer.from('GIF89a')).code, 'UNSUPPORTED_IMAGE_TYPE');
});

test('image size limit accepts the exact boundary and rejects the next byte', () => {
  const maxBytes = 32;
  const atLimit = imageWithHeader('jpeg', maxBytes);
  const overLimit = imageWithHeader('jpeg', maxBytes + 1);

  assert.equal(validateImageBuffer(atLimit, maxBytes).valid, true);
  assert.deepEqual(validateImageBuffer(overLimit, maxBytes), {
    valid: false,
    code: 'IMAGE_TOO_LARGE',
    message: 'Image exceeds the 32 bytes size limit.'
  });
});

test('image validation rejects incorrect data types and truncated signatures', () => {
  assert.equal(validateImageBuffer('not a buffer').code, 'INVALID_IMAGE');
  assert.equal(validateImageBuffer(Buffer.from([0xff, 0xd8])).code, 'UNSUPPORTED_IMAGE_TYPE');
  assert.equal(validateImageBuffer(Buffer.from('RIFFxxxxWEB')).code, 'UNSUPPORTED_IMAGE_TYPE');
});

test('WebSocket rejects a message over maxPayload with close code 1009', async (context) => {
  const { WebSocket, WebSocketServer } = require('ws');
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', maxPayload: 8 });
  server.on('connection', (socket) => socket.on('error', () => {}));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  const result = await new Promise((resolve, reject) => {
    client.once('error', reject);
    client.once('open', () => client.send(Buffer.alloc(9)));
    client.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });

  assert.equal(result.code, 1009);
});

test('WebSocket accepts a message at the configured maxPayload boundary', async (context) => {
  const { WebSocket, WebSocketServer } = require('ws');
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', maxPayload: 8 });
  const received = new Promise((resolve) => {
    server.once('connection', (socket) => socket.once('message', (data) => resolve(data.length)));
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  await new Promise((resolve, reject) => {
    client.once('error', reject);
    client.once('open', () => client.send(Buffer.alloc(8)));
    client.once('close', resolve);
    received.then(() => {
      client.close();
    });
  });

  assert.equal(await received, 8);
});
