package com.traderescue.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PacketTest {
    private val fixed = EmergencyPacket(
        txId = "TRX0A1B2C", userId = "U10021", action = "S", symbol = "RELIANCE",
        qty = 5, orderType = "M", nonce = "deadbeef", timestamp = 1700000000,
    )

    @Test
    fun hmacMatchesPublishedTestVector() {
        // The widely published HMAC-SHA256 example, truncated to 32 hex chars.
        assertEquals(
            "f7bc83f430538424b13298e6aa6fb143",
            PacketSigner.hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog"),
        )
    }

    @Test
    fun signingPayloadHasTheAgreedFieldOrder() {
        assertEquals("TRX0A1B2C|U10021|S|RELIANCE|5|M|deadbeef|1700000000", fixed.signingPayload())
    }

    @Test
    fun wirePacketMatchesReferenceSignature() {
        // Expected signature computed independently with .NET's HMACSHA256.
        val sig = PacketSigner.hmacSha256Hex(SIGNING_SECRET, fixed.signingPayload())
        assertEquals("30727513722d65e08ca55805de554550", sig)
        assertEquals(
            "TRX|TRX0A1B2C|U10021|S|RELIANCE|5|M|deadbeef|1700000000|30727513722d65e08ca55805de554550",
            fixed.toWire(sig),
        )
    }

    @Test
    fun builtPacketFitsOneSmsSegment() {
        val p = EmergencyPacket.build("U10021", "S", "BAJAJFINSV", 99999)
        val wire = p.toWire(PacketSigner.hmacSha256Hex(SIGNING_SECRET, p.signingPayload()))
        assertEquals(10, wire.split("|").size)
        assertTrue("was ${wire.length} chars", wire.length <= 160)
    }

    @Test
    fun everyPacketGetsAFreshNonceAndTxId() {
        val a = EmergencyPacket.build("U10021", "S", "TCS", 1)
        val b = EmergencyPacket.build("U10021", "S", "TCS", 1)
        assertNotEquals(a.nonce, b.nonce)
        assertNotEquals(a.txId, b.txId)
    }

    @Test
    fun emergencyLimitCapsWhatCanBeSold() {
        assertEquals(10, Holding("TCS", 10, 1.0, 0.0, 50).maxSellable)
        assertEquals(20, Holding("X", 100, 1.0, 0.0, 20).maxSellable)
        assertEquals(0, Holding("X", 0, 1.0, 0.0, 20).maxSellable)
    }
}
