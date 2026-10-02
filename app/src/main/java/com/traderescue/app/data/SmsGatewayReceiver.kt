package com.traderescue.app.data

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Gateway mode: lets a second phone stand in for the SMS provider. It
 * receives the emergency SMS on an ordinary SIM, forwards the packet to
 * the backend over its own data connection, and texts the backend's
 * confirmation back to the sender.
 *
 * Only messages that look like TradeRescue packets are touched, and only
 * while the switch in Settings is on; every other SMS is ignored. The
 * gateway is a courier, not a trusted party: it cannot forge or alter an
 * order, because the backend checks the packet's signature.
 */
class SmsGatewayReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        val from = parts.firstOrNull()?.originatingAddress ?: return
        val text = parts.joinToString("") { it.messageBody.orEmpty() }.trim()
        if (!text.startsWith("TRX|")) return
        // The receiver is registered twice (manifest, and by MainActivity
        // while the app is open), so the same SMS can arrive here twice.
        synchronized(handled) {
            if (!handled.add(text)) return
            if (handled.size > 50) handled.remove(handled.first())
        }

        // From here on every outcome is written to the status line shown in
        // Settings, so a silent gateway can be diagnosed from the phone.
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        fun note(message: String) {
            val time = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
            prefs.edit().putString(KEY_GATEWAY_LOG, "$time  $message").apply()
        }
        if (!prefs.getBoolean(KEY_GATEWAY_MODE, false)) {
            note("Packet arrived from $from but Gateway mode is off")
            return
        }
        val backend = prefs.getString(KEY_BACKEND_URL, "").orEmpty().trimEnd('/')
        if (backend.isEmpty()) {
            note("Packet arrived from $from but no Backend URL is saved")
            return
        }
        note("Packet received from $from, forwarding…")

        val appContext = context.applicationContext
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val reply = BackendApi(backend).forwardSms(from, text).fold(
                    onSuccess = {
                        note("Forwarded. Server said ${it.optString("status", "?")}")
                        it.optString("reply")
                    },
                    onFailure = {
                        Log.w(TAG, "Could not forward packet", it)
                        note("Could not reach the server: ${it.message}")
                        "TradeRescue: the gateway could not reach the server. Order NOT executed, please retry."
                    },
                )
                val last = prefs.getString(KEY_GATEWAY_LOG, "").orEmpty().substringAfter("  ")
                when {
                    reply.isBlank() -> Unit
                    !SmsSender.hasPermission(appContext) ->
                        note("$last Confirmation NOT sent: grant SMS permission in Settings.")
                    else -> try {
                        SmsSender.sendReply(appContext, from, reply)
                        note("$last Confirmation SMS sent to $from.")
                    } catch (e: Exception) {
                        note("$last Confirmation NOT sent: ${e.message}")
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Gateway failed", e)
                note("Gateway error: ${e.message}")
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        private const val TAG = "SmsGateway"
        private val handled = LinkedHashSet<String>()
        const val PREFS = "settings"
        const val KEY_BACKEND_URL = "backend_url"
        const val KEY_GATEWAY_MODE = "gateway_mode"
        const val KEY_GATEWAY_LOG = "gateway_log"
    }
}
