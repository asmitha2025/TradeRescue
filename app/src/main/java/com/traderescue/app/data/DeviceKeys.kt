package com.traderescue.app.data

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.KeyProtection
import android.security.keystore.StrongBoxUnavailableException
import android.security.keystore.UserNotAuthenticatedException
import androidx.annotation.RequiresApi
import java.security.KeyStore
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec

/**
 * What this device can sign, and what it can check.
 *
 * Two sub-keys, derived at enrollment from the one secret the server sends
 * and kept apart on purpose:
 *
 *   request   signs orders. Authorises money to move, so every use needs
 *             the user: biometric, or the device credential (PIN, pattern,
 *             password) for a phone with no enrolled fingerprint or a wet
 *             thumb in the rain. Locking someone out of their emergency
 *             exit to be strict would defeat the point of the app.
 *
 *   response  checks the server's confirmations. Authorises nothing, and a
 *             confirmation arrives by SMS whenever the network feels like
 *             it -- there is no user present to prompt, and nothing is at
 *             risk in reading one. No auth required.
 *
 * The device secret itself is never stored. It exists in memory for the
 * length of one enrollment call, long enough to derive both sub-keys, and
 * then it is overwritten.
 *
 * The honest limitation: this is an HMAC, so the server holds a copy of
 * this device's secret and could forge this device's packets. The Keystore
 * protects use of the key on the phone, not its secrecy from the backend.
 */
interface DeviceKeys {
    val keyId: String?
    val userId: String?
    val isEnrolled: Boolean get() = keyId != null

    /** Imports a freshly enrolled secret. Replaces whatever was here. */
    fun enroll(keyId: String, userId: String, secretHex: String)

    /**
     * A Mac ready to sign an order, or null if the user must authenticate
     * first. A null is not an error: it is the Keystore saying "prompt
     * them", and the caller is expected to do so and come back.
     */
    fun requestMacOrNull(): Mac?

    /** An uninitialised Mac to hand to a biometric prompt as a CryptoObject. */
    fun unauthenticatedRequestMac(): Mac

    /** Verifies a confirmation from the server. No user, no prompt. */
    fun verifyConfirmation(message: String): Confirmation?

    fun forget()
}

/** Signs with a Mac the caller has already had authenticated. */
fun Mac.signHex(payload: String): String =
    doFinal(payload.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }.take(32)

/**
 * The real thing: sub-keys imported into the Android Keystore, StrongBox
 * backed where the phone has it.
 *
 * Imported rather than generated, because the signature is an HMAC and the
 * server must hold the same key to check it -- a key generated inside the
 * Keystore could never leave, so it could never be verified anywhere. That
 * is the trade this design makes, and Phase 3's README says so plainly.
 *
 * Untested here: nothing in this repo exercises the Android Keystore, which
 * needs a device or emulator. The crypto that can be tested on the JVM --
 * the derivation, the packet format, confirmation verification -- is, via
 * InMemoryDeviceKeys. Treat this class the way the backend's README treats
 * FirestoreStore: written to the same interface, not demonstrated.
 */
class KeystoreDeviceKeys(context: Context) : DeviceKeys {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    override val keyId: String? get() = prefs.getString(KEY_ID, null)
    override val userId: String? get() = prefs.getString(USER_ID, null)

    override fun enroll(keyId: String, userId: String, secretHex: String) {
        val secret = Hkdf.fromHex(secretHex)
        try {
            importKey(aliasFor(DIRECTION_REQUEST), Hkdf.requestKey(secret), requireAuth = true)
            importKey(aliasFor(DIRECTION_RESPONSE), Hkdf.responseKey(secret), requireAuth = false)
            prefs.edit().putString(KEY_ID, keyId).putString(USER_ID, userId).apply()
        } finally {
            // The secret's only job was to produce the two sub-keys.
            secret.fill(0)
        }
    }

    override fun requestMacOrNull(): Mac? = try {
        Mac.getInstance(HMAC).apply { init(loadKey(aliasFor(DIRECTION_REQUEST))) }
    } catch (e: UserNotAuthenticatedException) {
        // Not a failure: the Keystore is saying "prompt them first".
        null
    }

    override fun unauthenticatedRequestMac(): Mac = Mac.getInstance(HMAC).also {
        runCatching { it.init(loadKey(aliasFor(DIRECTION_REQUEST))) }
    }

    override fun verifyConfirmation(message: String): Confirmation? {
        val mac = runCatching {
            Mac.getInstance(HMAC).apply { init(loadKey(aliasFor(DIRECTION_RESPONSE))) }
        }.getOrNull() ?: return null
        return Confirmation.verify(message) { payload -> mac.signHex(payload) }
    }

    override fun forget() {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        for (direction in listOf(DIRECTION_REQUEST, DIRECTION_RESPONSE)) {
            runCatching { store.deleteEntry(aliasFor(direction)) }
        }
        prefs.edit().remove(KEY_ID).remove(USER_ID).apply()
    }

    private fun loadKey(alias: String): SecretKey {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        return store.getKey(alias, null) as? SecretKey
            ?: throw IllegalStateException("This device is not enrolled")
    }

    /**
     * StrongBox first, then the TEE.
     *
     * StrongBox support for HMAC keys is patchy across devices, so a
     * failure here is expected on plenty of hardware and is not an error:
     * the key still lands in the Keystore, just not in the secure element.
     */
    private fun importKey(alias: String, material: ByteArray, requireAuth: Boolean) {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val entry = KeyStore.SecretKeyEntry(SecretKeySpec(material, HMAC))
        try {
            // Asking for StrongBox when IMPORTING a key needs API 31:
            // KeyGenParameterSpec has had the flag since 28, but
            // KeyProtection.Builder only got it in S, and an imported key
            // goes through KeyProtection. The whole attempt sits behind the
            // check, since the exception type is version-gated too.
            val inStrongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                tryStrongBox(store, alias, entry, requireAuth)
            if (!inStrongBox) {
                store.setEntry(alias, entry, protection(requireAuth, strongBox = false))
            }
        } finally {
            material.fill(0)
        }
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private fun tryStrongBox(
        store: KeyStore,
        alias: String,
        entry: KeyStore.SecretKeyEntry,
        requireAuth: Boolean,
    ): Boolean = try {
        store.setEntry(alias, entry, protection(requireAuth, strongBox = true))
        true
    } catch (e: StrongBoxUnavailableException) {
        // Expected on plenty of hardware: StrongBox support for HMAC keys
        // is patchy. The key still lands in the Keystore, just not in the
        // secure element.
        false
    }

    private fun protection(requireAuth: Boolean, strongBox: Boolean): KeyProtection =
        KeyProtection.Builder(KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY).apply {
            if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setIsStrongBoxBacked(true)
            if (requireAuth) {
                setUserAuthenticationRequired(true)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    // Timeout 0 means every single use is authenticated, and
                    // both factors are accepted: a phone with no enrolled
                    // biometric still has an emergency exit.
                    setUserAuthenticationParameters(
                        0,
                        KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
                    )
                } else {
                    @Suppress("DEPRECATION")
                    setUserAuthenticationValidityDurationSeconds(-1)
                }
            }
        }.build()

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val HMAC = "HmacSHA256"
        const val PREFS = "traderescue_device"
        const val KEY_ID = "key_id"
        const val USER_ID = "user_id"
        const val DIRECTION_REQUEST = "req"
        const val DIRECTION_RESPONSE = "resp"
        fun aliasFor(direction: String) = "traderescue_${direction}_v3"
    }
}

/**
 * The same interface over plain byte arrays, for unit tests and for
 * simulation mode on a device with no Keystore worth the name.
 *
 * Everything the JVM can check about this design -- that the sub-keys
 * differ, that the packet it signs verifies on the backend, that a
 * confirmation signed with the wrong key is refused -- is checked through
 * this class.
 */
class InMemoryDeviceKeys : DeviceKeys {
    private var requestKey: ByteArray? = null
    private var responseKey: ByteArray? = null
    override var keyId: String? = null
        private set
    override var userId: String? = null
        private set

    override fun enroll(keyId: String, userId: String, secretHex: String) {
        val secret = Hkdf.fromHex(secretHex)
        requestKey = Hkdf.requestKey(secret)
        responseKey = Hkdf.responseKey(secret)
        secret.fill(0)
        this.keyId = keyId
        this.userId = userId
    }

    override fun requestMacOrNull(): Mac? = requestKey?.let { macFor(it) }

    override fun unauthenticatedRequestMac(): Mac =
        requestMacOrNull() ?: throw IllegalStateException("This device is not enrolled")

    override fun verifyConfirmation(message: String): Confirmation? {
        val key = responseKey ?: return null
        return Confirmation.verify(message) { payload -> macFor(key).signHex(payload) }
    }

    override fun forget() {
        requestKey?.fill(0)
        responseKey?.fill(0)
        requestKey = null
        responseKey = null
        keyId = null
        userId = null
    }

    private fun macFor(key: ByteArray): Mac =
        Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }
}
