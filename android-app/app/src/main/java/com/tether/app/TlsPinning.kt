package com.tether.app

import okhttp3.CertificatePinner
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

internal fun normalizeCertificatePin(value: String): String? {
    val normalized = value.trim()
    return normalized.takeIf { it.matches(Regex("^sha256/[A-Za-z0-9+/]{43}=$")) }
}

internal fun createPinnedOkHttpClient(serverUrl: String, certificatePin: String): OkHttpClient {
    require(serverUrl.startsWith("wss://", ignoreCase = true)) {
        "Secure WebSocket transport is required"
    }
    val httpsUrl = "https://${serverUrl.substringAfter("://")}".toHttpUrlOrNull()
        ?: throw IllegalArgumentException("Invalid desktop server URL")
    val pin = normalizeCertificatePin(certificatePin)
        ?: throw IllegalArgumentException("Invalid TETHER certificate pin")
    val certificatePinner = CertificatePinner.Builder()
        .add(httpsUrl.host, pin)
        .build()
    return OkHttpClient.Builder()
        .certificatePinner(certificatePinner)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()
}
