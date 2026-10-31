(function initializeHostedPreview(global) {
  async function loadWithRetry(loader, {
    attempts = 3,
    timeoutMs = 5000,
    retryDelaysMs = [250, 1000],
    wait = (delay) => new Promise((resolve) => setTimeout(resolve, delay))
  } = {}) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let timeout;
      try {
        return await Promise.race([
          Promise.resolve().then(loader),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(Object.assign(new Error('Desktop config request timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
          })
        ]);
      } catch (error) {
        lastError = error;
        if (attempt + 1 < attempts) await wait(retryDelaysMs[attempt] ?? retryDelaysMs.at(-1) ?? 1000);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }

  function applyHostedPreviewState({ window, document, MutationObserver }) {
    // Electron is the only supported source of desktop pairing credentials.
    // A hosted page must never probe guessed LAN endpoints or invent a session.
    if (window.electronAPI) {
      const errorNotice = document.getElementById('desktop-config-error');
      let checking = false;
      const retryButton = document.getElementById('desktop-config-retry');

      const setLoadingError = () => {
        const paragraphs = [...document.querySelectorAll('p')];
        const loading = paragraphs.find((element) => element.textContent.trim() === 'Loading network profile...');
        if (loading) loading.textContent = 'Desktop connection profile unavailable';
        const detecting = [...document.querySelectorAll('.setting-value')]
          .find((element) => element.textContent.trim() === 'Detecting...');
        if (detecting) detecting.textContent = 'Unavailable';
      };

      const checkDesktop = async (manualRetry = false) => {
        if (checking) return;
        checking = true;
        if (retryButton) retryButton.disabled = true;
        try {
          await loadWithRetry(() => window.electronAPI.getServerConfig());
          if (errorNotice) errorNotice.hidden = true;
          if (manualRetry) window.location.reload();
        } catch (error) {
          console.warn('Desktop connection profile unavailable', {
            code: error?.code || error?.name || 'UNKNOWN'
          });
          if (errorNotice) errorNotice.hidden = false;
          setLoadingError();
        } finally {
          checking = false;
          if (retryButton) retryButton.disabled = false;
        }
      };

      retryButton?.addEventListener('click', () => checkDesktop(true));
      checkDesktop();
      return true;
    }

    const notice = document.getElementById('hosted-preview-notice');
    if (notice) notice.hidden = false;
    const setText = (element, text) => {
      if (element && element.textContent !== text) element.textContent = text;
    };

    const update = () => {
      const connectionStatus = document.querySelector('.status-badge span:last-child');
      setText(connectionStatus, 'Hosted preview — desktop connection unavailable');

      const endpointLabel = [...document.querySelectorAll('.setting-label')]
        .find((element) => element.textContent.trim() === 'Local Connection Endpoint');
      const endpoint = endpointLabel?.parentElement?.querySelector('.setting-value');
      setText(endpoint, 'Unavailable in hosted preview');

      const clientTypeLabel = [...document.querySelectorAll('.setting-label')]
        .find((element) => element.textContent.trim() === 'Client Type');
      const clientType = clientTypeLabel?.parentElement?.querySelector('.setting-value');
      setText(clientType, 'Desktop unavailable');

      const capturesLabel = [...document.querySelectorAll('.setting-label')]
        .find((element) => element.textContent.trim() === 'Captures Folder');
      const captures = capturesLabel?.parentElement?.querySelector('.setting-value');
      setText(captures, 'Available in desktop app only');

      const launchButton = [...document.querySelectorAll('button')]
        .find((element) => element.textContent.includes('Launch Web Receiver'));
      if (launchButton) launchButton.hidden = true;

      const connectionHeading = [...document.querySelectorAll('.sidebar-title')]
        .find((element) => element.textContent.trim() === 'Connection Hub');
      const placeholder = connectionHeading?.parentElement?.querySelector('.panel-card');
      if (placeholder && !placeholder.querySelector('.hosted-preview-state')) {
        placeholder.replaceChildren();
        const message = document.createElement('p');
        message.className = 'hosted-preview-state';
        message.setAttribute('role', 'status');
        message.textContent = 'Hosted preview — desktop connection unavailable. Open TETHER on the PC to pair devices and transfer images.';
        message.style.cssText = 'font-size:0.85rem;color:var(--text-muted);line-height:1.5;text-align:center;';
        placeholder.appendChild(message);
      }
    };

    update();
    if (MutationObserver) {
      const observer = new MutationObserver(update);
      observer.observe(document.getElementById('root') || document.documentElement, {
        childList: true,
        subtree: true
      });
    }
    return true;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { applyHostedPreviewState, loadWithRetry };
  } else {
    applyHostedPreviewState({
      window: global,
      document: global.document,
      MutationObserver: global.MutationObserver
    });
  }
})(typeof window === 'undefined' ? globalThis : window);
