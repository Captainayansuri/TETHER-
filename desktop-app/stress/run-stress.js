#!/usr/bin/env node
'use strict';

// Protocol and storage stress harness. It drives the production transfer receiver,
// queue, and recovery functions without patching their behavior.
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const {
  createImageTransferReceiver,
  IMAGE_TRANSFER_CHUNK_BYTES,
  sha256
} = require('../image-transfer');
const { createUploadQueue, recoverCaptureStorage } = require('../image-storage');

const imageCount = positiveInteger(process.env.STRESS_IMAGES, 1000);
const deviceCount = positiveInteger(process.env.STRESS_DEVICES, 8);
const slowDiskMs = nonNegativeInteger(process.env.STRESS_SLOW_DISK_MS, 2);
const memoryBudgetBytes = positiveInteger(process.env.STRESS_MEMORY_BUDGET_MB, 512) * 1024 * 1024;
const queueConcurrency = 4;
const queueLimit = 32;
const maxImageBytes = positiveInteger(process.env.STRESS_MAX_IMAGE_MB, 32) * 1024 * 1024;
const outputBase = path.resolve(process.env.STRESS_REPORT_DIR || process.cwd());

function positiveInteger(value, fallback) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Stress configuration values must be positive integers');
  return number;
}
function nonNegativeInteger(value, fallback) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Stress configuration values must be non-negative integers');
  return number;
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(predicate, label, timeoutMs = 15000, diagnostics = '') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(2);
  }
  throw new Error(`Timed out waiting for ${label}${diagnostics ? ` (${diagnostics})` : ''}`);
}
function delayedFileSystem(delayMs) {
  if (!delayMs) return fsp;
  return new Proxy(fsp, {
    get(target, property) {
      if (property !== 'open') return Reflect.get(target, property, target);
      return async (...args) => {
        const handle = await target.open(...args);
        return new Proxy(handle, {
          get(file, method) {
            if (method === 'write') return async (...writeArgs) => {
              await sleep(delayMs);
              return file.write(...writeArgs);
            };
            const value = Reflect.get(file, method, file);
            return typeof value === 'function' ? value.bind(file) : value;
          }
        });
      };
    }
  });
}
async function createImages() {
  const regular = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 42, g: 113, b: 186 } } })
    .jpeg({ quality: 82 }).toBuffer();
  // Textured high resolution source creates a multi-megabyte, decoder-valid image.
  const width = 1800, height = 1200;
  const pixels = crypto.randomBytes(width * height * 3);
  const large = await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
  pixels.fill(0);
  if (large.length < 1024 * 1024) throw new Error(`Large fixture unexpectedly small (${large.length} bytes)`);
  return { regular, large };
}
function makeQueue(onQueueSample) {
  return createUploadQueue(queueConcurrency, queueLimit);
}
function makeReceiver(directory, queue, device, stats, options = {}) {
  return createImageTransferReceiver({
    capturesDirectory: directory,
    maxImageBytes,
    chunkSize: IMAGE_TRANSFER_CHUNK_BYTES,
    uploadQueue: queue,
    fileSystem: delayedFileSystem(slowDiskMs),
    send(raw) {
      const message = JSON.parse(raw);
      if (message.type === 'queue_status') {
        stats.maxQueued = Math.max(stats.maxQueued, message.queuedCount || 0);
        stats.maxActive = Math.max(stats.maxActive, message.activeCount || 0);
      }
      if (message.type === 'upload_error') {
        stats.errors.push({ device, ...message });
        if (device.startsWith('android-')) stats.deviceStates.set(device, 'ERROR');
      }
      if (message.type === 'transfer_status') {
        const states = stats.transferStates.get(message.captureId) || [];
        states.push(message.state);
        stats.transferStates.set(message.captureId, states);
        if (message.state === 'FILE_SAVED' && device.startsWith('android-')) stats.deviceStates.set(device, 'CONNECTED');
      }
      if (message.type === 'image_ack' && device.startsWith('android-')) stats.deviceStates.set(device, 'CONNECTED');
      if (message.type === 'image_ack' && options.dropFirstAck && !options.ackDropped) {
        options.ackDropped = true;
        stats.lostAcknowledgements += 1;
        return;
      }
      stats.messages.get(device).push({ ...message, at: performance.now() });
      if (message.type === 'transfer_status' && message.state === 'FILE_SAVED') stats.fileSavedStatuses += 1;
    },
    onSaved() { stats.gallerySaveCallbacks += 1; }
  });
}
function latest(messages, captureId, type, state) {
  return messages.findLast((message) => message.captureId === captureId && message.type === type && (!state || message.state === state));
}
async function sendImage(receiver, messages, captureId, image, stats, opts = {}) {
  const started = performance.now();
  const device = opts.device;
  if (device) stats.deviceStates.set(device, 'TRANSFERRING');
  const metadata = { type: 'image_upload', captureId, size: image.length, imageType: 'jpeg', sha256: sha256(image) };
  await receiver.handleText(JSON.stringify(metadata));
  await waitFor(() => latest(messages, captureId, 'upload_ready') || latest(messages, captureId, 'image_ack') || latest(messages, captureId, 'upload_error'), `${captureId} admission`, 15000, `queue active=${stats.queue?.activeCount}, queued=${stats.queue?.queuedCount}, size=${stats.queue?.size}; recent=${JSON.stringify(messages.slice(-5).map(({ type, captureId: id, state, code }) => ({ type, id, state, code })))}`);
  if (opts.interruptAfterFirstChunk) {
    await receiver.handleBinary(image.subarray(0, Math.min(64 * 1024, image.length - 1)));
    return { interrupted: true, started };
  }
  const ready = latest(messages, captureId, 'upload_ready');
  if (ready) {
    for (let offset = 0; offset < image.length; offset += ready.chunkSize) {
      await receiver.handleBinary(image.subarray(offset, Math.min(offset + ready.chunkSize, image.length)));
    }
  }
  if (opts.expectLostAck) {
    await waitFor(() => latest(messages, captureId, 'transfer_status', 'FILE_SAVED'), `${captureId} persisted before injected lost acknowledgement`);
    return { started, lostAck: true, latencyMs: performance.now() - started };
  }
  await waitFor(() => latest(messages, captureId, 'image_ack') || latest(messages, captureId, 'upload_error'), `${captureId} completion`);
  const error = latest(messages, captureId, 'upload_error');
  if (error) throw new Error(`${captureId}: ${error.code}`);
  if (device) stats.deviceStates.set(device, 'CONNECTED');
  const completedStates = stats.transferStates.get(captureId) || [];
  if (latest(messages, captureId, 'upload_ready') &&
      !['SERVER_RECEIVED', 'FILE_VALIDATED', 'FILE_SAVED'].every((state, index) => completedStates.slice(-3)[index] === state)) {
    throw new Error(`${captureId}: invalid transfer status sequence ${completedStates.join(',')}`);
  }
  return { started, latencyMs: performance.now() - started };
}
async function validateInvalidTraffic(directory, queue, stats) {
  const device = 'invalid-probes';
  stats.messages.set(device, []);
  const receiver = makeReceiver(directory, queue, device, stats);
  await receiver.handleText('{malformed');
  const tooLargeId = crypto.randomUUID();
  await receiver.handleText(JSON.stringify({ type: 'image_upload', captureId: tooLargeId, size: maxImageBytes + 1, imageType: 'jpeg', sha256: '0'.repeat(64) }));
  const badImage = Buffer.from('not-an-image-payload');
  const badId = crypto.randomUUID();
  await receiver.handleText(JSON.stringify({ type: 'image_upload', captureId: badId, size: badImage.length, imageType: 'jpeg', sha256: sha256(badImage) }));
  await waitFor(() => stats.messages.get(device).filter((m) => m.type === 'upload_error').length >= 2, 'malformed and oversized payload rejection');
  await receiver.handleBinary(badImage);
  await receiver.close();
  stats.malformedRejected = stats.messages.get(device).filter((m) => m.type === 'upload_error').length;
  stats.invalidImageRejected = Boolean(latest(stats.messages.get(device), badId, 'upload_error'));
  stats.oversizedRejected = Boolean(latest(stats.messages.get(device), tooLargeId, 'upload_error'));
  stats.malformedPayloadRejected = stats.malformedRejected >= 1;
}

async function main() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'image-tether-stress-'));
  await fsp.mkdir(outputBase, { recursive: true });
  const stats = {
    messages: new Map(), deviceStates: new Map(), transferStates: new Map(), errors: [], latencies: [], ids: [], failedIds: [],
    maxQueued: 0, maxActive: 0, fileSavedStatuses: 0, gallerySaveCallbacks: 0,
    lostAcknowledgements: 0, duplicateTransmissions: 0, recoveryTimeMs: 0,
    malformedRejected: 0, malformedPayloadRejected: false, oversizedRejected: false, invalidImageRejected: false,
    peakRssBytes: process.memoryUsage().rss, baselineRssBytes: process.memoryUsage().rss,
    largeImageBytes: 0, recoveryValidCaptures: 0
  };
  const sampleMemory = () => { stats.peakRssBytes = Math.max(stats.peakRssBytes, process.memoryUsage().rss); };
  let receivers = [];
  let queue = makeQueue();
  stats.queue = queue;
  const { regular, large } = await createImages();
  stats.largeImageBytes = large.length;
  sampleMemory();
  for (let d = 0; d < deviceCount; d++) {
    stats.messages.set(`android-${d + 1}`, []);
    stats.deviceStates.set(`android-${d + 1}`, 'CONNECTED');
  }
  const createConnections = (epoch, loseAckForId = null) => {
    receivers = Array.from({ length: deviceCount }, (_, d) => {
      const device = `android-${d + 1}`;
      const opts = { dropFirstAck: false };
      return makeReceiver(directory, queue, device, stats, opts);
    });
  };
  createConnections(1);
  const runRange = async (start, end) => {
    const workers = Array.from({ length: deviceCount }, async (_, deviceIndex) => {
      const device = `android-${deviceIndex + 1}`;
      let receiver = receivers[deviceIndex];
      for (let index = start + deviceIndex; index < end; index += deviceCount) {
        const captureId = crypto.randomUUID();
        const image = index % 100 === 99 ? large : regular;
        stats.ids.push({ captureId, sha256: sha256(image), size: image.length, imageType: 'jpeg', index });
        try {
          const injectLostAck = index === start + 17 && start === 0;
          if (injectLostAck) {
            receiver = makeReceiver(directory, queue, device, stats, { dropFirstAck: true });
            receivers[deviceIndex] = receiver;
          }
          let result;
          try {
            result = await sendImage(receiver, stats.messages.get(device), captureId, image, stats, {
              interruptAfterFirstChunk: index % 113 === 112,
              expectLostAck: injectLostAck,
              device
            });
          } catch (firstError) {
            if (!/^Timed out waiting for /.test(firstError.message)) throw firstError;
            // Model a client reconnect after admission stalls: close the old session
            // to release its partial/queued slot, then retry the durable capture ID.
            await receiver.close();
            receiver = makeReceiver(directory, queue, device, stats);
            receivers[deviceIndex] = receiver;
            const deviceMessages = stats.messages.get(device);
            for (let cursor = deviceMessages.length - 1; cursor >= 0; cursor -= 1) {
              if (deviceMessages[cursor].captureId === captureId) deviceMessages.splice(cursor, 1);
            }
            stats.admissionTimeoutRecoveries = (stats.admissionTimeoutRecoveries || 0) + 1;
            stats.deviceStates.set(device, 'DISCONNECTED');
            stats.deviceStates.set(device, 'CONNECTED');
            result = await sendImage(receiver, deviceMessages, captureId, image, stats, { device });
          }
          if (result.interrupted) {
            await receiver.close();
            stats.deviceStates.set(device, 'DISCONNECTED');
            stats.messages.get(device).length = 0;
            receiver = makeReceiver(directory, queue, device, stats);
            receivers[deviceIndex] = receiver;
            stats.deviceStates.set(device, 'CONNECTED');
            const retry = await sendImage(receiver, stats.messages.get(device), captureId, image, stats, { device });
            if (Number.isFinite(retry.latencyMs)) stats.latencies.push(retry.latencyMs);
            stats.reconnectRetries = (stats.reconnectRetries || 0) + 1;
          } else {
            if (Number.isFinite(result.latencyMs)) stats.latencies.push(result.latencyMs);
          }
          // The receiver saved the file but the first ACK was suppressed. Reconnect
          // and retransmit the same ID; existing-file validation should ACK it once.
          if (injectLostAck) {
            await receiver.close();
            stats.deviceStates.set(device, 'DISCONNECTED');
            const ackReceiver = makeReceiver(directory, queue, device, stats);
            receiver = ackReceiver;
            receivers[deviceIndex] = receiver;
            stats.deviceStates.set(device, 'CONNECTED');
            const retryMessages = stats.messages.get(device);
            const duplicateStarted = performance.now();
            await ackReceiver.handleText(JSON.stringify({ type: 'image_upload', captureId, size: image.length, imageType: 'jpeg', sha256: sha256(image) }));
            await waitFor(() => latest(retryMessages, captureId, 'image_ack'), 'duplicate acknowledgement');
            stats.duplicateTransmissions += 1;
            stats.duplicateAckLatencyMs = round(performance.now() - duplicateStarted);
            await ackReceiver.close();
          }
        } catch (error) {
          stats.failedIds.push({ captureId, message: error.message });
          console.error(`stress transfer failure at image ${index + 1}: ${error.message}`);
        }
        if ((index + 1) % 100 === 0) console.log(`Stress progress: ${index + 1}/${imageCount} unique captures`);
        sampleMemory();
      }
    });
    await Promise.all(workers);
  };
  try {
    const half = Math.floor(imageCount / 2);
    await runRange(0, half);
    const restartStarted = performance.now();
    for (const device of stats.deviceStates.keys()) stats.deviceStates.set(device, 'DISCONNECTED');
    await Promise.all(receivers.map((receiver) => receiver.close()));
    await queue.waitForIdle();
    queue = makeQueue();
    stats.queue = queue;
    const recovery = await recoverCaptureStorage(directory, { temporaryFileTtlMs: 0 });
    stats.recoveryValidCaptures = recovery.validCaptures.length;
    receivers = [];
    createConnections(2);
    for (const device of stats.deviceStates.keys()) stats.deviceStates.set(device, 'CONNECTED');
    stats.recoveryTimeMs = performance.now() - restartStarted;
    await runRange(half, imageCount);
    await validateInvalidTraffic(directory, queue, stats);
    await Promise.all(receivers.map((receiver) => receiver.close()));
    await queue.waitForIdle();
    sampleMemory();

    const entries = await fsp.readdir(directory);
    const captureFiles = entries.filter((name) => /^capture_[0-9a-f-]{36}\.jpg$/i.test(name));
    const temporaryFiles = entries.filter((name) => name.endsWith('.tmp'));
    const expectedIds = new Set(stats.ids.map((item) => item.captureId));
    const actualIds = new Set(captureFiles.map((name) => name.slice('capture_'.length, -'.jpg'.length)));
    const missingIds = [...expectedIds].filter((id) => !actualIds.has(id));
    const duplicateFiles = captureFiles.length - actualIds.size;
    let corruptFiles = 0;
    for (const item of stats.ids) {
      const filename = path.join(directory, `capture_${item.captureId}.jpg`);
      try {
        const bytes = await fsp.readFile(filename);
        if (bytes.length !== item.size || sha256(bytes) !== item.sha256) { corruptFiles += 1; continue; }
        await sharp(bytes).raw().toBuffer();
        const metadata = JSON.parse(await fsp.readFile(path.join(directory, `.capture_${item.captureId}.json`), 'utf8'));
        if (metadata.sha256 !== item.sha256 || metadata.size !== item.size) corruptFiles += 1;
      } catch (error) {
        if (error.code !== 'ENOENT') corruptFiles += 1;
      }
      sampleMemory();
    }
    const sortedLatencies = [...stats.latencies].sort((a, b) => a - b);
    const averageLatencyMs = sortedLatencies.length ? sortedLatencies.reduce((sum, value) => sum + value, 0) / sortedLatencies.length : 0;
    const p95LatencyMs = sortedLatencies.length ? sortedLatencies[Math.ceil(sortedLatencies.length * 0.95) - 1] : 0;
    const successfulImages = actualIds.size;
    const failedImages = Math.max(0, imageCount - successfulImages);
    const report = {
      generatedAt: new Date().toISOString(),
      mode: 'protocol/storage integration stress (production receiver and recovery code)',
      configuration: { requestedImages: imageCount, connectedDevices: deviceCount, queueConcurrency, queueLimit, slowDiskMsPerWrite: slowDiskMs, maximumImageBytes: maxImageBytes, memoryBudgetBytes },
      totalImages: imageCount,
      successfulImages,
      failedImages,
      duplicates: duplicateFiles,
      duplicateTransmissions: stats.duplicateTransmissions,
      corruptFiles,
      averageLatencyMs: round(averageLatencyMs),
      p95LatencyMs: round(p95LatencyMs),
      maximumMemoryUsageBytes: stats.peakRssBytes,
      memoryGrowthBytes: Math.max(0, stats.peakRssBytes - stats.baselineRssBytes),
      memoryBudgetBytes,
      memoryWithinBudget: stats.peakRssBytes - stats.baselineRssBytes <= memoryBudgetBytes,
      maximumQueueDepth: stats.maxQueued,
      queueLimit,
      maximumActiveTransfers: stats.maxActive,
      queueWithinBounds: stats.maxQueued <= queueLimit && stats.maxActive <= queueConcurrency,
      recoveryTimeMs: round(stats.recoveryTimeMs),
      recoveredImagesAtRestart: stats.recoveryValidCaptures,
      interruptedTransfersRetried: stats.reconnectRetries || 0,
      admissionTimeoutReconnects: stats.admissionTimeoutRecoveries || 0,
      lostAcknowledgementsInjected: stats.lostAcknowledgements,
      malformedPayloadsRejected: stats.malformedPayloadRejected,
      oversizedPayloadsRejected: stats.oversizedRejected,
      invalidImageRejected: stats.invalidImageRejected,
      fileSavedStatuses: stats.fileSavedStatuses,
      gallerySaveCallbacks: stats.gallerySaveCallbacks,
      largeImageBytes: stats.largeImageBytes,
      danglingTemporaryFiles: temporaryFiles.length,
      missingImages: missingIds.length,
      rejectedInvalidPayloadAttempts: stats.errors.length,
      unexpectedValidTransferErrors: stats.errors.filter((error) => expectedIds.has(error.captureId)).length,
      latencySamples: sortedLatencies.length,
      transferStatusesCorrect: stats.ids.every(({ captureId }) => {
        const states = stats.transferStates.get(captureId) || [];
        return states.includes('SERVER_RECEIVED') && states.includes('FILE_VALIDATED') && states.includes('FILE_SAVED');
      }),
      deviceStatusesCorrect: [...stats.deviceStates.values()].every((state) => state === 'CONNECTED'),
      finalDeviceStatuses: Object.fromEntries(stats.deviceStates),
      failedTransferDetails: stats.failedIds
    };
    report.passed = report.successfulImages === imageCount && report.failedImages === 0 && report.duplicates === 0 && report.corruptFiles === 0 && report.memoryWithinBudget && report.queueWithinBounds && report.missingImages === 0 && report.danglingTemporaryFiles === 0 && report.malformedPayloadsRejected && report.oversizedPayloadsRejected && report.invalidImageRejected && report.transferStatusesCorrect && report.deviceStatusesCorrect && report.unexpectedValidTransferErrors === 0;
    const jsonPath = path.join(outputBase, 'stress-report.json');
    const markdownPath = path.join(outputBase, 'stress-report.md');
    await fsp.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    await fsp.writeFile(markdownPath, renderMarkdown(report));
    console.log(renderMarkdown(report));
    console.log(`\nJSON report: ${jsonPath}\nMarkdown report: ${markdownPath}`);
    if (!report.passed) process.exitCode = 1;
  } finally {
    await Promise.allSettled(receivers.map((receiver) => receiver.close()));
    await fsp.rm(directory, { recursive: true, force: true });
  }
}
function round(value) { return Math.round(value * 100) / 100; }
function renderMarkdown(r) {
  return `# Image Tether Stress Test Report\n\n` +
    `Generated: ${r.generatedAt}\n\n` +
    `Result: **${r.passed ? 'PASS' : 'FAIL'}**\n\n` +
    `| Measure | Result |\n|---|---:|\n` +
    `| Total images | ${r.totalImages} |\n| Successful images | ${r.successfulImages} |\n| Failed images | ${r.failedImages} |\n` +
    `| Duplicate files | ${r.duplicates} |\n| Duplicate transmissions (injected) | ${r.duplicateTransmissions} |\n| Corrupt files | ${r.corruptFiles} |\n` +
    `| Average latency | ${r.averageLatencyMs} ms |\n| P95 latency | ${r.p95LatencyMs} ms |\n| Maximum memory usage | ${(r.maximumMemoryUsageBytes / 1048576).toFixed(1)} MiB |\n` +
    `| Memory growth / budget | ${(r.memoryGrowthBytes / 1048576).toFixed(1)} / ${(r.memoryBudgetBytes / 1048576).toFixed(0)} MiB |\n` +
    `| Maximum queue depth / limit | ${r.maximumQueueDepth} / ${r.queueLimit} |\n| Maximum active transfers | ${r.maximumActiveTransfers} |\n` +
    `| Transfer status sequence valid | ${r.transferStatusesCorrect} |\n| Final device statuses valid | ${r.deviceStatusesCorrect} |\n` +
    `| Recovery time | ${r.recoveryTimeMs} ms |\n| Images present at restart recovery | ${r.recoveredImagesAtRestart} |\n| Interrupted transfer retries | ${r.interruptedTransfersRetried} |\n| Admission timeout reconnects | ${r.admissionTimeoutReconnects} |\n` +
    `| Malformed / oversized / invalid image rejected | ${r.malformedPayloadsRejected} / ${r.oversizedPayloadsRejected} / ${r.invalidImageRejected} |\n` +
    `| Missing / corrupt / temporary files | ${r.missingImages} / ${r.corruptFiles} / ${r.danglingTemporaryFiles} |\n| Connected devices | ${r.configuration.connectedDevices} |\n`;
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
