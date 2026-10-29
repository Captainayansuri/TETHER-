const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('Android transfers CameraX JPEG plane bytes directly without re-encoding or resizing', () => {
  const androidFile = path.join(
    __dirname,
    '..',
    '..',
    'android-app',
    'app',
    'src',
    'main',
    'java',
    'com',
    'tether',
    'app',
    'MainActivity.kt'
  );
  const source = fs.readFileSync(androidFile, 'utf8');
  const captureStart = source.indexOf('private fun takePhoto()');
  const queueStart = source.indexOf('private fun queueImage(', captureStart);
  assert.ok(captureStart >= 0 && queueStart > captureStart);
  const capturePath = source.slice(captureStart, queueStart);

  assert.match(capturePath, /image\.planes\[0\]\.buffer/);
  assert.match(capturePath, /buffer\.get\(bytes\)\s*queueImage\(bytes\)/);
  assert.doesNotMatch(capturePath, /BitmapFactory|\.compress\s*\(|Base64|\.resize\s*\(/);
});

test('browser live-camera capture uses source video dimensions and a single high-quality JPEG encode', () => {
  const mobileFile = path.join(__dirname, '..', 'public', 'mobile', 'mobile.js');
  const source = fs.readFileSync(mobileFile, 'utf8');
  const captureStart = source.indexOf('async function capturePhoto()');
  const sendStart = source.indexOf('// Send Blob over WebSocket', captureStart);
  assert.ok(captureStart >= 0 && sendStart > captureStart);
  const capturePath = source.slice(captureStart, sendStart);

  assert.match(capturePath, /canvas\.width\s*=\s*videoWidth/);
  assert.match(capturePath, /canvas\.height\s*=\s*videoHeight/);
  assert.match(capturePath, /canvas\.toBlob\([\s\S]*?'image\/jpeg',\s*0\.95\)/);
  assert.doesNotMatch(capturePath, /drawImage\([^,]+,[^,]+,[^,]+,\s*\d+\s*,\s*\d+\s*\)/);
});

test('Android camera capture queues offline images independently of WebSocket chunk reads', () => {
  const androidFile = path.join(
    __dirname,
    '..',
    '..',
    'android-app',
    'app',
    'src',
    'main',
    'java',
    'com',
    'tether',
    'app',
    'MainActivity.kt'
  );
  const source = fs.readFileSync(androidFile, 'utf8');
  const captureStart = source.indexOf('private fun takePhoto()');
  const queueStart = source.indexOf('private fun queueImage(', captureStart);
  const transferStart = source.indexOf('private fun sendNextImageChunk(');
  assert.ok(captureStart >= 0 && queueStart > captureStart && transferStart >= 0);
  const capturePath = source.slice(captureStart, queueStart);
  const chunkPath = source.slice(transferStart, source.indexOf('private fun failTransferConnection', transferStart));

  assert.match(source, /captureInProgress\.compareAndSet\(false,\s*true\)/);
  assert.match(source, /cameraExecutor\s*=\s*Executors\.newSingleThreadExecutor\(\)/);
  assert.match(source, /transferExecutor\s*=\s*Executors\.newSingleThreadExecutor\(\)/);
  assert.match(capturePath, /imageCapture\.takePicture/);
  assert.doesNotMatch(capturePath, /if\s*\(!isConnected\s*\|\|/);
  assert.match(chunkPath, /transferExecutor\.execute/);
  assert.match(source, /PendingImageStore\(/);
  assert.match(source, /DefaultLifecycleObserver/);
  assert.match(source, /override fun onStop\(owner: LifecycleOwner\)/);
  assert.match(source, /onNetworkingBackgrounded\(\)/);
  assert.match(source, /override fun onRetainCustomNonConfigurationInstance\(\)/);
  assert.doesNotMatch(source.slice(source.indexOf('override fun onRequestPermissionsResult')),
    /Camera permissions are mandatory[\s\S]*?finish\(\)/);
});
