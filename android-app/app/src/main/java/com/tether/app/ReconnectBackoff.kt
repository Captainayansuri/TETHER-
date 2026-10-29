package com.tether.app

import kotlin.math.min

class ReconnectBackoff(
    maxIntervalMs: Long = DEFAULT_MAX_INTERVAL_MS,
    private val random: () -> Double = { kotlin.random.Random.nextDouble() }
) {
    var maxIntervalMs: Long = maxIntervalMs
        set(value) {
            require(value in MIN_INTERVAL_MS..MAX_INTERVAL_MS)
            field = value
        }

    private var attempt = 0

    init {
        require(maxIntervalMs in MIN_INTERVAL_MS..MAX_INTERVAL_MS)
    }

    fun nextDelay(): Long {
        val multiplier = 1L shl min(attempt, 19)
        attempt += 1
        val ceiling = min(maxIntervalMs, BASE_INTERVAL_MS * multiplier)
        val jittered = (ceiling * (0.8 + random() * 0.4)).toLong()
        return min(maxIntervalMs, jittered)
    }

    fun reset() {
        attempt = 0
    }

    companion object {
        private const val BASE_INTERVAL_MS = 1_000L
        private const val DEFAULT_MAX_INTERVAL_MS = 30_000L
        private const val MIN_INTERVAL_MS = 1_000L
        private const val MAX_INTERVAL_MS = 600_000L
    }
}
