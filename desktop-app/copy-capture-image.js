const { resolveExistingCapturePath } = require('./capture-files');
const sharp = require('sharp');

function errorCode(error) {
  return error && (error.code || error.name) || 'UNKNOWN';
}

function report(onDiagnostic, stage, code) {
  try {
    onDiagnostic({ stage, errorCode: code });
  } catch {
    // Diagnostics must not interrupt clipboard handling.
  }
}

async function copyCaptureImage({
  capturesDirectory,
  filename,
  clipboard,
  ClipboardItem,
  BlobType = globalThis.Blob,
  fileSystem,
  maxInputPixels = 40_000_000,
  imageDecoder = sharp,
  onDiagnostic = () => {}
}) {
  let imagePath;
  try {
    imagePath = await resolveExistingCapturePath(capturesDirectory, filename, fileSystem);
  } catch (error) {
    report(onDiagnostic, 'source', errorCode(error));
    return { success: false, message: 'Unable to access image' };
  }
  if (!imagePath) {
    report(onDiagnostic, 'source', 'IMAGE_MISSING');
    return { success: false, message: 'Image data is missing or unavailable' };
  }

  let pngData;
  try {
    // Decode the stored source and normalize it to PNG without resizing. PNG
    // retains alpha and avoids asking Electron to infer a format from a path.
    pngData = await imageDecoder(imagePath, { limitInputPixels: maxInputPixels })
      .rotate()
      .png()
      .toBuffer();
  } catch (error) {
    report(onDiagnostic, 'decode', errorCode(error));
    return { success: false, message: 'This image could not be decoded. Choose a valid PNG or JPEG image.' };
  }
  try {
    const imageBlob = new BlobType([new Uint8Array(pngData)], { type: 'image/png' });
    const clipboardItem = new ClipboardItem({ 'image/png': imageBlob });
    await clipboard.write([clipboardItem]);
    return { success: true };
  } catch (error) {
    report(onDiagnostic, 'clipboard', errorCode(error));
    return { success: false, message: 'Could not copy the image to the clipboard' };
  }
}

module.exports = { copyCaptureImage };
