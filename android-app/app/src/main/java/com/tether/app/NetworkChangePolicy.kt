package com.tether.app

internal enum class NetworkChange {
    UNAVAILABLE,
    LOST,
    AVAILABLE,
    CHANGED,
    UNCHANGED
}

internal class NetworkChangePolicy {
    private var networkKey: String? = null
    private var fingerprint: String? = null

    @Synchronized
    fun update(nextNetworkKey: String?, nextFingerprint: String? = null): NetworkChange {
        if (nextNetworkKey == null) {
            if (networkKey == null) return NetworkChange.UNAVAILABLE
            networkKey = null
            fingerprint = null
            return NetworkChange.LOST
        }

        val previousNetworkKey = networkKey
        val previousFingerprint = fingerprint
        val networkReplaced = previousNetworkKey != null && previousNetworkKey != nextNetworkKey
        if (networkReplaced) fingerprint = null
        networkKey = nextNetworkKey
        if (nextFingerprint != null) fingerprint = nextFingerprint

        if (previousNetworkKey == null) return NetworkChange.AVAILABLE
        if (networkReplaced ||
            (previousFingerprint != null &&
                nextFingerprint != null &&
                previousFingerprint != nextFingerprint)) {
            return NetworkChange.CHANGED
        }
        return NetworkChange.UNCHANGED
    }

    @Synchronized
    fun reset() {
        networkKey = null
        fingerprint = null
    }
}
