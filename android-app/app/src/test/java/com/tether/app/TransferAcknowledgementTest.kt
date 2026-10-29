package com.tether.app

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import java.nio.charset.StandardCharsets
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TransferAcknowledgementTest {
    @Test
    fun onlyPersistedAcknowledgementForThePendingCaptureCompletesTransfer() {
        val captureId = "12345678-1234-4123-8123-123456789abc"
        val token = "a".repeat(64)
        val sha256 = "b".repeat(64)
        val payload = listOf(captureId, sha256, "123", "ACKNOWLEDGED", "true").joinToString("\n")
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(token.toByteArray(StandardCharsets.UTF_8), "HmacSHA256"))
        val proof = mac.doFinal(payload.toByteArray(StandardCharsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }

        assertTrue(isPersistedCaptureAcknowledgement(captureId, sha256, 123, captureId, "ACKNOWLEDGED", true, sha256, 123, proof, token))
        assertFalse(isPersistedCaptureAcknowledgement(captureId, sha256, 123, "other-capture", "ACKNOWLEDGED", true, sha256, 123, proof, token))
        assertFalse(isPersistedCaptureAcknowledgement(captureId, sha256, 123, captureId, "ACKNOWLEDGED", true, "c".repeat(64), 123, proof, token))
        assertFalse(isPersistedCaptureAcknowledgement(captureId, sha256, 123, captureId, "ACKNOWLEDGED", true, sha256, 124, proof, token))
        assertFalse(isPersistedCaptureAcknowledgement(captureId, sha256, 123, captureId, "ACKNOWLEDGED", false, sha256, 123, proof, token))
        assertFalse(isPersistedCaptureAcknowledgement(captureId, sha256, 123, captureId, "FILE_SAVED", true, sha256, 123, proof, token))
        assertFalse(isPersistedCaptureAcknowledgement(captureId, sha256, 123, captureId, "ACKNOWLEDGED", true, sha256, 123, "0".repeat(64), token))
    }
}
