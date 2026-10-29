package com.tether.app

import android.Manifest
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.media.MediaPlayer
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.app.ActivityCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import com.tether.app.databinding.ActivityMainBinding
import org.json.JSONObject
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

private data class PendingImageTransfer(
    val captureId: String,
    val file: java.io.File,
    val size: Int,
    val imageType: String,
    val sha256: String,
    var state: String = "CAPTURED",
    var chunkSize: Int = 0,
    var nextOffset: Int = 0
)

private enum class TetherConnectionState {
    DISCONNECTED,
    CONNECTING,
    AUTHENTICATING,
    CONNECTED,
    TRANSFERRING,
    RECONNECTING,
    ERROR
}

private data class RetainedConnectionState(
    val serverUrl: String,
    val pairingToken: String?,
    val certificatePin: String,
    val transfers: LinkedHashMap<String, PendingImageTransfer>,
    val imageStore: PendingImageStore?,
    val captureInProgress: AtomicBoolean
)

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private var imageCapture: ImageCapture? = null
    private lateinit var cameraExecutor: ExecutorService
    private lateinit var transferExecutor: ExecutorService
    private var pendingImageStore: PendingImageStore? = null

    // WebSocket variables
    private var webSocket: WebSocket? = null
    @Volatile private var isConnected = false
    @Volatile private var connectionState = TetherConnectionState.DISCONNECTED
    @Volatile private var connectionAttemptInProgress = false
    private lateinit var captureInProgress: AtomicBoolean
    @Volatile private var cameraReady = false
    @Volatile private var cameraInitializationPending = false
    private var cameraPermissionPermanentlyDenied = false
    private var cameraPermissionRequestedBefore = false
    @Volatile private var maxImageBytes = DEFAULT_MAX_IMAGE_BYTES
    private var targetServerUrl = ""
    private var pairingToken: String? = null
    private var serverCertificatePin = ""
    @Volatile private var authenticationRejected = false
    @Volatile private var authenticationFailureMessage: String? = null
    @Volatile private var connectionGeneration = 0
    private var pendingTransfers = LinkedHashMap<String, PendingImageTransfer>()
    @Volatile private var activeTransferId: String? = null

    private lateinit var sharedPreferences: SharedPreferences
    private val PREFS_NAME = "TetherPrefs"
    private val KEY_IP = "TargetIP"
    private val KEY_CERTIFICATE_PIN = "ServerCertificatePin"

    private val reconnectHandler = Handler(Looper.getMainLooper())
    private val reconnectBackoff = ReconnectBackoff()
    private var reconnectScheduled = false
    private var activityStarted = false
    @Volatile private var networkCallbackRegistered = false
    private lateinit var connectivityManager: ConnectivityManager
    private var activeNetwork: Network? = null
    private val networkChangePolicy = NetworkChangePolicy()
    private val lifecycleObserver = object : DefaultLifecycleObserver {
        override fun onStart(owner: LifecycleOwner) {
            onNetworkingForegrounded()
        }

        override fun onStop(owner: LifecycleOwner) {
            onNetworkingBackgrounded()
        }
    }
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            runOnUiThread {
                if (!activityStarted || !networkCallbackRegistered) return@runOnUiThread
                updateActiveNetwork(connectivityManager.activeNetwork ?: network)
            }
        }

        override fun onLost(network: Network) {
            runOnUiThread {
                if (!activityStarted || !networkCallbackRegistered || activeNetwork != network) {
                    return@runOnUiThread
                }
                updateActiveNetwork(connectivityManager.activeNetwork)
            }
        }

        override fun onLinkPropertiesChanged(
            network: Network,
            linkProperties: android.net.LinkProperties
        ) {
            runOnUiThread {
                if (!activityStarted || !networkCallbackRegistered) return@runOnUiThread
                if (connectivityManager.activeNetwork != network) return@runOnUiThread
                updateActiveNetwork(network, linkProperties)
            }
        }
    }
    private val reconnectRunnable = Runnable {
        reconnectScheduled = false
        if (activityStarted && activeNetwork != null) connectWebSocket()
    }
    private var transferTimeoutCaptureId: String? = null
    private val transferTimeoutRunnable = Runnable {
        val captureId = transferTimeoutCaptureId ?: return@Runnable
        markTransferPending(captureId)
        showUploadError("Transfer pending. No save confirmation was received; retrying safely.")
        webSocket?.close(1011, "Image acknowledgement timeout")
        handleDisconnect(connectionGeneration)
    }

    private fun scheduleTransferTimeout(captureId: String) {
        transferTimeoutCaptureId = captureId
        reconnectHandler.removeCallbacks(transferTimeoutRunnable)
        reconnectHandler.postDelayed(transferTimeoutRunnable, TRANSFER_ACK_TIMEOUT_MS)
    }

    private fun sendNextImageChunk(generation: Int, transfer: PendingImageTransfer) {
        if (generation != connectionGeneration ||
            !isConnected ||
            activeTransferId != transfer.captureId) return

        val start = transfer.nextOffset
        if (start >= transfer.size) return
        val end = minOf(start + transfer.chunkSize, transfer.size)
        try {
            transferExecutor.execute {
                try {
                    val chunk = ByteArray(end - start)
                    RandomAccessFile(transfer.file, "r").use { file ->
                        file.seek(start.toLong())
                        file.readFully(chunk)
                    }
                    runOnUiThread {
                        if (generation != connectionGeneration ||
                            !isConnected ||
                            activeTransferId != transfer.captureId) return@runOnUiThread
                        if (webSocket?.send(chunk.toByteString()) != true) {
                            failTransferConnection(generation, transfer.captureId)
                        }
                    }
                } catch (error: Exception) {
                    Log.e(TAG, "Could not read queued image chunk", error)
                    failTransferConnection(generation, transfer.captureId)
                }
            }
        } catch (error: java.util.concurrent.RejectedExecutionException) {
            Log.e(TAG, "Image transfer worker is unavailable", error)
            failTransferConnection(generation, transfer.captureId)
        }
    }

    private fun failTransferConnection(generation: Int, captureId: String) {
        markTransferPending(captureId)
        showUploadError("Transfer pending. Reconnecting to retry safely.")
        handleDisconnect(generation)
        webSocket?.close(1011, "Retry image transfer")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        sharedPreferences = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        cameraPermissionRequestedBefore =
            sharedPreferences.getBoolean(KEY_CAMERA_PERMISSION_REQUESTED, false)
        val savedIp = sharedPreferences.getString(KEY_IP, "")
        val savedCertificatePin = sharedPreferences.getString(KEY_CERTIFICATE_PIN, "")
        targetServerUrl = savedIp?.takeIf { it.isNotBlank() }?.let { toWebSocketUrl(it) } ?: ""
        serverCertificatePin = savedCertificatePin.orEmpty()
        connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val retainedState = lastCustomNonConfigurationInstance as? RetainedConnectionState
        if (retainedState != null) {
            targetServerUrl = retainedState.serverUrl
            pairingToken = retainedState.pairingToken
            serverCertificatePin = retainedState.certificatePin
            pendingTransfers = retainedState.transfers
        }
        captureInProgress = retainedState?.captureInProgress ?: AtomicBoolean(false)
        binding.ipAddressInput.setText(savedIp.orEmpty())
        binding.certificatePinInput.setText(serverCertificatePin)
        updateConnectionState(TetherConnectionState.DISCONNECTED, "Tap to Pair")

        cameraExecutor = Executors.newSingleThreadExecutor()
        transferExecutor = Executors.newSingleThreadExecutor()
        pendingImageStore = try {
            retainedState?.imageStore ?: PendingImageStore(
                    File(filesDir, "pending-images"),
                    MAX_PENDING_TRANSFERS,
                    MAX_PENDING_TRANSFER_BYTES
                )
        } catch (error: Exception) {
            Log.e(TAG, "Could not initialize pending image storage", error)
            Toast.makeText(this, "Image queue storage is unavailable.", Toast.LENGTH_LONG).show()
            null
        }
        if (retainedState == null) {
            pendingImageStore?.list()?.forEach { capture ->
                pendingTransfers[capture.captureId] = capture.toPendingTransfer()
            }
        }

        // Check and request camera permissions
        if (!allPermissionsGranted()) requestCameraPermission()

        // Shutter Button listener
        binding.captureButton.setOnClickListener {
            takePhoto()
        }

        // Connection Panel Toggle
        binding.connectionStatusContainer.setOnClickListener {
            binding.ipSettingsLayout.visibility = View.VISIBLE
        }

        // Connection Dialog Save Button
        binding.connectButton.setOnClickListener {
            val ipText = binding.ipAddressInput.text.toString().trim()
            val tokenText = binding.pairingTokenInput.text.toString().trim().lowercase(Locale.US)
            val certificatePinText = binding.certificatePinInput.text.toString().trim()
            if (ipText.isEmpty()) {
                Toast.makeText(this, "Please enter the desktop address", Toast.LENGTH_SHORT).show()
            } else if (!tokenText.matches(Regex("^[a-f0-9]{64}$"))) {
                Toast.makeText(this, "Enter the current 64-character pairing token", Toast.LENGTH_LONG).show()
            } else if (normalizeCertificatePin(certificatePinText) == null) {
                Toast.makeText(this, "Enter the TETHER certificate pin shown on the desktop", Toast.LENGTH_LONG).show()
            } else {
                val newServerUrl = toWebSocketUrl(ipText)
                if (targetServerUrl.isNotBlank() && targetServerUrl != newServerUrl) {
                    val captureIds = synchronized(pendingTransfers) {
                        pendingTransfers.keys.toList().also { pendingTransfers.clear() }
                    }
                    captureIds.forEach { captureId ->
                        try {
                            pendingImageStore?.remove(captureId)
                        } catch (error: Exception) {
                            Log.e(TAG, "Could not clear a pending image after changing desktop", error)
                        }
                    }
                    Toast.makeText(
                        this,
                        "Pending images were cleared because the desktop address changed.",
                        Toast.LENGTH_LONG
                    ).show()
                }
                sharedPreferences.edit()
                    .putString(KEY_IP, ipText)
                    .putString(KEY_CERTIFICATE_PIN, normalizeCertificatePin(certificatePinText))
                    .apply()
                targetServerUrl = newServerUrl
                serverCertificatePin = normalizeCertificatePin(certificatePinText).orEmpty()
                pairingToken = tokenText
                binding.ipSettingsLayout.visibility = View.GONE
                
                // Disconnect old socket and connect to new one
                disconnectWebSocket()
                reconnectBackoff.reset()
                connectWebSocket()
            }
        }

        // Cancel Connection Dialog
        binding.cancelButton.setOnClickListener {
            binding.ipSettingsLayout.visibility = View.GONE
        }

        lifecycle.addObserver(lifecycleObserver)
    }

    private fun onNetworkingForegrounded() {
        if (activityStarted) return
        activityStarted = true
        networkChangePolicy.reset()
        activeNetwork = null
        if (allPermissionsGranted()) startCamera()
        try {
            connectivityManager.registerDefaultNetworkCallback(networkCallback)
            networkCallbackRegistered = true
        } catch (error: SecurityException) {
            networkCallbackRegistered = false
            Log.w(TAG, "Network change monitoring is unavailable", error)
        } catch (error: RuntimeException) {
            networkCallbackRegistered = false
            Log.w(TAG, "Could not register default network callback", error)
        }
        val currentNetwork = try {
            connectivityManager.activeNetwork
        } catch (error: RuntimeException) {
            Log.w(TAG, "Could not inspect the active network", error)
            null
        }
        if (currentNetwork != null) updateActiveNetwork(currentNetwork)
        else {
            updateActiveNetwork(null)
            updateConnectionState(TetherConnectionState.DISCONNECTED, "Waiting for network")
        }
    }

    private fun onNetworkingBackgrounded() {
        if (!activityStarted) return
        activityStarted = false
        cameraReady = false
        imageCapture = null
        cameraInitializationPending = false
        reconnectHandler.removeCallbacks(reconnectRunnable)
        reconnectScheduled = false
        reconnectHandler.removeCallbacks(transferTimeoutRunnable)
        transferTimeoutCaptureId?.let(::markTransferPending)
        networkChangePolicy.reset()
        activeNetwork = null
        invalidateWebSocket()
        if (networkCallbackRegistered) {
            networkCallbackRegistered = false
            try {
                connectivityManager.unregisterNetworkCallback(networkCallback)
            } catch (error: IllegalArgumentException) {
                Log.d(TAG, "Network callback was already unregistered", error)
            } catch (error: RuntimeException) {
                Log.w(TAG, "Could not unregister network callback", error)
            }
        }
        updateConnectionState(TetherConnectionState.DISCONNECTED, "Paused")
    }

    private fun updateActiveNetwork(
        network: Network?,
        linkProperties: android.net.LinkProperties? = null
    ) {
        val fingerprint = linkProperties?.let(::networkFingerprint)
        val change = networkChangePolicy.update(network?.toString(), fingerprint)
        activeNetwork = network
        if (change == NetworkChange.LOST) {
            pauseForNetworkLoss()
            return
        }
        if (change == NetworkChange.UNAVAILABLE) return

        if (change == NetworkChange.CHANGED) {
            Log.i(TAG, "Default network, routes, or IP addresses changed")
            reconnectHandler.removeCallbacks(reconnectRunnable)
            reconnectScheduled = false
            reconnectHandler.removeCallbacks(transferTimeoutRunnable)
            transferTimeoutCaptureId?.let(::markTransferPending)
            invalidateWebSocket()
            if (pairingToken != null && targetServerUrl.isNotBlank()) connectWebSocket()
        } else if (!isConnected &&
            !connectionAttemptInProgress &&
            !reconnectScheduled &&
            pairingToken != null &&
            targetServerUrl.isNotBlank()) {
            scheduleReconnect(immediate = true)
        }
    }

    private fun networkFingerprint(linkProperties: android.net.LinkProperties): String =
        listOf(
            linkProperties.interfaceName,
            linkProperties.linkAddresses.toString(),
            linkProperties.routes.toString(),
            linkProperties.dnsServers.toString(),
            linkProperties.domains
        ).joinToString("|")

    private fun pauseForNetworkLoss() {
        reconnectHandler.removeCallbacks(reconnectRunnable)
        reconnectScheduled = false
        reconnectHandler.removeCallbacks(transferTimeoutRunnable)
        transferTimeoutCaptureId?.let(::markTransferPending)
        networkChangePolicy.reset()
        activeNetwork = null
        invalidateWebSocket()
        updateConnectionState(TetherConnectionState.DISCONNECTED, "Network unavailable")
    }

    private fun invalidateWebSocket() {
        connectionGeneration++
        connectionAttemptInProgress = false
        isConnected = false
        webSocket?.cancel()
        webSocket = null
        activeTransferId?.let(::markTransferPending)
    }

    override fun onRetainCustomNonConfigurationInstance(): Any {
        return RetainedConnectionState(
            targetServerUrl,
            pairingToken,
            serverCertificatePin,
            pendingTransfers,
            pendingImageStore,
            captureInProgress
        )
    }

    private fun toWebSocketUrl(address: String): String {
        val normalized = address.trim().trimEnd('/')
        return when {
            normalized.startsWith("wss://", ignoreCase = true) -> normalized
            normalized.startsWith("ws://", ignoreCase = true) -> "wss://${normalized.substringAfter("://")}"
            normalized.startsWith("https://", ignoreCase = true) -> "wss://${normalized.substringAfter("://")}"
            normalized.startsWith("http://", ignoreCase = true) -> "wss://${normalized.substringAfter("://")}"
            else -> "wss://$normalized"
        }
    }

    private fun startCamera() {
        if (!activityStarted || !allPermissionsGranted() || isFinishing || isDestroyed ||
            cameraInitializationPending) return
        cameraInitializationPending = true
        val cameraProviderFuture = try {
            ProcessCameraProvider.getInstance(this)
        } catch (error: Exception) {
            cameraInitializationPending = false
            Log.e(TAG, "Could not request camera provider", error)
            showCameraError("Camera could not be started. Please try again.")
            return
        }

        cameraProviderFuture.addListener({
            try {
                if (!activityStarted || !allPermissionsGranted() || isFinishing || isDestroyed) {
                    return@addListener
                }
                val cameraProvider = cameraProviderFuture.get()
                val preview = Preview.Builder()
                    .build()
                    .also { it.setSurfaceProvider(binding.viewFinder.surfaceProvider) }
                val captureUseCase = ImageCapture.Builder()
                    .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                    .build()
                val cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA
                if (!cameraProvider.hasCamera(cameraSelector)) {
                    cameraReady = false
                    imageCapture = null
                    showCameraError("No back camera is available on this device.")
                    return@addListener
                }
                // Unbind use cases before rebinding
                cameraProvider.unbindAll()

                // Bind use cases to camera
                cameraProvider.bindToLifecycle(
                    this, cameraSelector, preview, captureUseCase
                )
                imageCapture = captureUseCase
                cameraReady = true

            } catch (exc: Exception) {
                cameraReady = false
                imageCapture = null
                Log.e(TAG, "Use case binding failed", exc)
                showCameraError("Camera is unavailable. Close other camera apps and retry.")
            } finally {
                cameraInitializationPending = false
            }

        }, ContextCompat.getMainExecutor(this))
    }

    private fun takePhoto() {
        if (!activityStarted || !cameraReady || !allPermissionsGranted()) {
            if (!allPermissionsGranted()) requestCameraPermission()
            else {
                startCamera()
                showCameraError("Camera is not ready yet. Please try again.")
            }
            return
        }
        val imageCapture = imageCapture ?: run {
            showCameraError("Camera is unavailable. Please try again.")
            return
        }
        val transferQueueFull = synchronized(pendingTransfers) {
            pendingTransfers.size >= MAX_PENDING_TRANSFERS
        }
        if (transferQueueFull) {
            Toast.makeText(this, "Transfer queue is full. Wait before taking another photo.", Toast.LENGTH_LONG).show()
            return
        }
        if (captureInProgress.get()) {
            Toast.makeText(this, "Photo capture is still being queued. Please wait.", Toast.LENGTH_SHORT).show()
            return
        }

        if (!captureInProgress.compareAndSet(false, true)) {
            Toast.makeText(this, "Photo capture is still being queued. Please wait.", Toast.LENGTH_SHORT).show()
            return
        }
        triggerCameraEffects()

        try {
            imageCapture.takePicture(
                ContextCompat.getMainExecutor(this),
                object : ImageCapture.OnImageCapturedCallback() {
                    override fun onCaptureSuccess(image: ImageProxy) {
                        try {
                            cameraExecutor.execute {
                                try {
                                    val buffer = image.planes[0].buffer
                                    val imageSize = buffer.remaining()
                                    if (imageSize > maxImageBytes) {
                                        showUploadError("Image exceeds the desktop size limit.")
                                        return@execute
                                    }
                                    if (detectImageType(buffer) != "jpeg") {
                                        showUploadError("Camera returned an unsupported image format.")
                                        return@execute
                                    }

                                    val bytes = ByteArray(imageSize)
                                    buffer.get(bytes)
                                    queueImage(bytes)
                                } catch (error: Exception) {
                                    Log.e(TAG, "Could not store captured image", error)
                                    showUploadError("The captured image could not be queued.")
                                } finally {
                                    image.close()
                                    captureInProgress.set(false)
                                }
                            }
                        } catch (error: java.util.concurrent.RejectedExecutionException) {
                            image.close()
                            captureInProgress.set(false)
                            Log.e(TAG, "Camera worker is unavailable", error)
                            showUploadError("Camera is shutting down. Please try again.")
                        }
                    }

                    override fun onError(exc: ImageCaptureException) {
                        captureInProgress.set(false)
                        Log.e(TAG, "Photo capture failed: ${exc.message}", exc)
                        runOnUiThread {
                            if (isFinishing || isDestroyed) return@runOnUiThread
                            Toast.makeText(this@MainActivity, "Capture Error: ${exc.message}", Toast.LENGTH_SHORT).show()
                        }
                    }
                }
            )
        } catch (error: Exception) {
            captureInProgress.set(false)
            Log.e(TAG, "Camera capture could not start", error)
            showCameraError("Camera capture failed to start. Please try again.")
        }
    }

    private fun queueImage(jpegBytes: ByteArray) {
        if (jpegBytes.size > maxImageBytes) {
            showUploadError("Image exceeds the desktop size limit.")
            return
        }
        if (detectImageType(ByteBuffer.wrap(jpegBytes)) != "jpeg") {
            showUploadError("Only JPEG, PNG, and WebP images are supported.")
            return
        }

        val imageStore = pendingImageStore ?: run {
            showUploadError("Image queue storage is unavailable. Free device storage and restart the app.")
            return
        }
        val storedCapture = try {
            imageStore.enqueue(jpegBytes)
        } catch (error: PendingImageStorageException) {
            showUploadError(error.message ?: "Could not queue the image.")
            return
        } catch (error: Exception) {
            Log.e(TAG, "Could not persist captured image", error)
            showUploadError("Not enough storage to queue the image.")
            return
        }
        val transfer = storedCapture.toPendingTransfer()
        synchronized(pendingTransfers) {
            transfer.state = "QUEUED"
            pendingTransfers[transfer.captureId] = transfer
        }
        runOnUiThread {
            if (isFinishing || isDestroyed) return@runOnUiThread
            Toast.makeText(
                this,
                if (isConnected) "Image queued for transfer" else "Image saved to the transfer queue; waiting for desktop",
                Toast.LENGTH_SHORT
            ).show()
            sendNextTransfer()
        }
    }

    private fun StoredCapture.toPendingTransfer() = PendingImageTransfer(
        captureId = captureId,
        file = file,
        size = size,
        imageType = "jpeg",
        sha256 = sha256
    )

    private fun sendNextTransfer() {
        if (!isConnected || activeTransferId != null) return
        val socket = webSocket ?: return
        val transfer = synchronized(pendingTransfers) {
            pendingTransfers.values.firstOrNull { it.state == "QUEUED" || it.state == "PENDING" }
                ?.also {
                    it.state = "QUEUED"
                    activeTransferId = it.captureId
                }
        } ?: return
        updateConnectionState(TetherConnectionState.TRANSFERRING)

        val metadata = JSONObject()
            .put("type", "image_upload")
            .put("captureId", transfer.captureId)
            .put("size", transfer.size)
            .put("imageType", transfer.imageType)
            .put("sha256", transfer.sha256)
        if (!socket.send(metadata.toString())) {
            markTransferPending(transfer.captureId)
            showUploadError("Transfer pending. Waiting to reconnect.")
            handleDisconnect(connectionGeneration)
            socket.close(1011, "Could not queue image metadata")
        } else {
            transferTimeoutCaptureId = transfer.captureId
            reconnectHandler.removeCallbacks(transferTimeoutRunnable)
            reconnectHandler.postDelayed(transferTimeoutRunnable, TRANSFER_ACK_TIMEOUT_MS)
        }
    }

    private fun markTransferPending(captureId: String) {
        synchronized(pendingTransfers) {
            pendingTransfers[captureId]?.apply {
                state = "PENDING"
                nextOffset = 0
                chunkSize = 0
            }
        }
        if (activeTransferId == captureId) {
            activeTransferId = null
            if (transferTimeoutCaptureId == captureId) {
                transferTimeoutCaptureId = null
                reconnectHandler.removeCallbacks(transferTimeoutRunnable)
            }
        }
    }

    private fun sha256Hex(bytes: ByteArray): String {
        return MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { String.format(Locale.US, "%02x", it.toInt() and 0xff) }
    }

    private fun connectWebSocket() {
        reconnectHandler.removeCallbacks(reconnectRunnable)
        reconnectScheduled = false
        if (!activityStarted || connectionAttemptInProgress || isConnected) return
        if (activeNetwork == null) {
            activeNetwork = try {
                connectivityManager.activeNetwork
            } catch (error: RuntimeException) {
                Log.w(TAG, "Could not inspect the active network", error)
                null
            }
        }
        if (activeNetwork == null) {
            updateConnectionState(TetherConnectionState.DISCONNECTED, "Waiting for network")
            return
        }
        val token = pairingToken
        if (targetServerUrl.isBlank() || token == null) {
            updateConnectionState(TetherConnectionState.DISCONNECTED, "Tap to Pair")
            return
        }

        authenticationRejected = false
        connectionAttemptInProgress = true
        updateConnectionState(TetherConnectionState.CONNECTING)
        val generation = ++connectionGeneration
        val request = try {
            Request.Builder()
                .url(targetServerUrl)
                .header("User-Agent", "TetherCam Android")
                .build()
        } catch (_: IllegalArgumentException) {
            connectionAttemptInProgress = false
            updateConnectionState(TetherConnectionState.ERROR, "Invalid desktop address")
            return
        }

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (generation != connectionGeneration) return
                updateConnectionState(TetherConnectionState.AUTHENTICATING)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (generation != connectionGeneration) return
                val message = try {
                    JSONObject(text)
                } catch (_: Exception) {
                    handleAuthenticationFailure(generation, "AUTH_FAILED")
                    return
                }

                when (message.optString("type")) {
                    "challenge" -> {
                        val nonce = message.optString("nonce")
                        if (!nonce.matches(Regex("^[a-f0-9]{64}$"))) {
                            handleAuthenticationFailure(generation, "AUTH_FAILED")
                            return
                        }
                        val proof = createAuthenticationProof(token, nonce)
                        val response = JSONObject()
                            .put("type", "authenticate")
                            .put("proof", proof)
                        if (!webSocket.send(response.toString())) {
                            handleAuthenticationFailure(generation, "AUTH_FAILED")
                        }
                    }
                    "paired" -> {
                        isConnected = true
                        connectionAttemptInProgress = false
                        authenticationFailureMessage = null
                        reconnectBackoff.maxIntervalMs = message.optLong(
                            "reconnectMaxIntervalMs",
                            DEFAULT_RECONNECT_MAX_INTERVAL_MS
                        ).coerceIn(MIN_RECONNECT_MAX_INTERVAL_MS, MAX_RECONNECT_MAX_INTERVAL_MS)
                        reconnectBackoff.reset()
                        val serverMaxImageBytes = message.optLong("maxImageBytes", DEFAULT_MAX_IMAGE_BYTES.toLong())
                        if (serverMaxImageBytes in 1..MAX_IMAGE_BYTES.toLong()) {
                            maxImageBytes = serverMaxImageBytes.toInt()
                        }
                        val serverChunkSize = message.optInt("chunkSize", 0)
                        if (serverChunkSize !in 1..MAX_IMAGE_CHUNK_BYTES) {
                            webSocket.close(1002, "Invalid image chunk size")
                            handleDisconnect(generation)
                            return
                        }
                        runOnUiThread {
                            binding.ipSettingsLayout.visibility = View.GONE
                            binding.connectButton.text = "Connect Session"
                            binding.connectionIndicator.setBackgroundResource(R.drawable.indicator_green)
                            val ipStr = targetServerUrl.substringAfter("://")
                            updateConnectionState(
                                if (synchronized(pendingTransfers) { pendingTransfers.isEmpty() }) {
                                    TetherConnectionState.CONNECTED
                                }
                                else TetherConnectionState.TRANSFERRING,
                                "Linked: $ipStr"
                            )
                            sendNextTransfer()
                        }
                    }
                    "upload_ready" -> {
                        val captureId = message.optString("captureId")
                        val transfer = synchronized(pendingTransfers) {
                            pendingTransfers[captureId]
                        }
                        if (transfer == null || activeTransferId != captureId) return
                        val serverChunkSize = message.optInt("chunkSize", 0)
                        if (serverChunkSize !in 1..MAX_IMAGE_CHUNK_BYTES) {
                            failTransferConnection(generation, captureId)
                            return
                        }
                        transfer.chunkSize = serverChunkSize
                        transfer.nextOffset = 0
                        transfer.state = "UPLOADING"
                        scheduleTransferTimeout(captureId)
                        sendNextImageChunk(generation, transfer)
                    }
                    "queue_status" -> {
                        val captureId = message.optString("captureId")
                        if (activeTransferId != captureId) return
                        val state = message.optString("state")
                        if (state == "QUEUED") {
                            reconnectHandler.removeCallbacks(transferTimeoutRunnable)
                            runOnUiThread {
                                updateConnectionState(
                                    TetherConnectionState.TRANSFERRING,
                                    "Queued for transfer (${message.optInt("position", 1)}/${message.optInt("maxQueued", 0)})"
                                )
                            }
                        } else if (state == "STARTING") {
                            scheduleTransferTimeout(captureId)
                            runOnUiThread {
                                updateConnectionState(
                                    TetherConnectionState.TRANSFERRING,
                                    "Desktop preparing image transfer"
                                )
                            }
                        }
                    }
                    "chunk_ack" -> {
                        val captureId = message.optString("captureId")
                        val transfer = synchronized(pendingTransfers) { pendingTransfers[captureId] }
                        if (transfer == null || activeTransferId != captureId) return
                        val expectedOffset = minOf(
                            transfer.nextOffset + transfer.chunkSize,
                            transfer.size
                        )
                        if (message.optInt("nextOffset", -1) != expectedOffset) {
                            failTransferConnection(generation, captureId)
                            return
                        }
                        transfer.nextOffset = expectedOffset
                        scheduleTransferTimeout(captureId)
                        sendNextImageChunk(generation, transfer)
                    }
                    "transfer_status" -> {
                        val captureId = message.optString("captureId")
                        synchronized(pendingTransfers) {
                            val transfer = pendingTransfers[captureId]
                            if (transfer != null && activeTransferId == captureId) {
                                transfer.state = message.optString("state", transfer.state)
                            }
                        }
                    }
                    "image_ack" -> {
                        val captureId = message.optString("captureId")
                        val expectedTransfer = synchronized(pendingTransfers) {
                            pendingTransfers[captureId]
                        } ?: return
                        if (!isPersistedCaptureAcknowledgement(
                                activeTransferId ?: "",
                                expectedTransfer.sha256,
                                expectedTransfer.size.toLong(),
                                message.optString("captureId"),
                                message.optString("state"),
                                message.optBoolean("persisted", false),
                                message.optString("sha256"),
                                message.optLong("size", -1),
                                message.optString("proof"),
                                token
                            )) {
                            return
                        }
                        val removed = synchronized(pendingTransfers) {
                            if (activeTransferId == captureId && pendingTransfers.containsKey(captureId)) {
                                pendingTransfers.remove(captureId) != null
                            } else false
                        }
                        if (removed && activeTransferId == captureId) {
                            try {
                                pendingImageStore?.remove(captureId)
                            } catch (error: Exception) {
                                Log.e(TAG, "Could not remove acknowledged image from local queue", error)
                            }
                            activeTransferId = null
                            transferTimeoutCaptureId = null
                            reconnectHandler.removeCallbacks(transferTimeoutRunnable)
                            runOnUiThread {
                                showSentToast()
                                updateConnectionState(TetherConnectionState.CONNECTED, "Transfer successful")
                                sendNextTransfer()
                            }
                        }
                    }
                    "upload_error" -> {
                        val captureId = message.optString("captureId")
                        if (captureId.isBlank() || captureId == "null") {
                            showUploadError(message.optString("message", "Image transfer failed."))
                            return
                        }
                        val retryable = message.optBoolean("retryable", false)
                        if (retryable) {
                            markTransferPending(captureId)
                            runOnUiThread {
                                updateConnectionState(TetherConnectionState.RECONNECTING, "Transfer pending; retrying...")
                                showUploadError(message.optString("message", "Transfer pending; retrying."))
                            }
                            handleDisconnect(generation)
                            webSocket.close(1011, "Retry image transfer")
                        } else {
                            synchronized(pendingTransfers) {
                                pendingTransfers.remove(captureId)
                            }
                            try {
                                pendingImageStore?.remove(captureId)
                            } catch (error: Exception) {
                                Log.e(TAG, "Could not remove rejected image from local queue", error)
                            }
                            if (activeTransferId == captureId) activeTransferId = null
                            transferTimeoutCaptureId = null
                            reconnectHandler.removeCallbacks(transferTimeoutRunnable)
                            val failureMessage = message.optString("message", "Image transfer failed.")
                            runOnUiThread {
                                updateConnectionState(TetherConnectionState.CONNECTED, "Transfer failed")
                                showUploadError(failureMessage)
                            }
                            sendNextTransfer()
                        }
                    }
                    "auth_error" -> handleAuthenticationFailure(
                        generation,
                        message.optString("code")
                    )
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                if (code == 1009) {
                    showUploadError("Image exceeds the desktop size limit. Choose a smaller image.")
                }
                handleDisconnect(generation)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                handleDisconnect(generation)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (generation != connectionGeneration) return
                Log.w(TAG, "WebSocket connection failed", t)
                runOnUiThread {
                    binding.ipSettingsLayout.visibility = View.VISIBLE
                    binding.connectButton.text = "Retry Connection"
                    Toast.makeText(this@MainActivity, PairingFeedback.desktopUnreachable(), Toast.LENGTH_LONG).show()
                }
                handleDisconnect(generation)
            }
        }

        try {
            webSocket = createPinnedOkHttpClient(targetServerUrl, serverCertificatePin)
                .newWebSocket(request, listener)
        } catch (_: RuntimeException) {
            connectionAttemptInProgress = false
            updateConnectionState(TetherConnectionState.ERROR, "Could not start connection")
            scheduleReconnect()
        }
    }

    private fun createAuthenticationProof(token: String, nonce: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(token.toByteArray(StandardCharsets.UTF_8), "HmacSHA256"))
        return mac.doFinal(nonce.toByteArray(StandardCharsets.UTF_8))
            .joinToString("") { String.format(Locale.US, "%02x", it.toInt() and 0xff) }
    }

    private fun detectImageType(buffer: ByteBuffer): String? {
        val header = buffer.duplicate()
        val start = header.position()
        if (header.remaining() >= 3 &&
            (header.get(start).toInt() and 0xff) == 0xff &&
            (header.get(start + 1).toInt() and 0xff) == 0xd8 &&
            (header.get(start + 2).toInt() and 0xff) == 0xff) {
            return "jpeg"
        }
        val pngSignature = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
        if (header.remaining() >= pngSignature.size &&
            pngSignature.indices.all { header.get(start + it) == pngSignature[it] }) {
            return "png"
        }
        if (header.remaining() >= 12 &&
            String(ByteArray(4) { header.get(start + it) }, StandardCharsets.US_ASCII) == "RIFF" &&
            String(ByteArray(4) { header.get(start + 8 + it) }, StandardCharsets.US_ASCII) == "WEBP") {
            return "webp"
        }
        return null
    }

    private fun showUploadError(message: String) {
        runOnUiThread {
            if (isFinishing || isDestroyed) return@runOnUiThread
            Toast.makeText(this@MainActivity, message, Toast.LENGTH_LONG).show()
        }
    }

    private fun showCameraError(message: String) {
        cameraReady = false
        imageCapture = null
        runOnUiThread {
            if (isFinishing || isDestroyed) return@runOnUiThread
            binding.captureButton.isEnabled = true
            binding.captureButton.alpha = 1f
            Toast.makeText(this@MainActivity, message, Toast.LENGTH_LONG).show()
        }
    }

    private fun requestCameraPermission() {
        if (allPermissionsGranted()) {
            startCamera()
            return
        }
        val shouldShowRationale =
            ActivityCompat.shouldShowRequestPermissionRationale(this, Manifest.permission.CAMERA)
        if (cameraPermissionPermanentlyDenied ||
            (!shouldShowRationale && cameraPermissionRequestedBefore)) {
            AlertDialog.Builder(this)
                .setTitle("Camera permission denied")
                .setMessage("Enable camera access in app settings to capture images.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Open settings") { _, _ ->
                    val settingsIntent = Intent(
                        android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", packageName, null)
                    )
                    startActivity(settingsIntent)
                }
                .show()
            return
        }
        if (shouldShowRationale) {
            AlertDialog.Builder(this)
                .setTitle("Camera permission required")
                .setMessage("Allow camera access to capture images for your desktop.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Continue") { _, _ ->
                    markCameraPermissionRequested()
                    ActivityCompat.requestPermissions(
                        this,
                        arrayOf(Manifest.permission.CAMERA),
                        REQUEST_CODE_PERMISSIONS
                    )
                }
                .show()
        } else {
            markCameraPermissionRequested()
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.CAMERA),
                REQUEST_CODE_PERMISSIONS
            )
        }
    }

    private fun markCameraPermissionRequested() {
        cameraPermissionRequestedBefore = true
        sharedPreferences.edit().putBoolean(KEY_CAMERA_PERMISSION_REQUESTED, true).apply()
    }

    private fun handleAuthenticationFailure(generation: Int, code: String) {
        if (generation != connectionGeneration) return
        authenticationRejected = true
        connectionAttemptInProgress = false
        isConnected = false
        val feedback = PairingFeedback.authenticationFailure(code)
        authenticationFailureMessage = feedback.text
        updateConnectionState(TetherConnectionState.ERROR, feedback.text)
        runOnUiThread {
            binding.ipSettingsLayout.visibility = View.VISIBLE
            binding.connectButton.text = if (feedback.needsFreshToken) "Re-pair and Retry" else "Retry Connection"
            if (feedback.needsFreshToken) binding.pairingTokenInput.text?.clear()
            Toast.makeText(this, feedback.text, Toast.LENGTH_LONG).show()
        }
        webSocket?.close(1008, "Authentication failed")
    }

    private fun handleDisconnect(generation: Int? = null) {
        if (generation != null && generation != connectionGeneration) return
        invalidateWebSocket()
        reconnectHandler.removeCallbacks(transferTimeoutRunnable)
        transferTimeoutCaptureId = null
        isConnected = false
        connectionAttemptInProgress = false
        if (authenticationRejected) {
            updateConnectionState(
                TetherConnectionState.ERROR,
                authenticationFailureMessage ?: "Pairing rejected. Update the pairing details and retry."
            )
            return
        }
        if (!activityStarted) {
            updateConnectionState(TetherConnectionState.DISCONNECTED, "Paused")
            return
        }
        scheduleReconnect()
    }

    private fun scheduleReconnect(immediate: Boolean = false) {
        if (!activityStarted || authenticationRejected || pairingToken == null) return
        if (activeNetwork == null) {
            updateConnectionState(TetherConnectionState.DISCONNECTED, "Waiting for network")
            return
        }
        if (immediate && reconnectScheduled) {
            reconnectHandler.removeCallbacks(reconnectRunnable)
            reconnectScheduled = false
        }
        if (reconnectScheduled) return
        reconnectScheduled = true
        updateConnectionState(TetherConnectionState.RECONNECTING)
        val delay = if (immediate) 0L else reconnectBackoff.nextDelay()
        reconnectHandler.postDelayed(reconnectRunnable, delay)
    }

    private fun updateConnectionState(state: TetherConnectionState, detail: String? = null) {
        connectionState = state
        val description = detail ?: when (state) {
            TetherConnectionState.DISCONNECTED -> "Offline"
            TetherConnectionState.CONNECTING -> "Connecting to desktop..."
            TetherConnectionState.AUTHENTICATING -> "Authenticating with desktop..."
            TetherConnectionState.CONNECTED -> "Linked"
            TetherConnectionState.TRANSFERRING -> "Uploading image..."
            TetherConnectionState.RECONNECTING -> "Reconnecting..."
            TetherConnectionState.ERROR -> "Connection error"
        }
        runOnUiThread {
            binding.connectionIndicator.setBackgroundResource(
                if (state == TetherConnectionState.CONNECTED || state == TetherConnectionState.TRANSFERRING) {
                    R.drawable.indicator_green
                } else {
                    R.drawable.indicator_red
                }
            )
            binding.connectionStatusText.text = "${state.name} · $description"
        }
    }

    private fun disconnectWebSocket(resetBackoff: Boolean = true) {
        reconnectHandler.removeCallbacks(reconnectRunnable)
        reconnectScheduled = false
        reconnectHandler.removeCallbacks(transferTimeoutRunnable)
        transferTimeoutCaptureId?.let(::markTransferPending)
        invalidateWebSocket()
        if (resetBackoff) reconnectBackoff.reset()
        updateConnectionState(TetherConnectionState.DISCONNECTED)
    }

    private fun triggerCameraEffects() {
        // Haptic feedback pop
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val vibratorManager = getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
            vibratorManager.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createOneShot(50, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(50)
            }
        } catch (error: Exception) {
            Log.w(TAG, "Camera vibration feedback is unavailable", error)
        }

        // Screen Flash Effect
        binding.flashOverlay.visibility = View.VISIBLE
        binding.flashOverlay.alpha = 1.0f
        binding.flashOverlay.animate()
            .alpha(0.0f)
            .setDuration(150)
            .withEndAction {
                binding.flashOverlay.visibility = View.GONE
            }
            .start()

        // Shutter beep
        try {
            val sound = MediaPlayer.create(this, android.R.raw.camera_click)
            sound.setOnCompletionListener { mp -> mp.release() }
            sound.start()
        } catch (e: Exception) {
            Log.e(TAG, "Failed playing shutter click sound", e)
        }
    }

    private fun showSentToast() {
        val toast = Toast.makeText(this, "✓ Transfer successful", Toast.LENGTH_SHORT)
        toast.show()
    }

    private fun allPermissionsGranted() = REQUIRED_PERMISSIONS.all {
        ContextCompat.checkSelfPermission(
            baseContext, it
        ) == PackageManager.PERMISSION_GRANTED
    }

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<String>, grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_CODE_PERMISSIONS) {
            if (allPermissionsGranted()) {
                cameraPermissionPermanentlyDenied = false
                startCamera()
            } else {
                cameraPermissionPermanentlyDenied =
                    !ActivityCompat.shouldShowRequestPermissionRationale(this, Manifest.permission.CAMERA)
                Toast.makeText(
                    this,
                    "Camera permission was denied. Allow it in app settings to capture images.",
                    Toast.LENGTH_LONG
                ).show()
            }
        }
    }

    override fun onDestroy() {
        lifecycle.removeObserver(lifecycleObserver)
        onNetworkingBackgrounded()
        super.onDestroy()
        reconnectHandler.removeCallbacks(reconnectRunnable)
        reconnectHandler.removeCallbacks(transferTimeoutRunnable)
        reconnectScheduled = false
        connectionGeneration++
        webSocket?.cancel()
        webSocket = null
        isConnected = false
        connectionAttemptInProgress = false
        client.dispatcher.cancelAll()
        client.connectionPool.evictAll()
        client.dispatcher.executorService.shutdown()
        cameraReady = false
        cameraExecutor.shutdown()
        transferExecutor.shutdown()
    }

    companion object {
        private const val TAG = "TetherCam"
        private const val TRANSFER_ACK_TIMEOUT_MS = 45_000L
        private const val MIN_RECONNECT_MAX_INTERVAL_MS = 1_000L
        private const val DEFAULT_RECONNECT_MAX_INTERVAL_MS = 30_000L
        private const val MAX_RECONNECT_MAX_INTERVAL_MS = 600_000L
        private const val MAX_PENDING_TRANSFERS = 3
        private const val MAX_PENDING_TRANSFER_BYTES = 128L * 1024 * 1024
        private const val DEFAULT_MAX_IMAGE_BYTES = 32 * 1024 * 1024
        private const val MAX_IMAGE_BYTES = 128 * 1024 * 1024
        private const val MAX_IMAGE_CHUNK_BYTES = 1024 * 1024
        private const val REQUEST_CODE_PERMISSIONS = 10
        private const val KEY_CAMERA_PERMISSION_REQUESTED = "CameraPermissionRequested"
        private val REQUIRED_PERMISSIONS = arrayOf(Manifest.permission.CAMERA)
    }
}
