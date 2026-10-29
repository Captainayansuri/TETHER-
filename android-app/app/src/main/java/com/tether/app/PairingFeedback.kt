package com.tether.app

internal data class PairingFailureMessage(
    val text: String,
    val needsFreshToken: Boolean
)

internal object PairingFeedback {
    fun authenticationFailure(code: String): PairingFailureMessage = when (code) {
        "TOKEN_EXPIRED" -> PairingFailureMessage(
            "Pairing token expired. Copy the current token from TETHER, enter it below, then tap Re-pair and Retry.",
            needsFreshToken = true
        )
        "AUTH_FAILED" -> PairingFailureMessage(
            "TETHER rejected this token. It may be from before a desktop restart. Enter the current dashboard token and tap Re-pair and Retry.",
            needsFreshToken = true
        )
        "SERVER_BUSY" -> PairingFailureMessage(
            "TETHER is busy with the maximum number of devices. Tap Retry Connection in a moment.",
            needsFreshToken = false
        )
        else -> PairingFailureMessage(
            "TETHER could not verify pairing information ($code). Check the desktop address and current token, then retry.",
            needsFreshToken = true
        )
    }

    fun desktopUnreachable(): String =
        "Can't reach TETHER. Confirm the desktop is running, both devices use the same Wi-Fi, and the address below is current. Automatic retry is active; update the address and tap Retry Connection."
}
