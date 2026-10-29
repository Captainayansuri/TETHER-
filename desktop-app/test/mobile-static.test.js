const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const path = require('path');

test('mobile page stacks the camera and photo actions and removes the old icon toolbar', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'mobile', 'index.html'), 'utf8');
  const openCamera = page.indexOf('id="open-camera" type="button">Open Camera</button>');
  const choosePhoto = page.indexOf('id="choose-photo" type="button">Choose Photo</button>');

  assert.ok(openCamera >= 0);
  assert.ok(choosePhoto > openCamera);
  assert.doesNotMatch(page, /Open Camera \/ Choose Photo|controls-panel|id="shutter"|id="gallery-trigger"/);
  assert.doesNotMatch(page, /Switch Camera|Try Live Camera|id="toggle-camera"|id="retry-camera"/);
  const viewfinder = page.slice(page.indexOf('<div class="viewfinder-container">'), page.indexOf('</div>\n\n  <div id="transfer-progress"'));
  assert.ok(viewfinder.indexOf('id="fallback-view"') < viewfinder.indexOf('class="capture-actions"'));
  const mobileScript = fs.readFileSync(path.join(__dirname, '..', 'public', 'mobile', 'mobile.js'), 'utf8');
  assert.match(mobileScript, /Secure connection required/);
  assert.match(page, /accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(page, /viewport-fit=cover/);
  assert.doesNotMatch(page, /user-scalable=no|maximum-scale=/);
});

test('mobile action panel remains in the document flow and the page can scroll on short viewports', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'mobile', 'index.html'), 'utf8');
  const bodyStyles = page.match(/body\s*\{([\s\S]*?)\n    \}/)?.[1] || '';
  const viewfinderStyles = page.match(/\.viewfinder-container\s*\{([\s\S]*?)\n    \}/)?.[1] || '';
  const actionsStyles = page.match(/\.capture-actions\s*\{([\s\S]*?)\n    \}/)?.[1] || '';

  assert.match(bodyStyles, /overflow-y:\s*auto/);
  assert.match(bodyStyles, /100dvh/);
  assert.match(viewfinderStyles, /min-height:\s*14rem/);
  assert.match(viewfinderStyles, /flex-direction:\s*column/);
  assert.match(viewfinderStyles, /justify-content:\s*center/);
  assert.match(actionsStyles, /position:\s*relative/);
  assert.doesNotMatch(actionsStyles, /position:\s*fixed|position:\s*absolute/);
  assert.doesNotMatch(page, /\.camera-switch|position:\s*fixed[^}]*\.capture-actions/);
  assert.match(page, /env\(safe-area-inset-bottom\)/);
  assert.match(page, /min-height:\s*3\.25rem/);
});

test('the receiver page and every referenced browser asset are available over HTTP', async (context) => {
  const app = express();
  app.use('/mobile', express.static(path.join(__dirname, '..', 'public', 'mobile')));
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));

  const baseUrl = `http://127.0.0.1:${server.address().port}/mobile/`;
  const pageResponse = await fetch(baseUrl);
  assert.equal(pageResponse.status, 200);
  const canonicalResponse = await fetch(baseUrl.slice(0, -1));
  assert.equal(canonicalResponse.status, 200);
  assert.match(pageResponse.headers.get('content-type'), /text\/html/);
  const page = await pageResponse.text();
  const assetPaths = [...page.matchAll(/(?:src|href)="(?:\.\/)?([^"?#]+)"/g)]
    .map((match) => match[1])
    .filter((assetPath) => /\.(?:js|css)$/.test(assetPath));

  assert.ok(assetPaths.includes('mobile.js'));
  assert.ok(assetPaths.includes('auth-crypto.js'));
  assert.ok(assetPaths.includes('image-validation.js'));
  assert.ok(assetPaths.includes('reconnect-policy.js'));

  for (const assetPath of assetPaths) {
    const response = await fetch(new URL(assetPath, baseUrl));
    assert.equal(response.status, 200, assetPath);
    assert.match(response.headers.get('content-type'), /(?:javascript|css)/, assetPath);
    assert.ok((await response.text()).length > 0, assetPath);
  }
});
