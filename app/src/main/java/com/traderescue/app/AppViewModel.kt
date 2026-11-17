package com.traderescue.app

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.traderescue.app.data.BackendApi
import com.traderescue.app.data.EmergencyPacket
import com.traderescue.app.data.Holding
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import com.traderescue.app.data.Confirmation
import com.traderescue.app.data.DeviceKeys
import com.traderescue.app.data.KeystoreDeviceKeys
import com.traderescue.app.data.SmsGatewayReceiver
import com.traderescue.app.data.signHex
import com.traderescue.app.data.SmsSender
import com.traderescue.app.data.demoHoldings
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

enum class Screen { DASHBOARD, SETTINGS, SELECT_HOLDING, QUANTITY, PIN, EXECUTING, SUCCESS }

/** How an order actually left the phone. */
enum class Channel { DIRECT, SMS, HTTP_FALLBACK, SIMULATED }

/**
 * How sure the app is that an order actually happened.
 *
 * SENT is the honest state for the SMS channel on its own: the radio
 * accepted the message, which says nothing about whether it was executed.
 * Only a confirmation whose signature verifies against this device's
 * response sub-key moves it to EXECUTED. A reply that arrives but does not
 * verify moves it to UNVERIFIED and is shown as an unverified message --
 * never as a fill, however convincingly it is worded.
 */
enum class Confidence { SENT, EXECUTED, REFUSED, UNVERIFIED }

/**
 * What the success screen shows.
 */
data class SaleResult(
    val symbol: String,
    val qty: Int,
    val price: Double,
    val channel: Channel,
    val confidence: Confidence,
    val wirePacket: String?,
    val txId: String? = null,
    /** The server's own words, once verified. Null until then. */
    val confirmationText: String? = null,
    /** Why the server refused, when it did. */
    val refusalCode: String? = null,
) {
    val confirmed: Boolean get() = confidence == Confidence.EXECUTED
}

const val USER_ID = "U10021"
const val DEMO_PIN = "1234"

private const val MAX_PIN_ATTEMPTS = 3
private const val PIN_LOCK_SECONDS = 30

/**
 * Holds only the Application context (never the Activity), which is all
 * that connectivity monitoring, SharedPreferences and SmsManager need.
 */
class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val prefs = app.getSharedPreferences(SmsGatewayReceiver.PREFS, Context.MODE_PRIVATE)
    private val connectivity = app.getSystemService(ConnectivityManager::class.java)

    /**
     * This device's keys. Injectable so a test or a simulation run can hand
     * in an in-memory pair instead of the Android Keystore, which needs a
     * real device.
     */
    var deviceKeys: DeviceKeys = KeystoreDeviceKeys(app)

    /** Set when the user must authenticate before an order can be signed. */
    var authPrompt by mutableStateOf<(suspend () -> Boolean)?>(null)

    val isEnrolled: Boolean get() = deviceKeys.isEnrolled
    val deviceKeyId: String? get() = deviceKeys.keyId

    var screen by mutableStateOf(Screen.DASHBOARD)
        private set

    var holdings by mutableStateOf(demoHoldings())
        private set

    /** What the OS reports about the data connection. */
    var networkAvailable by mutableStateOf(currentlyOnline())
        private set

    /** Demo switch: behave as if data is down without touching the radio. */
    var simulateOutage by mutableStateOf(false)
        private set

    val isOnline: Boolean get() = networkAvailable && !simulateOutage

    var backendUrl by mutableStateOf(prefs.getString(KEY_BACKEND_URL, "").orEmpty())
        private set
    var smsDestinationNumber by mutableStateOf(prefs.getString(KEY_SMS_NUMBER, "").orEmpty())
        private set
    var smsPermissionGranted by mutableStateOf(SmsSender.hasPermission(app))
        private set

    var activeHolding by mutableStateOf<Holding?>(null)
        private set
    var sellQty by mutableStateOf(1)
        private set
    var enteredPin by mutableStateOf("")
        private set
    var pinError by mutableStateOf("")
        private set
    var pinLockSeconds by mutableStateOf(0)
        private set
    var execLog by mutableStateOf(listOf<String>())
        private set
    var execBusy by mutableStateOf(false)
        private set
    var execError by mutableStateOf<String?>(null)
        private set
    var wirePacket by mutableStateOf<String?>(null)
        private set
    var saleResult by mutableStateOf<SaleResult?>(null)
        private set

    /** The order waiting for a signed confirmation, if any. */
    var pendingTxId by mutableStateOf<String?>(null)
        private set

    /** What the Settings screen says about this device's enrollment. */
    var enrollmentStatus by mutableStateOf("")

    /**
     * The signed-in session and the one-time code, both typed in.
     *
     * Deliberately not persisted. The session token is a credential and
     * the code is single use; keeping either across restarts would be
     * storing something that should be used once and forgotten.
     */
    var sessionToken by mutableStateOf("")
    var enrollmentCode by mutableStateOf("")

    /** Null until a sync is attempted; then whether the dashboard shows the server's numbers. */
    var syncError by mutableStateOf<String?>(null)
        private set
    var lastSynced by mutableStateOf(false)
        private set

    private var pinAttempts = 0

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
            val wasAvailable = networkAvailable
            networkAvailable = caps.isUsable()
            // Back online: pull what the server did with any SMS orders.
            if (!wasAvailable && networkAvailable) refreshHoldings()
        }

        override fun onLost(network: Network) {
            networkAvailable = false
        }
    }

    init {
        connectivity.registerDefaultNetworkCallback(networkCallback)
        refreshHoldings()
    }

    /**
     * Replaces the local holdings with the server's. Only runs from the
     * dashboard so a sync can never change numbers under an order in progress.
     */
    fun refreshHoldings() {
        val backend = backendUrl.trimEnd('/')
        if (backend.isEmpty() || !isOnline || screen != Screen.DASHBOARD) return
        viewModelScope.launch {
            BackendApi(backend).getPortfolio(USER_ID)
                .onSuccess {
                    if (screen == Screen.DASHBOARD) holdings = it
                    lastSynced = true
                    syncError = null
                }
                .onFailure {
                    lastSynced = false
                    syncError = it.message ?: "unknown error"
                }
        }
    }

    override fun onCleared() {
        connectivity.unregisterNetworkCallback(networkCallback)
    }

    private fun currentlyOnline(): Boolean =
        connectivity.getNetworkCapabilities(connectivity.activeNetwork)?.isUsable() == true

    private fun NetworkCapabilities.isUsable(): Boolean =
        hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)

    fun goTo(s: Screen) { screen = s }

    fun toggleSimulatedOutage() {
        simulateOutage = !simulateOutage
        refreshHoldings()
    }

    /** This phone receives emergency SMS for the backend (see SmsGatewayReceiver). */
    var gatewayMode by mutableStateOf(prefs.getBoolean(SmsGatewayReceiver.KEY_GATEWAY_MODE, false))
        private set
    var smsReceiveGranted by mutableStateOf(canReceiveSms())
        private set

    /** Last thing the gateway receiver did, or empty if it has never fired. */
    var gatewayLog by mutableStateOf(prefs.getString(SmsGatewayReceiver.KEY_GATEWAY_LOG, "").orEmpty())
        private set

    // Held in a field: SharedPreferences keeps only a weak reference to it.
    private val prefsListener = SharedPreferences.OnSharedPreferenceChangeListener { p, key ->
        if (key == SmsGatewayReceiver.KEY_GATEWAY_LOG) gatewayLog = p.getString(key, "").orEmpty()
    }.also { prefs.registerOnSharedPreferenceChangeListener(it) }

    private fun canReceiveSms(): Boolean =
        ContextCompat.checkSelfPermission(getApplication(), android.Manifest.permission.RECEIVE_SMS) ==
            PackageManager.PERMISSION_GRANTED

    fun updateGatewayMode(on: Boolean) {
        gatewayMode = on
        prefs.edit().putBoolean(SmsGatewayReceiver.KEY_GATEWAY_MODE, on).apply()
    }

    fun refreshSmsPermission() {
        smsPermissionGranted = SmsSender.hasPermission(getApplication())
        smsReceiveGranted = canReceiveSms()
    }

    fun saveSettings(url: String, smsNumber: String) {
        backendUrl = url.trim()
        smsDestinationNumber = smsNumber.trim()
        prefs.edit().putString(KEY_BACKEND_URL, backendUrl).putString(KEY_SMS_NUMBER, smsDestinationNumber).apply()
        screen = Screen.DASHBOARD
        lastSynced = false
        syncError = null
        if (backendUrl.isEmpty()) holdings = demoHoldings() else refreshHoldings()
    }

    fun selectHolding(h: Holding) {
        if (h.maxSellable < 1) return
        activeHolding = h
        sellQty = 1
        screen = Screen.QUANTITY
    }

    fun maxSellable(): Int = activeHolding?.maxSellable ?: 0

    fun changeQty(delta: Int) {
        sellQty = (sellQty + delta).coerceIn(1, maxSellable().coerceAtLeast(1))
    }

    fun openPin() {
        if (maxSellable() < 1) return
        enteredPin = ""
        pinError = ""
        screen = Screen.PIN
    }

    fun pressPinDigit(d: Int) {
        if (pinLockSeconds > 0 || enteredPin.length >= DEMO_PIN.length) return
        enteredPin += d.toString()
        if (enteredPin.length == DEMO_PIN.length) checkPin()
    }

    fun backspacePin() {
        enteredPin = enteredPin.dropLast(1)
    }

    private fun checkPin() {
        if (enteredPin == DEMO_PIN) {
            pinAttempts = 0
            screen = Screen.EXECUTING
            execute()
            return
        }
        enteredPin = ""
        pinAttempts++
        if (pinAttempts >= MAX_PIN_ATTEMPTS) {
            pinAttempts = 0
            pinError = "Too many incorrect attempts"
            viewModelScope.launch {
                pinLockSeconds = PIN_LOCK_SECONDS
                while (pinLockSeconds > 0) {
                    delay(1000)
                    pinLockSeconds--
                }
                pinError = ""
            }
        } else {
            val left = MAX_PIN_ATTEMPTS - pinAttempts
            pinError = "Incorrect PIN — $left attempt${if (left == 1) "" else "s"} left"
        }
    }

    private fun log(line: String) { execLog = execLog + line }

    private fun execute() {
        val holding = activeHolding ?: return
        val qty = sellQty
        // Captured once: the channel is decided by the state at the moment
        // the user authorized, not by whatever the network does mid-flight.
        val online = isOnline
        val backend = backendUrl.trimEnd('/')
        val api = if (backend.isEmpty()) null else BackendApi(backend)
        execLog = emptyList()
        execError = null
        wirePacket = null
        execBusy = true

        viewModelScope.launch {
            try {
                if (online) {
                    if (api == null) {
                        log("No backend configured — simulating a direct order")
                        delay(900)
                        finishSale(holding, qty, holding.price, Channel.SIMULATED, Confidence.EXECUTED)
                    } else {
                        log("Sending order over HTTPS")
                        api.placeNormalOrder(USER_ID, holding.symbol, "SELL", qty)
                            .onSuccess { finishSale(holding, qty, it.optDouble("fill_price", holding.price), Channel.DIRECT, Confidence.EXECUTED) }
                            .onFailure { execError = "Could not reach backend: ${it.message}" }
                    }
                    return@launch
                }

                log("No data connection — switching to the emergency channel")
                delay(500)

                val keyId = deviceKeys.keyId
                if (keyId == null) {
                    // Enrollment needs the network, so it cannot be done
                    // now. Saying so plainly beats failing obscurely.
                    execError = "This device is not enrolled. Connect once while online to enroll it, " +
                        "then the emergency channel will work offline."
                    return@launch
                }

                val packet = EmergencyPacket.build(
                    keyId = keyId,
                    userId = deviceKeys.userId ?: USER_ID,
                    action = "S",
                    symbol = holding.symbol,
                    qty = qty,
                    // No floor: exit at any price. A floor is the user's
                    // choice, and the plans that let them set one arrive in
                    // Phase 4 -- until then the honest default for an
                    // emergency exit is to take the available price.
                    floorPaise = 0,
                )

                val signature = signPayload(packet.signingPayload())
                if (signature == null) {
                    execError = "The order was not signed, so nothing was sent."
                    return@launch
                }
                val wire = packet.toWire(signature)
                wirePacket = wire
                log("Signed with this device's key ${keyId} (${wire.length} characters)")
                log("Valid for ${EmergencyPacket.DEFAULT_VALIDITY_SECONDS / 60} minutes, then the server refuses it")
                delay(500)

                val smsBlocker = SmsSender.unavailableReason(getApplication(), smsDestinationNumber)
                when {
                    smsBlocker == null -> {
                        log("Handing the packet to the cellular radio")
                        // The SMS is the order, and it is not also posted
                        // over HTTP -- not because a second copy would be
                        // dangerous (the backend keys on tx_id and replays
                        // the first outcome), but because one order should
                        // cost one channel. Phase 5 adds deliberate fallback
                        // across channels reusing this same tx_id.
                        SmsSender.send(getApplication(), smsDestinationNumber, wire)
                            .onSuccess {
                                log("SMS accepted by the network → $smsDestinationNumber")
                                log("Waiting for a signed confirmation before calling this executed")
                                pendingTxId = packet.txId
                                finishSale(
                                    holding, qty, holding.price, Channel.SMS,
                                    Confidence.SENT, txId = packet.txId,
                                )
                            }
                            .onFailure { execError = "SMS could not be sent: ${it.message}" }
                    }
                    api == null -> {
                        log("Real SMS skipped ($smsBlocker) — simulating the SMS gateway")
                        delay(900)
                        finishSale(holding, qty, holding.price, Channel.SIMULATED, Confidence.EXECUTED)
                    }
                    else -> {
                        log("Real SMS skipped ($smsBlocker) — posting the same signed packet over HTTP")
                        api.postEmergencyPacket(wire)
                            .onSuccess { finishSale(holding, qty, it.optDouble("fill_price", holding.price), Channel.HTTP_FALLBACK, Confidence.EXECUTED) }
                            .onFailure { execError = "Could not reach the emergency gateway: ${it.message}" }
                    }
                }
            } finally {
                execBusy = false
            }
        }
    }

    private fun finishSale(
        holding: Holding,
        qty: Int,
        fillPrice: Double,
        channel: Channel,
        confidence: Confidence,
        txId: String? = null,
    ) {
        holdings = holdings.map { if (it.symbol == holding.symbol) it.copy(qty = it.qty - qty) else it }
        saleResult = SaleResult(holding.symbol, qty, fillPrice, channel, confidence, wirePacket, txId)
        screen = Screen.SUCCESS
    }

    /**
     * Signs with this device's request sub-key, prompting for biometrics or
     * the device credential when the Keystore asks for them.
     *
     * Returns null if the user cannot or will not authenticate, and the
     * caller sends nothing: an order nobody authorised is not an order.
     */
    private suspend fun signPayload(payload: String): String? {
        deviceKeys.requestMacOrNull()?.let { return it.signHex(payload) }

        log("Confirm it is you")
        val prompt = authPrompt
        if (prompt == null) {
            execError = "This device needs a screen lock or a fingerprint to authorise an order."
            return null
        }
        if (!prompt()) {
            log("Not authorised — nothing was sent")
            return null
        }
        return deviceKeys.requestMacOrNull()?.signHex(payload)
    }

    /**
     * An SMS arrived. If it verifies against this device's response
     * sub-key, and it is about the order we are waiting on, the screen may
     * finally say the order executed.
     *
     * Anything that does not verify is shown as an unverified message. It
     * is never allowed to read as a fill, however convincingly it is
     * worded: without the tag, anybody with the phone number could write it.
     */
    fun onSmsReceived(message: String) {
        if (!Confirmation.looksLikeConfirmation(message)) return
        val result = saleResult ?: return
        val verified = deviceKeys.verifyConfirmation(message)

        if (verified == null) {
            saleResult = result.copy(confidence = Confidence.UNVERIFIED)
            return
        }
        // A genuine confirmation for some other order is not this one's.
        if (pendingTxId != null && verified.txId != pendingTxId) return

        saleResult = if (verified.isFill) {
            result.copy(
                confidence = Confidence.EXECUTED,
                price = verified.fillPrice ?: result.price,
                qty = verified.quantity ?: result.qty,
                confirmationText = verified.text,
            )
        } else {
            result.copy(
                confidence = Confidence.REFUSED,
                refusalCode = verified.status,
                confirmationText = verified.text,
            )
        }
        pendingTxId = null
    }

    /**
     * Enrolls this device, online, and keeps the secret only long enough to
     * derive the two sub-keys.
     *
     * Both inputs come from a session the user is already signed in to
     * somewhere else: the session token identifies the account, the
     * six-digit code proves this device was authorised deliberately.
     *
     * Note what is NOT here: a sign-in screen. Wiring the Firebase Auth
     * SDK into the app needs a configured project and a google-services
     * file this repo does not carry, so the two values are pasted in. The
     * protocol the backend enforces is the real one; the way the app
     * obtains these two strings is the part still to build.
     */
    fun enrollDevice() {
        val backend = backendUrl.trimEnd('/')
        if (backend.isEmpty()) {
            enrollmentStatus = "Set a backend URL first — enrollment needs the network."
            return
        }
        if (sessionToken.isBlank()) {
            enrollmentStatus = "Sign in first: paste the session token from the signed-in screen."
            return
        }
        if (enrollmentCode.isBlank()) {
            enrollmentStatus = "Enter the six-digit code shown on the signed-in screen."
            return
        }
        enrollmentStatus = "Enrolling…"
        viewModelScope.launch {
            BackendApi(backend).enrollDevice(sessionToken.trim(), enrollmentCode.trim())
                .onSuccess { enrolled ->
                    runCatching {
                        deviceKeys.enroll(enrolled.keyId, enrolled.userId, enrolled.secretHex)
                    }.onSuccess {
                        // The code is single use and now spent; holding on
                        // to it would only invite a confusing retry.
                        enrollmentCode = ""
                        enrollmentStatus = "Enrolled as ${enrolled.keyId}"
                    }.onFailure {
                        enrollmentStatus = "Could not store the key on this device: ${it.message}"
                    }
                }
                .onFailure { enrollmentStatus = "Enrollment failed: ${it.message}" }
        }
    }

    fun returnToDashboard() {
        activeHolding = null
        screen = Screen.DASHBOARD
        refreshHoldings()
    }

    private companion object {
        const val KEY_BACKEND_URL = SmsGatewayReceiver.KEY_BACKEND_URL
        const val KEY_SMS_NUMBER = "sms_number"
    }
}
