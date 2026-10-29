const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { createImageTransferReceiver, sha256 } = require('../image-transfer');
const { createUploadQueue, recoverCaptureStorage } = require('../image-storage');

const CAPTURE_ID = '1f913e6c-1f22-4e12-a47b-1ae4fb2b2910';

function createImage(type = 'jpeg', size = 32) {
  const validImage = fs.readFileSync(path.join(__dirname, 'fixtures', `decoder-valid.${type}`));
  const image = Buffer.alloc(Math.max(size, validImage.length));
  validImage.copy(image);
  return image;
}

function createJpeg(size = 32) {
  return createImage('jpeg', size);
}

function metadata(image, captureId = CAPTURE_ID, imageType = 'jpeg') {
  return {
    type: 'image_upload',
    captureId,
    size: image.length,
    imageType,
    sha256: sha256(image)
  };
}

function createFixture(context, options = {}) {
  const capturesDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-transfer-'));
  context.after(async () => fs.promises.rm(capturesDirectory, { recursive: true, force: true }));
  const messages = [];
  const saved = [];
  const receiver = createImageTransferReceiver({
    capturesDirectory,
    maxImageBytes: 1024,
    send: (message) => messages.push(JSON.parse(message)),
    onSaved: (image) => saved.push(image),
    ...options
  });
  return { capturesDirectory, messages, receiver, saved };
}

function states(messages) {
  return messages.filter((message) => message.type === 'transfer_status').map((message) => message.state);
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

test('acknowledgement follows validation and verified atomic persistence', async (context) => {
  const image = createJpeg();
  const fixture = createFixture(context);
  await fixture.receiver.handleText(JSON.stringify(metadata(image)));
  assert.equal(fixture.messages.some((message) => message.type === 'upload_ready'), true);

  await fixture.receiver.handleBinary(image);

  const ack = fixture.messages.find((message) => message.type === 'image_ack');
  assert.deepEqual(states(fixture.messages), ['SERVER_RECEIVED', 'FILE_VALIDATED', 'FILE_SAVED']);
  assert.equal(ack.captureId, CAPTURE_ID);
  assert.equal(ack.state, 'ACKNOWLEDGED');
  assert.equal(ack.persisted, true);
  assert.ok(
    fixture.messages.findIndex((message) => message.type === 'image_ack') >
    fixture.messages.findIndex((message) => message.type === 'transfer_status' && message.state === 'FILE_SAVED')
  );
  assert.equal(fs.readFileSync(path.join(fixture.capturesDirectory, ack.filename)).compare(image), 0);
  assert.equal(fixture.saved.length, 1);
  assert.equal(fs.readdirSync(fixture.capturesDirectory).filter((name) => name.endsWith('.tmp')).length, 0);
  const savedMetadata = JSON.parse(fs.readFileSync(
    path.join(fixture.capturesDirectory, `.capture_${CAPTURE_ID}.json`),
    'utf8'
  ));
  assert.equal(savedMetadata.captureId, CAPTURE_ID);
  assert.equal(savedMetadata.sha256, sha256(image));
});

test('uploads are explicitly rejected while the server is shutting down', async (context) => {
  const image = createJpeg();
  const queue = createUploadQueue(1, 1);
  queue.stopAccepting();
  const fixture = createFixture(context, { uploadQueue: queue });

  await fixture.receiver.handleText(JSON.stringify(metadata(image)));

  assert.deepEqual(
    fixture.messages.filter((message) => message.type === 'upload_error').map((message) => message.code),
    ['SERVER_SHUTTING_DOWN']
  );
  assert.equal(fs.readdirSync(fixture.capturesDirectory).length, 0);
  await fixture.receiver.close();
});

test('camera JPEG persistence preserves encoded bytes, dimensions, and EXIF orientation', async (context) => {
  const sourceImage = await sharp({
    create: {
      width: 1920,
      height: 1080,
      channels: 3,
      background: { r: 35, g: 85, b: 125 }
    }
  }).jpeg({ quality: 82 }).withMetadata({ orientation: 6 }).toBuffer();
  const sourceMetadata = await sharp(sourceImage).metadata();
  assert.equal(sourceMetadata.width, 1920);
  assert.equal(sourceMetadata.height, 1080);
  assert.equal(sourceMetadata.orientation, 6);

  const fixture = createFixture(context, { maxImageBytes: 2 * 1024 * 1024 });
  await fixture.receiver.handleText(JSON.stringify(metadata(sourceImage)));
  await fixture.receiver.handleBinary(sourceImage);

  const acknowledgement = fixture.messages.find((message) => message.type === 'image_ack');
  assert.ok(acknowledgement);
  const savedImage = fs.readFileSync(path.join(fixture.capturesDirectory, acknowledgement.filename));
  assert.deepEqual(savedImage, sourceImage);
  assert.equal(sha256(savedImage), sha256(sourceImage));
  const savedMetadata = await sharp(savedImage).metadata();
  assert.equal(savedMetadata.width, sourceMetadata.width);
  assert.equal(savedMetadata.height, sourceMetadata.height);
  assert.equal(savedMetadata.orientation, sourceMetadata.orientation);
  assert.deepEqual(savedMetadata.exif, sourceMetadata.exif);
});

test('disconnect before the binary frame leaves no file and same-ID retry persists once', async (context) => {
  const image = createJpeg();
  const fixture = createFixture(context);
  await fixture.receiver.handleText(JSON.stringify(metadata(image)));
  await fixture.receiver.close();
  assert.equal(fs.readdirSync(fixture.capturesDirectory).length, 0);

  const retryMessages = [];
  const retryReceiver = createImageTransferReceiver({
    capturesDirectory: fixture.capturesDirectory,
    maxImageBytes: 1024,
    send: (message) => retryMessages.push(JSON.parse(message))
  });
  await retryReceiver.handleText(JSON.stringify(metadata(image)));
  await retryReceiver.handleBinary(image);

  assert.equal(retryMessages.filter((message) => message.type === 'image_ack').length, 1);
  assert.equal(fs.readdirSync(fixture.capturesDirectory).filter((name) => name.endsWith('.jpg')).length, 1);
});

test('partial upload disconnect removes the temporary file before a full same-ID retry', async (context) => {
  const image = createImage('jpeg', 32);
  const fixture = createFixture(context, { chunkSize: 4 });
  await fixture.receiver.handleText(JSON.stringify(metadata(image)));
  await fixture.receiver.handleBinary(image.subarray(0, 4));
  assert.equal(fixture.messages.at(-1).type, 'chunk_ack');
  assert.equal(fs.readdirSync(fixture.capturesDirectory).filter((name) => name.endsWith('.tmp')).length, 1);

  await fixture.receiver.close();
  assert.deepEqual(fs.readdirSync(fixture.capturesDirectory), []);

  const retryMessages = [];
  const retryReceiver = createImageTransferReceiver({
    capturesDirectory: fixture.capturesDirectory,
    maxImageBytes: 1024,
    chunkSize: 4,
    send: (message) => retryMessages.push(JSON.parse(message))
  });
  await retryReceiver.handleText(JSON.stringify(metadata(image)));
  for (let offset = 0; offset < image.length; offset += 4) {
    await retryReceiver.handleBinary(image.subarray(offset, offset + 4));
  }

  assert.equal(retryMessages.filter((message) => message.type === 'image_ack').length, 1);
  assert.deepEqual(
    fs.readFileSync(path.join(fixture.capturesDirectory, `capture_${CAPTURE_ID}.jpg`)),
    image
  );
});

test('graceful receiver close waits for an in-flight write and removes its temporary file', async (context) => {
  const image = createJpeg();
  let finishWrite;
  let notifyWrite;
  const writeStarted = new Promise((resolve) => { notifyWrite = resolve; });
  const writeGate = new Promise((resolve) => { finishWrite = resolve; });
  const fileSystem = new Proxy(fs.promises, {
    get(target, property) {
      if (property !== 'open') return Reflect.get(target, property, target);
      return async (...args) => {
        const handle = await Reflect.get(target, property, target).apply(target, args);
        return new Proxy(handle, {
          get(fileHandle, method) {
            if (method === 'write') {
              return async (...writeArgs) => {
                notifyWrite();
                await writeGate;
                return fileHandle.write(...writeArgs);
              };
            }
            const value = Reflect.get(fileHandle, method, fileHandle);
            return typeof value === 'function' ? value.bind(fileHandle) : value;
          }
        });
      };
    }
  });
  const fixture = createFixture(context, { fileSystem });
  await fixture.receiver.handleText(JSON.stringify(metadata(image)));

  const writing = fixture.receiver.handleBinary(image.subarray(0, 8));
  await writeStarted;
  let closed = false;
  const closing = fixture.receiver.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);

  finishWrite();
  await Promise.all([writing, closing]);
  assert.equal(closed, true);
  assert.deepEqual(fs.readdirSync(fixture.capturesDirectory), []);
});

test('process crash during transfer leaves only a recoverable temporary file', async (context) => {
  const image = createJpeg();
  const fixture = createFixture(context);
  const abandonedTemp = `.upload_${CAPTURE_ID}_${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(path.join(fixture.capturesDirectory, abandonedTemp), image.subarray(0, 12));

  const recovered = await recoverCaptureStorage(fixture.capturesDirectory, {
    temporaryFileTtlMs: 0
  });
  assert.deepEqual(recovered.removedTemporaryFiles, [abandonedTemp]);
  assert.equal(fs.existsSync(path.join(fixture.capturesDirectory, `capture_${CAPTURE_ID}.jpg`)), false);

  await fixture.receiver.handleText(JSON.stringify(metadata(image)));
  await fixture.receiver.handleBinary(image);
  assert.equal(fixture.messages.some((message) => message.type === 'image_ack'), true);
});

test('interrupted partial write is cleaned and a retry can complete the capture', async (context) => {
  const image = createJpeg();
  let shouldFail = true;
  const interruptedFileSystem = new Proxy(fs.promises, {
    get(target, property) {
      if (property !== 'open') {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (...args) => {
        const file = await Reflect.get(target, property, target).apply(target, args);
        if (args[1] !== 'wx' || !shouldFail) return file;
        return {
          write: async (...writeArgs) => {
            shouldFail = false;
            await file.write(writeArgs[0], writeArgs[1], 8, writeArgs[3]);
            const error = new Error('interrupted write');
            error.code = 'EIO';
            throw error;
          },
          close: file.close.bind(file),
          sync: file.sync.bind(file)
        };
      };
    }
  });
  const fixture = createFixture(context, { fileSystem: interruptedFileSystem });
  await fixture.receiver.handleText(JSON.stringify(metadata(image)));
  await fixture.receiver.handleBinary(image);
  assert.equal(fixture.messages.some((message) =>
    message.type === 'upload_error' && message.retryable
  ), true);
  assert.equal(fs.readdirSync(fixture.capturesDirectory).length, 0);

  const retryMessages = [];
  const retry = createImageTransferReceiver({
    capturesDirectory: fixture.capturesDirectory,
    maxImageBytes: 1024,
    send: (message) => retryMessages.push(JSON.parse(message))
  });
  await retry.handleText(JSON.stringify(metadata(image)));
  await retry.handleBinary(image);
  assert.equal(retryMessages.some((message) => message.type === 'image_ack'), true);
  await retry.close();
});

test('failure flushing capture metadata rolls back the image and does not acknowledge', async (context) => {
  const image = createJpeg();
  const fileSystem = new Proxy(fs.promises, {
    get(target, property) {
      if (property !== 'open') {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (...args) => {
        const file = await Reflect.get(target, property, target).apply(target, args);
        if (args[1] !== 'wx' || !path.basename(args[0]).startsWith('.metadata_')) return file;
        return {
          writeFile: file.writeFile.bind(file),
          sync: async () => {
            const error = new Error('metadata flush failed');
            error.code = 'ENOSPC';
            throw error;
          },
          close: file.close.bind(file)
        };
      };
    }
  });
  const fixture = createFixture(context, { fileSystem });
  await fixture.receiver.handleText(JSON.stringify(metadata(image)));
  await fixture.receiver.handleBinary(image);

  assert.equal(fixture.messages.some((message) => message.type === 'image_ack'), false);
  assert.equal(fixture.messages.at(-1).code, 'DISK_FULL');
  assert.equal(fs.existsSync(path.join(fixture.capturesDirectory, `capture_${CAPTURE_ID}.jpg`)), false);
  assert.equal(fs.readdirSync(fixture.capturesDirectory).some((filename) =>
    filename.startsWith('.capture_') || filename.endsWith('.tmp')
  ), false);
});

test('restart after persistence but lost acknowledgement validates metadata and returns existing result', async (context) => {
  const image = createJpeg();
  const fixture = createFixture(context, {
    send: (message) => {
      const parsed = JSON.parse(message);
      if (parsed.type !== 'image_ack') fixture.messages.push(parsed);
    }
  });
  await fixture.receiver.handleText(JSON.stringify(metadata(image)));
  await fixture.receiver.handleBinary(image);
  assert.equal(fixture.messages.some((message) => message.type === 'image_ack'), false);
  await fixture.receiver.close();

  const recovery = await recoverCaptureStorage(fixture.capturesDirectory, {
    temporaryFileTtlMs: 0
  });
  assert.deepEqual(recovery.invalidCaptures, []);
  const restartMessages = [];
  const restartedReceiver = createImageTransferReceiver({
    capturesDirectory: fixture.capturesDirectory,
    maxImageBytes: 1024,
    send: (message) => restartMessages.push(JSON.parse(message))
  });
  await restartedReceiver.handleText(JSON.stringify(metadata(image)));
  assert.equal(restartMessages.filter((message) => message.type === 'image_ack').length, 1);
  assert.equal(restartMessages.find((message) => message.type === 'image_ack').persisted, true);
  assert.equal(restartMessages.some((message) => message.type === 'upload_ready'), false);
  await restartedReceiver.close();
});

test('split file signatures validate for JPEG, PNG, and WebP uploads', async (context) => {
  const types = [
    ['jpeg', 'jpg'],
    ['png', 'png'],
    ['webp', 'webp']
  ];
  for (const [index, [type, extension]] of types.entries()) {
    const image = createImage(type, 32);
    const fixture = createFixture(context, { chunkSize: 4 });
    const captureId = `5f913e6c-1f22-4e12-a47b-1ae4fb2b291${index}`;
    await fixture.receiver.handleText(JSON.stringify(metadata(image, captureId, type)));
    for (let offset = 0; offset < image.length; offset += 4) {
      await fixture.receiver.handleBinary(image.subarray(offset, offset + 4));
    }

    const ack = fixture.messages.find((message) => message.type === 'image_ack');
    assert.equal(ack.captureId, captureId);
    assert.equal(ack.filename, `capture_${captureId}.${extension}`);
    assert.equal(
      fs.readdirSync(fixture.capturesDirectory).some((name) => name.endsWith('.tmp')),
      false,
      `${type} validation should release the temporary file before acknowledging`
    );
  }
});

test('duplicate capture metadata is idempotently acknowledged without another binary write', async (context) => {
  const image = createJpeg();
  const fixture = createFixture(context);
  const uploadMetadata = metadata(image);
  await fixture.receiver.handleText(JSON.stringify(uploadMetadata));
  await fixture.receiver.handleBinary(image);
  const fileBeforeRetry = fs.readdirSync(fixture.capturesDirectory);
  fixture.messages.length = 0;

  await fixture.receiver.handleText(JSON.stringify(uploadMetadata));

  assert.equal(fixture.messages.length, 1);
  assert.equal(fixture.messages[0].type, 'image_ack');
  assert.equal(fixture.messages[0].captureId, CAPTURE_ID);
  assert.deepEqual(fs.readdirSync(fixture.capturesDirectory), fileBeforeRetry);
  assert.equal(fixture.saved.length, 1);
});

test('sending the same capture twice saves it once and returns the saved result', async (context) => {
  const image = createJpeg();
  const fixture = createFixture(context);
  const uploadMetadata = metadata(image);
  await fixture.receiver.handleText(JSON.stringify(uploadMetadata));
  await fixture.receiver.handleBinary(image);
  fixture.messages.length = 0;

  await fixture.receiver.handleText(JSON.stringify(uploadMetadata));
  const duplicateAck = fixture.messages.find((message) => message.type === 'image_ack');

  assert.equal(duplicateAck.captureId, CAPTURE_ID);
  assert.equal(duplicateAck.persisted, true);
  assert.equal(duplicateAck.filename, `capture_${CAPTURE_ID}.jpg`);
  assert.equal(fixture.saved.length, 1);
  assert.deepEqual(
    fs.readdirSync(fixture.capturesDirectory).filter((filename) => filename.endsWith('.jpg')),
    [`capture_${CAPTURE_ID}.jpg`]
  );
});

test('a lost acknowledgement is recovered by a new receiver without saving twice', async (context) => {
  const image = createJpeg();
  const messages = [];
  let dropFirstAcknowledgement = true;
  const capturesDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-transfer-'));
  context.after(async () => fs.promises.rm(capturesDirectory, { recursive: true, force: true }));
  const createReceiver = (send) => createImageTransferReceiver({
    capturesDirectory,
    maxImageBytes: 1024,
    send
  });
  const firstReceiver = createReceiver((message) => {
      const parsed = JSON.parse(message);
      if (parsed.type === 'image_ack' && dropFirstAcknowledgement) {
        dropFirstAcknowledgement = false;
        return;
      }
      messages.push(parsed);
  });
  const uploadMetadata = metadata(image);
  await firstReceiver.handleText(JSON.stringify(uploadMetadata));
  await firstReceiver.handleBinary(image);
  await firstReceiver.close();
  assert.equal(messages.some((message) => message.type === 'image_ack'), false);

  const retryMessages = [];
  const retryReceiver = createReceiver((message) => retryMessages.push(JSON.parse(message)));
  await retryReceiver.handleText(JSON.stringify(uploadMetadata));

  const acknowledgement = retryMessages.find((message) => message.type === 'image_ack');
  assert.equal(acknowledgement.captureId, CAPTURE_ID);
  assert.equal(acknowledgement.persisted, true);
  assert.equal(fs.readdirSync(capturesDirectory).filter((name) => name.endsWith('.jpg')).length, 1);
});

test('a rejected transfer does not reserve its capture ID and can be retried', async (context) => {
  const image = createJpeg();
  const fixture = createFixture(context);
  const invalidMetadata = { ...metadata(image), sha256: '0'.repeat(64) };
  await fixture.receiver.handleText(JSON.stringify(invalidMetadata));
  await fixture.receiver.handleBinary(image);
  assert.equal(fixture.messages.at(-1).code, 'CHECKSUM_MISMATCH');

  await fixture.receiver.handleText(JSON.stringify(metadata(image)));
  assert.equal(fixture.messages.at(-1).type, 'upload_ready');
  await fixture.receiver.handleBinary(image);

  assert.equal(fixture.messages.filter((message) => message.type === 'image_ack').length, 1);
  assert.equal(fs.readdirSync(fixture.capturesDirectory).filter((name) => name.endsWith('.jpg')).length, 1);
});

test('two clients with different capture IDs save independent images', async (context) => {
  const fixture = createFixture(context);
  const firstImage = createJpeg(32);
  const secondImage = createJpeg(40);
  const secondCaptureId = '2f913e6c-1f22-4e12-a47b-1ae4fb2b2911';
  const firstMessages = [];
  const secondMessages = [];
  const createReceiver = (messages) => createImageTransferReceiver({
    capturesDirectory: fixture.capturesDirectory,
    maxImageBytes: 1024,
    send: (message) => messages.push(JSON.parse(message))
  });
  const firstClient = createReceiver(firstMessages);
  const secondClient = createReceiver(secondMessages);

  await Promise.all([
    firstClient.handleText(JSON.stringify(metadata(firstImage, CAPTURE_ID))),
    secondClient.handleText(JSON.stringify(metadata(secondImage, secondCaptureId)))
  ]);
  await Promise.all([firstClient.handleBinary(firstImage), secondClient.handleBinary(secondImage)]);

  assert.equal(firstMessages.some((message) => message.type === 'image_ack'), true);
  assert.equal(secondMessages.some((message) => message.type === 'image_ack'), true);
  assert.deepEqual(
    fs.readdirSync(fixture.capturesDirectory).filter((filename) => filename.endsWith('.jpg')).sort(),
    [`capture_${CAPTURE_ID}.jpg`, `capture_${secondCaptureId}.jpg`].sort()
  );
  assert.deepEqual(
    fs.readFileSync(path.join(fixture.capturesDirectory, `capture_${secondCaptureId}.jpg`)),
    secondImage
  );
});

test('concurrent clients reusing a capture ID receive one saved result without overwriting', async (context) => {
  const fixture = createFixture(context);
  const image = createJpeg();
  const uploadQueue = createUploadQueue();
  const firstMessages = [];
  const secondMessages = [];
  const createReceiver = (messages) => createImageTransferReceiver({
    capturesDirectory: fixture.capturesDirectory,
    maxImageBytes: 1024,
    uploadQueue,
    send: (message) => messages.push(JSON.parse(message))
  });
  const firstClient = createReceiver(firstMessages);
  const secondClient = createReceiver(secondMessages);

  await firstClient.handleText(JSON.stringify(metadata(image)));
  const secondMetadata = secondClient.handleText(JSON.stringify(metadata(image)));
  assert.equal(
    secondMessages.some((message) => message.type === 'image_ack'),
    false,
    'a duplicate client must wait for the first client to persist the capture'
  );
  await firstClient.handleBinary(image);
  await secondMetadata;

  assert.equal(firstMessages.filter((message) => message.type === 'image_ack').length, 1);
  assert.equal(secondMessages.filter((message) => message.type === 'image_ack').length, 1);
  assert.deepEqual(
    fs.readdirSync(fixture.capturesDirectory).filter((filename) => filename.endsWith('.jpg')),
    [`capture_${CAPTURE_ID}.jpg`]
  );
  assert.deepEqual(
    fs.readFileSync(path.join(fixture.capturesDirectory, `capture_${CAPTURE_ID}.jpg`)),
    image
  );
});

test('a capture ID cannot be saved again under a different image extension', async (context) => {
  const fixture = createFixture(context);
  const jpeg = createJpeg();
  const png = createImage('png');
  const secondMessages = [];
  const queue = createUploadQueue();
  const secondClient = createImageTransferReceiver({
    capturesDirectory: fixture.capturesDirectory,
    maxImageBytes: 1024,
    uploadQueue: queue,
    send: (message) => secondMessages.push(JSON.parse(message))
  });
  const firstClient = createImageTransferReceiver({
    capturesDirectory: fixture.capturesDirectory,
    maxImageBytes: 1024,
    uploadQueue: queue,
    send: (message) => fixture.messages.push(JSON.parse(message))
  });

  await Promise.all([
    firstClient.handleText(JSON.stringify(metadata(jpeg, CAPTURE_ID, 'jpeg'))),
    secondClient.handleText(JSON.stringify(metadata(png, CAPTURE_ID, 'png')))
  ]);
  await Promise.all([firstClient.handleBinary(jpeg), secondClient.handleBinary(png)]);

  assert.equal(secondMessages.some((message) => message.code === 'CAPTURE_ID_CONFLICT'), true);
  assert.equal(
    fs.readdirSync(fixture.capturesDirectory).filter((filename) =>
      filename.endsWith('.jpg') || filename.endsWith('.png')
    ).length,
    1
  );
  assert.deepEqual(fs.readFileSync(path.join(fixture.capturesDirectory, `capture_${CAPTURE_ID}.jpg`)), jpeg);
});

test('malformed capture IDs are rejected before creating temporary or final files', async (context) => {
  const image = createJpeg();
  const invalidIds = [
    '../capture',
    '1f913e6c-1f22-4e12-a47b-1ae4fb2b2910/../other',
    '1f913e6c-1f22-4e12-a47b-1ae4fb2b291',
    '1f913e6c-1f22-0e12-a47b-1ae4fb2b2910'
  ];
  for (const captureId of invalidIds) {
    const fixture = createFixture(context);
    await fixture.receiver.handleText(JSON.stringify(metadata(image, captureId)));
    assert.equal(fixture.messages.at(-1).code, 'INVALID_CAPTURE_ID');
    assert.deepEqual(fs.readdirSync(fixture.capturesDirectory), []);
  }
});

test('capture ID collisions never overwrite an unrelated saved image', async (context) => {
  const fixture = createFixture(context);
  const originalBytes = Buffer.from('unrelated existing file');
  const filename = `capture_${CAPTURE_ID}.jpg`;
  fs.writeFileSync(path.join(fixture.capturesDirectory, filename), originalBytes);
  const image = createJpeg();

  await fixture.receiver.handleText(JSON.stringify(metadata(image)));

  assert.equal(fixture.messages.at(-1).code, 'CAPTURE_ID_CONFLICT');
  assert.deepEqual(fs.readFileSync(path.join(fixture.capturesDirectory, filename)), originalBytes);
  assert.equal(fs.readdirSync(fixture.capturesDirectory).some((entry) => entry.endsWith('.tmp')), false);
});

test('duplicate binary messages without transfer metadata cannot create another file', async (context) => {
  const image = createJpeg();
  const fixture = createFixture(context);
  await fixture.receiver.handleText(JSON.stringify(metadata(image)));
  await fixture.receiver.handleBinary(image);
  await fixture.receiver.handleBinary(image);

  assert.equal(fixture.messages.at(-1).code, 'METADATA_REQUIRED');
  assert.equal(fixture.messages.filter((message) => message.type === 'image_ack').length, 1);
  assert.equal(fs.readdirSync(fixture.capturesDirectory).filter((name) => name.endsWith('.jpg')).length, 1);
});

test('failed disk writes return a retryable error and never acknowledge', async (context) => {
  const image = createJpeg();
  const failingFileSystem = new Proxy(fs.promises, {
    get(target, property) {
      if (property === 'open') {
        return async (...args) => {
          const file = await Reflect.get(target, property, target).apply(target, args);
          if (args[1] !== 'wx') return file;
          return {
            write: async () => {
              const error = new Error('simulated disk failure');
              error.code = 'ENOSPC';
              throw error;
            },
            close: file.close.bind(file),
            sync: file.sync.bind(file)
          };
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const fixture = createFixture(context, { fileSystem: failingFileSystem });
  await fixture.receiver.handleText(JSON.stringify(metadata(image)));
  await fixture.receiver.handleBinary(image);

  const error = fixture.messages.find((message) => message.type === 'upload_error');
  assert.equal(error.code, 'DISK_FULL');
  assert.equal(error.retryable, true);
  assert.equal(fixture.messages.some((message) => message.type === 'image_ack'), false);
  assert.equal(fs.readdirSync(fixture.capturesDirectory).length, 0);
});

test('failed atomic installation returns a retryable error and cleans its temporary file', async (context) => {
  const image = createJpeg();
  const failingFileSystem = new Proxy(fs.promises, {
    get(target, property) {
      if (property === 'rename') {
        return async () => {
          const error = new Error('simulated atomic install failure');
          error.code = 'EIO';
          throw error;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const fixture = createFixture(context, { fileSystem: failingFileSystem });
  await fixture.receiver.handleText(JSON.stringify(metadata(image)));
  await fixture.receiver.handleBinary(image);

  assert.equal(fixture.messages.some((message) => message.type === 'image_ack'), false);
  assert.equal(fixture.messages.at(-1).code, 'STORAGE_ERROR');
  assert.equal(fixture.messages.at(-1).retryable, true);
  assert.deepEqual(fs.readdirSync(fixture.capturesDirectory), []);
});

test('temporary-file permission failures are reported clearly and release capacity', async (context) => {
  const image = createJpeg();
  const queue = createUploadQueue(1);
  const deniedFileSystem = new Proxy(fs.promises, {
    get(target, property) {
      if (property === 'open') {
        return async () => {
          const error = new Error('permission denied');
          error.code = 'EACCES';
          throw error;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const fixture = createFixture(context, {
    uploadQueue: queue,
    fileSystem: deniedFileSystem
  });
  await fixture.receiver.handleText(JSON.stringify(metadata(image)));

  assert.equal(fixture.messages.at(-1).code, 'STORAGE_PERMISSION_DENIED');
  assert.equal(fixture.messages.at(-1).retryable, true);
  assert.equal(queue.activeCount, 0);
});

test('upload capacity remains reserved while dashboard delivery is backpressured', async (context) => {
  const queue = createUploadQueue(1, 1);
  const image = createJpeg();
  let finishSaved;
  let notifySaved;
  const savedStarted = new Promise((resolve) => { notifySaved = resolve; });
  const savedGate = new Promise((resolve) => { finishSaved = resolve; });
  const first = createFixture(context, {
    uploadQueue: queue,
    onSaved: async () => {
      notifySaved();
      await savedGate;
    }
  });
  await first.receiver.handleText(JSON.stringify(metadata(image)));
  const firstUpload = first.receiver.handleBinary(image);
  const saveReached = await Promise.race([
    savedStarted.then(() => true),
    firstUpload.then(() => false)
  ]);
  if (!saveReached) notifySaved();
  assert.equal(saveReached, true, 'upload should reach the save hook or report its own failure, never leave this wait pending');
  assert.equal(queue.activeCount, 1);

  const secondMessages = [];
  const second = createImageTransferReceiver({
    capturesDirectory: first.capturesDirectory,
    maxImageBytes: 1024,
    uploadQueue: queue,
    send: (message) => secondMessages.push(JSON.parse(message))
  });
  await second.handleText(JSON.stringify(metadata(image, '2f913e6c-1f22-4e12-a47b-1ae4fb2b2910')));
  assert.equal(secondMessages.at(-1).state, 'QUEUED');
  assert.equal(queue.queuedCount, 1);

  finishSaved();
  await firstUpload;
  await waitFor(
    () => secondMessages.some((message) => message.type === 'upload_ready'),
    'queued upload should resume after dashboard delivery releases capacity'
  );
  assert.equal(queue.activeCount, 1);
  assert.equal(first.messages.some((message) => message.type === 'image_ack'), true);
  await second.close();
});

test('failed image validation settles the upload without leaving the save callback promise pending', async (context) => {
  const invalidImage = Buffer.alloc(32);
  Buffer.from([0xff, 0xd8, 0xff]).copy(invalidImage);
  const capturesDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-invalid-image-'));
  context.after(async () => fs.promises.rm(capturesDirectory, { recursive: true, force: true }));
  const messages = [];
  let saveCalled = false;
  let resolveSave;
  const saveStarted = new Promise((resolve) => { resolveSave = resolve; });
  const receiver = createImageTransferReceiver({
    capturesDirectory,
    maxImageBytes: 1024,
    send: (message) => messages.push(JSON.parse(message)),
    onSaved: () => { saveCalled = true; resolveSave(); }
  });
  await receiver.handleText(JSON.stringify(metadata(invalidImage)));
  const upload = receiver.handleBinary(invalidImage);
  const uploadResult = await Promise.race([
    saveStarted.then(() => 'saved'),
    upload.then(() => 'settled')
  ]);

  assert.equal(uploadResult, 'settled');
  assert.equal(saveCalled, false);
  assert.equal(messages.at(-1).type, 'upload_error');
  await receiver.close();
});

test('global upload capacity applies backpressure and releases slots on disconnect', async (context) => {
  const image = createJpeg();
  const queue = createUploadQueue(1, 0);
  const firstMessages = [];
  const secondMessages = [];
  const createReceiver = (messages) => createImageTransferReceiver({
    capturesDirectory: fixture.capturesDirectory,
    maxImageBytes: 1024,
    uploadQueue: queue,
    send: (message) => messages.push(JSON.parse(message))
  });
  const fixture = createFixture(context);
  const first = createReceiver(firstMessages);
  const second = createReceiver(secondMessages);
  await first.handleText(JSON.stringify(metadata(image, CAPTURE_ID)));
  await second.handleText(JSON.stringify(metadata(image, 'e7384ed3-f66a-4caf-98e2-e6d26bc8f502')));

  assert.equal(firstMessages.at(-1).type, 'upload_ready');
  assert.equal(secondMessages.at(-1).code, 'QUEUE_FULL');
  assert.equal(secondMessages.at(-1).retryable, true);
  await first.close();
  await second.handleText(JSON.stringify(metadata(image, 'e7384ed3-f66a-4caf-98e2-e6d26bc8f502')));
  await waitFor(
    () => secondMessages.some((message) => message.type === 'upload_ready'),
    'retry should be admitted when active upload disconnects'
  );
  await second.close();
});

test('server queue informs clients, rejects overflow retryably, and resumes after disconnect', async (context) => {
  const fixture = createFixture(context);
  const queue = createUploadQueue(1, 1);
  const image = createJpeg();
  const receivers = [];
  const messages = [];
  const makeReceiver = (captureId) => {
    const receiverMessages = [];
    messages.push(receiverMessages);
    const receiver = createImageTransferReceiver({
      capturesDirectory: fixture.capturesDirectory,
      maxImageBytes: 1024,
      uploadQueue: queue,
      send: (message) => receiverMessages.push(JSON.parse(message))
    });
    receivers.push(receiver);
    return { receiver, receiverMessages, captureId };
  };
  const first = makeReceiver(CAPTURE_ID);
  const second = makeReceiver('2f913e6c-1f22-4e12-a47b-1ae4fb2b2910');
  const third = makeReceiver('3f913e6c-1f22-4e12-a47b-1ae4fb2b2910');

  await first.receiver.handleText(JSON.stringify(metadata(image, first.captureId)));
  await new Promise((resolve) => setImmediate(resolve));
  await second.receiver.handleText(JSON.stringify(metadata(image, second.captureId)));
  assert.equal(second.receiverMessages.at(-1).type, 'queue_status');
  assert.equal(second.receiverMessages.at(-1).state, 'QUEUED');
  assert.equal(second.receiverMessages.at(-1).position, 1);

  await third.receiver.handleText(JSON.stringify(metadata(image, third.captureId)));
  assert.equal(third.receiverMessages.at(-1).code, 'QUEUE_FULL');
  assert.equal(third.receiverMessages.at(-1).retryable, true);
  assert.equal(queue.queuedCount, 1);

  await first.receiver.close();
  await waitFor(
    () => second.receiverMessages.some((message) =>
      message.type === 'upload_ready' && message.captureId === second.captureId
    ),
    'waiting client should be admitted after disconnect'
  );
  assert.equal(queue.activeCount, 1);

  await second.receiver.close();
  assert.equal(queue.activeCount, 0);
  assert.equal(queue.queuedCount, 0);
  await third.receiver.close();
});

test('failed queued-file creation releases its entry and admits the next capture', async (context) => {
  const fixture = createFixture(context);
  const queue = createUploadQueue(1, 2);
  const image = createJpeg();
  const firstMessages = [];
  const deniedMessages = [];
  const nextMessages = [];
  const first = createImageTransferReceiver({
    capturesDirectory: fixture.capturesDirectory,
    maxImageBytes: 1024,
    uploadQueue: queue,
    send: (message) => firstMessages.push(JSON.parse(message))
  });
  const deniedFileSystem = new Proxy(fs.promises, {
    get(target, property) {
      if (property === 'open') {
        return async () => {
          const error = new Error('permission denied');
          error.code = 'EACCES';
          throw error;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const denied = createImageTransferReceiver({
    capturesDirectory: fixture.capturesDirectory,
    maxImageBytes: 1024,
    uploadQueue: queue,
    fileSystem: deniedFileSystem,
    send: (message) => deniedMessages.push(JSON.parse(message))
  });
  const next = createImageTransferReceiver({
    capturesDirectory: fixture.capturesDirectory,
    maxImageBytes: 1024,
    uploadQueue: queue,
    send: (message) => nextMessages.push(JSON.parse(message))
  });
  await first.handleText(JSON.stringify(metadata(image, CAPTURE_ID)));
  await denied.handleText(JSON.stringify(metadata(image, '2f913e6c-1f22-4e12-a47b-1ae4fb2b2910')));
  await next.handleText(JSON.stringify(metadata(image, '3f913e6c-1f22-4e12-a47b-1ae4fb2b2910')));
  assert.equal(queue.queuedCount, 2);

  await first.close();
  await waitFor(
    () => deniedMessages.some((message) => message.code === 'STORAGE_PERMISSION_DENIED'),
    'permission failure should be returned to the queued sender'
  );
  await waitFor(
    () => nextMessages.some((message) => message.type === 'upload_ready'),
    'following queued transfer should be admitted after failure cleanup'
  );
  assert.equal(queue.size, 1);
  assert.equal(queue.queuedCount, 0);
  await denied.close();
  await next.close();
  assert.equal(fs.readdirSync(fixture.capturesDirectory).some((name) => name.endsWith('.tmp')), false);
});

test('per-connection operation queue rejects excess queued messages', async (context) => {
  const image = createJpeg();
  let finishOpen;
  let notifyOpen;
  const openStarted = new Promise((resolve) => { notifyOpen = resolve; });
  const blockedFileSystem = new Proxy(fs.promises, {
    get(target, property) {
      if (property === 'open') {
        return async (...args) => {
          finishOpen = () => {};
          notifyOpen();
          await new Promise((resolve) => { finishOpen = resolve; });
          return Reflect.get(target, property, target).apply(target, args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const fixture = createFixture(context, {
    fileSystem: blockedFileSystem,
    maxQueuedMessages: 1
  });
  const first = fixture.receiver.handleText(JSON.stringify(metadata(image)));
  await openStarted;
  await assert.rejects(fixture.receiver.handleBinary(image), { code: 'TRANSFER_QUEUE_FULL' });
  finishOpen();
  await first;
  await fixture.receiver.close();
});

test('async disk writes do not block the event loop while persistence is pending', async (context) => {
  const image = createJpeg();
  let releaseWrite;
  const delayedFileSystem = new Proxy(fs.promises, {
    get(target, property) {
      if (property === 'open') {
        return async (...args) => {
          const file = await Reflect.get(target, property, target).apply(target, args);
          if (args[1] !== 'wx') return file;
          return {
            write: async (...writeArgs) => {
              await new Promise((resolve) => { releaseWrite = resolve; });
              return file.write(...writeArgs);
            },
            sync: file.sync.bind(file),
            close: file.close.bind(file)
          };
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const fixture = createFixture(context, { fileSystem: delayedFileSystem });
  await fixture.receiver.handleText(JSON.stringify(metadata(image)));
  const write = fixture.receiver.handleBinary(image);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof releaseWrite, 'function');
  let eventLoopResponsive = false;
  setImmediate(() => { eventLoopResponsive = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(eventLoopResponsive, true);
  releaseWrite();
  await write;
});

test('incorrect size or digest is rejected without creating a saved image', async (context) => {
  const image = createJpeg();
  const fixture = createFixture(context);
  await fixture.receiver.handleText(JSON.stringify(metadata(image)));
  await fixture.receiver.handleBinary(Buffer.concat([image, Buffer.from([0])]));

  assert.equal(fixture.messages.at(-1).code, 'SIZE_MISMATCH');
  assert.equal(fixture.messages.some((message) => message.type === 'image_ack'), false);
  assert.equal(fs.readdirSync(fixture.capturesDirectory).length, 0);
});

test('checksum mismatch is rejected and never acknowledged', async (context) => {
  const image = createJpeg();
  const fixture = createFixture(context);
  const wrongDigest = '0'.repeat(64);
  await fixture.receiver.handleText(JSON.stringify({
    ...metadata(image),
    sha256: wrongDigest
  }));
  await fixture.receiver.handleBinary(image);

  assert.equal(fixture.messages.some((message) => message.type === 'image_ack'), false);
  assert.equal(fixture.messages.at(-1).code, 'CHECKSUM_MISMATCH');
  assert.deepEqual(fs.readdirSync(fixture.capturesDirectory), []);
});
