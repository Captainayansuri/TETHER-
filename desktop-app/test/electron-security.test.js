const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  isPlainObject,
  isTrustedDashboardUrl,
  isValidPathArgument,
  parseSafeExternalUrl
} = require('../electron-security');

const dashboardFileUrl = 'file:///C:/app/dist/index.html';

test('dashboard URL policy only trusts the intended development origin or packaged file', () => {
  assert.equal(isTrustedDashboardUrl('http://localhost:5173/', {
    isDevelopment: true,
    dashboardFileUrl
  }), true);
  assert.equal(isTrustedDashboardUrl('http://user@localhost:5173/', {
    isDevelopment: true,
    dashboardFileUrl
  }), false);
  assert.equal(isTrustedDashboardUrl('http://localhost:5174/', {
    isDevelopment: true,
    dashboardFileUrl
  }), false);
  assert.equal(isTrustedDashboardUrl('https://localhost:5173/', {
    isDevelopment: true,
    dashboardFileUrl
  }), false);
  assert.equal(isTrustedDashboardUrl('http://localhost:5180/', {
    isDevelopment: true,
    developmentOrigin: 'http://localhost:5180',
    dashboardFileUrl
  }), true);
  assert.equal(isTrustedDashboardUrl('http://localhost:5173/', {
    isDevelopment: true,
    developmentOrigin: 'http://localhost:5180',
    dashboardFileUrl
  }), false);
  assert.equal(isTrustedDashboardUrl(dashboardFileUrl, {
    isDevelopment: false,
    dashboardFileUrl
  }), true);
  assert.equal(isTrustedDashboardUrl(`${dashboardFileUrl}?untrusted=1`, {
    isDevelopment: false,
    dashboardFileUrl
  }), false);
  assert.equal(isTrustedDashboardUrl('https://example.com/', {
    isDevelopment: false,
    dashboardFileUrl
  }), false);
});

test('external URLs allow only credential-free HTTP and HTTPS destinations', () => {
  assert.equal(parseSafeExternalUrl('https://example.com/path').href, 'https://example.com/path');
  assert.equal(parseSafeExternalUrl('http://127.0.0.1:8080/mobile').href, 'http://127.0.0.1:8080/mobile');
  assert.equal(parseSafeExternalUrl('javascript:alert(1)'), null);
  assert.equal(parseSafeExternalUrl('file:///etc/passwd'), null);
  assert.equal(parseSafeExternalUrl('https://user:password@example.com/'), null);
  assert.equal(parseSafeExternalUrl(`https://example.com/${'a'.repeat(2048)}`), null);
  assert.equal(parseSafeExternalUrl(null), null);
});

test('IPC path and object validators reject malformed values', () => {
  assert.equal(isValidPathArgument('C:\\captures'), true);
  assert.equal(isValidPathArgument(''), false);
  assert.equal(isValidPathArgument(`C:\\${'x'.repeat(32768)}`), false);
  assert.equal(isValidPathArgument('C:\\capture\u0000.jpg'), false);

  assert.equal(isPlainObject({ filename: 'capture.jpg' }), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
});

test('Electron main and preload keep renderer privileges constrained', () => {
  const desktopDirectory = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(desktopDirectory, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(desktopDirectory, 'preload.js'), 'utf8');
  const dashboardAdapter = fs.readFileSync(path.join(desktopDirectory, 'public', 'pairing-ui.js'), 'utf8');
  const tlsHelper = fs.readFileSync(path.join(desktopDirectory, 'local-tls.js'), 'utf8');
  const packageManifest = JSON.parse(fs.readFileSync(path.join(desktopDirectory, 'package.json'), 'utf8'));

  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegrationInSubFrames:\s*false/);
  assert.match(main, /nodeIntegrationInWorker:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /webSecurity:\s*true/);
  assert.match(main, /allowRunningInsecureContent:\s*false/);
  assert.match(main, /webviewTag:\s*false/);
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /will-navigate/);
  assert.match(main, /will-redirect/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /setPermissionCheckHandler/);
  assert.match(main, /devTools:\s*IS_DEVELOPMENT/);
  assert.match(main, /const APP_CONFIG = buildRuntimeConfig/);
  assert.match(main, /isPackaged:\s*app\.isPackaged/);
  assert.match(main, /IS_DEVELOPMENT = APP_CONFIG\.environment === 'development'/);
  assert.match(main, /loadURL\(DASHBOARD_DEV_URL\)/);
  assert.match(main, /capturesDir:\s*CAPTURES_DIR/);
  assert.match(main, /ipcMain\.handle\('get-connected-clients'/);
  assert.match(main, /authenticatedPairingToken = credentials\.token/);
  assert.match(main, /createAcknowledgementProof\(authenticatedPairingToken, acknowledgement\)/);
  assert.doesNotMatch(main, /^\s*mobileUrl,\s*$/m);
  assert.doesNotMatch(main, /createPreloadScript|writeFileSync\(preloadPath/);
  assert.match(preload, /contextBridge\.exposeInMainWorld/);
  assert.match(preload, /copyImage: \(filename\) => ipcRenderer\.invoke\('copy-image', \{ filename \}\)/);
  assert.match(main, /ipcMain\.handle\('copy-image'/);
  assert.match(main, /https\.createServer\(/);
  assert.match(main, /setCertificateVerifyProc/);
  assert.match(main, /export-local-trust-certificate/);
  assert.match(main, /https:\/\/\$\{localIP\}:\$\{PORT\}\/mobile/);
  assert.match(preload, /exportLocalTrustCertificate: \(\) => ipcRenderer\.invoke\('export-local-trust-certificate'\)/);
  assert.match(dashboardAdapter, /Export Trust Certificate/);
  assert.match(dashboardAdapter, /certificatePin/);
  assert.match(tlsHelper, /New-SelfSignedCertificate/);
  assert.ok(packageManifest.build.files.includes('local-tls.js'));
  assert.match(preload, /base64:\s*data\.previewUrl/);
  assert.doesNotMatch(main, /toString\(['"]base64['"]\)|base64:\s*`data:/);
  assert.match(main, /previewUrl:/);
  assert.match(main, /variant=full/);
  assert.doesNotMatch(`${main}\n${preload}`, /URL\.createObjectURL|URL\.revokeObjectURL/);
  assert.doesNotMatch(preload, /ipcRenderer\.send\s*\(|exposeInMainWorld\([^,]+,\s*ipcRenderer/);
  assert.match(dashboardAdapter, /element\.loading\s*=\s*'lazy'/);
  assert.match(dashboardAdapter, /element\.decoding\s*=\s*'async'/);
  assert.match(dashboardAdapter, /searchParams\.set\('variant',\s*'full'\)/);
});

test('shipped gallery bounds retained captures and cleans up IPC subscriptions and timers', () => {
  const bundlePath = path.join(__dirname, '..', 'public', 'app-dashboard.js');
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  const dashboardAdapter = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'pairing-ui.js'),
    'utf8'
  );

  assert.match(bundle, /slice\(0,200\)/);
  assert.match(bundle, /x\.captureId!==c\.captureId/);
  assert.match(bundle, /src:u\.url\|\|u\.base64,alt:"Active capture"/);
  assert.match(bundle, /unsubs\.push\(window\.electronAPI\.onClientConnected/);
  assert.match(bundle, /for\(const unsubscribe of unsubs\)unsubscribe\(\)/);
  assert.match(bundle, /toastTimers\.current\.clear\(\)/);
  assert.match(bundle, /slice\(-5\)/);
  assert.match(bundle, /for\(const \[id,timeout\] of toastTimers\.current\)/);
  assert.match(bundle, /notificationAudio\.current\.pause\(\)/);
  assert.match(bundle, /notificationAudio\.current\.src=""/);
  assert.equal((bundle.match(/new Audio\(/g) || []).length, 1);
  assert.match(dashboardAdapter, /window\.clearInterval\(refreshTimer\)/);
  assert.match(dashboardAdapter, /imageObserver\?\.disconnect\(\)/);
  assert.match(dashboardAdapter, /cardObserver\?\.disconnect\(\)/);
  assert.match(dashboardAdapter, /eventUnsubscribers\.splice\(0\)/);
});
