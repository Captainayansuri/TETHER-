const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const logger = require('./logger');
const { detectImageType, IMAGE_TYPES } = require('./image-upload');

const TEMPORARY_UPLOAD_PATTERN = /^\.upload_[0-9a-f-]{36}_[0-9a-f-]{36}\.tmp$/i;
const TEMPORARY_METADATA_PATTERN = /^\.metadata_[0-9a-f-]{36}_[0-9a-f-]{36}\.tmp$/i;
const TEMPORARY_THUMBNAIL_PATTERN = /^\.thumb_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[0-9a-f]{64}_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;
const LEGACY_TEMPORARY_THUMBNAIL_PATTERN = /^\.thumb_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;
const CAPTURE_FILE_PATTERN = /^capture_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(jpg|png|webp)$/i;
const CAPTURE_METADATA_PATTERN = /^\.capture_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i;
const DEFAULT_TEMPORARY_FILE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_QUEUED_UPLOADS = 32;
const DEFAULT_MAX_CAPTURE_STORAGE_BYTES = 10 * 1024 * 1024 * 1024;
const VERIFY_CHUNK_BYTES = 64 * 1024;
let directorySyncUnavailable = false;

function isValidCaptureMetadata(metadata) {
  return Boolean(metadata && typeof metadata === 'object' &&
    metadata.version === 1 &&
    typeof metadata.captureId === 'string' &&
    Number.isSafeInteger(metadata.size) && metadata.size > 0 &&
    Object.prototype.hasOwnProperty.call(IMAGE_TYPES, metadata.imageType) &&
    typeof metadata.sha256 === 'string' &&
    /^[a-f0-9]{64}$/i.test(metadata.sha256));
}

function getMaxQueuedUploads(value) {
  if (value === undefined || value === '') return DEFAULT_MAX_QUEUED_UPLOADS;
  if (!/^\d+$/.test(String(value))) {
    throw new Error('Maximum queued uploads must be an integer between 0 and 512');
  }
  const maxQueuedUploads = Number(value);
  if (!Number.isSafeInteger(maxQueuedUploads) || maxQueuedUploads > 512) {
    throw new Error('Maximum queued uploads must be an integer between 0 and 512');
  }
  return maxQueuedUploads;
}

function createUploadQueue(maxConcurrent = 4, maxQueued = DEFAULT_MAX_QUEUED_UPLOADS) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 ||
      !Number.isSafeInteger(maxQueued) || maxQueued < 0 || maxQueued > 512) {
    throw new Error('Upload queue limits are invalid');
  }
  const entries = new Map();
  const waiting = [];
  let activeCount = 0;
  let accepting = true;
  const idleWaiters = new Set();

  function notifyIdle() {
    if (entries.size !== 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  function reportState(entry, state, position) {
    try {
      entry.onQueueState({
        type: 'queue_status',
        captureId: entry.captureId,
        state,
        position,
        queuedCount: waiting.length,
        activeCount,
        maxQueued
      });
    } catch (error) {
      logger.error('upload.queue_state_report_failed', {
        errorCode: error.code || error.name || 'UNKNOWN'
      });
    }
  }

  function reportWaiting() {
    waiting.forEach((entry, index) => reportState(entry, 'QUEUED', index + 1));
  }

  function startEntry(entry) {
    Promise.resolve()
      .then(() => entry.onAdmit(entry.ticket))
      .then(() => entry.resolveAdmitted())
      .catch((error) => {
        logger.error('upload.queue_admission_failed', {
          errorCode: error.code || error.name || 'UNKNOWN',
          captureId: entry.captureId
        });
        entry.ticket.release();
        entry.resolveAdmitted();
      });
  }

  function pump() {
    while (activeCount < maxConcurrent && waiting.length > 0) {
      const entry = waiting.shift();
      if (entry.released) continue;
      entry.state = 'STARTING';
      activeCount += 1;
      reportState(entry, 'STARTING', 0);
      startEntry(entry);
    }
    reportWaiting();
  }

  return {
    enqueue({ captureId, digest, onAdmit, onQueueState = () => {} }) {
      if (!accepting) return { status: 'closed' };
      if (typeof captureId !== 'string' || typeof digest !== 'string' ||
          typeof onAdmit !== 'function' || typeof onQueueState !== 'function') {
        throw new Error('Upload queue entry is invalid');
      }
      const existing = entries.get(captureId);
      if (existing) {
        return {
          status: existing.digest === digest ? 'duplicate' : 'conflict',
          state: existing.state,
          position: existing.state === 'QUEUED' ? waiting.indexOf(existing) + 1 : 0,
          released: existing.releasedPromise
        };
      }
      if (activeCount >= maxConcurrent && waiting.length >= maxQueued) {
        return { status: 'full' };
      }

      const entry = {
        captureId,
        digest,
        onAdmit,
        onQueueState,
        state: 'QUEUED',
        released: false,
        ticket: null
      };
      entry.admitted = new Promise((resolve) => { entry.resolveAdmitted = resolve; });
      entry.releasedPromise = new Promise((resolve) => { entry.resolveReleased = resolve; });
      const ticket = {
        captureId,
        digest,
        release() {
          if (entry.released) return;
          entry.released = true;
          entries.delete(captureId);
          if (entry.state === 'QUEUED') {
            const index = waiting.indexOf(entry);
            if (index !== -1) waiting.splice(index, 1);
          } else {
            activeCount -= 1;
          }
          entry.state = 'RELEASED';
          entry.resolveReleased();
          pump();
          notifyIdle();
        },
        cancel() {
          this.release();
        },
        get state() {
          return entry.state;
        },
        get position() {
          return entry.state === 'QUEUED' ? waiting.indexOf(entry) + 1 : 0;
        },
        get isActive() {
          return !entry.released;
        }
      };
      entry.ticket = ticket;
      entries.set(captureId, entry);

      if (activeCount < maxConcurrent && waiting.length === 0) {
        entry.state = 'STARTING';
        activeCount += 1;
        reportState(entry, 'STARTING', 0);
        startEntry(entry);
        return { status: 'active', ticket, admitted: entry.admitted };
      }

      waiting.push(entry);
      reportWaiting();
      return { status: 'queued', ticket, position: waiting.length, admitted: entry.admitted };
    },
    get activeCount() {
      return activeCount;
    },
    get queuedCount() {
      return waiting.length;
    },
    get maxQueued() {
      return maxQueued;
    },
    get size() {
      return entries.size;
    },
    stopAccepting() {
      accepting = false;
    },
    waitForIdle() {
      if (entries.size === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.add(resolve));
    }
  };
}

function createCaptureStorageQuota({ capturesDirectory, maxBytes, fileSystem = fs }) {
  if (typeof capturesDirectory !== 'string' || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Capture storage quota configuration is invalid');
  }
  let usedBytes = 0;
  let initialized = false;
  const reservations = new Map();

  return {
    async initialize() {
      const entries = await fileSystem.readdir(capturesDirectory, { withFileTypes: true });
      let total = 0;
      for (const entry of entries) {
        if (!entry.isFile() || !CAPTURE_FILE_PATTERN.test(entry.name)) continue;
        const stats = await fileSystem.lstat(path.join(capturesDirectory, entry.name));
        if (stats.isFile() && !stats.isSymbolicLink()) total += stats.size;
      }
      usedBytes = total;
      initialized = true;
      return usedBytes;
    },
    reserve(captureId, size) {
      if (!initialized || typeof captureId !== 'string' ||
          !Number.isSafeInteger(size) || size < 1 || reservations.has(captureId)) return null;
      let reservedBytes = 0;
      for (const reserved of reservations.values()) reservedBytes += reserved;
      if (usedBytes + reservedBytes + size > maxBytes) return null;
      reservations.set(captureId, size);
      let finished = false;
      return {
        commit() {
          if (finished) return;
          finished = true;
          reservations.delete(captureId);
          usedBytes += size;
        },
        release() {
          if (finished) return;
          finished = true;
          reservations.delete(captureId);
        }
      };
    },
    get usedBytes() { return usedBytes; },
    get reservedBytes() {
      let total = 0;
      for (const size of reservations.values()) total += size;
      return total;
    },
    get maxBytes() { return maxBytes; }
  };
}

async function inspectImageFile(fileSystem, filename) {
  const file = await fileSystem.open(filename, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.alloc(VERIFY_CHUNK_BYTES);
  let position = 0;
  let signature = Buffer.alloc(0);
  try {
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (signature.length < 12) {
        signature = Buffer.concat([signature, chunk.subarray(0, 12 - signature.length)]);
      }
      position += bytesRead;
    }
  } finally {
    await file.close();
  }
  return {
    size: position,
    sha256: hash.digest('hex'),
    imageType: detectImageType(signature)
  };
}

async function removeIfPresent(fileSystem, filename) {
  try {
    await fileSystem.unlink(filename);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function recoverCaptureStorage(
  capturesDirectory,
  {
    fileSystem = fs,
    now = Date.now(),
    temporaryFileTtlMs = DEFAULT_TEMPORARY_FILE_TTL_MS
  } = {}
) {
  const entries = await fileSystem.readdir(capturesDirectory, { withFileTypes: true });
  const files = new Map(entries.filter((entry) => entry.isFile()).map((entry) => [entry.name, entry]));
  const removedTemporaryFiles = [];
  const invalidCaptures = [];
  const validCaptures = [];

  for (const entry of entries) {
    if (!entry.isFile() ||
        (!TEMPORARY_UPLOAD_PATTERN.test(entry.name) &&
         !TEMPORARY_METADATA_PATTERN.test(entry.name) &&
         !TEMPORARY_THUMBNAIL_PATTERN.test(entry.name) &&
         !LEGACY_TEMPORARY_THUMBNAIL_PATTERN.test(entry.name))) continue;
    const temporaryPath = path.join(capturesDirectory, entry.name);
    try {
      const stats = await fileSystem.stat(temporaryPath);
      if (temporaryFileTtlMs > 0 && now - stats.mtimeMs < temporaryFileTtlMs) continue;
      await fileSystem.unlink(temporaryPath);
      removedTemporaryFiles.push(entry.name);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  const metadataIds = new Set();
  for (const [filename, entry] of files) {
    if (!entry.isFile()) continue;
    const metadataMatch = filename.match(CAPTURE_METADATA_PATTERN);
    if (metadataMatch) metadataIds.add(metadataMatch[1].toLowerCase());
  }

  for (const [filename, entry] of files) {
    if (!entry.isFile()) continue;
    const match = filename.match(CAPTURE_FILE_PATTERN);
    if (!match) continue;

    const captureId = match[1].toLowerCase();
    const imagePath = path.join(capturesDirectory, filename);
    const metadataFilename = `.capture_${captureId}.json`;
    const metadataPath = path.join(capturesDirectory, metadataFilename);
    let isValid = false;
    let captureDigest;
    try {
      const stats = await fileSystem.lstat(imagePath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error('Capture is not a regular file');
      }
      const image = await inspectImageFile(fileSystem, imagePath);
      captureDigest = image.sha256;
      const extensionType = Object.entries(IMAGE_TYPES)
        .find(([, type]) => type.extension === match[2].toLowerCase())?.[0];
      isValid = image.size === stats.size &&
        image.imageType !== null &&
        extensionType === image.imageType;

      if (isValid && metadataIds.has(captureId)) {
        const metadata = JSON.parse(await fileSystem.readFile(metadataPath, 'utf8'));
        isValid = isValidCaptureMetadata(metadata) &&
          metadata.captureId.toLowerCase() === captureId &&
          metadata.size === image.size &&
          metadata.imageType === image.imageType &&
          metadata.sha256 === image.sha256;
        if (isValid) captureDigest = metadata.sha256;
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      isValid = false;
    }

    if (isValid) {
      validCaptures.push({ captureId, sha256: captureDigest });
      continue;
    }
    await removeIfPresent(fileSystem, imagePath);
    await removeIfPresent(fileSystem, metadataPath);
    invalidCaptures.push(captureId);
  }

  for (const [filename, entry] of files) {
    if (!entry.isFile()) continue;
    const match = filename.match(CAPTURE_METADATA_PATTERN);
    if (!match) continue;
    const captureId = match[1].toLowerCase();
    const hasCapture = entries.some((candidate) =>
      candidate.isFile() && candidate.name.toLowerCase().startsWith(`capture_${captureId}.`)
    );
    if (!hasCapture) {
      await removeIfPresent(fileSystem, path.join(capturesDirectory, filename));
    }
  }

  return { removedTemporaryFiles, invalidCaptures, validCaptures };
}

async function syncDirectory(fileSystem, directory, platform = process.platform) {
  // Windows does not expose a supported Node.js directory-handle flush operation.
  // File contents are still flushed before the atomic rename; only the directory
  // entry flush (rename durability across sudden power loss) is unavailable.
  if (platform === 'win32') return false;
  if (directorySyncUnavailable) return;
  let handle;
  let operation = 'DIRECTORY_OPEN';
  try {
    handle = await fileSystem.open(directory, 'r');
    operation = 'DIRECTORY_SYNC';
    await handle.sync();
    return true;
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR'].includes(error.code)) throw error;
    directorySyncUnavailable = true;
    logger.warn('storage.directory_sync_unavailable', {
      errorCode: error.code || 'UNKNOWN',
      reason: `${operation}_UNSUPPORTED`
    });
    return false;
  } finally {
    if (handle) await handle.close();
  }
}

async function persistCaptureMetadata(capturesDirectory, metadata, fileSystem = fs, platform = process.platform) {
  const filename = `.capture_${metadata.captureId}.json`;
  const finalPath = path.join(capturesDirectory, filename);
  const temporaryPath = path.join(
    capturesDirectory,
    `.metadata_${metadata.captureId}_${crypto.randomUUID()}.tmp`
  );
  let file;
  let finalReservation;
  try {
    file = await fileSystem.open(temporaryPath, 'wx', 0o600);
    await file.writeFile(JSON.stringify({ version: 1, ...metadata }));
    await file.sync();
    await file.close();
    file = null;
    try {
      // Reserve the destination without replacing an existing capture, then
      // atomically rename the already-flushed temporary file over the empty
      // placeholder. Both paths are in the same directory and volume.
      finalReservation = await fileSystem.open(finalPath, 'wx', 0o600);
      await finalReservation.close();
      finalReservation = null;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = JSON.parse(await fileSystem.readFile(finalPath, 'utf8'));
      if (!isValidCaptureMetadata(existing) ||
          existing.captureId.toLowerCase() !== metadata.captureId.toLowerCase() ||
          existing.size !== metadata.size ||
          existing.imageType !== metadata.imageType ||
          existing.sha256 !== metadata.sha256) {
        const conflict = new Error('Capture metadata already exists with different contents');
        conflict.code = 'CAPTURE_METADATA_CONFLICT';
        throw conflict;
      }
      await fileSystem.unlink(temporaryPath);
      await syncDirectory(fileSystem, capturesDirectory, platform);
      return finalPath;
    }
    await fileSystem.rename(temporaryPath, finalPath);
    await syncDirectory(fileSystem, capturesDirectory, platform);
    return finalPath;
  } catch (error) {
    if (finalReservation) {
      try {
        await finalReservation.close();
      } catch (closeError) {
        if (closeError.code !== 'EBADF') throw closeError;
      }
    }
    // If the rename did not commit, remove the empty exclusive placeholder.
    // If it did commit, finalPath is now the complete metadata file.
    try {
      const finalStats = await fileSystem.lstat(finalPath);
      if (finalStats.size === 0) await removeIfPresent(fileSystem, finalPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') throw cleanupError;
    }
    if (file) {
      try {
        await file.close();
      } catch (closeError) {
        if (closeError.code !== 'EBADF') {
          logger.error('storage.metadata_close_failed', {
            errorCode: closeError.code || closeError.name || 'UNKNOWN'
          });
        }
      }
    }
    await removeIfPresent(fileSystem, temporaryPath);
    throw error;
  }
}

async function cleanupAbandonedUploads(
  capturesDirectory,
  {
    fileSystem = fs,
    now = Date.now(),
    temporaryFileTtlMs = DEFAULT_TEMPORARY_FILE_TTL_MS
  } = {}
) {
  if (!Number.isSafeInteger(temporaryFileTtlMs) || temporaryFileTtlMs < 0) {
    throw new Error('Temporary upload lifetime must be a non-negative integer');
  }
  const entries = await fileSystem.readdir(capturesDirectory, { withFileTypes: true });
  const removed = [];
  for (const entry of entries) {
    if (!entry.isFile() ||
        (!TEMPORARY_UPLOAD_PATTERN.test(entry.name) &&
         !TEMPORARY_METADATA_PATTERN.test(entry.name) &&
         !TEMPORARY_THUMBNAIL_PATTERN.test(entry.name) &&
         !LEGACY_TEMPORARY_THUMBNAIL_PATTERN.test(entry.name))) continue;
    const temporaryPath = path.join(capturesDirectory, entry.name);
    try {
      const stats = await fileSystem.stat(temporaryPath);
      if (temporaryFileTtlMs > 0 && now - stats.mtimeMs < temporaryFileTtlMs) continue;
      await fileSystem.unlink(temporaryPath);
      removed.push(entry.name);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return removed;
}

module.exports = {
  CAPTURE_FILE_PATTERN,
  CAPTURE_METADATA_PATTERN,
  DEFAULT_MAX_QUEUED_UPLOADS,
  DEFAULT_MAX_CAPTURE_STORAGE_BYTES,
  DEFAULT_TEMPORARY_FILE_TTL_MS,
  TEMPORARY_UPLOAD_PATTERN,
  TEMPORARY_METADATA_PATTERN,
  TEMPORARY_THUMBNAIL_PATTERN,
  LEGACY_TEMPORARY_THUMBNAIL_PATTERN,
  cleanupAbandonedUploads,
  createUploadQueue,
  createCaptureStorageQuota,
  getMaxQueuedUploads,
  inspectImageFile,
  persistCaptureMetadata,
  recoverCaptureStorage,
  syncDirectory
};
