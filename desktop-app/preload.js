
    const { contextBridge, ipcRenderer } = require('electron');

    function subscribe(channel, callback) {
      if (typeof callback !== 'function') {
        throw new TypeError('Event listener must be a function');
      }
      const listener = (_event, data) => callback(data);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    }

    contextBridge.exposeInMainWorld('electronAPI', Object.freeze({
      onClientConnected: (callback) => subscribe('client-connected', callback),
      onClientDisconnected: (callback) => subscribe('client-disconnected', callback),
      onClientStateChanged: (callback) => subscribe('client-state-changed', callback),
      onImageReceived: (callback) => subscribe('image-received', (data) => callback({
        ...data,
        base64: data.previewUrl
      })),
      getServerConfig: () => ipcRenderer.invoke('get-server-config'),
      exportLocalTrustCertificate: () => ipcRenderer.invoke('export-local-trust-certificate'),
      getConnectedClients: () => ipcRenderer.invoke('get-connected-clients'),
      selectDirectory: () => ipcRenderer.invoke('select-directory'),
      saveImage: (_imageData, filename) => ipcRenderer.invoke('save-image', { filename }),
      copyImage: (filename) => ipcRenderer.invoke('copy-image', { filename }),
      showInFolder: (filepath) => ipcRenderer.invoke('show-in-folder', filepath),
      openExternal: (url) => ipcRenderer.invoke('open-external', url)
    }));
