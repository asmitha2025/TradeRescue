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
import com.traderescue.app.data.PacketSigner
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import com.traderescue.app.data.SIGNING_SECRET
import com.traderescue.app.data.SmsGatewayReceiver
import com.traderescue.app.data.SmsSender
import com.traderescue.app.data.demoHoldings
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

enum class Screen { DASHBOARD, SETTINGS, SELECT_HOLDING, QUANTITY, PIN, EXECUTING, SUCCESS }

/** How an order actually left the phone. */
enum class Channel { DIRECT, SMS, HTTP_FALLBACK, SIMULATED }

/**
 * What the success screen shows. [confirmed] is false for the SMS channel:
 * the radio accepted the message, but the fill itself is confirmed by the
 * backend, which the phone can't reach while it is offline.
 */
data class SaleResult(
    val symbol: String,
    val qty: Int,
    val price: Double,
    val channel: Channel,
    val confirmed: Boolean,
    val wirePacket: String?,
)

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
                        finishSale(holding, qty, holding.price, Channel.SIMULATED, confirmed = true)
                    } else {
                        log("Sending order over HTTPS")
                        api.placeNormalOrder(USER_ID, holding.symbol, "SELL", qty)
                            .onSuccess { finishSale(holding, qty, it.optDouble("fill_price", holding.price), Channel.DIRECT, confirmed = true) }
                            .onFailure { execError = "Could not reach backend: ${it.message}" }
                    }
                    return@launch
                }

                log("No data connection — switching to the emergency channel")
                delay(500)
                val packet = EmergencyPacket.build(USER_ID, "S", holding.symbol, qty)
                val wire = packet.toWire(PacketSigner.hmacSha256Hex(SIGNING_SECRET, packet.signingPayload()))
                wirePacket = wire
                log("Packet built & signed with HMAC-SHA256 (${wire.length} characters)")
                delay(500)

                val smsBlocker = SmsSender.unavailableReason(getApplication(), smsDestinationNumber)
                when {
                    smsBlocker == null -> {
                        log("Handing the packet to the cellular radio")
                        // The SMS is the order. It is deliberately NOT also
                        // posted over HTTP: the backend would see the same
                        // nonce twice and reject the second copy as a replay.
                        SmsSender.send(getApplication(), smsDestinationNumber, wire)
                            .onSuccess {
                                log("SMS accepted by the network → $smsDestinationNumber")
                                finishSale(holding, qty, holding.price, Channel.SMS, confirmed = false)
                            }
                            .onFailure { execError = "SMS could not be sent: ${it.message}" }
                    }
                    api == null -> {
                        log("Real SMS skipped ($smsBlocker) — simulating the SMS gateway")
                        delay(900)
                        finishSale(holding, qty, holding.price, Channel.SIMULATED, confirmed = true)
                    }
                    else -> {
                        log("Real SMS skipped ($smsBlocker) — posting the same signed packet over HTTP")
                        api.postEmergencyPacket(wire)
                            .onSuccess { finishSale(holding, qty, it.optDouble("fill_price", holding.price), Channel.HTTP_FALLBACK, confirmed = true) }
                            .onFailure { execError = "Could not reach the emergency gateway: ${it.message}" }
                    }
                }
            } finally {
                execBusy = false
            }
        }
    }

    private fun finishSale(holding: Holding, qty: Int, fillPrice: Double, channel: Channel, confirmed: Boolean) {
        holdings = holdings.map { if (it.symbol == holding.symbol) it.copy(qty = it.qty - qty) else it }
        saleResult = SaleResult(holding.symbol, qty, fillPrice, channel, confirmed, wirePacket)
        screen = Screen.SUCCESS
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
