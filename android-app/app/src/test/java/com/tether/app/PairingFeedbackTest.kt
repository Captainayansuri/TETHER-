package com.tether.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingFeedbackTest {
    @Test
    fun expiredAndInvalidTokensTellTheUserHowToRepair() {
        val expired = PairingFeedback.authenticationFailure("TOKEN_EXPIRED")
        assertTrue(expired.needsFreshToken)
        assertTrue(expired.text.contains("current token"))
        assertTrue(expired.text.contains("Re-pair and Retry"))

        val invalid = PairingFeedback.authenticationFailure("AUTH_FAILED")
        assertTrue(invalid.needsFreshToken)
        assertTrue(invalid.text.contains("desktop restart"))
    }

    @Test
    fun busyServerCanBeRetriedWithoutReplacingTheToken() {
        val busy = PairingFeedback.authenticationFailure("SERVER_BUSY")
        assertFalse(busy.needsFreshToken)
        assertTrue(busy.text.contains("Retry Connection"))
    }

    @Test
    fun unreachableDesktopExplainsNetworkChecksAndAutomaticRetry() {
        val message = PairingFeedback.desktopUnreachable()
        assertTrue(message.contains("same Wi-Fi"))
        assertTrue(message.contains("Automatic retry is active"))
        assertTrue(message.contains("Retry Connection"))
    }
}
