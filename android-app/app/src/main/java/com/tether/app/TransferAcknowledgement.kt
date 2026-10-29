package com.tether.app

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

internal fun isPersistedCaptureAcknowledgement(
    expectedCaptureId: String,
    expectedSha256: String,
    expectedSize: Long,
    responseCaptureId: String,
    state: String,
    persisted: Boolean,
    sha256: String,
    size: Long,
    proof: String,
    pairingToken: String
): Boolean {
    if (expectedCaptureId.isBlank() || responseCaptureId != expectedCaptureId ||
        sha256 != expectedSha256 || size != expectedSize ||
        state != "ACKNOWLEDGED" || !persisted || size <= 0 ||
        !sha256.matches(Regex("^[a-f0-9]{64}$")) ||
        !proof.matches(Regex("^[a-f0-9]{64}$")) ||
        !pairingToken.matches(Regex("^[a-f0-9]{64}$"))) return false

    val payload = listOf(responseCaptureId, sha256, size.toString(), state, persisted.toString())
        .joinToString("\n")
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(pairingToken.toByteArray(StandardCharsets.UTF_8), "HmacSHA256"))
    val expectedProof = mac.doFinal(payload.toByteArray(StandardCharsets.UTF_8))
    val receivedProof = proof.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    return MessageDigest.isEqual(expectedProof, receivedProof)
}
