package com.traderescue.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PacketTest {
    /**
     * The same reference packet the backend's test/packet.test.js pins, so
     * a format change on either side breaks a test on that side.
     *
     * The 30-minute expires_at here is deliberately longer than the
     * server's 15-minute cap: the server takes whichever comes first, and
     * this fixture is what proves a packet cannot buy itself more time.
     */
    private val fixed = EmergencyPacket(
        txId = "TRX0A1B2C", userId = "U10021", action = "S", symbol = "RELIANCE",
        qty = 5, orderType = "I", floorPaise = 148000, expiresAt = 1700001800,
        nonce = "deadbeef", timestamp = 1700000000,
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
        assertEquals(
            "TRX2|TRX0A1B2C|U10021|S|RELIANCE|5|I|148000|1700001800|deadbeef|1700000000",
            fixed.signingPayload(),
        )
    }

    @Test
    fun wirePacketMatchesReferenceSignature() {
        val sig = PacketSigner.hmacSha256Hex(SIGNING_SECRET, fixed.signingPayload())
        assertEquals("bb983dacfcd5053a247949e396fd4dcf", sig)
        assertEquals(
            "TRX2|TRX0A1B2C|U10021|S|RELIANCE|5|I|148000|1700001800|deadbeef|1700000000|" +
                "bb983dacfcd5053a247949e396fd4dcf",
            fixed.toWire(sig),
        )
    }

    @Test
    fun theVersionIsCoveredBySignatureSoV1CannotBeRewrittenIntoV2() {
        // Field 0 is inside the signed payload, so flipping a v1 prefix to
        // TRX2 changes what was signed and the backend refuses it.
        assertTrue(fixed.signingPayload().startsWith("TRX2|"))
        val v1Style = fixed.signingPayload().removePrefix("TRX2|")
        assertNotEquals(
            PacketSigner.hmacSha256Hex(SIGNING_SECRET, fixed.signingPayload()),
            PacketSigner.hmacSha256Hex(SIGNING_SECRET, v1Style),
        )
    }

    @Test
    fun builtPacketFitsOneSmsSegment() {
        val p = EmergencyPacket.build("U10021", "S", "BAJAJFINSV", 99999)
        val wire = p.toWire(PacketSigner.hmacSha256Hex(SIGNING_SECRET, p.signingPayload()))
        assertEquals(12, wire.split("|").size)
        assertTrue("was ${wire.length} chars", wire.length <= 160)
    }

    /**
     * The one-segment limit is the constraint the whole format exists to
     * respect, so it is checked at the widest packet the backend will
     * accept rather than the typical one. The limits are a shared budget:
     * if either side widens a field past it, this fails on this side and
     * the matching test fails on the other.
     */
    @Test
    fun theLongestPermittedPacketStillFitsOneSmsSegment() {
        val limits = EmergencyPacket.LIMITS
        val worst = EmergencyPacket(
            txId = "T".repeat(limits.getValue("txId")),
            userId = "U".repeat(limits.getValue("userId")),
            action = "S",
            symbol = "B".repeat(limits.getValue("symbol")),
            qty = "9".repeat(limits.getValue("qty")).toInt(),
            orderType = "I",
            floorPaise = "9".repeat(limits.getValue("floorPaise")).toLong(),
            expiresAt = "9".repeat(limits.getValue("expiresAt")).toLong(),
            nonce = "f".repeat(limits.getValue("nonce")),
            timestamp = "9".repeat(limits.getValue("timestamp")).toLong(),
        )
        val wire = worst.toWire(PacketSigner.hmacSha256Hex(SIGNING_SECRET, worst.signingPayload()))
        assertEquals(EmergencyPacket.maxPermittedWireLength(), wire.length)
        assertTrue(
            "the widest permitted packet was ${wire.length} chars",
            wire.length <= EmergencyPacket.MAX_WIRE_LENGTH,
        )
    }

    @Test
    fun theAppStaysWellInsideEveryFieldLimit() {
        val p = EmergencyPacket.build("U10021", "S", "BAJAJFINSV", 50)
        val limits = EmergencyPacket.LIMITS
        assertTrue("tx_id ${p.txId}", p.txId.length <= limits.getValue("txId"))
        assertTrue("user_id ${p.userId}", p.userId.length <= limits.getValue("userId"))
        assertTrue("nonce ${p.nonce}", p.nonce.length <= limits.getValue("nonce"))
        assertTrue("symbol ${p.symbol}", p.symbol.length <= limits.getValue("symbol"))
    }

    @Test
    fun packetIsGsm7SoItDoesNotSilentlyBecomeTwoSegments() {
        // A single non-GSM-7 character would switch the message to UCS-2
        // and halve the segment to 70 characters.
        val p = EmergencyPacket.build("U10021", "S", "RELIANCE", 5)
        val wire = p.toWire(PacketSigner.hmacSha256Hex(SIGNING_SECRET, p.signingPayload()))
        assertTrue("non-ASCII in $wire", wire.all { it.code in 0x20..0x7e })
    }

    @Test
    fun buildAsksForIocAndAnExpiryInsideTheServerCap() {
        val p = EmergencyPacket.build("U10021", "S", "TCS", 1, nowSeconds = 1700000000)
        assertEquals(EmergencyPacket.ORDER_TYPE_IOC, p.orderType)
        assertEquals(1700000000 + EmergencyPacket.DEFAULT_VALIDITY_SECONDS, p.expiresAt)
        // The server caps validity at 15 minutes; asking for more would
        // just be ignored, so the app does not ask.
        assertTrue(p.expiresAt - p.timestamp <= 15 * 60)
    }

    @Test
    fun defaultIsNoFloorAndAFloorConvertsToPaise() {
        assertEquals(0L, EmergencyPacket.build("U10021", "S", "TCS", 1).floorPaise)
        assertEquals(148520L, EmergencyPacket.floorPaise(1485.20))
        assertEquals(100L, EmergencyPacket.floorPaise(1.0))
        // Rounding, not truncation: a floor must never end up lower than
        // the user asked for by a paisa.
        assertEquals(149L, EmergencyPacket.floorPaise(1.485))
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
