package com.traderescue.app.data

import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Matches app/packet.py's DEMO_SECRET and the web UI's SIGNING_SECRET
 * exactly -- a packet signed on any of the three verifies on the backend.
 * This is a demo-only convention, called out the same way in both other
 * builds: a real device would generate and hold its own secret in the
 * Android Keystore, never a constant in source.
 */
const val SIGNING_SECRET = "TRADERESCUE_DEMO_SECRET_NOT_FOR_PRODUCTION"

object PacketSigner {
    private val random = SecureRandom()

    fun randomHex(bytes: Int): String {
        val b = ByteArray(bytes)
        random.nextBytes(b)
        return b.joinToString("") { "%02x".format(it) }
    }

    /** HMAC-SHA256, truncated to 32 hex chars -- same truncation as the
     * Python and JS implementations, kept short to fit an SMS. */
    fun hmacSha256Hex(secret: String, message: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        val raw = mac.doFinal(message.toByteArray(Charsets.UTF_8))
        return raw.joinToString("") { "%02x".format(it) }.take(32)
    }
}
