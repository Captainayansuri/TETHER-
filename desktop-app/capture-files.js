const fsp = require('fs/promises');
const path = require('path');

const CAPTURE_FILENAME_PATTERN = /^capture_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp)$/i;

function isPathInside(directory, candidate) {
  const relativePath = path.relative(directory, candidate);
  return relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath);
}

function resolveCapturePath(capturesDirectory, filename) {
  if (typeof filename !== 'string' || !CAPTURE_FILENAME_PATTERN.test(filename)) {
    return null;
  }

  const directory = path.resolve(capturesDirectory);
  const candidate = path.resolve(directory, filename);
  return isPathInside(directory, candidate) ? candidate : null;
}

async function resolveExistingCapturePath(capturesDirectory, filename, fileSystem = fsp) {
  const capturePath = resolveCapturePath(capturesDirectory, filename);
  if (!capturePath) return null;

  try {
    const stats = await fileSystem.lstat(capturePath);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;

    const realDirectory = await fileSystem.realpath(capturesDirectory);
    const realCapturePath = await fileSystem.realpath(capturePath);
    if (!isPathInside(realDirectory, realCapturePath)) return null;
    return realCapturePath;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

async function resolveExistingCapturePathFromPath(capturesDirectory, candidate, fileSystem = fsp) {
  if (typeof candidate !== 'string' || candidate.includes('\0')) return null;

  const filename = path.basename(candidate);
  const expectedPath = resolveCapturePath(capturesDirectory, filename);
  if (!expectedPath || candidate !== expectedPath) return null;
  return resolveExistingCapturePath(capturesDirectory, filename, fileSystem);
}

function isCapturesDirectory(capturesDirectory, candidate) {
  return typeof candidate === 'string' &&
    !candidate.includes('\0') &&
    candidate === path.resolve(capturesDirectory);
}

module.exports = {
  CAPTURE_FILENAME_PATTERN,
  isCapturesDirectory,
  resolveCapturePath,
  resolveExistingCapturePath,
  resolveExistingCapturePathFromPath,
};
