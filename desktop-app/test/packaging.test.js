const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const desktopDirectory = path.join(__dirname, '..');
const packageJson = require(path.join(desktopDirectory, 'package.json'));

test('Windows release metadata configures a per-user NSIS installer and app identity', () => {
  const { build } = packageJson;
  assert.equal(packageJson.version, '1.0.0');
  assert.equal(build.appId, 'com.imagetether.desktop');
  assert.equal(build.productName, 'TETHER');
  assert.equal(build.asar, true);
  assert.equal(build.win.legalTrademarks, 'TETHER');
  assert.equal(build.win.signAndEditExecutable, true);
  assert.equal(build.win.requestedExecutionLevel, 'asInvoker');
  assert.deepEqual(build.win.target, [{
    target: 'nsis',
    arch: ['x64']
  }]);
  assert.equal(build.nsis.oneClick, false);
  assert.equal(build.nsis.perMachine, false);
  assert.equal(build.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(packageJson.scripts['dist:win'], 'npm run build && electron-builder --win nsis --x64');
});

test('TETHER branding appears in the desktop window, dashboard, mobile page, and Android label', () => {
  const mainProcess = fs.readFileSync(path.join(desktopDirectory, 'main.js'), 'utf8');
  const dashboardHtml = fs.readFileSync(path.join(desktopDirectory, 'index.html'), 'utf8');
  const dashboardBundle = fs.readFileSync(path.join(desktopDirectory, 'public', 'app-dashboard.js'), 'utf8');
  const mobileHtml = fs.readFileSync(path.join(desktopDirectory, 'public', 'mobile', 'index.html'), 'utf8');
  const androidManifest = fs.readFileSync(path.join(desktopDirectory, '..', 'android-app', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');

  assert.match(mainProcess, /title:\s*'TETHER'/);
  assert.match(dashboardHtml, /<title>TETHER<\/title>/);
  assert.match(dashboardHtml, /id="renderer-error"/);
  assert.match(dashboardHtml, /setTimeout\(showError, 15000\)/);
  assert.match(dashboardBundle, /children:"TETHER"/);
  assert.doesNotMatch(dashboardBundle, /192\.168\.1\.15/);
  assert.match(mobileHtml, /<title>TETHER<\/title>/);
  assert.match(androidManifest, /android:label="TETHER"/);
});

test('release includes runtime, preload, server and dashboard assets inside app.asar', () => {
  const { files, asarUnpack } = packageJson.build;
  for (const required of [
    'main.js',
    'runtime-config.js',
    'http-app.js',
    'local-tls.js',
    'preload.js',
    'public/**/*',
    'dist/**/*',
    'build/app-icon.ico',
    'package.json'
  ]) {
    assert.ok(files.includes(required), `release file rule includes ${required}`);
  }
  assert.ok(asarUnpack.includes('**/*.node'));

  const main = fs.readFileSync(path.join(desktopDirectory, 'main.js'), 'utf8');
  assert.match(main, /const APP_ROOT = app\.getAppPath\(\)/);
  assert.match(main, /getAppAssetPath\('preload\.js'\)/);
  assert.match(main, /icon:\s*APP_ICON_PATH/);
  assert.match(main, /getAppAssetPath\('dist', 'index\.html'\)/);
  assert.match(main, /\/mobile\/#token=/);
  assert.ok(main.includes('mobileAddress: `https://${localIP}:${PORT}/mobile/`'));
  const dashboardHtml = fs.readFileSync(path.join(desktopDirectory, 'index.html'), 'utf8');
  const viteConfig = fs.readFileSync(path.join(desktopDirectory, 'vite.config.mjs'), 'utf8');
  assert.match(dashboardHtml, /<script type="module" src="\.\/app-dashboard\.js"><\/script>/);
  assert.match(dashboardHtml, /<script type="module" src="\.\/pairing-ui\.js"><\/script>/);
  assert.match(dashboardHtml, /id="hosted-preview-notice"/);
  assert.match(dashboardHtml, /type="module" src="\.\/hosted-preview\.js"/);
  assert.match(viteConfig, /root: path\.resolve\(__dirname, 'src'\)/);
  assert.match(main, /getAppAssetPath\('public', 'mobile'\)/);
  assert.match(main, /userDataPath:\s*app\.getPath\('userData'\)/);
  assert.doesNotMatch(main, /loadURL\(DASHBOARD_DEV_URL\)\s*;[\s\S]*?app\.isPackaged/);
});

test('dashboard build inputs use local relative assets and Windows icon is valid ICO', () => {
  const html = fs.readFileSync(path.join(desktopDirectory, 'index.html'), 'utf8');
  assert.match(html, /href=["']\.\/app-dashboard\.css["']/);
  assert.match(html, /src=["']\.\/app-dashboard\.js["']/);
  assert.match(html, /src=["']\.\/pairing-ui\.js["']/);
  assert.doesNotMatch(html, /\/src\/main\.jsx/);

  const buildScript = fs.readFileSync(path.join(desktopDirectory, 'build-dashboard.js'), 'utf8');
  assert.match(buildScript, /replaceAll\('\.\.\/assets\//);
  assert.match(buildScript, /copyAsset\('pairing-ui\.js'\)/);
  assert.match(buildScript, /copyAsset\('hosted-preview\.js'\)/);
  assert.match(buildScript, /path\.join\(output, 'mobile'\)/);

  const icon = fs.readFileSync(path.join(desktopDirectory, 'build', 'app-icon.ico'));
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  assert.equal(icon.readUInt16LE(4), 1);
  assert.equal(icon.readUInt32LE(18), 22);
  assert.equal(icon.subarray(22, 26).toString('hex'), '89504e47');
});

test('update policy is documented as versioned per-user installer replacement', () => {
  const readme = fs.readFileSync(path.join(desktopDirectory, 'README.md'), 'utf8');
  assert.match(readme, /Windows distribution/);
  assert.match(readme, /versioned installer replacement/i);
  assert.match(readme, /code signing/i);
  assert.match(readme, /preserving captures and settings/i);
  assert.match(readme, /clean Windows x64 machine/i);
});
