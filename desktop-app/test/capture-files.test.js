const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isCapturesDirectory,
  resolveCapturePath,
  resolveExistingCapturePath,
  resolveExistingCapturePathFromPath
} = require('../capture-files');

test('capture paths only resolve for generated server-side UUID filenames', async (context) => {
  const capturesDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-captures-'));
  context.after(() => fs.rmSync(capturesDirectory, { recursive: true, force: true }));
  const filename = 'capture_01234567-89ab-cdef-0123-456789abcdef.jpg';

  assert.equal(
    resolveCapturePath(capturesDirectory, filename),
    path.join(capturesDirectory, filename)
  );
  assert.equal(
    resolveCapturePath(capturesDirectory, 'capture_01234567-89ab-cdef-0123-456789abcdef.png'),
    path.join(capturesDirectory, 'capture_01234567-89ab-cdef-0123-456789abcdef.png')
  );
  assert.equal(
    resolveCapturePath(capturesDirectory, 'capture_01234567-89ab-cdef-0123-456789abcdef.webp'),
    path.join(capturesDirectory, 'capture_01234567-89ab-cdef-0123-456789abcdef.webp')
  );
  for (const invalidName of [
    '../file',
    '..\\file',
    '../../file',
    '..\\..\\file',
    '%2e%2e%2ffile',
    '%2e%2e%5cfile',
    '%252e%252e%252ffile',
    'capture_123.jpg',
    path.join(capturesDirectory, filename),
    '/private/capture_01234567-89ab-cdef-0123-456789abcdef.jpg',
    'C:\\private\\capture_01234567-89ab-cdef-0123-456789abcdef.jpg',
    '\\\\server\\share\\capture_01234567-89ab-cdef-0123-456789abcdef.jpg',
    'capture_01234567-89ab-cdef-0123-456789abcdef.jpg\0.jpg',
    'capture_01234567-89ab-cdef-0123-456789abcdef%2ejpg'
  ]) {
    assert.equal(resolveCapturePath(capturesDirectory, invalidName), null);
    assert.equal(await resolveExistingCapturePath(capturesDirectory, invalidName), null);
  }
});

test('only regular files inside the captures directory can be resolved', async (context) => {
  const capturesDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-captures-'));
  context.after(() => fs.rmSync(capturesDirectory, { recursive: true, force: true }));
  const filename = 'capture_01234567-89ab-cdef-0123-456789abcdef.jpg';
  const capturePath = path.join(capturesDirectory, filename);
  assert.equal(await resolveExistingCapturePath(capturesDirectory, filename), null);
  fs.writeFileSync(capturePath, 'image');
  const canonicalPath = await fs.promises.realpath(capturePath);
  assert.ok(canonicalPath);
  assert.equal(await resolveExistingCapturePath(capturesDirectory, filename), canonicalPath);
  assert.equal(await resolveExistingCapturePathFromPath(capturesDirectory, capturePath), canonicalPath);
  for (const invalidPath of [
    path.join(capturesDirectory, '..', 'tether-captures', filename),
    path.join(path.dirname(capturesDirectory), filename),
    `C:\\private\\${filename}`,
    `${capturePath}\0`
  ]) {
    assert.equal(await resolveExistingCapturePathFromPath(capturesDirectory, invalidPath), null);
  }
});

test('canonical resolution rejects capture symlinks that point outside the directory', async (context) => {
  const capturesDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-captures-'));
  const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-outside-'));
  context.after(() => {
    fs.rmSync(capturesDirectory, { recursive: true, force: true });
    fs.rmSync(outsideDirectory, { recursive: true, force: true });
  });

  const filename = 'capture_01234567-89ab-cdef-0123-456789abcdef.jpg';
  const outsidePath = path.join(outsideDirectory, filename);
  fs.writeFileSync(outsidePath, 'outside');
  try {
    fs.symlinkSync(outsidePath, path.join(capturesDirectory, filename), 'file');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      context.skip('The current Windows environment does not permit creating test symlinks');
      return;
    }
    throw error;
  }

  assert.equal(await resolveExistingCapturePath(capturesDirectory, filename), null);
});

test('the captures directory exception only accepts that exact directory', () => {
  const capturesDirectory = path.resolve(os.tmpdir(), 'tether-captures');

  assert.ok(isCapturesDirectory(capturesDirectory, capturesDirectory));
  assert.ok(!isCapturesDirectory(capturesDirectory, path.dirname(capturesDirectory)));
  assert.ok(!isCapturesDirectory(capturesDirectory, `${capturesDirectory}-other`));
  assert.ok(!isCapturesDirectory(capturesDirectory, null));
  assert.ok(!isCapturesDirectory(capturesDirectory, `${capturesDirectory}\\..\\tether-captures`));
  assert.ok(!isCapturesDirectory(capturesDirectory, 'C:\\Windows'));
  assert.ok(!isCapturesDirectory(capturesDirectory, `${capturesDirectory}\0`));
});
