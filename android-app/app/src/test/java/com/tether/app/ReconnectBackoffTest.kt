package com.tether.app

import org.junit.Assert.assertEquals
import org.junit.Test

class ReconnectBackoffTest {
    @Test
    fun repeatedFailuresBackOffAndRemainAtConfiguredMaximum() {
        val backoff = ReconnectBackoff(maxIntervalMs = 8_000L) { 0.5 }
        val delays = List(8) { backoff.nextDelay() }
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 8_000L, 8_000L, 8_000L, 8_000L), delays)
    }

    @Test
    fun resetAfterConnectionRestartsBackoffSequence() {
        val backoff = ReconnectBackoff(maxIntervalMs = 10_000L) { 0.5 }
        assertEquals(1_000L, backoff.nextDelay())
        assertEquals(2_000L, backoff.nextDelay())
        backoff.reset()
        assertEquals(1_000L, backoff.nextDelay())
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsMaximumBelowBaseInterval() {
        ReconnectBackoff(maxIntervalMs = 999L)
    }
}
