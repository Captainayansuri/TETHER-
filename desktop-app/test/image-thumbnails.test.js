const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const {
  createThumbnailCache,
  getThumbnailPath,
  THUMBNAIL_TEMP_PATTERN
} = require('../image-thumbnails');

const CACHE_LIMIT = 1024 * 1024;

function fakeWebp(size = 12) {
  const bytes = Buffer.alloc(size);
  bytes.write('RIFF', 0, 'ascii');
  bytes.write('WEBP', 8, 'ascii');
  return bytes;
}

async function createCapture(directory, extension, format, idSuffix = 'a') {
  const captureId = `12345678-1234-4123-8123-123456789ab${idSuffix}`;
  const imagePath = path.join(directory, `capture_${captureId}.${extension}`);
  const image = await sharp({
    create: {
      width: 800,
      height: 600,
      channels: 3,
      background: { r: 30, g: 80, b: 120 }
    }
  })[format]().toBuffer();
  await fs.writeFile(imagePath, image);
  return {
    captureId,
    imagePath,
    image,
    sha256: crypto.createHash('sha256').update(image).digest('hex')
  };
}

async function withDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tether-thumbnails-'));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100
    });
  }
}

test('thumbnails support JPEG, PNG and WebP without modifying originals', async () => {
  await withDirectory(async (capturesDirectory) => {
    const cache = createThumbnailCache({ capturesDirectory, maxBytes: CACHE_LIMIT });
    for (const [extension, format] of [['jpg', 'jpeg'], ['png', 'png'], ['webp', 'webp']]) {
      const capture = await createCapture(capturesDirectory, extension, format, extension === 'jpg' ? '1' : extension === 'png' ? '2' : '3');
      const original = await fs.readFile(capture.imagePath);
      const thumbnailPath = await cache.get(capture);
      const thumbnailBytes = await fs.readFile(thumbnailPath);
      const thumbnail = await sharp(thumbnailBytes).metadata();
      assert.equal(thumbnail.format, 'webp');
      assert.ok(thumbnail.width <= 480);
      assert.ok(thumbnail.height <= 320);
      assert.deepEqual(await fs.readFile(capture.imagePath), original);
    }
    assert.equal(cache.size, 3);
  });
});

test('thumbnail dimensions are configurable independently of the original image', async () => {
  await withDirectory(async (capturesDirectory) => {
    const capture = await createCapture(capturesDirectory, 'jpg', 'jpeg');
    const cache = createThumbnailCache({
      capturesDirectory,
      maxBytes: CACHE_LIMIT,
      width: 160,
      height: 120
    });

    const thumbnailPath = await cache.get(capture);
    const thumbnail = await sharp(thumbnailPath).metadata();
    const original = await sharp(capture.imagePath).metadata();

    assert.equal(thumbnail.width, 160);
    assert.equal(thumbnail.height, 120);
    assert.equal(original.width, 800);
    assert.equal(original.height, 600);
  });
});

test('concurrent requests share one generation and subsequent requests reuse cache', async () => {
  await withDirectory(async (capturesDirectory) => {
    let generations = 0;
    const cache = createThumbnailCache({
      capturesDirectory,
      maxBytes: CACHE_LIMIT,
      generate: async ({ capturesDirectory: directory, captureId, sha256 }) => {
        generations += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        await fs.writeFile(getThumbnailPath(directory, captureId, sha256), fakeWebp());
      }
    });
    const capture = await createCapture(capturesDirectory, 'jpg', 'jpeg');
    const paths = await Promise.all(Array.from({ length: 10 }, () => cache.get(capture)));
    assert.equal(new Set(paths).size, 1);
    assert.equal(generations, 1);
    await cache.get(capture);
    assert.equal(generations, 1);
    assert.equal(cache.inFlightCount, 0);
  });
});

test('cache evicts least recently used thumbnails to stay within byte limit', async () => {
  await withDirectory(async (capturesDirectory) => {
    let currentTime = 1_000_000;
    const cache = createThumbnailCache({
      capturesDirectory,
      maxBytes: CACHE_LIMIT,
      now: () => currentTime,
      generate: async ({ capturesDirectory: directory, captureId, sha256 }) => {
        await fs.writeFile(
          getThumbnailPath(directory, captureId, sha256),
          fakeWebp(600 * 1024)
        );
      }
    });
    const first = await createCapture(capturesDirectory, 'jpg', 'jpeg', '1');
    const second = await createCapture(capturesDirectory, 'jpg', 'jpeg', '2');
    await cache.get(first);
    currentTime += 1;
    await cache.get(second);
    assert.equal(cache.size, 1);
    assert.equal(cache.sizeBytes, 600 * 1024);
    await assert.rejects(fs.access(getThumbnailPath(capturesDirectory, first.captureId, first.sha256)));
    await fs.access(getThumbnailPath(capturesDirectory, second.captureId, second.sha256));
  });
});

test('startup cleanup removes expired, orphaned, and interrupted thumbnails', async () => {
  await withDirectory(async (capturesDirectory) => {
    let currentTime = 2_000_000;
    const cache = createThumbnailCache({
      capturesDirectory,
      maxBytes: CACHE_LIMIT,
      maxAgeMs: 60_000,
      now: () => currentTime,
      generate: async ({ capturesDirectory: directory, captureId, sha256 }) => {
        await fs.writeFile(getThumbnailPath(directory, captureId, sha256), fakeWebp());
      }
    });
    const valid = await createCapture(capturesDirectory, 'jpg', 'jpeg');
    const orphan = await createCapture(capturesDirectory, 'png', 'png', '2');
    const validPath = await cache.get(valid);
    const orphanPath = await cache.get(orphan);
    const expiredPath = await cache.get(await createCapture(capturesDirectory, 'webp', 'webp', '3'));
    const interruptedPath = path.join(
      capturesDirectory,
      `.thumb_${valid.captureId}_${valid.sha256}_${crypto.randomUUID()}.tmp`
    );
    const legacyThumbnailPath = path.join(capturesDirectory, `.thumb_${valid.captureId}.webp`);
    const legacyInterruptedPath = path.join(
      capturesDirectory,
      `.thumb_${valid.captureId}_${crypto.randomUUID()}.tmp`
    );
    assert.match(path.basename(interruptedPath), THUMBNAIL_TEMP_PATTERN);
    await fs.writeFile(interruptedPath, 'incomplete');
    await fs.writeFile(legacyThumbnailPath, fakeWebp());
    await fs.writeFile(legacyInterruptedPath, 'old interrupted file');
    currentTime += 61_000;
    await fs.utimes(expiredPath, new Date(1), new Date(1));

    const result = await cache.cleanup({
      validCaptures: [{ captureId: valid.captureId, sha256: valid.sha256 }]
    });
    assert.equal(result.entries, 1);
    assert.ok(await fs.stat(validPath));
    await assert.rejects(fs.access(orphanPath));
    await assert.rejects(fs.access(expiredPath));
    await assert.rejects(fs.access(interruptedPath));
    await assert.rejects(fs.access(legacyThumbnailPath));
    await assert.rejects(fs.access(legacyInterruptedPath));
  });
});

test('invalid cached thumbnails are regenerated instead of being served', async () => {
  await withDirectory(async (capturesDirectory) => {
    let generations = 0;
    const capture = await createCapture(capturesDirectory, 'jpg', 'jpeg');
    const thumbnailPath = getThumbnailPath(capturesDirectory, capture.captureId, capture.sha256);
    await fs.writeFile(thumbnailPath, 'not webp');
    const cache = createThumbnailCache({
      capturesDirectory,
      maxBytes: CACHE_LIMIT,
      generate: async ({ capturesDirectory: directory, captureId, sha256 }) => {
        generations += 1;
        await fs.writeFile(getThumbnailPath(directory, captureId, sha256), fakeWebp());
      }
    });
    assert.equal(await cache.get(capture), thumbnailPath);
    assert.equal(generations, 1);
    assert.deepEqual(await fs.readFile(thumbnailPath), fakeWebp());
  });
});
