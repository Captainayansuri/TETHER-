const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const logger = require('./logger');

sharp.cache(false);

const DEFAULT_THUMBNAIL_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const MAX_THUMBNAIL_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_THUMBNAIL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const THUMBNAIL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const THUMBNAIL_FILENAME_PATTERN = /^\.thumb_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([0-9a-f]{64})\.webp$/i;
const THUMBNAIL_TEMP_PATTERN = /^\.thumb_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([0-9a-f]{64})_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/i;
const LEGACY_THUMBNAIL_PATTERN = /^\.thumb_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.webp$/i;
const LEGACY_THUMBNAIL_TEMP_PATTERN = /^\.thumb_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/i;

function parseCacheLimit(value) {
  if (value === undefined || value === '') return DEFAULT_THUMBNAIL_CACHE_MAX_BYTES;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1024 * 1024 || limit > MAX_THUMBNAIL_CACHE_BYTES) {
    throw new Error(`TETHER_THUMBNAIL_CACHE_MAX_BYTES must be between 1048576 and ${MAX_THUMBNAIL_CACHE_BYTES}`);
  }
  return limit;
}

function parseMaxAge(value) {
  if (value === undefined || value === '') return DEFAULT_THUMBNAIL_MAX_AGE_MS;
  const maxAge = Number(value);
  if (!Number.isSafeInteger(maxAge) || maxAge < 60_000 || maxAge > 365 * 24 * 60 * 60 * 1000) {
    throw new Error('TETHER_THUMBNAIL_CACHE_MAX_AGE_MS must be between 60000 and 31536000000');
  }
  return maxAge;
}

function getThumbnailPath(capturesDirectory, captureId, sha256) {
  if (!THUMBNAIL_ID_PATTERN.test(captureId) || !/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error('Thumbnail cache key is invalid');
  }
  return path.join(capturesDirectory, `.thumb_${captureId}_${sha256.toLowerCase()}.webp`);
}

async function createImageThumbnail({
  capturesDirectory,
  captureId,
  sha256,
  imagePath,
  fileSystem = fs,
  maxInputPixels = 40_000_000,
  width = 480,
  height = 320
}) {
  const finalPath = getThumbnailPath(capturesDirectory, captureId, sha256);
  const temporaryPath = path.join(
    capturesDirectory,
    `.thumb_${captureId}_${sha256.toLowerCase()}_${crypto.randomUUID()}.tmp`
  );

  try {
    await sharp(imagePath, { limitInputPixels: maxInputPixels })
      .rotate()
      .resize({ width, height, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 })
      .toFile(temporaryPath);

    const file = await fileSystem.open(temporaryPath, 'r+');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    await fileSystem.rename(temporaryPath, finalPath);
    return finalPath;
  } catch (error) {
    try {
      await fileSystem.unlink(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        logger.error('thumbnail.cleanup_failed', {
          errorCode: cleanupError.code || cleanupError.name || 'UNKNOWN'
        });
      }
    }
    throw error;
  }
}

async function isWebpFile(fileSystem, filePath) {
  let file;
  try {
    file = await fileSystem.open(filePath, 'r');
    const header = Buffer.alloc(12);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    return bytesRead === header.length &&
      header.toString('ascii', 0, 4) === 'RIFF' &&
      header.toString('ascii', 8, 12) === 'WEBP';
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  } finally {
    if (file) await file.close();
  }
}

function createThumbnailCache({
  capturesDirectory,
  maxBytes = parseCacheLimit(),
  maxAgeMs = parseMaxAge(),
  width = 480,
  height = 320,
  maxInputPixels = 40_000_000,
  fileSystem = fs,
  generate = createImageThumbnail,
  now = Date.now
}) {
  if (typeof capturesDirectory !== 'string' ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1024 * 1024 ||
      !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 60_000 ||
      !Number.isSafeInteger(width) || width < 64 || width > 4096 ||
      !Number.isSafeInteger(height) || height < 64 || height > 4096 ||
      !Number.isSafeInteger(maxInputPixels) || maxInputPixels < 1_000_000 || maxInputPixels > 100_000_000 ||
      typeof generate !== 'function' ||
      typeof now !== 'function') {
    throw new Error('Thumbnail cache configuration is invalid');
  }

  const entries = new Map();
  const inFlight = new Map();
  let cacheBytes = 0;

  function removeEntry(filename) {
    const entry = entries.get(filename);
    if (!entry) return;
    entries.delete(filename);
    cacheBytes -= entry.size;
  }

  function remember(filename, size, lastAccess = now()) {
    removeEntry(filename);
    entries.set(filename, { size, lastAccess });
    cacheBytes += size;
  }

  async function prune() {
    const oldestFirst = [...entries.entries()].sort((left, right) =>
      left[1].lastAccess - right[1].lastAccess
    );
    for (const [filename, entry] of oldestFirst) {
      const expired = now() - entry.lastAccess > maxAgeMs;
      if (!expired && cacheBytes <= maxBytes) continue;
      try {
        await fileSystem.unlink(path.join(capturesDirectory, filename));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      removeEntry(filename);
    }
  }

  return {
    async cleanup({ validCaptures } = {}) {
      const files = await fileSystem.readdir(capturesDirectory, { withFileTypes: true });
      cacheBytes = 0;
      entries.clear();
      const candidates = [];
      const validDigests = validCaptures
        ? new Map(validCaptures.map(({ captureId, sha256 }) => [captureId.toLowerCase(), sha256.toLowerCase()]))
        : null;
      for (const item of files) {
        const tempMatch = item.name.match(THUMBNAIL_TEMP_PATTERN);
        const finalMatch = item.name.match(THUMBNAIL_FILENAME_PATTERN);
        const legacyTempMatch = item.name.match(LEGACY_THUMBNAIL_TEMP_PATTERN);
        const legacyFinalMatch = item.name.match(LEGACY_THUMBNAIL_PATTERN);
        if (!tempMatch && !finalMatch && !legacyTempMatch && !legacyFinalMatch) continue;
        const fullPath = path.join(capturesDirectory, item.name);
        const stats = await fileSystem.lstat(fullPath);
        const staleCapture = finalMatch && validDigests &&
          validDigests.get(finalMatch[1].toLowerCase()) !== finalMatch[2].toLowerCase();
        if (!stats.isFile() || stats.isSymbolicLink() ||
            tempMatch || legacyTempMatch || legacyFinalMatch || staleCapture ||
            now() - stats.mtimeMs > maxAgeMs ||
            !(await isWebpFile(fileSystem, fullPath))) {
          await fileSystem.unlink(fullPath);
          continue;
        }
        candidates.push({ filename: item.name, size: stats.size, lastAccess: stats.mtimeMs });
      }
      candidates.sort((left, right) => left.lastAccess - right.lastAccess);
      for (const candidate of candidates) {
        remember(candidate.filename, candidate.size, candidate.lastAccess);
      }
      await prune();
      return { entries: entries.size, bytes: cacheBytes };
    },

    async get({ captureId, sha256, imagePath }) {
      const finalPath = getThumbnailPath(capturesDirectory, captureId, sha256);
      const filename = path.basename(finalPath);
      const existingTask = inFlight.get(filename);
      if (existingTask) return existingTask;

      const task = (async () => {
        if (entries.has(filename)) {
          const entry = entries.get(filename);
          try {
            const stats = await fileSystem.lstat(finalPath);
            if (stats.isFile() && !stats.isSymbolicLink() &&
                await isWebpFile(fileSystem, finalPath)) {
              entry.lastAccess = now();
              await fileSystem.utimes(finalPath, new Date(entry.lastAccess), new Date(entry.lastAccess));
              await prune();
              return finalPath;
            }
            await fileSystem.unlink(finalPath);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          removeEntry(filename);
        }

        try {
          const stats = await fileSystem.lstat(finalPath);
          if (!stats.isFile() || stats.isSymbolicLink() ||
              !(await isWebpFile(fileSystem, finalPath))) {
            await fileSystem.unlink(finalPath);
            throw Object.assign(new Error('Invalid cached thumbnail'), { code: 'ENOENT' });
          }
          remember(filename, stats.size);
          await prune();
          if (entries.has(filename)) return finalPath;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }

        await generate({
          capturesDirectory,
          captureId,
          sha256,
          imagePath,
          fileSystem,
          maxInputPixels,
          width,
          height
        });
        const stats = await fileSystem.stat(finalPath);
        if (!(await isWebpFile(fileSystem, finalPath))) {
          await fileSystem.unlink(finalPath);
          throw new Error('Generated thumbnail is not a valid WebP file');
        }
        if (stats.size > maxBytes) {
          await fileSystem.unlink(finalPath);
          throw new Error('Generated thumbnail exceeds the configured cache size');
        }
        remember(filename, stats.size);
        await prune();
        return finalPath;
      })();
      inFlight.set(filename, task);
      try {
        return await task;
      } finally {
        inFlight.delete(filename);
      }
    },

    get sizeBytes() {
      return cacheBytes;
    },
    get size() {
      return entries.size;
    },
    get inFlightCount() {
      return inFlight.size;
    },
    get maxBytes() {
      return maxBytes;
    }
  };
}

module.exports = {
  DEFAULT_THUMBNAIL_CACHE_MAX_BYTES,
  DEFAULT_THUMBNAIL_MAX_AGE_MS,
  MAX_THUMBNAIL_CACHE_BYTES,
  THUMBNAIL_FILENAME_PATTERN,
  THUMBNAIL_TEMP_PATTERN,
  createImageThumbnail,
  createThumbnailCache,
  getThumbnailPath,
  parseCacheLimit,
  parseMaxAge
};
