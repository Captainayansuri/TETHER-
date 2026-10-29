const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const imageValidation = require('../public/mobile/image-validation');
const reconnectPolicy = require('../public/mobile/reconnect-policy');
const authCrypto = require('../public/mobile/auth-crypto');

const mobileScript = fs.readFileSync(path.join(__dirname, '..', 'public', 'mobile', 'mobile.js'), 'utf8');
const elementIds = [
  'viewfinder', 'open-camera', 'choose-photo', 'status-dot', 'status-text', 'flash-overlay', 'toast',
  'capture-canvas', 'file-input', 'fallback-view',
  'fallback-title', 'fallback-text', 'transfer-progress',
  'transfer-progress-text', 'transfer-progress-bar'
];
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4, 5, 6, 7, 8]);

class FakeElement {
  constructor(id) {
    this.id = id;
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.files = [];
    this.children = { textContent: '' };
    this.lastChild = { textContent: '' };
    this.classNames = new Set();
    this.classList = {
      add: (value) => this.classNames.add(value),
      remove: (value) => this.classNames.delete(value),
      toggle: (value, force) => {
        const enabled = force === undefined ? !this.classNames.has(value) : force;
        if (enabled) this.classNames.add(value);
        else this.classNames.delete(value);
        return enabled;
      },
      contains: (value) => this.classNames.has(value)
    };
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  async emit(name, event = {}) {
    const results = await Promise.all((this.listeners.get(name) || []).map((listener) =>
      listener({ target: this, ...event })
    ));
    return results.at(-1);
  }

  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector() { return this.children; }
  click() { this.clicked = true; }
  pause() { this.paused = true; }
  async play() { this.playing = true; }
  getContext() { return { translate() {}, scale() {}, drawImage() {} }; }
  toBlob(callback, type) { callback(new Blob([JPEG], { type })); }
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(data) { this.sent.push(data); }
  close(code = 1000, reason = '') {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  receive(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

function createBrowser({ getUserMedia = async () => makeStream(), isSecureContext = true } = {}) {
  FakeWebSocket.instances = [];
  const elements = Object.fromEntries(elementIds.map((id) => [id, new FakeElement(id)]));
  elements['capture-canvas'].toBlob = (callback, type) => callback(new Blob([JPEG], { type }));
  elements.viewfinder.videoWidth = 1280;
  elements.viewfinder.videoHeight = 720;
  const windowListeners = new Map();
  const documentListeners = new Map();
  const window = {
    location: {
      hash: `#token=${'a'.repeat(64)}`,
      pathname: '/mobile/',
      search: '',
      protocol: 'http:',
      host: '127.0.0.1:8080'
    },
    isSecureContext,
    crypto: webcrypto,
    tetherImageValidation: imageValidation,
    tetherReconnectPolicy: reconnectPolicy,
    tetherAuthCrypto: authCrypto,
    addEventListener(name, listener) {
      const list = windowListeners.get(name) || [];
      list.push(listener);
      windowListeners.set(name, list);
    },
    dispose() {
      for (const listener of windowListeners.get('pagehide') || []) listener();
    }
  };
  const document = {
    visibilityState: 'visible',
    getElementById: (id) => elements[id] || new FakeElement(id),
    addEventListener(name, listener) {
      const list = documentListeners.get(name) || [];
      list.push(listener);
      documentListeners.set(name, list);
    }
  };
  const navigator = { onLine: true, mediaDevices: { getUserMedia } };
  const history = { replaceState() { window.historyReplaced = true; } };
  const context = vm.createContext({
    window, document, navigator, history,
    location: window.location,
    URLSearchParams,
    WebSocket: FakeWebSocket,
    Blob,
    Uint8Array,
    ArrayBuffer,
    DataView,
    TextEncoder,
    console: { ...console, warn() {}, error() {} },
    setTimeout,
    clearTimeout
  });
  vm.runInContext(mobileScript, context, { filename: 'mobile.js' });
  return {
    context, elements, window, document, navigator,
    windowListeners, documentListeners,
    socket: () => FakeWebSocket.instances.at(-1),
    sockets: () => FakeWebSocket.instances
  };
}

function makeStream() {
  const track = { stopped: false, stop() { this.stopped = true; } };
  return {
    track,
    getTracks: () => [track],
    getVideoTracks: () => [track]
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    // Give timers scheduled by reconnect policy a timer phase to run; setImmediate
    // polling alone can exhaust this loop before a zero-delay reconnect fires.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

function authenticate(socket) {
  socket.open();
  socket.receive({ type: 'challenge', nonce: 'b'.repeat(64) });
  assert.equal(JSON.parse(socket.sent[0]).type, 'authenticate');
  socket.receive({ type: 'paired', reconnectMaxIntervalMs: 1000, maxImageBytes: 1024 });
}

test('receiver requests a live camera, releases it when hidden, and reacquires it when visible', async (t) => {
  const streams = [];
  const browser = createBrowser({
    getUserMedia: async () => {
      const stream = makeStream();
      streams.push(stream);
      return stream;
    }
  });
  t.after(() => browser.window.dispose());
  await settle();
  assert.equal(streams.length, 1);
  assert.equal(browser.elements.viewfinder.srcObject, streams[0]);

  browser.document.visibilityState = 'hidden';
  for (const listener of browser.documentListeners.get('visibilitychange')) listener();
  assert.equal(streams[0].track.stopped, true);
  assert.equal(browser.elements.viewfinder.srcObject, null);

  browser.document.visibilityState = 'visible';
  for (const listener of browser.documentListeners.get('visibilitychange')) listener();
  await settle();
  assert.equal(streams.length, 2);
  assert.equal(browser.elements.viewfinder.srcObject, streams[1]);
});

test('camera permission denial keeps picker guidance without a live-camera retry control', async (t) => {
  const browser = createBrowser({
    getUserMedia: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); }
  });
  t.after(() => browser.window.dispose());
  await settle();
  assert.equal(browser.elements['fallback-title'].textContent, 'Camera permission denied');
  assert.match(browser.elements['fallback-text'].textContent, /Choose Photo/i);
  assert.doesNotMatch(mobileScript, /retry-camera|Try Live Camera|toggle-camera|Switch Camera/);
});

test('insecure LAN fallback opens the camera and photo picker separately', async (t) => {
  const browser = createBrowser({ isSecureContext: false });
  t.after(() => browser.window.dispose());
  await settle();

  assert.match(browser.elements['fallback-text'].textContent, /requires HTTPS or localhost/i);
  await browser.elements['open-camera'].emit('click');
  assert.equal(browser.elements['file-input'].attributes.get('capture'), 'environment');
  assert.equal(browser.elements['file-input'].clicked, true);

  await browser.elements['file-input'].emit('cancel');
  browser.elements['file-input'].clicked = false;
  await browser.elements['choose-photo'].emit('click');
  assert.equal(browser.elements['file-input'].attributes.has('capture'), false);
  assert.equal(browser.elements['file-input'].clicked, true);
});

test('a captured image is validated, chunked, and only cleared after persisted acknowledgement', async (t) => {
  const browser = createBrowser();
  t.after(() => browser.window.dispose());
  await settle();
  const socket = browser.socket();
  authenticate(socket);
  await browser.elements['open-camera'].emit('click');

  await waitFor(() => socket.sent.some((item) => typeof item === 'string' && JSON.parse(item).type === 'image_upload'),
    'receiver did not announce its image transfer');
  const request = JSON.parse(socket.sent.find((item) => typeof item === 'string' && JSON.parse(item).type === 'image_upload'));
  assert.equal(request.size, JPEG.length);
  assert.equal(request.imageType, 'jpeg');
  socket.receive({ type: 'upload_ready', captureId: request.captureId, chunkSize: 5 });

  let expectedOffset = 0;
  while (expectedOffset < JPEG.length) {
    await waitFor(() => socket.sent.some((item) => item instanceof ArrayBuffer), 'receiver did not send a data chunk');
    const chunk = socket.sent.find((item) => item instanceof ArrayBuffer);
    socket.sent.splice(socket.sent.indexOf(chunk), 1);
    const bytes = new Uint8Array(chunk);
    assert.deepEqual(Array.from(bytes), Array.from(JPEG.slice(expectedOffset, expectedOffset + bytes.length)));
    expectedOffset += bytes.length;
    socket.receive({ type: 'chunk_ack', captureId: request.captureId, nextOffset: expectedOffset });
    await settle();
  }

  assert.equal(browser.elements['transfer-progress'].hidden, false);
  socket.receive({
    type: 'image_ack',
    captureId: request.captureId,
    sha256: request.sha256,
    size: request.size,
    state: 'ACKNOWLEDGED',
    persisted: true
  });
  assert.equal(
    browser.elements['transfer-progress'].hidden,
    false,
    'an unauthenticated acknowledgement must not clear a queued capture'
  );
  const acknowledgement = {
    captureId: request.captureId,
    sha256: request.sha256,
    size: request.size,
    state: 'ACKNOWLEDGED',
    persisted: true
  };
  acknowledgement.proof = authCrypto.hmacSha256Hex(
    'a'.repeat(64),
    [acknowledgement.captureId, acknowledgement.sha256, String(acknowledgement.size),
      acknowledgement.state, String(acknowledgement.persisted)].join('\n')
  );
  socket.receive({ type: 'image_ack', ...acknowledgement });
  assert.equal(browser.elements['transfer-progress'].hidden, true);
  assert.match(browser.elements.toast.lastChild.textContent, /Transfer successful/);
  assert.equal(browser.elements['status-text'].dataset.connectionState, 'CONNECTED');
});

test('invalid file selection is rejected before any image upload reaches the desktop', async (t) => {
  const browser = createBrowser();
  t.after(() => browser.window.dispose());
  await settle();
  const socket = browser.socket();
  authenticate(socket);
  const before = socket.sent.length;
  browser.elements['file-input'].files = [new Blob(['not an image'], { type: 'image/jpeg' })];
  await browser.elements['file-input'].emit('change');
  await waitFor(() => browser.elements.toast.lastChild.textContent.length > 0,
    'receiver did not explain why the selected file was rejected');

  assert.equal(socket.sent.length, before);
  assert.match(browser.elements.toast.lastChild.textContent, /Only JPEG, PNG, and WebP/i);
});

test('network recovery reconnects and retries the same queued capture ID', async (t) => {
  const browser = createBrowser();
  t.after(() => browser.window.dispose());
  await settle();
  const firstSocket = browser.socket();
  authenticate(firstSocket);
  await browser.elements['open-camera'].emit('click');
  await waitFor(() => firstSocket.sent.some((item) => typeof item === 'string' && JSON.parse(item).type === 'image_upload'),
    'initial transfer was not queued');
  const originalRequest = JSON.parse(firstSocket.sent.find((item) => typeof item === 'string' && JSON.parse(item).type === 'image_upload'));

  browser.navigator.onLine = false;
  for (const listener of browser.windowListeners.get('offline')) listener();
  browser.navigator.onLine = true;
  for (const listener of browser.windowListeners.get('online')) listener();
  await waitFor(() => browser.sockets().length > 1, 'receiver did not reconnect after network recovery');
  const secondSocket = browser.socket();
  authenticate(secondSocket);
  await waitFor(() => secondSocket.sent.some((item) => typeof item === 'string' && JSON.parse(item).type === 'image_upload'),
    'queued image was not retried after reconnect');
  const retry = JSON.parse(secondSocket.sent.find((item) => typeof item === 'string' && JSON.parse(item).type === 'image_upload'));
  assert.equal(retry.captureId, originalRequest.captureId);
  assert.equal(retry.sha256, originalRequest.sha256);
});
