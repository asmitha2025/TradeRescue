package com.traderescue.app.data

import java.security.SecureRandom

/**
 * Random material for packets.
 *
 * There is no signing secret here any more. Every device holds its own key,
 * imported into the Android Keystore at enrollment and used through
 * [DeviceKeys] -- which means a signature now needs the user present, and a
 * constant in source cannot produce one.
 */
object PacketSigner {
    private val random = SecureRandom()

    fun randomHex(bytes: Int): String {
        val b = ByteArray(bytes)
        random.nextBytes(b)
        return b.joinToString("") { "%02x".format(it) }
    }
}
