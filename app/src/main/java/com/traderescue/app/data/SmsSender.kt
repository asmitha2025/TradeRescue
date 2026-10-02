package com.traderescue.app.data

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SmsManager
import androidx.core.content.ContextCompat
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException
import kotlin.coroutines.resume

/**
 * The actual reason a native build is worth having over the web UI: sending
 * a real SMS over the cellular network, independent of data connectivity,
 * via the OS radio directly -- not an HTTP request pretending to be one.
 *
 * Needs android.permission.SEND_SMS granted at runtime (Android 6.0+);
 * MainActivity requests it at launch. When [unavailableReason] is non-null
 * the caller falls back to BackendApi.postEmergencyPacket() over HTTP --
 * same signed packet either way, only the transport differs, matching the
 * three-tier failover the backend already implements.
 */
object SmsSender {
    private const val SENT_TIMEOUT_MS = 30_000L

    fun hasPermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, android.Manifest.permission.SEND_SMS) ==
            PackageManager.PERMISSION_GRANTED

    /** Why real SMS can't be used right now, or null if it can. */
    fun unavailableReason(context: Context, destinationNumber: String): String? = when {
        destinationNumber.isBlank() -> "no SMS number set"
        !context.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY) -> "this device has no cellular radio"
        !hasPermission(context) -> "SMS permission not granted"
        else -> null
    }

    /**
     * Sends the packet and suspends until the radio reports what happened to
     * it, so "sent" on screen means the network accepted the message rather
     * than that we merely asked for it to be sent.
     */
    suspend fun send(context: Context, destinationNumber: String, wirePacket: String): Result<Unit> {
        val appContext = context.applicationContext
        val action = "${appContext.packageName}.SMS_SENT.${PacketSigner.randomHex(4)}"
        return withTimeoutOrNull(SENT_TIMEOUT_MS) {
            suspendCancellableCoroutine { cont ->
                val receiver = object : BroadcastReceiver() {
                    override fun onReceive(c: Context, intent: Intent) {
                        runCatching { appContext.unregisterReceiver(this) }
                        if (!cont.isActive) return
                        cont.resume(
                            if (resultCode == Activity.RESULT_OK) Result.success(Unit)
                            else Result.failure(IOException(describeFailure(resultCode)))
                        )
                    }
                }
                ContextCompat.registerReceiver(
                    appContext, receiver, IntentFilter(action), ContextCompat.RECEIVER_NOT_EXPORTED
                )
                cont.invokeOnCancellation { runCatching { appContext.unregisterReceiver(receiver) } }
                try {
                    val sentIntent = PendingIntent.getBroadcast(
                        appContext, 0, Intent(action).setPackage(appContext.packageName), PendingIntent.FLAG_IMMUTABLE
                    )
                    // The packet is ~85 ASCII characters by design, so it
                    // always fits one 160-character SMS segment.
                    smsManager(appContext).sendTextMessage(destinationNumber, null, wirePacket, sentIntent, null)
                } catch (e: Exception) {
                    runCatching { appContext.unregisterReceiver(receiver) }
                    if (cont.isActive) cont.resume(Result.failure(e))
                }
            }
        } ?: Result.failure(IOException("the radio did not confirm the SMS within ${SENT_TIMEOUT_MS / 1000}s"))
    }

    /** Fire-and-forget text, used by Gateway mode for the confirmation reply. */
    fun sendReply(context: Context, destinationNumber: String, text: String) {
        val manager = smsManager(context.applicationContext)
        manager.sendMultipartTextMessage(destinationNumber, null, manager.divideMessage(text), null, null)
    }

    private fun smsManager(context: Context): SmsManager =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            context.getSystemService(SmsManager::class.java)
        } else {
            @Suppress("DEPRECATION")
            SmsManager.getDefault()
        }

    private fun describeFailure(resultCode: Int): String = when (resultCode) {
        SmsManager.RESULT_ERROR_NO_SERVICE -> "no cellular service"
        SmsManager.RESULT_ERROR_RADIO_OFF -> "the radio is off (airplane mode?)"
        SmsManager.RESULT_ERROR_NULL_PDU -> "the message could not be encoded"
        else -> "the network rejected the message (code $resultCode)"
    }
}
