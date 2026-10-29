// DOM Elements
const viewfinder = document.getElementById('viewfinder');
const openCameraBtn = document.getElementById('open-camera');
const choosePhotoBtn = document.getElementById('choose-photo');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const flashOverlay = document.getElementById('flash-overlay');
const toast = document.getElementById('toast');
const canvas = document.getElementById('capture-canvas');
const fileInput = document.getElementById('file-input');
const fallbackView = document.getElementById('fallback-view');
const fallbackTitle = document.getElementById('fallback-title');
const fallbackText = document.getElementById('fallback-text');
const transferProgress = document.getElementById('transfer-progress');
const transferProgressText = document.getElementById('transfer-progress-text');
const transferProgressBar = document.getElementById('transfer-progress-bar');

let ws = null;
let stream = null;
let currentFacingMode = 'environment';
let isCapturing = false;
let cameraRequestId = 0;
let cameraShouldResume = true;
let cameraPermissionDenied = false;
let authenticated = false;
let authenticationFailed = false;
let maxImageBytes = window.tetherImageValidation.DEFAULT_MAX_IMAGE_BYTES;
let pendingTransfer = null;
let transferSending = false;
let transferAckTimeout = null;
let reconnectTimer = null;
let socketGeneration = 0;
let reconnectMaxIntervalMs = window.tetherReconnectPolicy.DEFAULT_MAX_INTERVAL_MS;
let reconnectBackoff = window.tetherReconnectPolicy.createReconnectBackoff({
  maxIntervalMs: reconnectMaxIntervalMs
});
let connectionState = 'DISCONNECTED';
let toastTimer = null;
let flashTimer = null;
let pickerFocusTimer = null;
let audioContext = null;
const pairingToken = new URLSearchParams(window.location.hash.slice(1)).get('token');
const MAX_SUPPORTED_IMAGE_BYTES = 128 * 1024 * 1024;
const MAX_IMAGE_CHUNK_BYTES = 1024 * 1024;

// Keep the pairing credential out of the request URL and subsequent browser history.
if (window.location.hash) {
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

// Determine WebSocket address dynamically
// TETHER serves this page over HTTPS and connects its receiver using WSS.
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsHost = window.location.host;
const wsUrl = `${wsProtocol}//${wsHost}`;

// Initialize WebSocket
function setConnectionState(state, detail = '') {
  connectionState = state;
  statusDot.classList.toggle('connected', state === 'CONNECTED' || state === 'TRANSFERRING');
  const descriptions = {
    DISCONNECTED: 'Offline',
    CONNECTING: 'Connecting to Desktop...',
    AUTHENTICATING: 'Authenticating with Desktop...',
    CONNECTED: 'Ready to Send',
    TRANSFERRING: 'Uploading image...',
    RECONNECTING: 'Reconnecting...',
    ERROR: 'Connection error'
  };
  statusText.textContent = detail || descriptions[state] || state;
  statusText.dataset.connectionState = state;
}

function setTransferProgress(message = '', percent = null) {
  if (!message) {
    transferProgress.hidden = true;
    transferProgressBar.removeAttribute('value');
    return;
  }
  transferProgress.hidden = false;
  transferProgressText.textContent = message;
  if (percent === null) transferProgressBar.removeAttribute('value');
  else transferProgressBar.value = Math.max(0, Math.min(100, percent));
}

function scheduleReconnect(immediate = false) {
  if (authenticationFailed) return;
  if (immediate && reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (reconnectTimer !== null) return;
  if (navigator.onLine === false) {
    setConnectionState('DISCONNECTED', 'Network unavailable');
    return;
  }
  setConnectionState('RECONNECTING');
  const delay = immediate ? 0 : reconnectBackoff.nextDelay();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delay);
}

function connectWebSocket() {
  if (authenticationFailed) return;
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  if (typeof WebSocket !== 'function') {
    setConnectionState('ERROR', 'This browser does not support WebSocket connections.');
    return;
  }
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (!pairingToken || !/^[a-f0-9]{64}$/i.test(pairingToken)) {
    authenticationFailed = true;
    setConnectionState('ERROR', 'Pairing failed: scan the current dashboard QR code.');
    return;
  }

  setConnectionState('CONNECTING');
  const generation = ++socketGeneration;
  let socket;
  try {
    socket = new WebSocket(wsUrl);
  } catch {
    setConnectionState('RECONNECTING');
    scheduleReconnect();
    return;
  }
  ws = socket;
  socket.binaryType = 'arraybuffer';

  socket.onopen = () => {
    if (generation !== socketGeneration) return;
    setConnectionState('AUTHENTICATING');
  };

  socket.onmessage = (event) => {
    if (generation !== socketGeneration) return;
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'challenge') {
        if (!/^[a-f0-9]{64}$/i.test(data.nonce || '')) {
          failAuthentication('Pairing failed: invalid desktop challenge.');
          return;
        }
        setConnectionState('AUTHENTICATING');
        socket.send(JSON.stringify({
          type: 'authenticate',
          proof: window.tetherAuthCrypto.hmacSha256Hex(pairingToken, data.nonce)
        }));
      } else if (data.type === 'paired') {
        authenticated = true;
        reconnectMaxIntervalMs = window.tetherReconnectPolicy.parseMaxInterval(
          data.reconnectMaxIntervalMs
        );
        reconnectBackoff = window.tetherReconnectPolicy.createReconnectBackoff({
          maxIntervalMs: reconnectMaxIntervalMs
        });
        reconnectBackoff.reset();
        if (Number.isSafeInteger(data.maxImageBytes) &&
            data.maxImageBytes > 0 &&
            data.maxImageBytes <= MAX_SUPPORTED_IMAGE_BYTES) {
          maxImageBytes = data.maxImageBytes;
        }
        setConnectionState('CONNECTED');
        startPendingTransfer();
      } else if (data.type === 'upload_ready') {
        if (!pendingTransfer || data.captureId !== pendingTransfer.captureId || transferSending) return;
        const serverChunkSize = data.chunkSize;
        if (!Number.isSafeInteger(serverChunkSize) ||
            serverChunkSize < 1 ||
            serverChunkSize > MAX_IMAGE_CHUNK_BYTES) {
          failTransferConnection('Desktop returned an invalid image chunk size.');
          return;
        }
        pendingTransfer.chunkSize = serverChunkSize;
        pendingTransfer.nextOffset = 0;
        pendingTransfer.state = 'UPLOADING';
        setConnectionState('TRANSFERRING');
        setTransferProgress('Uploading image...', 0);
        scheduleTransferTimeout();
        sendNextImageChunk();
      } else if (data.type === 'queue_status') {
        if (!pendingTransfer || data.captureId !== pendingTransfer.captureId) return;
        pendingTransfer.state = data.state;
        if (data.state === 'QUEUED') {
          clearTimeout(transferAckTimeout);
          transferAckTimeout = null;
          setConnectionState('TRANSFERRING', `Queued for transfer (${data.position}/${data.maxQueued})`);
          setTransferProgress(`Queued for transfer (${data.position}/${data.maxQueued})`);
        } else if (data.state === 'STARTING') {
          scheduleTransferTimeout();
          setConnectionState('TRANSFERRING', 'Desktop preparing image transfer...');
          setTransferProgress('Desktop preparing image transfer...');
        }
      } else if (data.type === 'chunk_ack') {
        if (!pendingTransfer || data.captureId !== pendingTransfer.captureId) return;
        const expectedOffset = Math.min(
          pendingTransfer.nextOffset + pendingTransfer.chunkSize,
          pendingTransfer.blob.size
        );
        if (data.nextOffset !== expectedOffset) {
          failTransferConnection('Desktop returned an invalid image transfer acknowledgement.');
          return;
        }
        pendingTransfer.nextOffset = expectedOffset;
        transferSending = false;
        const percent = Math.floor(expectedOffset / pendingTransfer.blob.size * 100);
        setTransferProgress(
          percent >= 100 ? 'Image uploaded; waiting for desktop save confirmation...' : `Uploading image · ${percent}%`,
          percent
        );
        scheduleTransferTimeout();
        sendNextImageChunk();
      } else if (data.type === 'transfer_status') {
        if (pendingTransfer && data.captureId === pendingTransfer.captureId) {
          pendingTransfer.state = data.state;
          if (data.state === 'SERVER_RECEIVED' || data.state === 'FILE_VALIDATED') {
            transferSending = false;
            scheduleTransferTimeout();
          }
        }
      } else if (data.type === 'image_ack') {
        const acknowledgementPayload = [
          data.captureId,
          data.sha256,
          String(data.size),
          data.state,
          String(data.persisted)
        ].join('\n');
        const expectedProof = window.tetherAuthCrypto.hmacSha256Hex(
          pairingToken,
          acknowledgementPayload
        );
        if (pendingTransfer &&
            data.captureId === pendingTransfer.captureId &&
            data.state === 'ACKNOWLEDGED' &&
            data.persisted === true &&
            data.sha256 === pendingTransfer.sha256 &&
            data.size === pendingTransfer.blob.size &&
            typeof data.proof === 'string' &&
            data.proof === expectedProof) {
          pendingTransfer.state = 'ACKNOWLEDGED';
          pendingTransfer = null;
          transferSending = false;
          clearTimeout(transferAckTimeout);
          transferAckTimeout = null;
          setTransferProgress('');
          setConnectionState('CONNECTED');
          showToast('Transfer successful');
        }
      } else if (data.type === 'upload_error') {
        if (!pendingTransfer || data.captureId !== pendingTransfer.captureId) {
          showToast(data.message || 'Image transfer failed.', true);
        } else if (data.retryable) {
          pendingTransfer.state = 'PENDING';
          transferSending = false;
          clearTimeout(transferAckTimeout);
          transferAckTimeout = null;
          setTransferProgress('Transfer pending · reconnecting to retry safely');
          showToast(data.message || 'Transfer pending. Reconnecting...', true);
          socket.close(1011, 'Retry image transfer');
        } else {
          pendingTransfer = null;
          transferSending = false;
          clearTimeout(transferAckTimeout);
          transferAckTimeout = null;
          setTransferProgress('');
          showToast(data.message || 'Image transfer failed.', true);
          setConnectionState('CONNECTED');
        }
      } else if (data.type === 'auth_error') {
        const reason = data.code === 'TOKEN_EXPIRED'
          ? 'pairing token expired'
          : 'token rejected';
        failAuthentication(`Pairing failed: ${reason}. Scan the current dashboard QR code.`);
      } else if (authenticated && data.status === 'error') {
        showToast(data.message || 'Image upload failed.', true);
      }
    } catch {
      failAuthentication('Pairing failed: authentication could not be completed.');
    }
  };

  socket.onclose = (event) => {
    if (generation !== socketGeneration) return;
    if (ws === socket) ws = null;
    authenticated = false;
    transferSending = false;
    clearTimeout(transferAckTimeout);
    transferAckTimeout = null;
    if (pendingTransfer) pendingTransfer.state = 'PENDING';
    if (pendingTransfer) {
      setTransferProgress(
        `Transfer pending · ${Math.floor((pendingTransfer.nextOffset || 0) / pendingTransfer.blob.size * 100)}% sent`
      );
    }
    if (authenticationFailed) {
      setConnectionState('ERROR', statusText.textContent);
      return;
    }
    if (event.code === 1009) {
      const message = 'Image exceeds the desktop size limit. Choose a smaller image.';
      setConnectionState('ERROR', message);
      showToast(message, true);
    } else {
      scheduleReconnect();
    }
  };

  socket.onerror = () => {
    if (generation === socketGeneration) setConnectionState('RECONNECTING');
  };
}

function failAuthentication(message) {
  authenticationFailed = true;
  authenticated = false;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  setConnectionState('ERROR', message);
  if (ws && ws.readyState < WebSocket.CLOSING) {
    ws.close(1008, 'Authentication failed');
  }
}

function cameraErrorMessage(error) {
  switch (error && error.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return {
        title: 'Camera permission denied',
        message: 'Allow camera access in your browser site settings to use the live preview. Open Camera or Choose Photo to continue.'
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return {
        title: 'No camera available',
        message: 'This device has no available camera. Use Open Camera to launch the camera picker or Choose Photo to select an image.'
      };
    case 'NotReadableError':
    case 'TrackStartError':
      return {
        title: 'Camera is unavailable',
        message: 'The camera may be in use by another app. Close other camera apps and retry, or choose a photo.'
      };
    case 'OverconstrainedError':
      return {
        title: 'Camera mode unavailable',
        message: 'This camera mode is unavailable. Use Open Camera or Choose Photo instead.'
      };
    case 'SecurityError':
      return {
        title: 'Secure connection required',
        message: 'Browser live camera access requires HTTPS or localhost. Use Open Camera or Choose Photo below on this local connection.'
      };
    default:
      return {
        title: 'Live camera unavailable',
        message: 'The browser could not start the camera. Check browser permissions or choose a photo instead.'
      };
  }
}

function showCameraFallback(title, message) {
  fallbackTitle.textContent = title;
  fallbackText.textContent = message;
  fallbackView.style.display = 'flex';
}

function releaseCameraStream() {
  if (stream) {
    stream.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    stream = null;
  }
  viewfinder.pause();
  viewfinder.srcObject = null;
}

function cameraApiAvailable() {
  return window.isSecureContext !== false &&
    Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

async function startCamera() {
  const requestId = ++cameraRequestId;
  cameraShouldResume = true;
  cameraPermissionDenied = false;
  releaseCameraStream();

  if (!cameraApiAvailable()) {
    cameraShouldResume = false;
    const secureContextUnavailable = window.isSecureContext === false;
    showCameraFallback(
      secureContextUnavailable ? 'Secure connection required' : 'Live camera unsupported',
      secureContextUnavailable
        ? 'Browser live camera access requires HTTPS or localhost. Use Open Camera or Choose Photo below on this local connection.'
        : 'This browser does not support live camera access. Use Open Camera or Choose Photo below instead.',
    );
    return false;
  }

  try {
    const nextStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { exact: currentFacingMode },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    });
    if (requestId !== cameraRequestId || document.visibilityState === 'hidden') {
      nextStream.getTracks().forEach((track) => track.stop());
      return false;
    }

    stream = nextStream;
    viewfinder.srcObject = nextStream;
    await viewfinder.play();
    if (requestId !== cameraRequestId) {
      nextStream.getTracks().forEach((track) => track.stop());
      if (stream === nextStream) releaseCameraStream();
      return false;
    }
    nextStream.getVideoTracks().forEach((track) => {
      track.onended = () => {
        if (requestId !== cameraRequestId) return;
        releaseCameraStream();
        cameraShouldResume = false;
        showCameraFallback(
          'Camera disconnected',
          'The camera stopped unexpectedly. Retry live camera access or choose a photo.'
        );
      };
    });
    fallbackView.style.display = 'none';
    return true;
  } catch (error) {
    if (requestId !== cameraRequestId) return false;
    releaseCameraStream();
    const cameraError = cameraErrorMessage(error);
    cameraPermissionDenied = cameraError.title === 'Camera permission denied';
    cameraShouldResume = false;
    console.warn('Could not start the live camera:', error && error.name || 'unknown error');
    showCameraFallback(cameraError.title, cameraError.message);
    return false;
  }
}

// Visual screen flash effect on capture
function triggerFlash() {
  flashOverlay.classList.add('flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashOverlay.classList.remove('flash');
  }, 100);

  // Play snap audio
  try {
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (AudioContextConstructor) {
      const contextForSound = new AudioContextConstructor();
      audioContext = contextForSound;
      const osc = contextForSound.createOscillator();
      const gain = contextForSound.createGain();
      osc.connect(gain);
      gain.connect(contextForSound.destination);

      gain.gain.setValueAtTime(0.5, contextForSound.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, contextForSound.currentTime + 0.1);
      osc.frequency.setValueAtTime(800, contextForSound.currentTime);
      osc.frequency.exponentialRampToValueAtTime(150, contextForSound.currentTime + 0.1);

      osc.start();
      osc.onended = () => {
        if (audioContext === contextForSound) audioContext = null;
        contextForSound.close().catch((error) => {
          console.warn('Could not close shutter audio context:', error && error.name || 'unknown error');
        });
      };
      osc.stop(contextForSound.currentTime + 0.1);
    }
  } catch (error) {
    console.warn('Shutter sound is unavailable:', error && error.name || 'unknown error');
  }

  // Mobile vibration
  if (navigator.vibrate) {
    navigator.vibrate(60);
  }
}

// Display receipt toast
function showToast(message = 'Sent Instantly', isError = false) {
  clearTimeout(toastTimer);
  toast.classList.toggle('error', isError);
  toast.querySelector('span').textContent = isError ? '!' : '✓';
  toast.lastChild.textContent = ` ${message}`;
  toast.classList.add('show');
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, isError ? 5000 : 2500);
}

// Capture frame and send over WS
async function capturePhoto() {
  if (pendingTransfer) {
    showToast('An image is already queued. Wait for it to finish.', true);
    return;
  }
  if (isCapturing) {
    showToast('A photo is already being prepared. Please wait.', true);
    return;
  }
  if (!authenticated || !ws || ws.readyState !== WebSocket.OPEN) {
    if (!authenticated) {
      showToast('Pair with the desktop before sending a photo.', true);
    }
    return;
  }

  isCapturing = true;
  openCameraBtn.classList.add('sending');

  triggerFlash();

  try {
    // Check if live camera is working, otherwise prompt fallback picker
    if (stream && viewfinder.videoWidth > 0) {
      const videoWidth = viewfinder.videoWidth;
      const videoHeight = viewfinder.videoHeight;
      
      canvas.width = videoWidth;
      canvas.height = videoHeight;
      
      const ctx = canvas.getContext('2d');
      // If user camera (front camera), flip horizontally to look natural
      if (currentFacingMode === 'user') {
        ctx.translate(videoWidth, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(viewfinder, 0, 0, videoWidth, videoHeight);

      // Convert to binary jpeg blob
      canvas.toBlob((blob) => {
        if (blob) {
          sendBlob(blob);
        } else {
          console.error('Could not encode the camera frame as an image blob.');
          showToast('Photo could not be encoded. Please try again.', true);
          resetCaptureAction();
        }
      }, 'image/jpeg', 0.95);
    } else {
      openFilePicker(true, true);
    }
  } catch (err) {
    console.error('Capture failed:', err && err.name || 'unknown error');
    showToast('Camera capture failed. Check camera permission or choose a photo.', true);
    resetCaptureAction();
  }
}

// Send Blob over WebSocket
async function sendBlob(blob) {
  let reservedTransfer = null;
  try {
    if (!isCapturing) {
      if (pendingTransfer) {
        showToast('Another image is still transferring.', true);
        return;
      }
      isCapturing = true;
      openCameraBtn.classList.add('sending');
    }
    if (pendingTransfer) {
      showToast('Another image is still transferring.', true);
      return;
    }
    const validation = await window.tetherImageValidation.validateBlob(blob, maxImageBytes);
    if (!validation.valid) {
      showToast(validation.message, true);
      return;
    }
    reservedTransfer = {
      captureId: createCaptureId(),
      blob,
      imageType: validation.type,
      sha256: null,
      state: 'PREPARING',
      nextOffset: 0,
      chunkSize: 0
    };
    pendingTransfer = reservedTransfer;
    setTransferProgress('Preparing image for secure transfer...');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (pendingTransfer !== reservedTransfer) return;
    reservedTransfer.sha256 = window.tetherAuthCrypto.sha256Hex(bytes);
    reservedTransfer.state = 'QUEUED';
    if (authenticated && ws && ws.readyState === WebSocket.OPEN) {
      startPendingTransfer();
    } else {
      reservedTransfer.state = 'PENDING';
      setTransferProgress('Image ready · waiting for desktop connection');
    }
  } catch (err) {
    if (pendingTransfer === reservedTransfer) pendingTransfer = null;
    transferSending = false;
    console.error('Image preparation failed:', err && err.name || 'unknown error');
    showToast('Image could not be prepared for transfer.', true);
    setTransferProgress('');
  } finally {
    resetCaptureAction();
  }
}

function createCaptureId() {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function startPendingTransfer() {
  if (!authenticated || !pendingTransfer || !pendingTransfer.sha256 ||
      !ws || ws.readyState !== WebSocket.OPEN) return;
  pendingTransfer.state = 'QUEUED';
  setConnectionState('TRANSFERRING');
  setTransferProgress('Waiting for desktop...', 0);
  transferSending = false;
  pendingTransfer.nextOffset = 0;
  pendingTransfer.chunkSize = 0;
  try {
    ws.send(JSON.stringify({
      type: 'image_upload',
      captureId: pendingTransfer.captureId,
      size: pendingTransfer.blob.size,
      imageType: pendingTransfer.imageType,
      sha256: pendingTransfer.sha256
    }));
    scheduleTransferTimeout();
  } catch (error) {
    console.warn('Could not start image upload:', error && error.name || 'unknown error');
    failTransferConnection('Transfer pending. Reconnecting to retry safely.');
  }
}

function sendNextImageChunk() {
  if (!authenticated || !pendingTransfer || transferSending ||
      !pendingTransfer.chunkSize || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (pendingTransfer.nextOffset >= pendingTransfer.blob.size) return;

  const start = pendingTransfer.nextOffset;
  const end = Math.min(start + pendingTransfer.chunkSize, pendingTransfer.blob.size);
  const transfer = pendingTransfer;
  const socket = ws;
  const generation = socketGeneration;
  transferSending = true;
  transfer.blob.slice(start, end).arrayBuffer()
    .then((chunk) => {
      if (generation !== socketGeneration ||
          pendingTransfer !== transfer ||
          !authenticated ||
          ws !== socket ||
          socket.readyState !== WebSocket.OPEN) return;
      socket.send(chunk);
    })
    .catch((error) => {
      console.warn('Could not prepare image chunk:', error && error.name || 'unknown error');
      if (generation === socketGeneration && pendingTransfer === transfer) {
        failTransferConnection('Image chunk could not be prepared.');
      }
    });
}

function scheduleTransferTimeout() {
  clearTimeout(transferAckTimeout);
  transferAckTimeout = setTimeout(() => {
    if (!pendingTransfer) return;
    failTransferConnection('Transfer pending. No save confirmation was received; retrying safely.');
  }, 45000);
}

function failTransferConnection(message) {
  if (pendingTransfer) pendingTransfer.state = 'PENDING';
  transferSending = false;
  showToast(message, true);
  if (pendingTransfer) {
    const percent = pendingTransfer.blob.size
      ? Math.floor((pendingTransfer.nextOffset || 0) / pendingTransfer.blob.size * 100)
      : 0;
    setTransferProgress(`Transfer pending · ${percent}% sent`);
  }
  setConnectionState('RECONNECTING', message);
  if (ws && ws.readyState === WebSocket.OPEN) ws.close(1011, 'Retry image transfer');
}

function resetCaptureAction() {
  isCapturing = false;
  openCameraBtn.classList.remove('sending');
}

function openFilePicker(useCamera = false, captureLockHeld = false) {
  if (!captureLockHeld) {
    if (isCapturing || pendingTransfer) {
      showToast('Finish the current image before choosing another.', true);
      return;
    }
    isCapturing = true;
    openCameraBtn.classList.add('sending');
  }
  if (useCamera) fileInput.setAttribute('capture', currentFacingMode);
  else fileInput.removeAttribute('capture');

  try {
    fileInput.click();
    clearTimeout(pickerFocusTimer);
    pickerFocusTimer = setTimeout(() => {
      if (isCapturing && !fileInput.files?.length) resetCaptureAction();
    }, 60_000);
  } catch (error) {
    console.warn('Could not open the device image picker:', error && error.name || 'unknown error');
    showToast('Could not open the camera or photo picker.', true);
    resetCaptureAction();
  }
}

// Handle Direct Upload fallback inputs
function handleFileInput(e) {
  const file = e.target.files[0];
  clearTimeout(pickerFocusTimer);
  pickerFocusTimer = null;
  if (!file) {
    resetCaptureAction();
    return;
  }

  triggerFlash();
  openCameraBtn.classList.add('sending');
  isCapturing = true;
  sendBlob(file);
  fileInput.value = '';
}

// Bind Event Listeners
openCameraBtn.addEventListener('click', () => {
  if (stream && viewfinder.videoWidth > 0) void capturePhoto();
  else openFilePicker(true);
});
choosePhotoBtn.addEventListener('click', () => openFilePicker());
fileInput.addEventListener('change', handleFileInput);
fileInput.addEventListener('cancel', () => {
  clearTimeout(pickerFocusTimer);
  pickerFocusTimer = null;
  resetCaptureAction();
});

window.addEventListener('online', () => {
  if (connectionState !== 'CONNECTED' && connectionState !== 'TRANSFERRING') {
    scheduleReconnect(true);
  }
});
window.addEventListener('offline', () => {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (pendingTransfer) pendingTransfer.state = 'PENDING';
  authenticated = false;
  transferSending = false;
  setConnectionState('DISCONNECTED', 'Network unavailable');
  if (pendingTransfer) setTransferProgress('Transfer pending · network unavailable');
  if (ws && ws.readyState < WebSocket.CLOSING) ws.close(1001, 'Network unavailable');
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    cameraShouldResume = cameraShouldResume || Boolean(stream);
    releaseCameraStream();
  } else {
    if (cameraShouldResume && !cameraPermissionDenied) startCamera();
    if (connectionState !== 'CONNECTED' && connectionState !== 'TRANSFERRING') {
      scheduleReconnect(true);
    }
  }
});

function cleanupMobilePage() {
  cameraShouldResume = false;
  releaseCameraStream();
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearTimeout(transferAckTimeout);
  transferAckTimeout = null;
  clearTimeout(toastTimer);
  clearTimeout(flashTimer);
  clearTimeout(pickerFocusTimer);
  if (audioContext) {
    const contextToClose = audioContext;
    audioContext = null;
    contextToClose.close().catch((error) => {
      console.warn('Could not close shutter audio context:', error && error.name || 'unknown error');
    });
  }
  authenticated = false;
  socketGeneration++;
  if (ws && ws.readyState < WebSocket.CLOSING) ws.close(1000, 'Receiver page closed');
  ws = null;
}

window.addEventListener('pagehide', cleanupMobilePage);
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  cameraShouldResume = !cameraPermissionDenied;
  if (cameraShouldResume) startCamera();
  if (!authenticationFailed) connectWebSocket();
});

// Init on load
connectWebSocket();
startCamera();
