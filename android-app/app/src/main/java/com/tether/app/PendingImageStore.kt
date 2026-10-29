package com.tether.app

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID

internal data class StoredCapture(
    val captureId: String,
    val file: File,
    val size: Int,
    val sha256: String
)

internal class PendingImageStore(
    private val directory: File,
    private val maxItems: Int,
    private val maxBytes: Long,
    private val minimumFreeBytes: Long = DEFAULT_MINIMUM_FREE_BYTES,
    private val availableBytes: () -> Long = { directory.usableSpace }
) {
    private val captures = LinkedHashMap<String, StoredCapture>()

    init {
        require(maxItems > 0)
        require(maxBytes > 0)
        require(minimumFreeBytes >= 0)
        if (!directory.exists() && !directory.mkdirs()) {
            throw IOException("Could not create the pending image directory")
        }
        if (!directory.isDirectory) {
            throw IOException("Pending image storage is not a directory")
        }
        recover()
    }

    @Synchronized
    fun list(): List<StoredCapture> = captures.values.toList()

    @Synchronized
    fun enqueue(bytes: ByteArray): StoredCapture {
        if (bytes.size < 3 ||
            bytes[0] != 0xff.toByte() ||
            bytes[1] != 0xd8.toByte() ||
            bytes[2] != 0xff.toByte()) {
            throw PendingImageStorageException("Camera returned an invalid JPEG image")
        }
        val queuedBytes = captures.values.sumOf { it.size.toLong() }
        if (captures.size >= maxItems || queuedBytes + bytes.size > maxBytes) {
            throw PendingImageStorageException("Transfer queue is full")
        }
        if (availableBytes() < bytes.size + minimumFreeBytes) {
            throw PendingImageStorageException("Not enough device storage to queue this image")
        }

        val captureId = UUID.randomUUID().toString()
        val digest = sha256(bytes)
        val temporaryFile = File(directory, ".$captureId.tmp")
        val finalFile = File(directory, "${captureId}_$digest.jpg")
        try {
            if (finalFile.exists()) throw IOException("Pending image identifier already exists")
            FileOutputStream(temporaryFile).use { output ->
                output.write(bytes)
                output.fd.sync()
            }
            if (!temporaryFile.renameTo(finalFile)) {
                throw IOException("Could not finalize the pending image")
            }
        } catch (error: Exception) {
            temporaryFile.delete()
            throw PendingImageStorageException(
                if (error is IOException) "Could not save the pending image" else "Could not queue the image",
                error
            )
        }

        return StoredCapture(captureId, finalFile, bytes.size, digest).also {
            captures[captureId] = it
        }
    }

    @Synchronized
    fun remove(captureId: String) {
        val capture = captures.remove(captureId) ?: return
        if (capture.file.exists() && !capture.file.delete()) {
            captures[captureId] = capture
            throw IOException("Could not remove the completed pending image")
        }
    }

    private fun recover() {
        val entries = directory.listFiles() ?: throw IOException("Could not read pending image storage")
        for (entry in entries.sortedBy { it.lastModified() }) {
            if (entry.isFile && entry.name.matches(TEMPORARY_FILE_PATTERN)) {
                if (!entry.delete()) throw IOException("Could not remove an incomplete pending image")
                continue
            }
            val match = PENDING_FILE_PATTERN.matchEntire(entry.name) ?: continue
            if (!entry.isFile) continue
            val captureId = match.groupValues[1]
            val expectedDigest = match.groupValues[2]
            val queuedBytes = captures.values.sumOf { it.size.toLong() }
            if (captures.size >= maxItems ||
                entry.length() <= 0L ||
                entry.length() > maxBytes ||
                queuedBytes + entry.length() > maxBytes) {
                if (!entry.delete()) throw IOException("Could not remove an invalid pending image")
                continue
            }
            if (entry.length() < 3L ||
                !hasJpegSignature(entry) ||
                sha256(entry) != expectedDigest) {
                if (!entry.delete()) throw IOException("Could not remove a corrupt pending image")
                continue
            }
            captures[captureId] = StoredCapture(
                captureId,
                entry,
                entry.length().toInt(),
                expectedDigest
            )
        }
    }

    private fun hasJpegSignature(file: File): Boolean =
        FileInputStream(file).use { input ->
            input.read() == 0xff &&
                input.read() == 0xd8 &&
                input.read() == 0xff
        }

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    companion object {
        const val DEFAULT_MINIMUM_FREE_BYTES = 5L * 1024 * 1024
        private val PENDING_FILE_PATTERN = Regex(
            "^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([0-9a-f]{64})\\.jpg$",
            RegexOption.IGNORE_CASE
        )
        private val TEMPORARY_FILE_PATTERN = Regex(
            "^\\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.tmp$",
            RegexOption.IGNORE_CASE
        )
    }
}

internal class PendingImageStorageException(
    message: String,
    cause: Throwable? = null
) : IOException(message, cause)
