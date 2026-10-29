package com.tether.app

import org.junit.Assert.assertEquals
import org.junit.Test

class NetworkChangePolicyTest {
    @Test
    fun availabilityAndRepeatedCallbacksDoNotCreateDuplicateChanges() {
        val policy = NetworkChangePolicy()

        assertEquals(NetworkChange.UNAVAILABLE, policy.update(null))
        assertEquals(NetworkChange.AVAILABLE, policy.update("wifi"))
        assertEquals(NetworkChange.UNCHANGED, policy.update("wifi"))
        assertEquals(NetworkChange.UNCHANGED, policy.update("wifi"))
    }

    @Test
    fun networkReplacementAndIpOrRouteChangeInvalidateConnection() {
        val policy = NetworkChangePolicy()

        assertEquals(NetworkChange.AVAILABLE, policy.update("wifi", "ip-a/routes-a"))
        assertEquals(NetworkChange.UNCHANGED, policy.update("wifi", "ip-a/routes-a"))
        assertEquals(NetworkChange.CHANGED, policy.update("wifi", "ip-b/routes-b"))
        assertEquals(NetworkChange.CHANGED, policy.update("cellular", "ip-c/routes-c"))
    }

    @Test
    fun lossAndForegroundReavailabilityStartANewNetworkSession() {
        val policy = NetworkChangePolicy()

        assertEquals(NetworkChange.AVAILABLE, policy.update("wifi"))
        assertEquals(NetworkChange.LOST, policy.update(null))
        assertEquals(NetworkChange.UNAVAILABLE, policy.update(null))
        assertEquals(NetworkChange.AVAILABLE, policy.update("wifi"))
    }

    @Test
    fun resetPreventsAnOldNetworkFromBeingTreatedAsCurrent() {
        val policy = NetworkChangePolicy()
        assertEquals(NetworkChange.AVAILABLE, policy.update("wifi", "old-address"))

        policy.reset()

        assertEquals(NetworkChange.AVAILABLE, policy.update("wifi", "new-address"))
    }
}
