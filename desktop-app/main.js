const { app, BrowserWindow, ipcMain, dialog, shell, session, clipboard, ClipboardItem } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const { WebSocketServer } = require('ws');
const os = require('os');
const qrcode = require('qrcode');
const { pathToFileURL } = require('url');
const { buildRuntimeConfig } = require('./runtime-config');
const { createGracefulShutdown } = require('./graceful-shutdown');
const logger = require('./logger');
const APP_CONFIG = buildRuntimeConfig({
  environment: process.env.NODE_ENV,
  isPackaged: app.isPackaged,
  userDataPath: app.getPath('userData'),
  env: process.env
});
const APP_ROOT = app.getAppPath();
const getAppAssetPath = (...segments) => path.join(APP_ROOT, ...segments);
const APP_ICON_PATH = getAppAssetPath('build', 'app-icon.ico');
logger.setLogLevel(APP_CONFIG.loggingLevel);
logger.info('application.startup', {
  environment: APP_CONFIG.environment,
  isPackaged: app.isPackaged
});
const {
  isPlainObject,
  isTrustedDashboardUrl,
  isValidPathArgument,
  parseSafeExternalUrl
} = require('./electron-security');
const { createHttpApp } = require('./http-app');
const {
  isCapturesDirectory,
  resolveExistingCapturePath,
  resolveExistingCapturePathFromPath
} = require('./capture-files');
const {
  createPairingCredentials,
  createAcknowledgementProof,
  requireWebSocketAuthentication
} = require('./pairing-auth');
const {
  createUploadQueue,
  createCaptureStorageQuota,
  recoverCaptureStorage
} = require('./image-storage');
const {
  createConnectionRegistry,
  getClientDescriptor
} = require('./connection-registry');
const {
  createImageTransferReceiver,
  IMAGE_TRANSFER_CHUNK_BYTES
} = require('./image-transfer');
const {
  createThumbnailCache
} = require('./image-thumbnails');
const { copyCaptureImage } = require('./copy-capture-image');
const {
  createLocalTlsMaterial,
  isLocalTlsMaterialCurrent,
  listLocalIPv4Addresses,
  selectLanIPv4Address
} = require('./local-tls');

let mainWindow;
let httpServer;
let localTlsMaterial;
let localTlsRefreshPromise;
let wss;
let heartbeatTimer;
let shuttingDown = false;
let pendingAuthenticationConnections = 0;
let PORT = APP_CONFIG.serverPort;
let pairingCredentials = createPairingCredentials(APP_CONFIG.pairingExpirationMs);
const CAPTURES_DIR = APP_CONFIG.captureDirectory;
const CAPTURE_ACCESS_TOKEN = crypto.randomBytes(32).toString('hex');
const thumbnailCache = createThumbnailCache({
  capturesDirectory: CAPTURES_DIR,
  maxBytes: APP_CONFIG.thumbnailCacheBytes,
  maxAgeMs: APP_CONFIG.thumbnailMaxAgeMs,
  maxInputPixels: APP_CONFIG.maxInputPixels,
  width: APP_CONFIG.thumbnailWidth,
  height: APP_CONFIG.thumbnailHeight
});
const IS_DEVELOPMENT = APP_CONFIG.environment === 'development';
const DASHBOARD_DEV_URL = `http://localhost:${APP_CONFIG.dashboardDevPort}`;
const clientRegistry = createConnectionRegistry({
  staleConnectionMs: APP_CONFIG.staleConnectionTimeoutMs,
  onEvent: (event, client) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(event, client);
    }
  }
});
const uploadQueue = createUploadQueue(
  APP_CONFIG.maxConcurrentUploads,
  APP_CONFIG.queueSize
);
const captureStorageQuota = createCaptureStorageQuota({
  capturesDirectory: CAPTURES_DIR,
  maxBytes: APP_CONFIG.maxCaptureStorageBytes
});
const activeTransferReceivers = new Set();
let galleryUpdateQueue = Promise.resolve();

function queueGalleryUpdate({ captureId, filename, path: filepath, mimeType, size, sha256 }) {
  const timestamp = Date.now();
  const update = galleryUpdateQueue.then(async () => {
    const window = mainWindow;
    if (!window || window.isDestroyed()) return;

    await thumbnailCache.get({
      captureId,
      sha256,
      imagePath: filepath
    });
    if (window.isDestroyed()) return;
    const imageUrl = new URL(
      `/_desktop/captures/${encodeURIComponent(filename)}`,
      `https://127.0.0.1:${PORT}`
    );
    imageUrl.searchParams.set('key', CAPTURE_ACCESS_TOKEN);
    window.webContents.send('image-received', {
      captureId,
      filename,
      previewUrl: `${imageUrl.href}&variant=thumbnail`,
      url: `${imageUrl.href}&variant=full`,
      mimeType,
      size: `${(size / (1024 * 1024)).toFixed(2)} MB`,
      bytes: size,
      timestamp
    });
  });
  galleryUpdateQueue = update.catch((error) => {
    logger.error('gallery.publish_failed', {
      errorCode: error.code || error.name || 'UNKNOWN'
    });
  });
  return galleryUpdateQueue;
}
function getLocalIP() {
  return selectLanIPv4Address(os.networkInterfaces());
}

async function createServer() {
  const interfaces = os.networkInterfaces();
  const localIP = selectLanIPv4Address(interfaces);
  localTlsMaterial = await createLocalTlsMaterial({
    userDataPath: app.getPath('userData'),
    addresses: listLocalIPv4Addresses(interfaces, localIP)
  });
  logger.info('tls.local_certificate_ready', {
    rootFingerprint: localTlsMaterial.rootFingerprint,
    rootNotAfter: localTlsMaterial.rootNotAfter,
    leafFingerprint: localTlsMaterial.leafFingerprint,
    leafNotAfter: localTlsMaterial.leafNotAfter,
    subjectAlternativeNames: localTlsMaterial.subjectAlternativeNames
  });
  const expressApp = createHttpApp({
    mobileStaticPath: getAppAssetPath('public', 'mobile'),
    localIP,
    capturesDirectory: CAPTURES_DIR,
    captureAccessToken: CAPTURE_ACCESS_TOKEN,
    thumbnailCache,
    getPort: () => PORT
  });

  // Pairing pages and WebSockets share a TLS-protected local-network listener.
  try {
    httpServer = https.createServer({
      pfx: localTlsMaterial.pfx,
      passphrase: localTlsMaterial.pfxPassphrase
    }, expressApp);
  } finally {
    localTlsMaterial.pfx.fill(0);
  }

  // Initialize WebSocket server on the same HTTP server port
  wss = new WebSocketServer({
    server: httpServer,
    maxPayload: Math.max(64 * 1024, Math.min(APP_CONFIG.uploadLimitBytes, IMAGE_TRANSFER_CHUNK_BYTES))
  });

  heartbeatTimer = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) {
        logger.warn('websocket.heartbeat_timeout');
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
    clientRegistry.cleanupStale();
  }, APP_CONFIG.heartbeatIntervalMs);

  wss.on('connection', (ws, req) => {
    if (shuttingDown) {
      ws.close(1012, 'Server shutting down');
      return;
    }
    if (wss.clients.size > APP_CONFIG.maxClientConnections ||
        pendingAuthenticationConnections >= Math.min(APP_CONFIG.maxClientConnections, 8)) {
      logger.warn('client.connection_rejected', {
        reason: 'SERVER_BUSY',
        clientPlatform: 'UNKNOWN'
      });
      ws.close(1013, 'Too many connected clients');
      return;
    }
    pendingAuthenticationConnections += 1;
    let authenticationSlotHeld = true;
    ws.isAlive = true;
    const userAgent = req.headers['user-agent'] || '';
    const device = getClientDescriptor(userAgent);
    logger.info('websocket.connection_opened', {
      clientPlatform: device.platform
    });
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('error', (error) => {
      logger.warn('websocket.transport_error', {
        errorCode: error.code || error.name || 'UNKNOWN'
      });
    });

    let queuedMessages = 0;
    let messageQueue = Promise.resolve();

    const transferReceiver = createImageTransferReceiver({
      capturesDirectory: CAPTURES_DIR,
      maxImageBytes: APP_CONFIG.uploadLimitBytes,
      maxInputPixels: APP_CONFIG.maxInputPixels,
      reserveCaptureStorage: ({ captureId, size }) => captureStorageQuota.reserve(captureId, size),
      signAcknowledgement: (acknowledgement) =>
        createAcknowledgementProof(authenticatedPairingToken, acknowledgement),
      uploadQueue,
      send: (message) => {
        if (ws.readyState !== 1) return;
        ws.send(message);
        const response = JSON.parse(message);
        if (response.type === 'upload_error' ||
            response.type === 'image_ack' ||
            (response.type === 'transfer_status' && response.state === 'FILE_SAVED')) {
          clientRegistry.setState(
            clientId,
            response.type === 'upload_error' ? 'ERROR' : 'CONNECTED'
          );
        }
      },
      onSaved: async (image) => {
        await queueGalleryUpdate(image);
        clientRegistry.setState(clientId, 'CONNECTED');
      }
    });
    activeTransferReceivers.add(transferReceiver);

    let authenticated = false;
    let clientId;
    let authenticatedPairingToken;
    requireWebSocketAuthentication(ws, () => pairingCredentials, (sessionId, credentials) => {
      if (shuttingDown) {
        ws.close(1012, 'Server shutting down');
        return;
      }
      if (clientRegistry.size >= APP_CONFIG.maxClientConnections) {
        logger.warn('client.connection_rejected', {
          reason: 'SERVER_BUSY',
          clientPlatform: device.platform
        });
        ws.send(JSON.stringify({ type: 'auth_error', code: 'SERVER_BUSY' }));
        ws.close(1013, 'Too many connected clients');
        return;
      }
      authenticated = true;
      authenticatedPairingToken = credentials.token;
      authenticationSlotHeld = false;
      pendingAuthenticationConnections -= 1;
      clientId = sessionId;
      const clientRecord = clientRegistry.register({
        id: clientId,
        ...device,
        connection: ws
      });
      logger.info('client.connected', { clientPlatform: clientRecord.platform });
      ws.send(JSON.stringify({
        type: 'paired',
        sessionId: clientId,
        deviceName: clientRecord.name,
        maxImageBytes: APP_CONFIG.uploadLimitBytes,
        chunkSize: Math.min(APP_CONFIG.uploadLimitBytes, IMAGE_TRANSFER_CHUNK_BYTES),
        maxQueuedUploads: APP_CONFIG.queueSize,
        reconnectMaxIntervalMs: APP_CONFIG.reconnectMaxIntervalMs
      }));
    }, APP_CONFIG.connectionTimeoutMs);

    ws.on('message', (message, isBinary) => {
      if (!authenticated) return;
      queuedMessages += 1;
      if (queuedMessages > 2) {
        logger.warn('websocket.inbound_queue_full', {
          clientPlatform: device.platform
        });
        ws.close(1013, 'Image processing queue is full');
        return;
      }
      ws._socket.pause();
      messageQueue = messageQueue.then(async () => {
        clientRegistry.touch(clientId);
        if (isBinary) {
          clientRegistry.setState(clientId, 'TRANSFERRING');
          await transferReceiver.handleBinary(message);
          return;
        }

        try {
          const data = JSON.parse(message.toString());
          if (data.type === 'image_upload') {
            clientRegistry.setState(clientId, 'TRANSFERRING');
            await transferReceiver.handleText(message.toString());
          } else if (data.type === 'authenticate') {
            return;
          } else if (data.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          } else if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('client-message', { clientId, data });
          }
        } catch (error) {
          if (error.code === 'TRANSFER_QUEUE_FULL') {
            ws.close(1013, 'Image processing queue is full');
            return;
          }
          if (error instanceof SyntaxError) {
            logger.debug('websocket.non_json_message');
            return;
          }
          logger.error('websocket.message_processing_failed', {
            errorCode: error.code || error.name || 'UNKNOWN'
          });
          if (ws.readyState === 1) ws.close(1011, 'Image processing failed');
        }
      }).catch((error) => {
        if (error.code === 'TRANSFER_QUEUE_FULL') {
          ws.close(1013, 'Image processing queue is full');
          return;
        }
        logger.error('websocket.message_processing_failed', {
          errorCode: error.code || error.name || 'UNKNOWN'
        });
        if (ws.readyState === 1) ws.close(1011, 'Image processing failed');
      }).finally(() => {
        queuedMessages -= 1;
        if (ws.readyState === 1) ws._socket.resume();
      });
    });
    ws.on('close', () => {
      if (authenticationSlotHeld) {
        authenticationSlotHeld = false;
        pendingAuthenticationConnections -= 1;
      }
      logger.info('websocket.connection_closed', {
        clientPlatform: device.platform,
        authResult: authenticated ? 'ACCEPTED' : 'NOT_AUTHENTICATED'
      });
      void transferReceiver.close()
        .then(() => activeTransferReceivers.delete(transferReceiver))
        .catch((error) => {
          logger.error('transfer.cleanup_failed', {
            errorCode: error.code || error.name || 'UNKNOWN'
          });
          activeTransferReceivers.delete(transferReceiver);
        });
      if (authenticated) {
        clientRegistry.remove(clientId);
        logger.info('client.disconnected', { clientPlatform: device.platform });
      }
    });

    ws.on('pong', () => {
      if (authenticated) clientRegistry.touch(clientId);
    });

  });

  let portFallbackCount = 0;
  httpServer.once('close', () => clearInterval(heartbeatTimer));
  await new Promise((resolve, reject) => {
    let startupSettled = false;
    const listenOnPort = (portToTry) => {
      httpServer.listen(portToTry, '0.0.0.0', () => {
        PORT = httpServer.address().port;
        logger.info('server.started', { port: PORT });
        startupSettled = true;
        resolve();
      });
    };

    httpServer.on('error', (err) => {
      if (shuttingDown) {
        logger.warn('server.start_cancelled', {
          errorCode: err.code || err.name || 'UNKNOWN'
        });
        if (!startupSettled) {
          startupSettled = true;
          reject(err);
        }
        return;
      }
      if (err.code === 'EADDRINUSE' &&
          PORT < 65535 &&
          portFallbackCount < APP_CONFIG.portFallbackAttempts) {
        portFallbackCount++;
        PORT++;
        logger.warn('server.port_in_use', { port: PORT, attempt: portFallbackCount });
        listenOnPort(PORT);
      } else {
        logger.error('server.start_failed', {
          errorCode: err.code || err.name || 'UNKNOWN',
          port: PORT
        });
        if (!startupSettled) {
          startupSettled = true;
          reject(err);
        }
      }
    });

    listenOnPort(PORT);
  });
}

async function ensureLocalTlsAddress(address) {
  if (isLocalTlsMaterialCurrent(localTlsMaterial, address)) return;
  if (localTlsRefreshPromise) {
    await localTlsRefreshPromise;
    if (isLocalTlsMaterialCurrent(localTlsMaterial, address)) return;
  }

  localTlsRefreshPromise = (async () => {
    const interfaces = os.networkInterfaces();
    const addresses = listLocalIPv4Addresses(interfaces, address);
    const updatedMaterial = await createLocalTlsMaterial({
      userDataPath: app.getPath('userData'),
      addresses
    });
    try {
      httpServer.setSecureContext({
        pfx: updatedMaterial.pfx,
        passphrase: updatedMaterial.pfxPassphrase
      });
    } finally {
      updatedMaterial.pfx.fill(0);
    }
    localTlsMaterial = updatedMaterial;
    logger.info('tls.local_certificate_refreshed', {
      rootFingerprint: updatedMaterial.rootFingerprint,
      rootNotAfter: updatedMaterial.rootNotAfter,
      leafFingerprint: updatedMaterial.leafFingerprint,
      leafNotAfter: updatedMaterial.leafNotAfter,
      subjectAlternativeNames: updatedMaterial.subjectAlternativeNames,
      selectedAddress: address
    });
  })().finally(() => {
    localTlsRefreshPromise = null;
  });
  await localTlsRefreshPromise;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 850,
    title: 'TETHER',
    icon: APP_ICON_PATH,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: IS_DEVELOPMENT,
      preload: getAppAssetPath('preload.js')
    }
  });

  const isTrustedUrl = (candidate) => isTrustedDashboardUrl(candidate, {
    isDevelopment: IS_DEVELOPMENT,
    developmentOrigin: DASHBOARD_DEV_URL,
    dashboardFileUrl
  });
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!isTrustedUrl(navigationUrl)) event.preventDefault();
  });
  mainWindow.webContents.on('will-redirect', (event, navigationUrl) => {
    if (!isTrustedUrl(navigationUrl)) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedUrl(mainWindow.webContents.getURL())) {
      const externalUrl = parseSafeExternalUrl(url);
      if (externalUrl) {
        void shell.openExternal(externalUrl.href).catch((error) => {
          logger.error('shell.open_external_failed', {
            errorCode: error.code || error.name || 'UNKNOWN'
          });
        });
      }
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame) {
      logger.error('renderer.load_failed', {
        errorCode: String(errorCode),
        reason: 'MAIN_FRAME_LOAD_FAILED'
      });
    }
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('renderer.process_gone', {
      errorCode: String(details.exitCode),
      reason: details.reason || 'UNKNOWN'
    });
  });
  mainWindow.webContents.on('console-message', (details) => {
    if (details.level === 'error') {
      logger.error('renderer.console_error', {
        errorCode: 'JAVASCRIPT_CONSOLE_ERROR',
        reason: 'RENDERER_SCRIPT_FAILED'
      });
    }
  });

  if (IS_DEVELOPMENT) {
    void mainWindow.loadURL(DASHBOARD_DEV_URL);
    mainWindow.webContents.openDevTools();
  } else {
    void mainWindow.loadFile(getAppAssetPath('dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    let fingerprint = '';
    try {
      fingerprint = new crypto.X509Certificate(request.certificate?.data).fingerprint256
        .replaceAll(':', '').toLowerCase();
    } catch {}
    if ((request.hostname === '127.0.0.1' || request.hostname === '::1') &&
        localTlsMaterial && fingerprint === localTlsMaterial.leafFingerprint) {
      callback(0);
      return;
    }
    callback(-3);
  });
  let startupStage = 'storage.directory_create';
  return fs.promises.mkdir(CAPTURES_DIR, { recursive: true })
    .then(() => {
      startupStage = 'storage.recovery';
      return recoverCaptureStorage(CAPTURES_DIR, { temporaryFileTtlMs: 0 });
    })
    .then(async (recovery) => {
      startupStage = 'thumbnail.cleanup';
      await thumbnailCache.cleanup({ validCaptures: recovery.validCaptures });
      startupStage = 'capture_quota.initialize';
      await captureStorageQuota.initialize();
      const { removedTemporaryFiles, invalidCaptures, orphanMetadata } = recovery;
      if (removedTemporaryFiles.length) {
        logger.info('storage.recovery_removed_temporary_files', {
          count: removedTemporaryFiles.length
        });
      }
      if (invalidCaptures.length) {
        logger.warn('storage.recovery_invalid_captures_preserved', {
          count: invalidCaptures.length
        });
      }
      if (orphanMetadata.length) {
        logger.warn('storage.recovery_orphan_metadata_preserved', {
          count: orphanMetadata.length
        });
      }
      startupStage = 'server.start';
      await createServer();
      startupStage = 'dashboard.create';
      createWindow();
      logger.info('application.ready');
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch((error) => {
      logger.error('application.startup_failed', {
        stage: startupStage,
        errorCode: error.code || error.name || 'UNKNOWN',
        errorMessage: error.message || String(error),
        stackTrace: error.stack || 'No stack trace available'
      });
      dialog.showErrorBox(
        'TETHER could not start',
        `Startup failed during ${startupStage}.\n\n${error.message || 'Unknown startup error.'}\n\nSee the application log for diagnostic details.`
      );
      app.quit();
    });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

let shutdownComplete = false;
let shutdownPromise;
app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownPromise) return;

  logger.info('application.shutdown_started');
  shuttingDown = true;
  clearInterval(heartbeatTimer);

  let httpClosePromise = Promise.resolve();
  let websocketClosePromise = Promise.resolve();
  const shutdown = createGracefulShutdown({
    timeoutMs: APP_CONFIG.shutdownTimeoutMs,
    stopAccepting: () => {
      if (httpServer) {
        httpClosePromise = new Promise((resolve, reject) => {
          httpServer.close((error) => {
            if (error?.code === 'ERR_SERVER_NOT_RUNNING') resolve();
            else if (error) reject(error);
            else resolve();
          });
        });
      }
      if (wss) {
        websocketClosePromise = new Promise((resolve, reject) => {
          wss.close((error) => error ? reject(error) : resolve());
        });
      }
      return Promise.all([httpClosePromise, websocketClosePromise]);
    },
    notifyClients: () => {
      if (!wss) return;
      const message = JSON.stringify({ type: 'server_shutdown', retryable: true });
      for (const socket of wss.clients) {
        if (socket.readyState !== 1) continue;
        socket.send(message, (error) => {
          if (error) {
            logger.warn('shutdown.client_notification_failed', {
              errorCode: error.code || error.name || 'UNKNOWN'
            });
          }
        });
      }
    },
    stopQueueAdmission: () => uploadQueue.stopAccepting(),
    drainQueue: () => uploadQueue.waitForIdle(),
    closeTransfers: async () => {
      await Promise.all(Array.from(activeTransferReceivers, (receiver) => receiver.close()));
      activeTransferReceivers.clear();
    },
    persistState: () => galleryUpdateQueue,
    closeClients: () => new Promise((resolve) => {
      if (!wss) {
        resolve();
        return;
      }
      const sockets = Array.from(wss.clients);
      if (sockets.length === 0) {
        clientRegistry.closeAll('server-shutdown', { graceful: true });
        resolve();
        return;
      }
      let remaining = sockets.length;
      const onClosed = () => {
        remaining -= 1;
        if (remaining === 0) resolve();
      };
      for (const socket of sockets) socket.once('close', onClosed);
      clientRegistry.closeAll('server-shutdown', { graceful: true });
      for (const socket of sockets) {
        if (socket.readyState === 1 || socket.readyState === 0) {
          socket.close(1001, 'Server shutting down');
        }
      }
      for (const socket of sockets) {
        if (socket.readyState === 3) {
          socket.removeListener('close', onClosed);
          onClosed();
        }
      }
    }),
    forceCloseClients: () => {
      if (!wss) return;
      for (const socket of wss.clients) socket.terminate();
    },
    forceCloseServer: () => {
      if (httpServer && typeof httpServer.closeAllConnections === 'function') {
        httpServer.closeAllConnections();
      }
      if (wss) {
        for (const socket of wss.clients) socket.terminate();
      }
    },
    onError: (stage, error) => {
      logger.error('application.shutdown_step_failed', {
        reason: stage.toUpperCase(),
        errorCode: error.code || error.name || 'UNKNOWN'
      });
    },
    onTimeout: (stage) => {
      logger.warn('application.shutdown_timeout', {
        reason: stage.toUpperCase()
      });
    }
  });

  shutdownPromise = shutdown()
    .catch((error) => {
      logger.error('application.shutdown_failed', {
        errorCode: error.code || error.name || 'UNKNOWN'
      });
    })
    .finally(() => {
      logger.info('application.shutdown_completed');
      shutdownComplete = true;
      app.quit();
    });
});

function requestShutdownFromSignal() {
  logger.info('application.shutdown_signal');
  app.quit();
}

process.once('SIGINT', requestShutdownFromSignal);
process.once('SIGTERM', requestShutdownFromSignal);

const dashboardFileUrl = pathToFileURL(getAppAssetPath('dist', 'index.html')).href;

function isTrustedDashboardSender(event) {
  if (!mainWindow ||
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== event.sender.mainFrame) {
    return false;
  }

  return isTrustedDashboardUrl(event.senderFrame.url, {
    isDevelopment: IS_DEVELOPMENT,
    developmentOrigin: DASHBOARD_DEV_URL,
    dashboardFileUrl
  });
}

// IPC Handlers
ipcMain.handle('get-server-config', async (event, ...args) => {
  if (!isTrustedDashboardSender(event) || args.length !== 0) {
    throw new Error('Request not authorized');
  }

  if (Date.now() >= pairingCredentials.expiresAt) {
    pairingCredentials = createPairingCredentials(APP_CONFIG.pairingExpirationMs);
  }

  const localIP = getLocalIP();
  await ensureLocalTlsAddress(localIP);
  const mobileUrl = `https://${localIP}:${PORT}/mobile/#token=${pairingCredentials.token}`;
  
  // Generate QR Code as DataURL
  const qrCodeDataUrl = await qrcode.toDataURL(mobileUrl, {
    margin: 2,
    width: 250,
    color: {
      dark: '#0F172A',
      light: '#FFFFFF'
    }
  });

  return {
    ip: localIP,
    port: PORT,
    pairingToken: pairingCredentials.token,
    pairingTokenExpiresAt: pairingCredentials.expiresAt,
    certificatePin: localTlsMaterial?.certificatePin || '',
    certificateFingerprint: localTlsMaterial?.rootFingerprint || '',
    certificateExpiresAt: localTlsMaterial?.leafNotAfter || '',
    certificateAuthorityExpiresAt: localTlsMaterial?.rootNotAfter || '',
    certificateSubjectAlternativeNames: localTlsMaterial?.subjectAlternativeNames || '',
    certificateAuthorityRotated: localTlsMaterial?.certificateAuthorityRotated === true,
    mobileAddress: `https://${localIP}:${PORT}/mobile/`,
    maxImageBytes: APP_CONFIG.uploadLimitBytes,
    qrCode: qrCodeDataUrl,
    capturesDir: CAPTURES_DIR
  };
});

ipcMain.handle('export-local-trust-certificate', async (event, ...args) => {
  if (!isTrustedDashboardSender(event) || args.length !== 0 || !localTlsMaterial) {
    return { success: false, message: 'Request not authorized' };
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('downloads'), 'TETHER-Local-Trust.cer'),
    filters: [{ name: 'TETHER trust certificate', extensions: ['cer'] }]
  });
  if (result.canceled || !result.filePath) return { success: false, message: 'Cancelled' };
  try {
    await fs.promises.copyFile(localTlsMaterial.rootCertificatePath, result.filePath);
    return { success: true, path: result.filePath };
  } catch (error) {
    logger.error('tls.trust_certificate_export_failed', { errorCode: error.code || error.name || 'UNKNOWN' });
    return { success: false, message: 'Unable to export the trust certificate' };
  }
});

ipcMain.handle('get-connected-clients', (event, ...args) => {
  if (!isTrustedDashboardSender(event) || args.length !== 0) {
    throw new Error('Request not authorized');
  }
  return clientRegistry.list();
});

ipcMain.handle('show-in-folder', async (event, filepath, ...args) => {
  if (!isTrustedDashboardSender(event) || args.length !== 0 || !isValidPathArgument(filepath)) {
    return false;
  }

  if (isCapturesDirectory(CAPTURES_DIR, filepath)) {
    const result = await shell.openPath(CAPTURES_DIR);
    if (result) {
      logger.error('capture_directory.open_failed');
      return false;
    }
    return true;
  }

  try {
    const safePath = await resolveExistingCapturePathFromPath(CAPTURES_DIR, filepath);
    if (!safePath) return false;
    shell.showItemInFolder(safePath);
    return true;
  } catch (error) {
    logger.error('capture.reveal_failed', {
      errorCode: error.code || error.name || 'UNKNOWN'
    });
    return false;
  }
});

ipcMain.handle('open-external', async (event, url, ...args) => {
  if (!isTrustedDashboardSender(event) || args.length !== 0) {
    return false;
  }
  const parsedUrl = parseSafeExternalUrl(url);
  if (!parsedUrl) return false;
  await shell.openExternal(parsedUrl.href);
  return true;
});

ipcMain.handle('select-directory', async (event, ...args) => {
  if (!isTrustedDashboardSender(event) || args.length !== 0) {
    return null;
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (result.canceled) {
    return null;
  } else {
    return result.filePaths[0];
  }
});

ipcMain.handle('save-image', async (event, data, ...args) => {
  if (!isTrustedDashboardSender(event)) {
    return { success: false, message: 'Request not authorized' };
  }

  if (args.length !== 0 ||
      !isPlainObject(data) ||
      Object.keys(data).some((key) => key !== 'filename') ||
      typeof data.filename !== 'string' ||
      data.filename.length > 128) {
    return { success: false, message: 'Invalid image request' };
  }
  const filename = data.filename;
  let sourcePath;
  try {
    sourcePath = await resolveExistingCapturePath(CAPTURES_DIR, filename);
  } catch (error) {
    logger.error('capture.export_resolve_failed', {
      errorCode: error.code || error.name || 'UNKNOWN'
    });
    return { success: false, message: 'Unable to access image' };
  }
  if (!sourcePath) {
    return { success: false, message: 'Source capture not found' };
  }

  // Allow user to choose where to save the photo
  const defaultPath = path.join(app.getPath('downloads'), filename);
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath,
    filters: [{ name: 'Images', extensions: ['jpg', 'png', 'webp'] }]
  });

  if (result.canceled || !result.filePath) {
    return { success: false, message: 'Cancelled' };
  }

  try {
    await fs.promises.copyFile(sourcePath, result.filePath);
    return { success: true, path: result.filePath };
  } catch (error) {
    logger.error('capture.export_failed', {
      errorCode: error.code || error.name || 'UNKNOWN'
    });
    return { success: false, message: 'Unable to save image' };
  }
});

ipcMain.handle('copy-image', async (event, data, ...args) => {
  if (!isTrustedDashboardSender(event) ||
      args.length !== 0 ||
      !isPlainObject(data) ||
      Object.keys(data).some((key) => key !== 'filename') ||
      typeof data.filename !== 'string' ||
      data.filename.length > 128) {
    return { success: false, message: 'Invalid image request' };
  }
  return copyCaptureImage({
    capturesDirectory: CAPTURES_DIR,
    filename: data.filename,
    clipboard,
    ClipboardItem,
    maxInputPixels: APP_CONFIG.maxInputPixels,
    onDiagnostic: ({ stage, errorCode }) => logger.error('capture.copy_failed', { stage, errorCode })
  });
});
