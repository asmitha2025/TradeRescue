package com.traderescue.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PacketTest {
    /**
     * The same reference device and packet the backend's
     * test/packet.test.js pins, so a format change on either side breaks a
     * test on that side. This secret is a fixed test vector, not a shared
     * production key: every real device gets its own from the server at
     * enrollment, and there is no longer any secret shared by all installs.
     */
    private val secretHex = "0123456789abcdef".repeat(4)
    private val keys = InMemoryDeviceKeys().apply { enroll("a1b2c3d4", "U10021", secretHex) }

    /**
     * The 30-minute expires_at here is deliberately longer than the
     * server's 15-minute cap: the server takes whichever comes first, and
     * this fixture is what proves a packet cannot buy itself more time.
     */
    private val fixed = EmergencyPacket(
        keyId = "a1b2c3d4", txId = "TRX0A1B2C", userId = "U10021", action = "S",
        symbol = "RELIANCE", qty = 5, orderType = "I", floorPaise = 148000,
        expiresAt = 1700001800, nonce = "deadbeef", timestamp = 1700000000,
    )

    private fun sign(payload: String) = keys.requestMacOrNull()!!.signHex(payload)

    // -----------------------------------------------------------------------
    // Key derivation
    // -----------------------------------------------------------------------

    @Test
    fun hkdfMatchesTheBackendsDerivation() {
        // Pinned against the value firebase/functions/keys.js produces for
        // the same secret, so the two ends cannot drift apart silently.
        val secret = Hkdf.fromHex(secretHex)
        assertEquals(
            "ed3b97cfa228c79340d3978a057001c6cda2d5e7eceab91a740ac20592985c13",
            Hkdf.requestKey(secret).toHex(),
        )
        assertEquals(
            "99e19970cafdd5eb6c738840675e7af3a004fd41ffd34be8e969425a98bdebf1",
            Hkdf.responseKey(secret).toHex(),
        )
    }

    @Test
    fun theTwoSubKeysDifferAndNeitherIsTheSecret() {
        val secret = Hkdf.fromHex(secretHex)
        val req = Hkdf.requestKey(secret)
        val resp = Hkdf.responseKey(secret)
        assertEquals(32, req.size)
        assertFalse("request and response keys must differ", req.contentEquals(resp))
        assertFalse("a sub-key must not be the secret itself", req.contentEquals(secret))
    }

    @Test
    fun derivationIsDeterministicAndPerDevice() {
        val a = Hkdf.fromHex(secretHex)
        val b = Hkdf.fromHex("ff".repeat(32))
        assertTrue(Hkdf.requestKey(a).contentEquals(Hkdf.requestKey(a)))
        assertFalse(Hkdf.requestKey(a).contentEquals(Hkdf.requestKey(b)))
    }

    @Test
    fun anUnknownDirectionLabelIsRefused() {
        val secret = Hkdf.fromHex(secretHex)
        try {
            Hkdf.deriveSubKey(secret, "orders")
            throw AssertionError("an unknown direction should be refused")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("unknown key direction"))
        }
    }

    // -----------------------------------------------------------------------
    // The wire format
    // -----------------------------------------------------------------------

    @Test
    fun signingPayloadHasTheAgreedFieldOrder() {
        assertEquals(
            "TRX3|a1b2c3d4|TRX0A1B2C|U10021|S|RELIANCE|5|I|148000|1700001800|deadbeef|1700000000",
            fixed.signingPayload(),
        )
    }

    @Test
    fun wirePacketMatchesTheBackendsReferenceSignature() {
        val sig = sign(fixed.signingPayload())
        assertEquals("80882aab5f00c74589a2271b52679701", sig)
    }

    @Test
    fun theVersionIsCoveredBySignatureSoAnOlderPacketCannotBeRelabelled() {
        assertTrue(fixed.signingPayload().startsWith("TRX3|"))
        val unversioned = fixed.signingPayload().removePrefix("TRX3|")
        assertNotEquals(sign(fixed.signingPayload()), sign(unversioned))
    }

    @Test
    fun theKeyIdIsCoveredBySignature() {
        // The server reads the key id before it can check anything, so it
        // has to be inside what the signature covers or a packet could be
        // pointed at another device's key.
        val other = fixed.copy(keyId = "ffffffff")
        assertNotEquals(sign(fixed.signingPayload()), sign(other.signingPayload()))
    }

    @Test
    fun builtPacketFitsOneSmsSegment() {
        val p = EmergencyPacket.build("a1b2c3d4", "U10021", "S", "BAJAJFINSV", 99999)
        val wire = p.toWire(sign(p.signingPayload()))
        assertEquals(13, wire.split("|").size)
        assertTrue("was ${wire.length} chars", wire.length <= EmergencyPacket.MAX_WIRE_LENGTH)
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
            keyId = "f".repeat(limits.getValue("keyId")),
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
        val wire = worst.toWire(sign(worst.signingPayload()))
        assertEquals(EmergencyPacket.maxPermittedWireLength(), wire.length)
        assertTrue(
            "the widest permitted packet was ${wire.length} chars",
            wire.length <= EmergencyPacket.MAX_WIRE_LENGTH,
        )
    }

    @Test
    fun theAppStaysWellInsideEveryFieldLimit() {
        val p = EmergencyPacket.build("a1b2c3d4", "U10021", "S", "BAJAJFINSV", 50)
        val limits = EmergencyPacket.LIMITS
        assertTrue("key_id ${p.keyId}", p.keyId.length <= limits.getValue("keyId"))
        assertTrue("tx_id ${p.txId}", p.txId.length <= limits.getValue("txId"))
        assertTrue("user_id ${p.userId}", p.userId.length <= limits.getValue("userId"))
        assertTrue("nonce ${p.nonce}", p.nonce.length <= limits.getValue("nonce"))
        assertTrue("symbol ${p.symbol}", p.symbol.length <= limits.getValue("symbol"))
    }

    @Test
    fun packetIsGsm7SoItDoesNotSilentlyBecomeTwoSegments() {
        // A single non-GSM-7 character would switch the message to UCS-2
        // and halve the segment to 70 characters.
        val p = EmergencyPacket.build("a1b2c3d4", "U10021", "S", "RELIANCE", 5)
        val wire = p.toWire(sign(p.signingPayload()))
        assertTrue("non-ASCII in $wire", wire.all { it.code in 0x20..0x7e })
    }

    @Test
    fun buildAsksForIocAndAnExpiryInsideTheServerCap() {
        val p = EmergencyPacket.build("a1b2c3d4", "U10021", "S", "TCS", 1, nowSeconds = 1700000000)
        assertEquals(EmergencyPacket.ORDER_TYPE_IOC, p.orderType)
        assertEquals(1700000000 + EmergencyPacket.DEFAULT_VALIDITY_SECONDS, p.expiresAt)
        assertTrue(p.expiresAt - p.timestamp <= 15 * 60)
    }

    @Test
    fun defaultIsNoFloorAndAFloorConvertsToPaise() {
        assertEquals(0L, EmergencyPacket.build("a1b2c3d4", "U10021", "S", "TCS", 1).floorPaise)
        assertEquals(148520L, EmergencyPacket.floorPaise(1485.20))
        assertEquals(100L, EmergencyPacket.floorPaise(1.0))
        // Rounding, not truncation: a floor must never end up lower than
        // the user asked for by a paisa.
        assertEquals(149L, EmergencyPacket.floorPaise(1.485))
    }

    @Test
    fun everyPacketGetsAFreshNonceAndTxId() {
        val a = EmergencyPacket.build("a1b2c3d4", "U10021", "S", "TCS", 1)
        val b = EmergencyPacket.build("a1b2c3d4", "U10021", "S", "TCS", 1)
        assertNotEquals(a.nonce, b.nonce)
        assertNotEquals(a.txId, b.txId)
    }

    // -----------------------------------------------------------------------
    // Device keys
    // -----------------------------------------------------------------------

    @Test
    fun anUnenrolledDeviceCannotSign() {
        val fresh = InMemoryDeviceKeys()
        assertFalse(fresh.isEnrolled)
        assertNull(fresh.requestMacOrNull())
        assertNull(fresh.verifyConfirmation("anything"))
    }

    @Test
    fun forgettingADeviceRemovesItsAbilityToSign() {
        val keys = InMemoryDeviceKeys().apply { enroll("a1b2c3d4", "U10021", secretHex) }
        assertTrue(keys.isEnrolled)
        keys.forget()
        assertFalse(keys.isEnrolled)
        assertNull(keys.requestMacOrNull())
    }

    @Test
    fun twoDevicesProduceDifferentSignaturesForTheSamePacket() {
        val other = InMemoryDeviceKeys().apply { enroll("ffffffff", "U10021", "ab".repeat(32)) }
        val mine = keys.requestMacOrNull()!!.signHex(fixed.signingPayload())
        val theirs = other.requestMacOrNull()!!.signHex(fixed.signingPayload())
        assertNotEquals(mine, theirs)
    }

    // -----------------------------------------------------------------------
    // Confirmations
    // -----------------------------------------------------------------------

    /** Builds a confirmation the way the server does, for this device. */
    private fun confirmation(body: String): String {
        val resp = Hkdf.responseKey(Hkdf.fromHex(secretHex))
        val mac = javax.crypto.Mac.getInstance("HmacSHA256").apply {
            init(javax.crypto.spec.SecretKeySpec(resp, "HmacSHA256"))
        }
        return "$body #${mac.signHex(body).take(Confirmation.TAG_HEX)}"
    }

    private val fillBody =
        "TradeRescue: SOLD 5 RELIANCE @Rs1485.20 (15 left) Ref TRX0A1B2C 1700000060"

    @Test
    fun aGenuineConfirmationVerifiesAndParses() {
        val seen = keys.verifyConfirmation(confirmation(fillBody))
        assertNotNull(seen)
        assertEquals("FILLED", seen!!.status)
        assertTrue(seen.isFill)
        assertEquals(5, seen.quantity)
        assertEquals("RELIANCE", seen.symbol)
        assertEquals(1485.20, seen.fillPrice!!, 0.001)
        assertEquals(15, seen.remaining)
        assertEquals("TRX0A1B2C", seen.txId)
        assertEquals(1700000060L, seen.at)
    }

    @Test
    fun aRefusalConfirmationVerifiesAndIsNotAFill() {
        val seen = keys.verifyConfirmation(
            confirmation("TradeRescue: NOT SOLD (EXPIRED) Ref TRX0A1B2C 1700000060"),
        )
        assertNotNull(seen)
        assertEquals("EXPIRED", seen!!.status)
        assertFalse("a refusal must never read as a fill", seen.isFill)
    }

    @Test
    fun anAlteredConfirmationDoesNotVerify() {
        // This is what stops anyone with the phone number telling the app a
        // sale happened.
        val genuine = confirmation(fillBody)
        for (broken in listOf(
            genuine.replace("SOLD 5", "SOLD 50"),
            genuine.replace("RELIANCE", "INFY"),
            genuine.replace("1485.20", "1.00"),
            genuine.replace("(15 left)", "(99 left)"),
            genuine.substringBeforeLast(" #") + " #" + "0".repeat(Confirmation.TAG_HEX),
            genuine.substringBeforeLast(" #"),
            genuine + "0",
        )) {
            assertNull("should not verify: $broken", keys.verifyConfirmation(broken))
        }
    }

    @Test
    fun aConfirmationForAnotherDeviceDoesNotVerify() {
        val other = InMemoryDeviceKeys().apply { enroll("ffffffff", "U10021", "ab".repeat(32)) }
        assertNull(other.verifyConfirmation(confirmation(fillBody)))
    }

    @Test
    fun aConfirmationSignedWithTheRequestKeyDoesNotVerify() {
        // The reason for two sub-keys: a message signed in the wrong
        // direction is not a confirmation, however genuine the device.
        val wrongDirection = "$fillBody #${sign(fillBody).take(Confirmation.TAG_HEX)}"
        assertNull(keys.verifyConfirmation(wrongDirection))
    }

    @Test
    fun plausibleTextWithoutATagNeverVerifies() {
        for (unsigned in listOf(
            fillBody,
            "TradeRescue: SOLD 5 RELIANCE @Rs1485.20 (15 left) Ref TRX0A1B2C 1700000060 #short",
            "Your order was executed successfully",
        )) {
            assertNull(keys.verifyConfirmation(unsigned))
        }
    }

    @Test
    fun looksLikeConfirmationIsOnlyAFilterNotATrustCheck() {
        assertTrue(Confirmation.looksLikeConfirmation(confirmation(fillBody)))
        assertFalse(Confirmation.looksLikeConfirmation("TRX3|a1b2c3d4|TRX0A1B2C"))
        assertFalse(Confirmation.looksLikeConfirmation("hello"))
        // It says nothing about authenticity, which is the point of
        // keeping it separate from verify().
        assertTrue(Confirmation.looksLikeConfirmation("TradeRescue: SOLD everything #deadbeefdeadbeef"))
        assertNull(keys.verifyConfirmation("TradeRescue: SOLD everything #deadbeefdeadbeef"))
    }

    // -----------------------------------------------------------------------
    // Holdings
    // -----------------------------------------------------------------------

    @Test
    fun emergencyLimitCapsWhatCanBeSold() {
        assertEquals(10, Holding("TCS", 10, 1.0, 0.0, 50).maxSellable)
        assertEquals(20, Holding("X", 100, 1.0, 0.0, 20).maxSellable)
        assertEquals(0, Holding("X", 0, 1.0, 0.0, 20).maxSellable)
    }
}

private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

private fun javax.crypto.Mac.signHex(payload: String): String =
    doFinal(payload.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }.take(32)
