const test = require('node:test');
const assert = require('node:assert/strict');
const { applyHostedPreviewState, loadWithRetry } = require('../public/hosted-preview');

function element(textContent = '') {
  return {
    textContent,
    hidden: false,
    style: {},
    attributes: {},
    children: [],
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener() {},
    querySelector(selector) {
      if (selector === '.setting-value') return this.value;
      if (selector === '.panel-card') return this.card;
      if (selector === '.hosted-preview-state') return this.children.find((child) => child.className === 'hosted-preview-state') || null;
      return null;
    },
    replaceChildren(...children) { this.children = children; },
    appendChild(child) { this.children.push(child); }
  };
}

function previewDocument() {
  const notice = element();
  notice.hidden = true;
  const status = element('Waiting for connection');
  const rows = ['Local Connection Endpoint', 'Client Type', 'Captures Folder'].map((label) => {
    const value = element(label === 'Local Connection Endpoint' ? 'Detecting...' : 'Loading...');
    const row = element();
    row.value = value;
    const labelElement = element(label);
    labelElement.parentElement = row;
    return { label: labelElement, row, value };
  });
  const launch = element('Launch Web Receiver');
  const card = element();
  const connectionHeading = element('Connection Hub');
  const connectionContainer = element();
  connectionContainer.card = card;
  connectionHeading.parentElement = connectionContainer;
  const elements = {
    '.status-badge span:last-child': [status],
    '.setting-label': rows.map((row) => row.label),
    'button': [launch],
    '.sidebar-title': [connectionHeading]
  };
  return {
    notice, status, rows, launch, card,
    document: {
      documentElement: element(),
      getElementById(id) { return id === 'hosted-preview-notice' ? notice : element(); },
      querySelectorAll(selector) { return elements[selector] || []; },
      querySelector(selector) { return elements[selector]?.[0] || null; },
      createElement() { return element(); }
    }
  };
}

test('Electron mode reads the current config through its trusted IPC bridge', async () => {
  const state = previewDocument();
  let configCalls = 0;
  assert.equal(applyHostedPreviewState({
    window: { electronAPI: { getServerConfig() {
      configCalls += 1;
      return Promise.resolve({ ip: '192.168.1.2', port: 8080, mobileAddress: 'https://192.168.1.2:8080/mobile/', qrCode: 'data:image/png;base64,local-only' });
    } } },
    document: state.document,
    MutationObserver: class { constructor() { throw new Error('observer should not be created'); } }
  }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(configCalls, 1);
  assert.equal(state.notice.hidden, true);
  assert.equal(state.rows[0].value.textContent, 'Detecting...');
});

test('hosted mode clearly disables pairing affordances and never invents a QR/session', () => {
  const state = previewDocument();
  let observed;
  assert.equal(applyHostedPreviewState({
    window: {},
    document: state.document,
    MutationObserver: class {
      constructor(callback) { observed = callback; }
      observe() {}
    }
  }), true);
  assert.equal(state.notice.hidden, false);
  assert.equal(state.status.textContent, 'Hosted preview — desktop connection unavailable');
  assert.equal(state.rows[0].value.textContent, 'Unavailable in hosted preview');
  assert.equal(state.rows[1].value.textContent, 'Desktop unavailable');
  assert.equal(state.rows[2].value.textContent, 'Available in desktop app only');
  assert.equal(state.launch.hidden, true);
  assert.match(state.card.children[0].textContent, /pair devices and transfer images/i);
  observed();
  assert.equal(state.card.children.length, 1, 'rerenders do not duplicate the hosted state message');
});

test('desktop configuration retries are bounded and recover on a later attempt', async () => {
  let calls = 0;
  const result = await loadWithRetry(async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('temporary'), { code: 'EAGAIN' });
    return { ip: '192.168.1.2', port: 8080, qrCode: 'data:image/png;base64,not-inspected' };
  }, { retryDelaysMs: [], wait: async () => {} });
  assert.equal(calls, 3);
  assert.equal(result.port, 8080);
});

test('desktop configuration timeout and failures stop after the configured attempts', async () => {
  let calls = 0;
  await assert.rejects(loadWithRetry(() => {
    calls += 1;
    return new Promise(() => {});
  }, { attempts: 2, timeoutMs: 5, retryDelaysMs: [], wait: async () => {} }), /timed out/);
  assert.equal(calls, 2);
});
