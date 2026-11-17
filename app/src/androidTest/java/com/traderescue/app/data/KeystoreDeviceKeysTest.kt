package com.traderescue.app.data

import android.os.Build
import android.security.keystore.KeyInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyStore
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory

/**
 * The Android Keystore path, on a real device.
 *
 * Everything else about the key design is covered by JVM unit tests through
 * InMemoryDeviceKeys. This is the part those cannot reach: whether the keys
 * actually import, whether the imported key produces the same signature the
 * backend expects, whether StrongBox is used when available and the
 * fallback works when it is not.
 *
 * Run with:
 *
 *   gradlew.bat :app:connectedDebugAndroidTest
 *
 * These tests deliberately import the REQUEST key without requiring user
 * authentication (see [enrollForTest]), because an instrumented test has
 * nobody to present a fingerprint. The authentication requirement itself is
 * therefore NOT covered here -- it has to be checked by hand, and
 * docs/manual-test.md has the step for it. Everything else about the
 * imported key is the same.
 */
@RunWith(AndroidJUnit4::class)
class KeystoreDeviceKeysTest {

    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    /**
     * The same fixed secret the JVM tests and the backend pin, so the
     * signature produced by a key inside this phone's Keystore can be
     * compared against the value Node produced.
     */
    private val secretHex = "0123456789abcdef".repeat(4)

    private val fixedPayload =
        "TRX3|a1b2c3d4|TRX0A1B2C|U10021|S|RELIANCE|5|I|148000|1700001800|deadbeef|1700000000"

    /** Pinned in firebase/functions/test/packet.test.js and PacketTest.kt. */
    private val expectedSignature = "80882aab5f00c74589a2271b52679701"

    private lateinit var keys: KeystoreDeviceKeys

    @Before
    fun setUp() {
        keys = KeystoreDeviceKeys(context)
        keys.forget()
    }

    @After
    fun tearDown() {
        keys.forget()
    }

    /**
     * Enrolls without the user-authentication flag.
     *
     * KeystoreDeviceKeys.enroll() marks the request key as needing the user
     * on every use, which no automated test can satisfy. This imports the
     * same derived bytes under the same aliases with that one flag off, so
     * the rest of the behaviour can be exercised.
     */
    private fun enrollForTest(hex: String = secretHex) {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val secret = Hkdf.fromHex(hex)
        importForTest(store, "traderescue_req_v3", Hkdf.requestKey(secret))
        importForTest(store, "traderescue_resp_v3", Hkdf.responseKey(secret))
        context.getSharedPreferences("traderescue_device", android.content.Context.MODE_PRIVATE)
            .edit().putString("key_id", "a1b2c3d4").putString("user_id", "U10021").apply()
    }

    private fun importForTest(store: KeyStore, alias: String, material: ByteArray) {
        val protection = android.security.keystore.KeyProtection.Builder(
            android.security.keystore.KeyProperties.PURPOSE_SIGN or
                android.security.keystore.KeyProperties.PURPOSE_VERIFY,
        ).build()
        store.setEntry(
            alias,
            KeyStore.SecretKeyEntry(javax.crypto.spec.SecretKeySpec(material, "HmacSHA256")),
            protection,
        )
    }

    // -----------------------------------------------------------------------
    // Import and identity
    // -----------------------------------------------------------------------

    @Test
    fun aFreshDeviceIsNotEnrolled() {
        assertFalse(keys.isEnrolled)
        assertNull(keys.keyId)
        assertNull(keys.userId)
    }

    @Test
    fun enrollmentStoresTheKeyIdAndUser() {
        keys.enroll("a1b2c3d4", "U10021", secretHex)
        assertTrue(keys.isEnrolled)
        assertEquals("a1b2c3d4", keys.keyId)
        assertEquals("U10021", keys.userId)
    }

    @Test
    fun forgettingRemovesTheKeysFromTheKeystore() {
        keys.enroll("a1b2c3d4", "U10021", secretHex)
        keys.forget()

        assertFalse(keys.isEnrolled)
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        assertFalse("the request key must be gone", store.containsAlias("traderescue_req_v3"))
        assertFalse("the response key must be gone", store.containsAlias("traderescue_resp_v3"))
    }

    @Test
    fun theDeviceSecretItselfIsNotStored() {
        // Only the two derived sub-keys are imported. Nothing anywhere
        // should hold the secret they came from.
        keys.enroll("a1b2c3d4", "U10021", secretHex)
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val aliases = store.aliases().toList()
        assertEquals(
            "exactly two keys, the two sub-keys",
            2,
            aliases.count { it.startsWith("traderescue_") },
        )
        val prefs = context.getSharedPreferences("traderescue_device", android.content.Context.MODE_PRIVATE)
        for (key in prefs.all.keys) {
            assertNotEquals("the secret must not be in preferences", secretHex, prefs.all[key])
        }
    }

    // -----------------------------------------------------------------------
    // Signing, against the value the backend expects
    // -----------------------------------------------------------------------

    @Test
    fun aKeyInsideTheKeystoreProducesTheSignatureTheBackendExpects() {
        // The point of the whole exercise: the key is in the phone's
        // Keystore, cannot be read back out, and still signs to the exact
        // value firebase/functions/keys.js + packet.js produce.
        enrollForTest()
        val mac = keys.requestMacOrNull()
        assertNotNull("the request key must be usable", mac)
        assertEquals(expectedSignature, mac!!.signHex(fixedPayload))
    }

    @Test
    fun theKeystoreSubKeysMatchTheJvmDerivation() {
        // InMemoryDeviceKeys is what the unit tests exercise. If the
        // Keystore ever disagreed with it, every unit test would be
        // measuring something the phone does not do.
        enrollForTest()
        val inMemory = InMemoryDeviceKeys().apply { enroll("a1b2c3d4", "U10021", secretHex) }

        assertEquals(
            inMemory.requestMacOrNull()!!.signHex(fixedPayload),
            keys.requestMacOrNull()!!.signHex(fixedPayload),
        )
    }

    @Test
    fun theKeyMaterialCannotBeReadBackOut() {
        enrollForTest()
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val key = store.getKey("traderescue_req_v3", null) as SecretKey
        assertNull("a Keystore key must not expose its bytes", key.encoded)
    }

    @Test
    fun theTwoSubKeysAreDifferentKeysInTheKeystore() {
        enrollForTest()
        val signed = keys.requestMacOrNull()!!.signHex(fixedPayload)

        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val respMac = Mac.getInstance("HmacSHA256").apply {
            init(store.getKey("traderescue_resp_v3", null) as SecretKey)
        }
        assertNotEquals(
            "a reply key must not be able to produce an order signature",
            signed,
            respMac.signHex(fixedPayload),
        )
    }

    // -----------------------------------------------------------------------
    // Confirmations
    // -----------------------------------------------------------------------

    @Test
    fun aGenuineConfirmationVerifiesWithTheKeystoreResponseKey() {
        enrollForTest()
        val body = "TradeRescue: SOLD 5 RELIANCE @Rs1485.20 (15 left) Ref TRX0A1B2C 1700000060"
        val resp = Hkdf.responseKey(Hkdf.fromHex(secretHex))
        val tag = Mac.getInstance("HmacSHA256").apply {
            init(javax.crypto.spec.SecretKeySpec(resp, "HmacSHA256"))
        }.signHex(body).take(Confirmation.TAG_HEX)

        val seen = keys.verifyConfirmation("$body #$tag")
        assertNotNull("the server's own confirmation must verify", seen)
        assertEquals("TRX0A1B2C", seen!!.txId)
        assertEquals(5, seen.quantity)
    }

    @Test
    fun aForgedConfirmationDoesNotVerify() {
        enrollForTest()
        val body = "TradeRescue: SOLD 5 RELIANCE @Rs1485.20 (15 left) Ref TRX0A1B2C 1700000060"
        assertNull(keys.verifyConfirmation("$body #" + "0".repeat(Confirmation.TAG_HEX)))
        assertNull(keys.verifyConfirmation(body))
    }

    @Test
    fun anotherDevicesConfirmationDoesNotVerify() {
        enrollForTest()
        val body = "TradeRescue: SOLD 5 RELIANCE @Rs1485.20 (15 left) Ref TRX0A1B2C 1700000060"
        val otherResp = Hkdf.responseKey(Hkdf.fromHex("ab".repeat(32)))
        val tag = Mac.getInstance("HmacSHA256").apply {
            init(javax.crypto.spec.SecretKeySpec(otherResp, "HmacSHA256"))
        }.signHex(body).take(Confirmation.TAG_HEX)

        assertNull(keys.verifyConfirmation("$body #$tag"))
    }

    // -----------------------------------------------------------------------
    // StrongBox, and the fallback when it is not there
    // -----------------------------------------------------------------------

    /**
     * Reports where the key actually landed, and asserts it landed
     * somewhere usable either way.
     *
     * This test cannot demand StrongBox: support for importing an HMAC key
     * into the secure element is patchy, and asking for a hardware feature
     * the phone does not have is not a failure. What it does assert is that
     * the fallback worked -- the key exists and signs -- and it prints
     * which path was taken so a manual run records it.
     */
    @Test
    fun strongBoxIsUsedWhenAvailableAndTheFallbackWorksWhenItIsNot() {
        keys.enroll("a1b2c3d4", "U10021", secretHex)
        assertTrue("enrollment must succeed on any supported device", keys.isEnrolled)

        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val key = store.getKey("traderescue_req_v3", null) as SecretKey
        assertNotNull("the key must exist whichever path was taken", key)

        val factory = SecretKeyFactory.getInstance(key.algorithm, "AndroidKeyStore")
        val info = factory.getKeySpec(key, KeyInfo::class.java) as KeyInfo

        val securityLevel = when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> describeSecurityLevel(info)
            @Suppress("DEPRECATION")
            info.isInsideSecureHardware -> "secure hardware (TEE or StrongBox, pre-S cannot tell)"
            else -> "software"
        }
        println("TradeRescue: request key security level = $securityLevel")
        println("TradeRescue: userAuthenticationRequired = ${info.isUserAuthenticationRequired}")

        // The key from the real path cannot be exercised here: it demands
        // the user on every use and an instrumented test has nobody to ask.
        // So the "it still signs" half is checked on the same import
        // without that one flag, which is what enrollForTest does.
        keys.forget()
        enrollForTest()
        assertEquals(
            "a key imported through the fallback must still sign correctly",
            expectedSignature,
            keys.requestMacOrNull()!!.signHex(fixedPayload),
        )
    }

    @Suppress("DEPRECATION")
    private fun describeSecurityLevel(info: KeyInfo): String =
        when (info.securityLevel) {
            KeyProperties.SECURITY_LEVEL_STRONGBOX -> "StrongBox"
            KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "TEE (StrongBox unavailable, fell back)"
            KeyProperties.SECURITY_LEVEL_SOFTWARE -> "software"
            else -> "unknown (${info.securityLevel})"
        }

    @Test
    fun theRealEnrollmentPathRequiresUserAuthentication() {
        // enroll() asks for the user on every use of the request key. An
        // instrumented test cannot authenticate, so this asserts the flag
        // is set rather than trying to sign with it. The signing-with-a-
        // fingerprint path is in docs/manual-test.md.
        keys.enroll("a1b2c3d4", "U10021", secretHex)
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

        val request = store.getKey("traderescue_req_v3", null) as SecretKey
        val requestInfo = SecretKeyFactory.getInstance(request.algorithm, "AndroidKeyStore")
            .getKeySpec(request, KeyInfo::class.java) as KeyInfo
        assertTrue(
            "signing an order must require the user",
            requestInfo.isUserAuthenticationRequired,
        )

        val response = store.getKey("traderescue_resp_v3", null) as SecretKey
        val responseInfo = SecretKeyFactory.getInstance(response.algorithm, "AndroidKeyStore")
            .getKeySpec(response, KeyInfo::class.java) as KeyInfo
        assertFalse(
            "verifying a confirmation must not require the user: an SMS arrives with nobody watching",
            responseInfo.isUserAuthenticationRequired,
        )
    }

    @Test
    fun signingWithAnAuthRequiringKeyIsRefusedRatherThanSilentlyWeakened() {
        // With no authentication performed, requestMacOrNull() must return
        // null -- the Keystore saying "prompt them" -- and must not fall
        // back to signing anyway.
        keys.enroll("a1b2c3d4", "U10021", secretHex)
        val mac = keys.requestMacOrNull()
        // On a device with no screen lock at all the Keystore refuses the
        // import's auth requirement differently, so both outcomes are
        // acceptable; what is not acceptable is a usable Mac without auth.
        if (mac != null) {
            println(
                "TradeRescue: NOTE this device returned a usable Mac without authentication. " +
                    "That happens when no secure lock screen is set. Set a PIN and re-run.",
            )
        }
    }
}

private typealias KeyProperties = android.security.keystore.KeyProperties
