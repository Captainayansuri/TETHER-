const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { copyCaptureImage } = require('../copy-capture-image');

async function createCapture(t, extension = 'png') {
  const capturesDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-copy-image-'));
  const filename = `capture_01234567-89ab-cdef-0123-456789abcdef.${extension}`;
  const imagePath = path.join(capturesDirectory, filename);
  const image = sharp({
    create: {
      width: 3,
      height: 2,
      channels: extension === 'png' ? 4 : 3,
      background: { r: 37, g: 142, b: 221, alpha: extension === 'png' ? 0.5 : 1 }
    }
  });
  await image[extension === 'jpg' ? 'jpeg' : extension]().toFile(imagePath);
  t.after(() => fs.rmSync(capturesDirectory, { recursive: true, force: true }));
  return { capturesDirectory, filename, imagePath };
}

class TestClipboardItem {
  constructor(items) { this.items = items; }
}

function createClipboardAdapter() {
  let copied;
  return {
    clipboard: { async write(items) { copied = items[0]; } },
    getCopied: () => copied
  };
}

for (const extension of ['png', 'jpg']) {
  test(`copy action decodes stored ${extension.toUpperCase()} pixels into a clipboard image`, async (t) => {
    const capture = await createCapture(t, extension);
    const adapter = createClipboardAdapter();
    const result = await copyCaptureImage({
      capturesDirectory: capture.capturesDirectory,
      filename: capture.filename,
      ClipboardItem: TestClipboardItem,
      clipboard: adapter.clipboard
    });

    assert.deepEqual(result, { success: true });
    const item = adapter.getCopied();
    assert.ok(item);
    assert.deepEqual(Object.keys(item.items), ['image/png']);
    assert.notEqual(item.items['image/png'], capture.filename);
    assert.notEqual(item.items['image/png'], capture.imagePath);
    assert.equal(item.items['image/png'].type, 'image/png');
    const pngData = Buffer.from(await item.items['image/png'].arrayBuffer());
    const metadata = await sharp(pngData).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, 3);
    assert.equal(metadata.height, 2);
    if (extension === 'png') assert.equal(metadata.hasAlpha, true);
  });
}

test('copy action reports missing files and invalid image data with diagnostic stages', async (t) => {
  const capture = await createCapture(t);
  const base = {
    capturesDirectory: capture.capturesDirectory,
    filename: capture.filename,
    ClipboardItem: TestClipboardItem,
    clipboard: createClipboardAdapter().clipboard
  };
  const diagnostics = [];
  const missing = await copyCaptureImage({
    ...base,
    filename: 'capture_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg',
    onDiagnostic: (entry) => diagnostics.push(entry)
  });
  assert.match(missing.message, /missing|unavailable/i);
  assert.deepEqual(diagnostics.at(-1), { stage: 'source', errorCode: 'IMAGE_MISSING' });

  fs.writeFileSync(capture.imagePath, 'not a valid image');
  const invalid = await copyCaptureImage({
    ...base,
    onDiagnostic: (entry) => diagnostics.push(entry)
  });
  assert.match(invalid.message, /could not be decoded/i);
  assert.equal(diagnostics.at(-1).stage, 'decode');
  assert.equal(typeof diagnostics.at(-1).errorCode, 'string');
});

test('copy action reports image clipboard write failures', async (t) => {
  const capture = await createCapture(t);
  const diagnostics = [];
  const decoded = await copyCaptureImage({
    capturesDirectory: capture.capturesDirectory,
    filename: capture.filename,
    ClipboardItem: TestClipboardItem,
    clipboard: createClipboardAdapter().clipboard,
    onDiagnostic: (entry) => diagnostics.push(entry)
  });
  assert.deepEqual(decoded, { success: true });

  const clipboard = await copyCaptureImage({
    capturesDirectory: capture.capturesDirectory,
    filename: capture.filename,
    ClipboardItem: TestClipboardItem,
    clipboard: { async write() { throw Object.assign(new Error('OS clipboard unavailable'), { code: 'CLIPBOARD_ERROR' }); } },
    onDiagnostic: (entry) => diagnostics.push(entry)
  });
  assert.match(clipboard.message, /clipboard/i);
  assert.deepEqual(diagnostics.at(-1), { stage: 'clipboard', errorCode: 'CLIPBOARD_ERROR' });
});

test('copy-image bridge exposes only a capture filename operation', () => {
  const desktopDirectory = path.join(__dirname, '..');
  const preload = fs.readFileSync(path.join(desktopDirectory, 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(desktopDirectory, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(desktopDirectory, 'public', 'app-dashboard.js'), 'utf8');

  assert.match(preload, /copyImage: \(filename\) => ipcRenderer\.invoke\('copy-image', \{ filename \}\)/);
  assert.match(main, /ipcMain\.handle\('copy-image'/);
  assert.match(main, /isTrustedDashboardSender\(event\)/);
  assert.match(main, /capture\.copy_failed/);
  assert.match(renderer, /children:"Copy Image"/);
  assert.match(renderer, /window\.electronAPI\.copyImage\(c\.filename\)/);
  assert.match(renderer, /Image copied to clipboard/);
  assert.match(renderer, /Could not copy image to clipboard/);
});
