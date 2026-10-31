package com.tether.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class TlsPinningTest {
    private val validPin = "sha256/" + "A".repeat(43) + "="

    @Test
    fun onlyAcceptsSha256SpkiPins() {
        assertEquals(validPin, normalizeCertificatePin("  $validPin  "))
        assertNull(normalizeCertificatePin("sha1/" + "A".repeat(27) + "="))
        assertNull(normalizeCertificatePin("sha256/short"))
    }

    @Test
    fun pinnedClientRequiresSecureWebSocketAndAttachesPinToRequestedHost() {
        val client = createPinnedOkHttpClient("wss://192.168.1.15:8080", validPin)
        assertNotNull(client.certificatePinner.findMatchingPins("192.168.1.15").singleOrNull())
        assertThrows(IllegalArgumentException::class.java) {
            createPinnedOkHttpClient("ws://192.168.1.15:8080", validPin)
        }
        assertThrows(IllegalArgumentException::class.java) {
            createPinnedOkHttpClient("https://192.168.1.15:8080", validPin)
        }
        assertThrows(IllegalArgumentException::class.java) {
            createPinnedOkHttpClient("wss://192.168.1.15:8080", "sha256/bad")
        }
    }
}
