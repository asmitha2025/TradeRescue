package com.traderescue.app.data

import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Matches DEMO_SECRET in the backend's packet.js, so a packet signed here
 * verifies there.
 *
 * Demo only, and the weakest part of the current design: one secret shared
 * by every install, sitting in source. Phase 3 replaces it with a key
 * provisioned per device at enrollment and held in the Android Keystore,
 * unlocked by biometrics or the device credential.
 */
const val SIGNING_SECRET = "TRADERESCUE_DEMO_SECRET_NOT_FOR_PRODUCTION"

object PacketSigner {
    private val random = SecureRandom()

    fun randomHex(bytes: Int): String {
        val b = ByteArray(bytes)
        random.nextBytes(b)
        return b.joinToString("") { "%02x".format(it) }
    }

    /** HMAC-SHA256, truncated to 32 hex chars -- the same 128-bit tag the
     * backend compares against, kept short to fit an SMS. */
    fun hmacSha256Hex(secret: String, message: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        val raw = mac.doFinal(message.toByteArray(Charsets.UTF_8))
        return raw.joinToString("") { "%02x".format(it) }.take(32)
    }
}
