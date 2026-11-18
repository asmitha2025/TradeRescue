package com.traderescue.app.data

/** The holdings the demo starts from, matching the backend's demoHoldings(). */
data class Holding(
    val symbol: String,
    val qty: Int,
    val price: Double,
    val changePct: Double,
    val emergencyLimit: Int,
) {
    /** Most that can go out through the emergency channel right now. */
    val maxSellable: Int get() = minOf(qty, emergencyLimit)
}

fun demoHoldings(): List<Holding> = listOf(
    Holding("RELIANCE", 20, 1485.20, -0.8, 20),
    Holding("TCS", 10, 3421.50, 0.3, 50),
    Holding("INFY", 15, 1612.30, -1.2, 30),
)

/**
 * The compact, SMS-sized emergency packet:
 *
 *   TRX3|key_id|tx_id|user_id|action|symbol|qty|order_type|floor|expires_at|nonce|timestamp|signature
 *
 * `key_id` names the device key that signed this packet, so the server
 * knows which key to check against before it checks anything else. Every
 * device has its own, handed over once at enrollment; there is no longer
 * any secret shared by every install.
 *
 * action is "S"/"B" and order_type is "I" for immediate-or-cancel, the only
 * type the emergency channel places: it fills at the available price or not
 * at all. `floor` is a price floor in paise, 0 meaning "exit at any price",
 * which keeps the comparison off floating point on both sides.
 *
 * The version is field 0 and is covered by the signature, so an older TRX
 * or TRX2 packet cannot be passed off as a v3 one -- it fails on the field
 * count and, failing that, on the signature.
 *
 * Identical to packet.js on the backend, which is what makes a packet built
 * here verify there. PacketTest.kt and test/packet.test.js pin the same
 * reference packet, so a change on either side fails a test on that side.
 */
data class EmergencyPacket(
    val keyId: String,
    val txId: String,
    val userId: String,
    val action: String,
    val symbol: String,
    val qty: Int,
    val orderType: String,
    val floorPaise: Long,
    val expiresAt: Long,
    val nonce: String,
    val timestamp: Long,
) {
    fun signingPayload(): String =
        listOf(
            VERSION, keyId, txId, userId, action, symbol, qty.toString(), orderType,
            floorPaise.toString(), expiresAt.toString(), nonce, timestamp.toString(),
        ).joinToString("|")

    fun toWire(signature: String): String = "${signingPayload()}|$signature"

    companion object {
        const val VERSION = "TRX3"

        /** Immediate-or-cancel: the only order type the emergency path takes. */
        const val ORDER_TYPE_IOC = "I"

        /**
         * How long a packet asks to stay valid. Comfortably inside the
         * server's 15-minute cap, with room for SMS store-and-forward to
         * take its time -- an emergency exit that expires in transit is
         * worse than useless.
         */
        const val DEFAULT_VALIDITY_SECONDS = 10L * 60

        /** Rupees as the user thinks of them, paise as the packet carries them. */
        fun floorPaise(rupees: Double): Long = Math.round(rupees * 100)

        /** One SMS segment in GSM-7, the constraint the format exists to respect. */
        const val MAX_WIRE_LENGTH = 160

        /**
         * The longest each variable field may be, matching LIMITS in the
         * backend's packet.js. The backend refuses anything longer, so
         * these are not style preferences: they are the character budget
         * that keeps the whole packet inside one segment, and the two ends
         * have to agree on them.
         *
         * key_id cost 8 characters plus a separator in TRX3. The nonce paid
         * most of that back, dropping from 16 to 12.
         */
        val LIMITS = mapOf(
            "keyId" to 8, "txId" to 12, "userId" to 12, "symbol" to 16, "qty" to 9,
            "floorPaise" to 10, "expiresAt" to 11, "nonce" to 12, "timestamp" to 11,
        )

        /** The longest packet the backend's shape checks will accept. */
        fun maxPermittedWireLength(): Int =
            VERSION.length +
                LIMITS.values.sum() +
                2 + // action and order_type, one character each
                12 + // the | separators
                32 // the truncated HMAC

        fun build(
            keyId: String,
            userId: String,
            action: String,
            symbol: String,
            qty: Int,
            floorPaise: Long = 0,
            validitySeconds: Long = DEFAULT_VALIDITY_SECONDS,
            nowSeconds: Long = System.currentTimeMillis() / 1000,
        ): EmergencyPacket =
            EmergencyPacket(
                keyId = keyId,
                txId = "TRX" + PacketSigner.randomHex(3).uppercase(),
                userId = userId,
                action = action,
                symbol = symbol,
                qty = qty,
                orderType = ORDER_TYPE_IOC,
                floorPaise = floorPaise,
                expiresAt = nowSeconds + validitySeconds,
                nonce = PacketSigner.randomHex(4),
                timestamp = nowSeconds,
            )
    }
}
