const crypto = require('crypto');
const nodeFs = require('fs');
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const logger = require('./logger');
const {
  resolveCapturePath,
  resolveExistingCapturePath
} = require('./capture-files');
const { detectImageType, IMAGE_TYPES } = require('./image-upload');
const {
  createUploadQueue,
  inspectImageFile,
  persistCaptureMetadata
} = require('./image-storage');

const CAPTURE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXTENSIONS = Object.values(IMAGE_TYPES).map((imageType) => imageType.extension);
const IMAGE_TRANSFER_CHUNK_BYTES = 1024 * 1024;
const VERIFY_CHUNK_BYTES = 64 * 1024;
const MAX_QUEUED_MESSAGES = 2;

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function hashFile(fileSystem, filename) {
  const hash = crypto.createHash('sha256');
  const file = await fileSystem.open(filename, 'r');
  const buffer = Buffer.alloc(VERIFY_CHUNK_BYTES);
  try {
    let position = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest('hex');
  } finally {
    await file.close();
  }
}

function sendJson(send, message) {
  send(JSON.stringify(message));
}

function storageFailure(error) {
  if (error.code === 'ENOSPC' || error.code === 'EDQUOT') {
    return {
      code: 'DISK_FULL',
      message: 'There is not enough disk space to save the image.'
    };
  }
  if (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'EROFS') {
    return {
      code: 'STORAGE_PERMISSION_DENIED',
      message: 'Desktop does not have permission to save images.'
    };
  }
  return {
    code: 'STORAGE_ERROR',
    message: 'Unable to save image. The transfer is pending.'
  };
}

function createImageTransferReceiver({
  capturesDirectory,
  maxImageBytes,
  maxInputPixels = 40_000_000,
  send,
  signAcknowledgement = null,
  reserveCaptureStorage = null,
  onSaved = () => {},
  fileSystem = fs,
  chunkSize = IMAGE_TRANSFER_CHUNK_BYTES,
  uploadQueue = createUploadQueue(),
  maxQueuedMessages = MAX_QUEUED_MESSAGES
}) {
  let pendingTransfer = null;
  let pendingTicket = null;
  let closed = false;
  let closePromise = null;
  let queuedMessages = 0;
  let operationChain = Promise.resolve();
  const admissionTasks = new Set();

  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 ||
      !Number.isSafeInteger(maxQueuedMessages) || maxQueuedMessages < 1) {
    throw new Error('Image transfer queue configuration is invalid');
  }
  const maxChunkBytes = Math.min(chunkSize, maxImageBytes, IMAGE_TRANSFER_CHUNK_BYTES);

  function sendError(captureId, code, message, retryable = false) {
    sendJson(send, {
      type: 'upload_error',
      captureId,
      code,
      message,
      retryable
    });
    logger.warn('transfer.rejected', {
      ...(captureId ? { captureId } : {}),
      reason: code,
      transferState: retryable ? 'PENDING' : 'REJECTED'
    });
  }

  async function discardPending() {
    const pending = pendingTransfer;
    pendingTransfer = null;
    if (!pending) return;

    pendingTicket = null;
    pending.storageReservation?.release();
    pending.storageReservation = null;
    if (pending.file) {
      try {
        await pending.file.close();
      } catch (error) {
        if (error.code !== 'EBADF') {
          logger.error('transfer.temporary_file_close_failed', {
            captureId: pending.captureId,
            errorCode: error.code || error.name || 'UNKNOWN'
          });
        }
      }
      pending.file = null;
    }
    try {
      await fileSystem.unlink(pending.temporaryPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('transfer.temporary_file_cleanup_failed', {
          captureId: pending.captureId,
          errorCode: error.code || error.name || 'UNKNOWN'
        });
      }
    } finally {
      pending.ticket?.release();
    }
  }

  function sendAcknowledgement(metadata, filename, size) {
    const acknowledgement = {
      type: 'image_ack',
      captureId: metadata.captureId,
      sha256: metadata.sha256,
      state: 'ACKNOWLEDGED',
      persisted: true,
      filename,
      size
    };
    if (typeof signAcknowledgement === 'function') {
      acknowledgement.proof = signAcknowledgement(acknowledgement);
    }
    sendJson(send, acknowledgement);
  }

  async function findExisting(metadata) {
    for (const extension of EXTENSIONS) {
      const filename = `capture_${metadata.captureId}.${extension}`;
      const candidate = path.join(capturesDirectory, filename);
      try {
        await fileSystem.access(candidate);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
        throw error;
      }
      const existingPath = await resolveExistingCapturePath(
        capturesDirectory,
        filename,
        fileSystem
      );
      if (!existingPath) return { conflict: true };
      return { filename, path: existingPath, extension };
    }
    return null;
  }

  async function acknowledgeExisting(metadata) {
    const existing = await findExisting(metadata);
    if (!existing) return false;
    if (existing.conflict || existing.extension !== IMAGE_TYPES[metadata.imageType].extension) {
      sendError(metadata.captureId, 'CAPTURE_ID_CONFLICT', 'Capture identifier is already in use.');
      return true;
    }

    try {
      const stats = await fileSystem.stat(existing.path);
      const inspected = await inspectImageFile(fileSystem, existing.path);
      if (stats.size !== metadata.size ||
          inspected.size !== metadata.size ||
          inspected.sha256 !== metadata.sha256 ||
          inspected.imageType !== metadata.imageType) {
        sendError(metadata.captureId, 'CAPTURE_ID_CONFLICT', 'Capture identifier is already in use.');
        return true;
      }
      const metadataPath = path.join(capturesDirectory, `.capture_${metadata.captureId}.json`);
      try {
        const savedMetadata = JSON.parse(await fileSystem.readFile(metadataPath, 'utf8'));
        if (!savedMetadata ||
            savedMetadata.version !== 1 ||
            typeof savedMetadata.captureId !== 'string' ||
            savedMetadata.captureId.toLowerCase() !== metadata.captureId.toLowerCase() ||
            savedMetadata.size !== metadata.size ||
            savedMetadata.imageType !== metadata.imageType ||
            savedMetadata.sha256 !== metadata.sha256) {
          sendError(metadata.captureId, 'CAPTURE_ID_CONFLICT', 'Capture identifier is already in use.');
          return true;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await persistCaptureMetadata(capturesDirectory, metadata, fileSystem);
      }
      logger.info('transfer.duplicate_already_persisted', {
        captureId: metadata.captureId,
        sizeBytes: stats.size,
        imageType: metadata.imageType
      });
      sendAcknowledgement(metadata, path.basename(existing.path), stats.size);
      logger.info('transfer.acknowledged', {
        captureId: metadata.captureId,
        transferState: 'ACKNOWLEDGED'
      });
    } catch (error) {
      logger.error('transfer.existing_capture_inspection_failed', {
        captureId: metadata.captureId,
        errorCode: error.code || error.name || 'UNKNOWN'
      });
      const failure = storageFailure(error);
      sendError(metadata.captureId, failure.code, failure.message, true);
    }
    return true;
  }

  async function handleMetadata(data) {
    const captureId = typeof data.captureId === 'string' ? data.captureId.toLowerCase() : null;
    if (!captureId || !CAPTURE_ID_PATTERN.test(captureId)) {
      sendError(captureId, 'INVALID_CAPTURE_ID', 'Invalid capture identifier.');
      return;
    }
    if (!Number.isSafeInteger(data.size) || data.size < 1 || data.size > maxImageBytes) {
      sendError(captureId, 'IMAGE_TOO_LARGE', 'Image exceeds the configured size limit.');
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(IMAGE_TYPES, data.imageType) ||
        typeof data.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(data.sha256)) {
      sendError(captureId, 'INVALID_METADATA', 'Image transfer metadata is invalid.');
      return;
    }

    const metadata = {
      captureId,
      size: data.size,
      imageType: data.imageType,
      sha256: data.sha256.toLowerCase(),
      receivedAt: Date.now()
    };
    logger.info('transfer.metadata_received', {
      captureId,
      sizeBytes: metadata.size,
      imageType: metadata.imageType
    });
    try {
      if (await acknowledgeExisting(metadata)) return;
    } catch (error) {
      logger.error('transfer.existing_capture_inspection_failed', {
        captureId,
        errorCode: error.code || error.name || 'UNKNOWN'
      });
      const failure = storageFailure(error);
      sendError(captureId, failure.code, 'Unable to verify the saved image.', true);
      return;
    }
    if (pendingTicket) {
      if (pendingTicket.captureId === captureId && pendingTicket.digest === metadata.sha256) {
        sendJson(send, {
          type: 'queue_status',
          captureId,
          state: pendingTicket.state,
          position: pendingTicket.position
        });
        return;
      }
      sendError(captureId, 'TRANSFER_BUSY', 'Another image transfer is in progress.', true);
      return;
    }

    const startTransfer = async (ticket) => {
      if (closed || !ticket.isActive || pendingTicket !== ticket) {
        ticket.release();
        if (pendingTicket === ticket) pendingTicket = null;
        return;
      }
      const storageReservation = typeof reserveCaptureStorage === 'function'
        ? reserveCaptureStorage({ captureId, size: metadata.size })
        : null;
      if (typeof reserveCaptureStorage === 'function' && !storageReservation) {
        sendError(captureId, 'STORAGE_QUOTA_EXCEEDED', 'Desktop capture storage is full. Remove saved images or increase the storage limit.', true);
        ticket.release();
        if (pendingTicket === ticket) pendingTicket = null;
        return;
      }
      logger.info('transfer.upload_started', {
        captureId,
        sizeBytes: metadata.size,
        imageType: metadata.imageType
      });
      const temporaryPath = path.join(
        capturesDirectory,
        `.upload_${metadata.captureId}_${crypto.randomUUID()}.tmp`
      );
      let file;
      try {
        file = await fileSystem.open(temporaryPath, 'wx', 0o600);
        if (closed || !ticket.isActive || pendingTicket !== ticket) {
          await file.close();
          await fileSystem.unlink(temporaryPath).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
          });
          storageReservation?.release();
          ticket.release();
          return;
        }
        pendingTransfer = {
          ...metadata,
          storageReservation,
          temporaryPath,
          file,
          ticket,
          maxChunkBytes,
          receivedBytes: 0,
          chunkIndex: 0,
          signature: Buffer.alloc(0),
          hash: crypto.createHash('sha256')
        };
        sendJson(send, {
          type: 'upload_ready',
          captureId,
          state: 'UPLOADING',
          chunkSize: maxChunkBytes
        });
      } catch (error) {
        storageReservation?.release();
        if (file) {
          try {
            await file.close();
          } catch (closeError) {
            if (closeError.code !== 'EBADF') {
              logger.error('transfer.temporary_file_close_failed', {
                captureId,
                errorCode: closeError.code || closeError.name || 'UNKNOWN'
              });
            }
          }
        }
        try {
          await fileSystem.unlink(temporaryPath);
        } catch (cleanupError) {
          if (cleanupError.code !== 'ENOENT') {
            logger.error('transfer.temporary_file_cleanup_failed', {
              captureId,
              errorCode: cleanupError.code || cleanupError.name || 'UNKNOWN'
            });
          }
        }
        ticket.release();
        if (pendingTicket === ticket) pendingTicket = null;
        logger.error('transfer.temporary_file_create_failed', {
          captureId,
          errorCode: error.code || error.name || 'UNKNOWN'
        });
        const failure = storageFailure(error);
        sendError(captureId, failure.code, failure.message, true);
      }
    };
    const trackAdmission = (ticket) => {
      const task = startTransfer(ticket).finally(() => admissionTasks.delete(task));
      admissionTasks.add(task);
      return task;
    };

    if (uploadQueue) {
      const result = uploadQueue.enqueue({
        captureId,
        digest: metadata.sha256,
        onAdmit: trackAdmission,
        onQueueState: (state) => {
          logger.info('transfer.queue_state', {
            captureId,
            transferState: state.state,
            queuePosition: state.position,
            queueSize: state.queuedCount
          });
          sendJson(send, state);
        }
      });
      if (result.status === 'conflict') {
        sendError(captureId, 'CAPTURE_ID_CONFLICT', 'Capture identifier is already in use.');
      } else if (result.status === 'closed') {
        sendError(
          captureId,
          'SERVER_SHUTTING_DOWN',
          'Desktop is shutting down. The image remains pending for retry.',
          true
        );
      } else if (result.status === 'duplicate') {
        sendJson(send, {
          type: 'queue_status',
          captureId,
          state: result.state,
          position: result.position,
          queuedCount: uploadQueue.queuedCount,
          activeCount: uploadQueue.activeCount,
          maxQueued: uploadQueue.maxQueued
        });
        await result.released;
        if (!closed && !(await acknowledgeExisting(metadata))) {
          await handleMetadata(data);
        }
      } else if (result.status === 'full') {
        sendError(captureId, 'QUEUE_FULL', 'Desktop transfer queue is full. The image remains pending; retry shortly.', true);
      } else {
        pendingTicket = result.ticket;
        if (result.status === 'active') await result.admitted;
      }
      return;
    }
  }

  async function handleText(text) {
    if (closed) return;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      sendError(null, 'INVALID_METADATA', 'Image transfer metadata is invalid.');
      return;
    }
    if (data.type === 'image_upload') await handleMetadata(data);
  }

  async function installSavedFile(pending, filename, finalPath, stats) {
    try {
      // The shared upload queue reserves capture IDs. Rename the closed,
      // flushed temp file directly so Windows never has to replace a placeholder.
      await fileSystem.rename(pending.temporaryPath, finalPath);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      await discardPending();
      await acknowledgeExisting(pending);
      return false;
    }
    try {
      await persistCaptureMetadata(capturesDirectory, {
        captureId: pending.captureId,
        size: pending.size,
        imageType: pending.imageType,
        sha256: pending.sha256
      }, fileSystem);
    } catch (error) {
      try {
        await fileSystem.unlink(finalPath);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') {
          logger.error('transfer.persistence_rollback_failed', {
            captureId: pending.captureId,
            errorCode: cleanupError.code || cleanupError.name || 'UNKNOWN'
          });
        }
      }
      throw error;
    }
    pending.storageReservation?.commit();
    pending.storageReservation = null;
    pending.file = null;
    pendingTransfer = null;
    try {
      const savedPath = await resolveExistingCapturePath(
        capturesDirectory,
        filename,
        fileSystem
      );
      if (!savedPath) throw new Error('Saved image verification failed');

      sendJson(send, {
        type: 'transfer_status',
        captureId: pending.captureId,
        state: 'FILE_SAVED'
      });
      logger.info('transfer.file_persisted', {
        captureId: pending.captureId,
        filename,
        sizeBytes: stats.size,
        imageType: pending.imageType,
        durationMs: Date.now() - pending.receivedAt
      });
      try {
        await onSaved({
          captureId: pending.captureId,
          filename,
          path: savedPath,
          mimeType: IMAGE_TYPES[pending.imageType].mimeType,
          size: stats.size,
          sha256: pending.sha256
        });
      } catch (error) {
        logger.error('gallery.publish_failed', {
          captureId: pending.captureId,
          errorCode: error.code || error.name || 'UNKNOWN'
        });
      }
      sendAcknowledgement(pending, filename, stats.size);
      logger.info('transfer.acknowledged', {
        captureId: pending.captureId,
        transferState: 'ACKNOWLEDGED'
      });
      return true;
    } finally {
      pending.ticket.release();
      pendingTicket = null;
    }
  }

  async function handleBinary(buffer) {
    if (closed) return;
    const pending = pendingTransfer;
    if (!pending) {
      sendError(null, 'METADATA_REQUIRED', 'Image transfer metadata is required.');
      return;
    }

    const remainingBytes = pending.size - pending.receivedBytes;
    if (!Buffer.isBuffer(buffer) ||
        buffer.length < 1 ||
        buffer.length > pending.maxChunkBytes ||
        buffer.length > remainingBytes) {
      await discardPending();
      sendError(pending.captureId, 'SIZE_MISMATCH', 'Received image size does not match its metadata.');
      return;
    }

    try {
      if (pending.receivedBytes === 0) {
        pending.signature = Buffer.from(buffer.subarray(0, 12));
      } else if (pending.signature.length < 12) {
        pending.signature = Buffer.concat([
          pending.signature,
          buffer.subarray(0, 12 - pending.signature.length)
        ]);
      }

      if (pending.signature.length >= 12 || buffer.length === remainingBytes) {
        const detectedType = detectImageType(pending.signature);
        if (!detectedType || detectedType !== pending.imageType) {
          await discardPending();
          sendError(pending.captureId, 'UNSUPPORTED_IMAGE_TYPE', 'Image format does not match its metadata.');
          return;
        }
      }

      let written = 0;
      while (written < buffer.length) {
        const result = await pending.file.write(
          buffer,
          written,
          buffer.length - written,
          pending.receivedBytes + written
        );
        if (result.bytesWritten <= 0) throw new Error('Image chunk could not be fully written');
        written += result.bytesWritten;
      }
      pending.hash.update(buffer);
      pending.receivedBytes += buffer.length;
      const chunkIndex = pending.chunkIndex++;

      if (pending.receivedBytes < pending.size) {
        logger.debug('transfer.chunk_received', {
          captureId: pending.captureId,
          bytesReceived: pending.receivedBytes,
          chunkIndex
        });
        sendJson(send, {
          type: 'chunk_ack',
          captureId: pending.captureId,
          chunkIndex,
          nextOffset: pending.receivedBytes
        });
        return;
      }

      sendJson(send, {
        type: 'transfer_status',
        captureId: pending.captureId,
        state: 'SERVER_RECEIVED'
      });
      logger.info('transfer.server_received', {
        captureId: pending.captureId,
        sizeBytes: pending.size,
        durationMs: Date.now() - pending.receivedAt
      });
      if (pending.hash.digest('hex') !== pending.sha256) {
        logger.warn('transfer.validation_failed', {
          captureId: pending.captureId,
          reason: 'CHECKSUM_MISMATCH'
        });
        await discardPending();
        sendError(pending.captureId, 'CHECKSUM_MISMATCH', 'Received image did not pass integrity validation.');
        return;
      }

      sendJson(send, {
        type: 'transfer_status',
        captureId: pending.captureId,
        state: 'FILE_VALIDATED'
      });
      logger.info('transfer.file_validated', {
        captureId: pending.captureId,
        sizeBytes: pending.size,
        imageType: pending.imageType
      });

      await pending.file.sync();
      await pending.file.close();
      pending.file = null;
      const stats = await fileSystem.stat(pending.temporaryPath);
      if (stats.size !== pending.size ||
          await hashFile(fileSystem, pending.temporaryPath) !== pending.sha256) {
        throw new Error('Temporary image verification failed');
      }
      const imageValidator = sharp({ limitInputPixels: maxInputPixels });
      const imageInput = nodeFs.createReadStream(pending.temporaryPath);
      imageInput.on('error', (error) => imageValidator.destroy(error));
      imageValidator.on('error', () => imageInput.destroy());
      imageInput.pipe(imageValidator);
      let decodedImage;
      try {
        ({ info: decodedImage } = await imageValidator
          .resize({ width: 1, height: 1, fit: 'inside' })
          .toBuffer({ resolveWithObject: true }));
      } finally {
        imageValidator.destroy();
        if (!imageInput.closed) {
          const inputClosed = new Promise((resolve) => imageInput.once('close', resolve));
          imageInput.destroy();
          await inputClosed;
        }
      }
      if (!decodedImage.width || !decodedImage.height ||
          decodedImage.format !== pending.imageType) {
        throw new Error('Uploaded image dimensions or format are invalid');
      }

      const extension = IMAGE_TYPES[pending.imageType].extension;
      const filename = `capture_${pending.captureId}.${extension}`;
      const finalPath = resolveCapturePath(capturesDirectory, filename);
      if (!finalPath) throw new Error('Capture identifier already exists');
      if (await acknowledgeExisting(pending)) {
        await discardPending();
        return;
      }
      await installSavedFile(pending, filename, finalPath, stats);
    } catch (error) {
      const captureId = pending.captureId;
      logger.error('transfer.persistence_failed', {
        captureId,
        errorCode: error.code || error.name || 'UNKNOWN'
      });
      await discardPending();
      const failure = storageFailure(error);
      sendError(captureId, failure.code, failure.message, true);
    }
  }

  function enqueue(operation, messageSize = 0) {
    if (closed) return Promise.resolve();
    if (queuedMessages >= maxQueuedMessages) {
      const error = new Error('Image transfer queue is full');
      error.code = 'TRANSFER_QUEUE_FULL';
      sendError(pendingTransfer?.captureId || null, error.code, 'Image storage is busy. Retry shortly.', true);
      return Promise.reject(error);
    }
    queuedMessages += 1;
    const task = operationChain.then(() => {
      if (closed) return;
      if (messageSize > maxChunkBytes && pendingTransfer) {
        const error = new Error('Queued upload message exceeds chunk limit');
        error.code = 'MESSAGE_TOO_LARGE';
        throw error;
      }
      return operation();
    });
    operationChain = task.catch(() => {});
    return task.finally(() => {
      queuedMessages -= 1;
    });
  }

  return {
    handleBinary(buffer) {
      return enqueue(() => handleBinary(buffer), Buffer.isBuffer(buffer) ? buffer.length : 0);
    },
    handleText(text) {
      return enqueue(() => handleText(text), Buffer.byteLength(text));
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        if (pendingTicket?.state === 'QUEUED') pendingTicket.cancel();
        await Promise.resolve();
        await operationChain;
        await Promise.all(Array.from(admissionTasks));
        if (pendingTransfer) {
          logger.warn('transfer.interrupted', {
            captureId: pendingTransfer.captureId,
            bytesReceived: pendingTransfer.receivedBytes,
            sizeBytes: pendingTransfer.size,
            transferState: 'UPLOADING'
          });
        }
        await discardPending();
        pendingTicket?.cancel?.();
        pendingTicket = null;
      })();
      return closePromise;
    }
  };
}

module.exports = {
  CAPTURE_ID_PATTERN,
  IMAGE_TRANSFER_CHUNK_BYTES,
  MAX_QUEUED_MESSAGES,
  createImageTransferReceiver,
  hashFile,
  sha256
};
