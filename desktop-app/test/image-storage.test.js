const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  cleanupAbandonedUploads,
  createUploadQueue,
  createCaptureStorageQuota,
  getMaxQueuedUploads,
  DEFAULT_MAX_QUEUED_UPLOADS,
  recoverCaptureStorage,
  persistCaptureMetadata
} = require('../image-storage');
const crypto = require('crypto');

const CAPTURE_ID = 'e7384ed3-f66a-4caf-98e2-e6d26bc8f501';
const SECOND_CAPTURE_ID = 'e7384ed3-f66a-4caf-98e2-e6d26bc8f502';

test('capture storage quota initializes from existing files without altering user data', async (context) => {
  const capturesDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-quota-startup-'));
  context.after(() => fs.rmSync(capturesDirectory, { recursive: true, force: true }));
  const existingName = `capture_${CAPTURE_ID}.jpg`;
  const existingBytes = Buffer.from('preserve existing capture bytes');
  await fs.promises.writeFile(path.join(capturesDirectory, existingName), existingBytes);
  const quota = createCaptureStorageQuota({ capturesDirectory, maxBytes: 1024 });

  assert.equal(quota.reserve(CAPTURE_ID, 1), null, 'quota must not reserve before initialization');
  assert.equal(await quota.initialize(), existingBytes.length);
  const reservation = quota.reserve(SECOND_CAPTURE_ID, 10);
  assert.ok(reservation);
  reservation.release();
  assert.deepEqual(await fs.promises.readFile(path.join(capturesDirectory, existingName)), existingBytes);
});

test('capture storage quota reports initialization failures without mutating the directory', async () => {
  const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const quota = createCaptureStorageQuota({
    capturesDirectory: 'unavailable-captures-directory',
    maxBytes: 1024,
    fileSystem: { readdir: async () => { throw error; } }
  });

  await assert.rejects(quota.initialize(), { code: 'EACCES' });
  assert.equal(quota.reserve(CAPTURE_ID, 1), null);
  assert.equal(quota.usedBytes, 0);
});

function createWindowsPersistenceFileSystem({ failAt, failCode = 'EACCES' } = {}) {
  const events = [];
  const fileSystem = new Proxy(fs.promises, {
    get(target, property) {
      if (property === 'open') {
        return async (filename, ...args) => {
          const name = path.basename(filename);
          events.push(`open:${name}`);
          if (failAt === 'open-final' && name.startsWith('.capture_')) {
            const error = new Error('permission denied');
            error.code = failCode;
            throw error;
          }
          const handle = await fs.promises.open(filename, ...args);
          return new Proxy(handle, {
            get(file, method) {
              if (method === 'writeFile') {
                return async (data, ...writeArgs) => {
                  events.push('write');
                  if (failAt === 'write-interrupted') {
                    await file.writeFile(String(data).slice(0, 12), ...writeArgs);
                    const error = new Error('simulated interrupted write');
                    error.code = 'EIO';
                    throw error;
                  }
                  return file.writeFile(data, ...writeArgs);
                };
              }
              if (method === 'sync') {
                return async (...syncArgs) => {
                  events.push('file-sync');
                  return file.sync(...syncArgs);
                };
              }
              if (method === 'close') {
                return async (...closeArgs) => {
                  events.push('close');
                  return file.close(...closeArgs);
                };
              }
              const value = Reflect.get(file, method, file);
              return typeof value === 'function' ? value.bind(file) : value;
            }
          });
        };
      }
      if (property === 'rename') {
        return async (...args) => {
          events.push('rename');
          return fs.promises.rename(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return { fileSystem, events };
}

function captureMetadata(captureId = CAPTURE_ID) {
  return {
    captureId,
    size: 32,
    imageType: 'jpeg',
    sha256: 'a'.repeat(64),
    receivedAt: 123
  };
}

function createJpeg(size = 32) {
  const image = Buffer.alloc(size);
  Buffer.from([0xff, 0xd8, 0xff, 0xdb]).copy(image);
  return image;
}

test('queued upload limit defaults safely and supports bounded configuration', () => {
  assert.equal(getMaxQueuedUploads(undefined), DEFAULT_MAX_QUEUED_UPLOADS);
  assert.equal(getMaxQueuedUploads('0'), 0);
  assert.equal(getMaxQueuedUploads('512'), 512);
  assert.throws(() => getMaxQueuedUploads('-1'), /between 0 and 512/);
  assert.throws(() => getMaxQueuedUploads('513'), /between 0 and 512/);
  assert.throws(() => getMaxQueuedUploads('many'), /between 0 and 512/);
});

test('upload queue bounds hundreds of requests, deduplicates IDs, and resumes FIFO', async () => {
  const maxConcurrent = 4;
  const maxQueued = 32;
  const queue = createUploadQueue(maxConcurrent, maxQueued);
  const admitted = [];
  const accepted = [];
  const full = [];
  const states = new Map();

  for (let index = 0; index < 300; index += 1) {
    const captureId = `capture-${index}`;
    const result = queue.enqueue({
      captureId,
      digest: String(index),
      onAdmit: (ticket) => admitted.push(ticket),
      onQueueState: (state) => states.set(captureId, state)
    });
    if (result.status === 'full') full.push(captureId);
    else accepted.push({ captureId, result });
  }

  assert.equal(queue.activeCount, maxConcurrent);
  assert.equal(queue.queuedCount, maxQueued);
  assert.equal(queue.size, maxConcurrent + maxQueued);
  assert.equal(accepted.length, maxConcurrent + maxQueued);
  assert.equal(full.length, 300 - maxConcurrent - maxQueued);
  assert.equal(states.get(accepted[maxConcurrent].captureId).position, 1);

  const duplicate = queue.enqueue({
    captureId: accepted[maxConcurrent].captureId,
    digest: String(maxConcurrent),
    onAdmit: () => assert.fail('duplicate capture must not be admitted twice')
  });
  assert.equal(duplicate.status, 'duplicate');
  const conflicting = queue.enqueue({
    captureId: accepted[maxConcurrent].captureId,
    digest: 'different',
    onAdmit: () => assert.fail('conflicting capture ID must not be admitted')
  });
  assert.equal(conflicting.status, 'conflict');
  assert.equal(queue.size, maxConcurrent + maxQueued);

  let released = 0;
  while (queue.size > 0) {
    await new Promise((resolve) => setImmediate(resolve));
    const batch = admitted.splice(0);
    assert.ok(batch.length > 0, 'waiting queue should admit work after capacity is released');
    for (const ticket of batch) {
      ticket.release();
      released += 1;
    }
  }
  assert.equal(released, maxConcurrent + maxQueued);
  assert.equal(queue.activeCount, 0);
  assert.equal(queue.queuedCount, 0);

  const retry = queue.enqueue({
    captureId: full[0],
    digest: String(Number(full[0].slice('capture-'.length))),
    onAdmit: (ticket) => admitted.push(ticket)
  });
  assert.ok(['active', 'queued'].includes(retry.status));
  assert.equal(queue.size, 1);
  retry.ticket.release();
});

test('queued transfer state updates positions and slot release automatically admits next capture', async () => {
  const queue = createUploadQueue(1, 2);
  const active = [];
  const states = new Map();
  const add = (captureId) => queue.enqueue({
    captureId,
    digest: captureId,
    onAdmit: (ticket) => active.push(ticket),
    onQueueState: (state) => states.set(captureId, state)
  });

  const first = add('first');
  const second = add('second');
  const third = add('third');
  assert.equal(first.status, 'active');
  assert.equal(second.status, 'queued');
  assert.equal(third.status, 'queued');
  assert.equal(states.get('third').position, 2);

  await new Promise((resolve) => setImmediate(resolve));
  active.shift().release();
  assert.equal(states.get('third').position, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active.length, 1);
  assert.equal(active[0].captureId, 'second');
  active.shift().release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active[0].captureId, 'third');
  active.shift().release();
  assert.equal(queue.size, 0);
});

test('upload queue rejects new work during shutdown and waits for admitted entries', async () => {
  const queue = createUploadQueue(1, 1);
  const activeTickets = [];
  const active = queue.enqueue({
    captureId: 'active',
    digest: 'active',
    onAdmit: (ticket) => activeTickets.push(ticket)
  });
  const waiting = queue.enqueue({
    captureId: 'waiting',
    digest: 'waiting',
    onAdmit: (ticket) => activeTickets.push(ticket)
  });
  await new Promise((resolve) => setImmediate(resolve));

  let drained = false;
  const draining = queue.waitForIdle().then(() => { drained = true; });
  queue.stopAccepting();
  assert.equal(queue.enqueue({
    captureId: 'late',
    digest: 'late',
    onAdmit: () => assert.fail('shutdown must reject new queue work')
  }).status, 'closed');
  assert.equal(drained, false);

  activeTickets[0].release();
  await new Promise((resolve) => setImmediate(resolve));
  activeTickets[1].release();
  await draining;

  assert.equal(active.status, 'active');
  assert.equal(waiting.status, 'queued');
  assert.equal(drained, true);
  assert.equal(queue.size, 0);
});

test('startup cleanup deletes only old generated upload temporary files', async (context) => {
  const capturesDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-cleanup-'));
  context.after(() => fs.rmSync(capturesDirectory, { recursive: true, force: true }));
  const abandoned = `.upload_${CAPTURE_ID}_${CAPTURE_ID}.tmp`;
  const recent = `.upload_e7384ed3-f66a-4caf-98e2-e6d26bc8f502_${CAPTURE_ID}.tmp`;
  const unrelated = 'keep.tmp';
  const directory = `.upload_${CAPTURE_ID}_${CAPTURE_ID}.tmp.dir`;
  await Promise.all([
    fs.promises.writeFile(path.join(capturesDirectory, abandoned), 'old'),
    fs.promises.writeFile(path.join(capturesDirectory, recent), 'new'),
    fs.promises.writeFile(path.join(capturesDirectory, unrelated), 'keep'),
    fs.promises.mkdir(path.join(capturesDirectory, directory))
  ]);
  const oldDate = new Date(Date.now() - 60_000);
  await fs.promises.utimes(path.join(capturesDirectory, abandoned), oldDate, oldDate);
  const removed = await cleanupAbandonedUploads(capturesDirectory, {
    now: Date.now(),
    temporaryFileTtlMs: 30_000
  });

  assert.deepEqual(removed, [abandoned]);
  assert.equal(fs.existsSync(path.join(capturesDirectory, abandoned)), false);
  assert.equal(fs.existsSync(path.join(capturesDirectory, recent)), true);
  assert.equal(fs.existsSync(path.join(capturesDirectory, unrelated)), true);
  assert.equal(fs.existsSync(path.join(capturesDirectory, directory)), true);
});

test('permission errors during abandoned-file cleanup are surfaced to startup', async (context) => {
  const capturesDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-cleanup-'));
  context.after(() => fs.rmSync(capturesDirectory, { recursive: true, force: true }));
  const fakeFileSystem = {
    readdir: async () => [{ name: `.upload_${CAPTURE_ID}_${CAPTURE_ID}.tmp`, isFile: () => true }],
    stat: async () => ({ mtimeMs: 0 }),
    unlink: async () => {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    }
  };
  await assert.rejects(
    cleanupAbandonedUploads(capturesDirectory, {
      fileSystem: fakeFileSystem,
      now: 10_000,
      temporaryFileTtlMs: 1
    }),
    { code: 'EACCES' }
  );
});

test('Windows metadata save flushes the temp file then atomically renames without opening the directory', async (context) => {
  const capturesDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-win-save-'));
  context.after(() => fs.rmSync(capturesDirectory, { recursive: true, force: true }));
  const { fileSystem, events } = createWindowsPersistenceFileSystem();

  const finalPath = await persistCaptureMetadata(
    capturesDirectory,
    captureMetadata(),
    fileSystem,
    'win32'
  );

  assert.deepEqual(JSON.parse(await fs.promises.readFile(finalPath, 'utf8')), {
    version: 1,
    ...captureMetadata()
  });
  assert.ok(events.indexOf('write') < events.indexOf('file-sync'));
  assert.ok(events.indexOf('file-sync') < events.indexOf('rename'));
  assert.ok(events.indexOf('close') < events.indexOf('rename'));
  assert.equal(events.some((event) => event === `open:${path.basename(capturesDirectory)}`), false);
  assert.equal((await fs.promises.readdir(capturesDirectory)).some((name) => name.endsWith('.tmp')), false);
});

test('Windows metadata save does not suppress EACCES or EPERM destination errors', async (context) => {
  const capturesDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-win-denied-'));
  context.after(() => fs.rmSync(capturesDirectory, { recursive: true, force: true }));
  for (const code of ['EACCES', 'EPERM']) {
    const { fileSystem } = createWindowsPersistenceFileSystem({ failAt: 'open-final', failCode: code });
    await assert.rejects(
      persistCaptureMetadata(capturesDirectory, captureMetadata(), fileSystem, 'win32'),
      { code }
    );
  }
  assert.deepEqual(await fs.promises.readdir(capturesDirectory), []);
});

test('Windows interrupted metadata write is cleaned up and recovery keeps only a verified save', async (context) => {
  const capturesDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-win-recovery-'));
  context.after(() => fs.rmSync(capturesDirectory, { recursive: true, force: true }));
  const interrupted = createWindowsPersistenceFileSystem({ failAt: 'write-interrupted' });
  await assert.rejects(
    persistCaptureMetadata(capturesDirectory, captureMetadata(), interrupted.fileSystem, 'win32'),
    { code: 'EIO' }
  );
  assert.deepEqual(await fs.promises.readdir(capturesDirectory), []);

  const image = createJpeg();
  const validMetadata = {
    ...captureMetadata(SECOND_CAPTURE_ID),
    size: image.length,
    sha256: crypto.createHash('sha256').update(image).digest('hex')
  };
  await fs.promises.writeFile(path.join(capturesDirectory, `capture_${SECOND_CAPTURE_ID}.jpg`), image);
  await persistCaptureMetadata(capturesDirectory, validMetadata, fs.promises, 'win32');
  await fs.promises.writeFile(
    path.join(capturesDirectory, `.metadata_${CAPTURE_ID}_${SECOND_CAPTURE_ID}.tmp`),
    '{partial'
  );

  const recovered = await recoverCaptureStorage(capturesDirectory, { temporaryFileTtlMs: 0 });
  assert.deepEqual(recovered.validCaptures.map(({ captureId }) => captureId), [SECOND_CAPTURE_ID]);
  assert.ok(recovered.removedTemporaryFiles.some((name) => name.startsWith('.metadata_')));
});

test('startup recovery removes generated temp files and preserves verified and invalid user captures', async (context) => {
  const capturesDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-recovery-'));
  context.after(() => fs.rmSync(capturesDirectory, { recursive: true, force: true }));
  const image = createJpeg();
  const metadata = {
    version: 1,
    captureId: CAPTURE_ID,
    size: image.length,
    imageType: 'jpeg',
    sha256: crypto.createHash('sha256').update(image).digest('hex')
  };
  const savedFile = `capture_${CAPTURE_ID}.jpg`;
  await fs.promises.writeFile(path.join(capturesDirectory, savedFile), image);
  await fs.promises.writeFile(
    path.join(capturesDirectory, `.capture_${CAPTURE_ID}.json`),
    JSON.stringify(metadata)
  );
  await fs.promises.writeFile(path.join(capturesDirectory, `capture_${SECOND_CAPTURE_ID}.jpg`), 'partial');
  await fs.promises.writeFile(
    path.join(capturesDirectory, `.capture_${SECOND_CAPTURE_ID}.json`),
    JSON.stringify({ ...metadata, captureId: SECOND_CAPTURE_ID, size: 7 })
  );
  const abandoned = `.upload_${SECOND_CAPTURE_ID}_${CAPTURE_ID}.tmp`;
  const interruptedMetadata = `.metadata_${SECOND_CAPTURE_ID}_${CAPTURE_ID}.tmp`;
  const abandonedThumbnail = `.thumb_${SECOND_CAPTURE_ID}_${'a'.repeat(64)}_${CAPTURE_ID}.tmp`;
  const legacyAbandonedThumbnail = `.thumb_${SECOND_CAPTURE_ID}_${CAPTURE_ID}.tmp`;
  await fs.promises.writeFile(path.join(capturesDirectory, abandoned), image.subarray(0, 4));
  await fs.promises.writeFile(path.join(capturesDirectory, interruptedMetadata), '{"version":');
  await fs.promises.writeFile(path.join(capturesDirectory, abandonedThumbnail), 'partial thumbnail');
  await fs.promises.writeFile(path.join(capturesDirectory, legacyAbandonedThumbnail), 'partial old thumbnail');

  const result = await recoverCaptureStorage(capturesDirectory, {
    temporaryFileTtlMs: 0
  });
  assert.deepEqual(
    result.removedTemporaryFiles.sort(),
    [abandoned, interruptedMetadata, abandonedThumbnail, legacyAbandonedThumbnail].sort()
  );
  assert.deepEqual(result.invalidCaptures, [SECOND_CAPTURE_ID]);
  assert.equal(fs.existsSync(path.join(capturesDirectory, savedFile)), true);
  assert.equal(await fs.promises.readFile(path.join(capturesDirectory, `capture_${SECOND_CAPTURE_ID}.jpg`), 'utf8'), 'partial');
  assert.deepEqual(
    JSON.parse(await fs.promises.readFile(path.join(capturesDirectory, `.capture_${SECOND_CAPTURE_ID}.json`), 'utf8')),
    { ...metadata, captureId: SECOND_CAPTURE_ID, size: 7 }
  );
});

test('startup preserves orphan metadata and rejects a committed image with a mismatching digest', async (context) => {
  const capturesDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-recovery-'));
  context.after(() => fs.rmSync(capturesDirectory, { recursive: true, force: true }));
  const image = createJpeg();
  await fs.promises.writeFile(path.join(capturesDirectory, `capture_${CAPTURE_ID}.jpg`), image);
  await fs.promises.writeFile(
    path.join(capturesDirectory, `.capture_${CAPTURE_ID}.json`),
    JSON.stringify({
      version: 1,
      captureId: CAPTURE_ID,
      size: image.length,
      imageType: 'jpeg',
      sha256: '0'.repeat(64)
    })
  );
  const orphanMetadataId = SECOND_CAPTURE_ID;
  await fs.promises.writeFile(
    path.join(capturesDirectory, `.capture_${orphanMetadataId}.json`),
    JSON.stringify({ version: 1 })
  );

  const result = await recoverCaptureStorage(capturesDirectory, { temporaryFileTtlMs: 0 });
  assert.deepEqual(result.invalidCaptures, [CAPTURE_ID]);
  assert.deepEqual(result.orphanMetadata, [orphanMetadataId]);
  assert.deepEqual(await fs.promises.readFile(path.join(capturesDirectory, `capture_${CAPTURE_ID}.jpg`)), image);
  assert.equal(fs.existsSync(path.join(capturesDirectory, `.capture_${CAPTURE_ID}.json`)), true);
  assert.equal(fs.existsSync(path.join(capturesDirectory, `.capture_${orphanMetadataId}.json`)), true);
});
