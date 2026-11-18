package com.traderescue.app.data

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * HKDF-SHA256, matching `deriveSubKey` in the backend's keys.js.
 *
 * The device enrolls once and receives one secret. Both ends then derive
 * the same two sub-keys from it under direction labels: one the phone signs
 * orders with, one the server signs confirmations with. The labels are what
 * stop a confirmation being reflected back as an order -- a reply simply is
 * not a valid order signature, with no check needing to remember to look
 * for it.
 *
 * The salt is empty because the device secret is already full-entropy
 * random from the server, so the extract step has nothing to concentrate.
 */
object Hkdf {
    private const val HMAC = "HmacSHA256"
    private const val HASH_LEN = 32

    /** The direction labels. These are protocol, not naming: do not reword. */
    const val DIRECTION_REQUEST = "req"
    const val DIRECTION_RESPONSE = "resp"

    /** Includes the format version so a future format cannot reuse a sub-key. */
    fun infoFor(direction: String): String = "TRX3-$direction"

    fun deriveSubKey(secret: ByteArray, direction: String): ByteArray {
        require(direction == DIRECTION_REQUEST || direction == DIRECTION_RESPONSE) {
            "unknown key direction: $direction"
        }
        return expand(extract(secret), infoFor(direction).toByteArray(Charsets.UTF_8), HASH_LEN)
    }

    fun requestKey(secret: ByteArray): ByteArray = deriveSubKey(secret, DIRECTION_REQUEST)

    fun responseKey(secret: ByteArray): ByteArray = deriveSubKey(secret, DIRECTION_RESPONSE)

    /** PRK = HMAC(salt, IKM), with an empty salt of hash length. */
    private fun extract(ikm: ByteArray): ByteArray = hmac(ByteArray(HASH_LEN), ikm)

    /** One round is enough: 32 bytes out of a 32-byte hash. */
    private fun expand(prk: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length <= HASH_LEN) { "this implementation does one HKDF round" }
        return hmac(prk, info + byteArrayOf(1)).copyOf(length)
    }

    private fun hmac(key: ByteArray, message: ByteArray): ByteArray {
        val mac = Mac.getInstance(HMAC)
        mac.init(SecretKeySpec(key, HMAC))
        return mac.doFinal(message)
    }

    /** Hex in, bytes out, for the secret as the server sends it at enrollment. */
    fun fromHex(hex: String): ByteArray {
        require(hex.length % 2 == 0) { "a hex secret has an even number of characters" }
        return ByteArray(hex.length / 2) { i ->
            ((hex[i * 2].digitToInt(16) shl 4) or hex[i * 2 + 1].digitToInt(16)).toByte()
        }
    }
}
