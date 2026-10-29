(() => {
  let updating = false;
  let clientEventsSubscribed = false;
  let connectionPanel = null;
  let disposed = false;
  let imageUpdateFrame = null;
  let imageObserver;
  let cardObserver;
  let refreshTimer;
  const clients = new Map();
  const clientEventRevision = new Map();
  const eventUnsubscribers = [];

  function formatTime(timestamp) {
    if (!Number.isFinite(timestamp)) return 'Unknown';
    return new Date(timestamp).toLocaleTimeString();
  }

  function renderClientList() {
    if (!connectionPanel) return;
    for (const [id, record] of clients) {
      if (record.state === 'DISCONNECTED' &&
          Number.isFinite(record.disconnectedAt) &&
          Date.now() - record.disconnectedAt > 5 * 60 * 1000) {
        clients.delete(id);
        clientEventRevision.delete(id);
      }
    }

    const list = connectionPanel.querySelector('.connected-device-list');
    list.replaceChildren();
    const records = [...clients.values()].sort((left, right) => {
      const leftConnected = left.state !== 'DISCONNECTED';
      const rightConnected = right.state !== 'DISCONNECTED';
      return Number(rightConnected) - Number(leftConnected) ||
        (right.connectedAt || 0) - (left.connectedAt || 0);
    });

    if (records.length === 0) {
      const empty = document.createElement('li');
      empty.textContent = 'No devices have connected yet.';
      empty.style.cssText = 'padding:0.75rem;color:var(--text-muted);list-style:none;';
      list.appendChild(empty);
      return;
    }

    for (const client of records) {
      const item = document.createElement('li');
      item.style.cssText = 'display:grid;grid-template-columns:1fr auto;gap:0.25rem 1rem;padding:0.75rem;border-top:1px solid rgba(255,255,255,0.08);list-style:none;';
      const identity = document.createElement('strong');
      identity.textContent = `${client.name} · ${client.platform}`;
      const state = document.createElement('span');
      state.textContent = client.state;
      state.style.cssText = client.state === 'CONNECTED' || client.state === 'TRANSFERRING'
        ? 'color:#34d399;font-size:0.75rem;'
        : 'color:#f87171;font-size:0.75rem;';
      const details = document.createElement('small');
      details.textContent = `Connected ${formatTime(client.connectedAt)} · Last activity ${formatTime(client.lastActivityAt)}`;
      details.style.cssText = 'grid-column:1 / -1;color:var(--text-muted);';
      item.title = `Client ${client.id}`;
      item.append(identity, state, details);
      list.appendChild(item);
    }
  }

  function updateClient(client, eventName) {
    if (!client || typeof client.id !== 'string') return;
    clientEventRevision.set(client.id, (clientEventRevision.get(client.id) || 0) + 1);
    if (eventName === 'client-disconnected') {
      clients.set(client.id, { ...clients.get(client.id), ...client, state: 'DISCONNECTED' });
    } else {
      clients.set(client.id, { ...clients.get(client.id), ...client });
    }
    if (clients.size > 100) {
      const disconnected = [...clients.values()]
        .filter((record) => record.state === 'DISCONNECTED')
        .sort((left, right) => (left.disconnectedAt || 0) - (right.disconnectedAt || 0));
      while (clients.size > 100 && disconnected.length > 0) {
        const oldest = disconnected.shift();
        clients.delete(oldest.id);
        clientEventRevision.delete(oldest.id);
      }
    }
    renderClientList();
  }

  function ensureConnectionPanel(card) {
    if (connectionPanel && connectionPanel.isConnected) return;
    const panel = document.createElement('section');
    panel.className = 'connected-device-panel';
    panel.setAttribute('aria-live', 'polite');
    panel.style.cssText = 'margin-top:1rem;border:1px solid rgba(255,255,255,0.12);border-radius:0.75rem;overflow:hidden;';
    const heading = document.createElement('h3');
    heading.textContent = 'Connected devices';
    heading.style.cssText = 'padding:0.75rem;margin:0;font-size:0.9rem;';
    const list = document.createElement('ul');
    list.className = 'connected-device-list';
    list.style.cssText = 'padding:0;margin:0;';
    panel.append(heading, list);
    card.insertAdjacentElement('afterend', panel);
    connectionPanel = panel;
    renderClientList();
  }

  function subscribeToClientEvents() {
    if (clientEventsSubscribed || !window.electronAPI) return;
    clientEventsSubscribed = true;
    eventUnsubscribers.push(
      window.electronAPI.onClientConnected((client) => updateClient(client, 'client-connected')),
      window.electronAPI.onClientDisconnected((client) => updateClient(client, 'client-disconnected')),
      window.electronAPI.onClientStateChanged((client) => updateClient(client, 'client-state-changed'))
    );
    const revisionsBeforeSnapshot = new Map(clientEventRevision);
    window.electronAPI.getConnectedClients().then((snapshot) => {
      if (disposed) return;
      for (const client of snapshot) {
        if ((clientEventRevision.get(client.id) || 0) === (revisionsBeforeSnapshot.get(client.id) || 0) &&
            !clients.has(client.id)) {
          clients.set(client.id, client);
        }
      }
      renderClientList();
    }).catch((error) => {
      console.error('Could not load connected client snapshot:', error);
    });
  }

  function optimizeImageLoading(root = document) {
    const elements = [];
    if (root instanceof Element && root.matches('img, .gallery-item')) elements.push(root);
    elements.push(...root.querySelectorAll('img, .gallery-item'));
    for (const element of elements) {
      if (element.classList.contains('gallery-item')) {
        element.style.contentVisibility = 'auto';
        element.style.containIntrinsicSize = '140px 100px';
      }
      if (element.tagName !== 'IMG') continue;
      if (element.classList.contains('gallery-thumb')) {
        element.loading = 'lazy';
        element.decoding = 'async';
      }
      if (element.classList.contains('active-photo')) {
        element.decoding = 'async';
        try {
          const imageUrl = new URL(element.getAttribute('src'), window.location.href);
          if (imageUrl.pathname.startsWith('/_desktop/captures/') &&
              imageUrl.searchParams.get('variant') === 'thumbnail') {
            imageUrl.searchParams.set('variant', 'full');
            element.src = imageUrl.href;
          }
        } catch {
          // Ignore non-URL or invalid image sources from the renderer.
        }
      }
    }
  }

  function scheduleImageOptimization() {
    if (disposed || imageUpdateFrame !== null) return;
    imageUpdateFrame = window.requestAnimationFrame(() => {
      imageUpdateFrame = null;
      optimizeImageLoading();
    });
  }

  function cleanup() {
    if (disposed) return;
    disposed = true;
    if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
    if (imageUpdateFrame !== null) window.cancelAnimationFrame(imageUpdateFrame);
    imageObserver?.disconnect();
    cardObserver?.disconnect();
    for (const unsubscribe of eventUnsubscribers.splice(0)) {
      if (typeof unsubscribe === 'function') unsubscribe();
    }
    clients.clear();
    clientEventRevision.clear();
  }

  async function updatePairingCard() {
    if (disposed) return;
    const card = document.querySelector('.pairing-card');
    if (!card || !window.electronAPI || updating) return;

    subscribeToClientEvents();
    ensureConnectionPanel(card);
    updating = true;
    try {
      const config = await window.electronAPI.getServerConfig();
      if (disposed) return;
      card.querySelector('.pairing-auth-error')?.remove();
      const qrCode = card.querySelector('.qr-image');
      if (qrCode && qrCode.src !== config.qrCode) qrCode.src = config.qrCode;
      const instructions = card.querySelectorAll('p');
      if (instructions.length > 0) {
        instructions[0].textContent = 'Browser: scan QR; Android app: enter token';
      }

      let details = card.querySelector('.pairing-auth-details');
      if (!details) {
        details = document.createElement('div');
        details.className = 'pairing-auth-details';
        details.style.cssText = 'margin-top:0.5rem;font-size:0.75rem;color:var(--text-muted);';

        const label = document.createElement('p');
        label.textContent = 'Android app pairing token';
        details.appendChild(label);

        const token = document.createElement('code');
        token.className = 'pairing-auth-token';
        token.style.cssText = 'display:block;margin-top:0.25rem;color:var(--text-color);overflow-wrap:anywhere;user-select:text;';
        details.appendChild(token);

        const expiry = document.createElement('p');
        expiry.className = 'pairing-auth-expiry';
        expiry.style.marginTop = '0.25rem';
        details.appendChild(expiry);
        card.appendChild(details);
      }

      details.querySelector('.pairing-auth-token').textContent = config.pairingToken;
      details.querySelector('.pairing-auth-expiry').textContent =
        `Expires ${new Date(config.pairingTokenExpiresAt).toLocaleTimeString()}`;
    } catch {
      let error = card.querySelector('.pairing-auth-error');
      if (!error) {
        error = document.createElement('p');
        error.className = 'pairing-auth-error';
        error.style.color = 'var(--danger-color)';
        card.appendChild(error);
      }
      error.textContent = 'Pairing credentials are unavailable. Restart the desktop app.';
    } finally {
      updating = false;
    }
  }

  let currentCard = null;
  cardObserver = new MutationObserver(() => {
    const card = document.querySelector('.pairing-card');
    if (card && card !== currentCard) {
      currentCard = card;
      updatePairingCard();
    }
  });
  cardObserver.observe(document.documentElement, { childList: true, subtree: true });
  imageObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        scheduleImageOptimization();
      } else {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) {
            scheduleImageOptimization();
            break;
          }
        }
      }
    }
  });
  imageObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src']
  });
  optimizeImageLoading();
  refreshTimer = window.setInterval(() => {
    renderClientList();
    updatePairingCard();
  }, 60000);
  window.addEventListener('pagehide', cleanup, { once: true });
  updatePairingCard();
})();
