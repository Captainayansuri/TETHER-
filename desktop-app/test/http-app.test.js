const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { createHttpApp } = require('../http-app');
const { IMAGE_TYPES } = require('../image-upload');
const { createThumbnailCache } = require('../image-thumbnails');

async function withServer(context, run, options = {}) {
  const app = createHttpApp({
    mobileStaticPath: path.join(__dirname, '..', 'public', 'mobile'),
    localIP: '127.0.0.1',
    getPort: () => 8080,
    ...options
  });

  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  return run(`http://127.0.0.1:${server.address().port}`);
}

test('capture image URLs require a loopback request and the per-run access token', async (context) => {
  const capturesDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tether-image-http-'));
  context.after(() => fs.promises.rm(capturesDirectory, { recursive: true, force: true }));
  const captureId = '12345678-1234-4123-8123-123456789abc';
  const filename = `capture_${captureId}.jpg`;
  const image = await sharp({
    create: {
      width: 1000,
      height: 700,
      channels: 3,
      background: { r: 30, g: 80, b: 120 }
    }
  }).jpeg({ quality: 90 }).toBuffer();
  await fs.promises.writeFile(path.join(capturesDirectory, filename), image);
  await fs.promises.writeFile(
    path.join(capturesDirectory, `.capture_${captureId}.json`),
    JSON.stringify({
      version: 1,
      captureId,
      size: image.length,
      imageType: 'jpeg',
      sha256: crypto.createHash('sha256').update(image).digest('hex')
    })
  );
  const corruptCaptureId = '22345678-1234-4123-8123-123456789abc';
  const corruptFilename = `capture_${corruptCaptureId}.jpg`;
  await fs.promises.writeFile(path.join(capturesDirectory, corruptFilename), Buffer.from('corrupt'));
  await fs.promises.writeFile(
    path.join(capturesDirectory, `.capture_${corruptCaptureId}.json`),
    JSON.stringify({
      version: 1,
      captureId: corruptCaptureId,
      size: 7,
      imageType: 'jpeg',
      sha256: crypto.createHash('sha256').update('corrupt').digest('hex')
    })
  );
  const accessToken = crypto.randomBytes(32).toString('hex');
  const thumbnailCache = createThumbnailCache({ capturesDirectory });

  await withServer(context, async (baseUrl) => {
    const url = new URL(`/_desktop/captures/${filename}`, baseUrl);
    const unauthorized = await fetch(url, { headers: { Connection: 'close' } });
    assert.equal(unauthorized.status, 404);
    url.searchParams.set('key', accessToken);

    const badTokenUrl = new URL(url);
    badTokenUrl.searchParams.set('key', 'wrong');
    const rejected = await fetch(badTokenUrl, { headers: { Connection: 'close' } });
    assert.equal(rejected.status, 404);

    url.searchParams.set('variant', 'thumbnail');
    const thumbnail = await fetch(url, { headers: { Connection: 'close' } });
    assert.equal(thumbnail.status, 200);
    assert.equal(thumbnail.headers.get('content-type'), 'image/webp');
    assert.equal(thumbnail.headers.get('cache-control'), 'private, max-age=86400, immutable');
    const thumbnailBytes = Buffer.from(await thumbnail.arrayBuffer());
    const thumbnailMetadata = await sharp(thumbnailBytes).metadata();
    assert.ok(thumbnailMetadata.width <= 480);
    assert.ok(thumbnailMetadata.height <= 320);
    assert.equal(thumbnailBytes.includes(Buffer.from('RIFF')), true);

    url.searchParams.set('variant', 'full');
    const full = await fetch(url, { headers: { Connection: 'close' } });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), IMAGE_TYPES.jpeg.mimeType);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), image);

    const traversal = new URL(`/_desktop/captures/%2e%2e%2fprivate.jpg`, baseUrl);
    traversal.searchParams.set('key', accessToken);
    const traversalResponse = await fetch(traversal, { headers: { Connection: 'close' } });
    assert.equal(traversalResponse.status, 404);

    const corruptUrl = new URL(`/_desktop/captures/${corruptFilename}`, baseUrl);
    corruptUrl.searchParams.set('key', accessToken);
    const corrupt = await fetch(corruptUrl, { headers: { Connection: 'close' } });
    assert.equal(corrupt.status, 404);
  }, {
    capturesDirectory,
    captureAccessToken: accessToken,
    thumbnailCache
  });
});

test('no HTTP route lists or serves captures, including traversal attempts', async (context) => {
  await withServer(context, async (baseUrl) => {
    const requests = [
      '/captures',
      '/captures/',
      '/captures/capture_01234567-89ab-cdef-0123-456789abcdef.jpg',
      '/captures/../private.txt',
      '/captures/..%5cprivate.txt',
      '/captures/%2e%2e%2fprivate.txt',
      '/captures/%2e%2e%5cprivate.txt',
      '/captures/%252e%252e%252fprivate.txt',
      '/captures/C%3A%5cWindows%5cwin.ini',
      '/captures/%00private.txt'
    ];

    for (const requestPath of requests) {
      const response = await fetch(`${baseUrl}${requestPath}`);
      assert.equal(response.status, 404, requestPath);
      const body = await response.text();
      assert.deepEqual(JSON.parse(body), { error: 'Not found' });
      assert.ok(!body.includes('private.txt'));
    }
  });
});

test('public mobile and status endpoints receive security headers', async (context) => {
  await withServer(context, async (baseUrl) => {
    const mobileResponse = await fetch(`${baseUrl}/mobile/`);
    assert.equal(mobileResponse.status, 200);
    assert.match(mobileResponse.headers.get('content-security-policy'), /object-src 'none'/);
    assert.equal(mobileResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(mobileResponse.headers.get('x-frame-options'), 'DENY');
    assert.equal(mobileResponse.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(mobileResponse.headers.get('cache-control'), 'no-store');
    assert.equal(mobileResponse.headers.get('x-powered-by'), null);

    const statusResponse = await fetch(`${baseUrl}/status`);
    assert.deepEqual(await statusResponse.json(), {
      status: 'online',
      ip: '127.0.0.1',
      port: 8080
    });
  });
});
