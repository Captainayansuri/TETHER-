package com.tether.app

import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PendingImageStoreTest {
    @Test
    fun storesOriginalBytesAndRecoversThemAfterStoreRecreation() {
        withDirectory { directory ->
            val source = fakeJpeg(128)
            val store = PendingImageStore(directory, maxItems = 3, maxBytes = 1024, minimumFreeBytes = 0)
            val queued = store.enqueue(source)

            assertArrayEquals(source, queued.file.readBytes())
            assertEquals(source.size, queued.size)
            assertEquals(sha256(source), queued.sha256)

            val recovered = PendingImageStore(directory, maxItems = 3, maxBytes = 1024, minimumFreeBytes = 0)
            assertEquals(1, recovered.list().size)
            assertEquals(queued.captureId, recovered.list().single().captureId)
            assertArrayEquals(source, recovered.list().single().file.readBytes())
        }
    }

    @Test
    fun enforcesItemAndByteBoundsAndRemovesAcknowledgedFiles() {
        withDirectory { directory ->
            val store = PendingImageStore(directory, maxItems = 2, maxBytes = 20, minimumFreeBytes = 0)
            val first = store.enqueue(fakeJpeg(10))
            store.enqueue(fakeJpeg(10))
            assertThrows<PendingImageStorageException> { store.enqueue(fakeJpeg(3)) }
            store.remove(first.captureId)
            assertFalse(first.file.exists())
            assertEquals(1, store.list().size)
            assertThrows<PendingImageStorageException> { store.enqueue(fakeJpeg(11)) }
        }
    }

    @Test
    fun repeatedImageCapturesReceiveDistinctIdsAndAcknowledgingOneDoesNotRemoveAnother() {
        withDirectory { directory ->
            val store = PendingImageStore(directory, maxItems = 3, maxBytes = 1024, minimumFreeBytes = 0)
            val image = fakeJpeg(32)
            val first = store.enqueue(image)
            val second = store.enqueue(image)

            assertFalse(first.captureId == second.captureId)
            assertEquals(2, store.list().size)
            store.remove(first.captureId)

            val recovered = PendingImageStore(directory, maxItems = 3, maxBytes = 1024, minimumFreeBytes = 0)
            assertEquals(listOf(second.captureId), recovered.list().map { it.captureId })
            assertArrayEquals(image, recovered.list().single().file.readBytes())
        }
    }

    @Test
    fun recoveryRemovesInterruptedAndCorruptQueueFiles() {
        withDirectory { directory ->
            val valid = fakeJpeg(64)
            val validDigest = sha256(valid)
            val validId = "12345678-1234-4123-8123-123456789abc"
            File(directory, "${validId}_$validDigest.jpg").writeBytes(valid)
            File(directory, ".12345678-1234-4123-8123-123456789abd.tmp").writeText("partial")
            File(directory, "12345678-1234-4123-8123-123456789abe_${"0".repeat(64)}.jpg")
                .writeBytes(fakeJpeg(64))

            val store = PendingImageStore(directory, maxItems = 3, maxBytes = 1024, minimumFreeBytes = 0)

            assertEquals(listOf(validId), store.list().map { it.captureId })
            assertEquals(1, directory.listFiles()?.size)
        }
    }

    @Test
    fun refusesNonJpegDataWithoutCreatingQueueFiles() {
        withDirectory { directory ->
            val store = PendingImageStore(directory, maxItems = 3, maxBytes = 1024, minimumFreeBytes = 0)
            assertThrows<PendingImageStorageException> { store.enqueue(ByteArray(32) { 0x01 }) }
            assertTrue(directory.listFiles().orEmpty().isEmpty())
        }
    }

    @Test
    fun reportsInsufficientFreeStorageWithoutCreatingAQueueEntry() {
        withDirectory { directory ->
            val store = PendingImageStore(
                directory,
                maxItems = 3,
                maxBytes = 1024,
                minimumFreeBytes = 5,
                availableBytes = { 4 }
            )
            assertThrows<PendingImageStorageException> { store.enqueue(fakeJpeg(32)) }
            assertTrue(store.list().isEmpty())
            assertTrue(directory.listFiles().orEmpty().isEmpty())
        }
    }

    private fun fakeJpeg(size: Int): ByteArray =
        ByteArray(size).also {
            it[0] = 0xff.toByte()
            it[1] = 0xd8.toByte()
            it[2] = 0xff.toByte()
            it[3] = 0xdb.toByte()
        }

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }

    private inline fun withDirectory(block: (File) -> Unit) {
        val directory = Files.createTempDirectory("tether-pending-images").toFile()
        try {
            block(directory)
        } finally {
            directory.deleteRecursively()
        }
    }

    private inline fun <reified T : Throwable> assertThrows(block: () -> Unit) {
        try {
            block()
        } catch (error: Throwable) {
            if (error is T) return
            throw AssertionError("Expected ${T::class.java.simpleName}, got ${error::class.java.simpleName}", error)
        }
        throw AssertionError("Expected ${T::class.java.simpleName}")
    }
}
