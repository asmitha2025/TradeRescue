package com.traderescue.app.data

/** Mirrors ui/index.html's holdings exactly, so the two builds show the same demo state. */
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
 * The compact, SMS-sized packet from the design doc:
 *   TRX|tx_id|user_id|action|symbol|qty|order_type|nonce|timestamp|signature
 * action is "S"/"B", order_type is "M"/"L" -- identical to app/packet.py on
 * the backend and to the web UI's JS, so a packet built on any of the three
 * verifies on the backend the same way.
 */
data class EmergencyPacket(
    val txId: String,
    val userId: String,
    val action: String,
    val symbol: String,
    val qty: Int,
    val orderType: String,
    val nonce: String,
    val timestamp: Long,
) {
    fun signingPayload(): String =
        listOf(txId, userId, action, symbol, qty.toString(), orderType, nonce, timestamp.toString())
            .joinToString("|")

    fun toWire(signature: String): String = "TRX|${signingPayload()}|$signature"

    companion object {
        fun build(userId: String, action: String, symbol: String, qty: Int, orderType: String = "M"): EmergencyPacket =
            EmergencyPacket(
                txId = "TRX" + PacketSigner.randomHex(3).uppercase(),
                userId = userId,
                action = action,
                symbol = symbol,
                qty = qty,
                orderType = orderType,
                nonce = PacketSigner.randomHex(4),
                timestamp = System.currentTimeMillis() / 1000,
            )
    }
}
