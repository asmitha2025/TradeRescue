package com.traderescue.app

import android.content.IntentFilter
import android.os.Bundle
import android.provider.Telephony
import androidx.core.content.ContextCompat
import com.traderescue.app.data.SmsGatewayReceiver
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.fragment.app.FragmentActivity
import androidx.core.content.ContextCompat.getMainExecutor
import com.traderescue.app.ui.TradeRescueApp
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

// FragmentActivity rather than ComponentActivity: BiometricPrompt needs
// one, and FragmentActivity extends ComponentActivity so setContent,
// viewModels and enableEdgeToEdge all still work.
class MainActivity : FragmentActivity() {
    private val viewModel: AppViewModel by viewModels()
    private val gatewayReceiver = SmsGatewayReceiver()

    private val requestSmsPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { viewModel.refreshSmsPermission() }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        // Asked up front rather than at the moment of an emergency sell: the
        // one time the user needs this path is the worst time for a dialog.
        if (savedInstanceState == null && !viewModel.smsPermissionGranted) {
            requestSmsPermission.launch(android.Manifest.permission.SEND_SMS)
        }

        // Signing an order moves money, so the Keystore asks for the user
        // every time. Biometrics or the device credential: a phone with no
        // enrolled fingerprint, or a wet thumb in the rain, must still have
        // an emergency exit.
        viewModel.authPrompt = { authenticate() }

        // A confirmation arriving by SMS goes to the view model, which
        // verifies its signature before believing a word of it.
        SmsGatewayReceiver.confirmationListener = { text ->
            runOnUiThread { viewModel.onSmsReceived(text) }
        }

        // Some phone makers refuse to wake a sideloaded app for an incoming
        // SMS, which silences the manifest receiver. Listening directly for
        // as long as this screen exists does not depend on being woken.
        ContextCompat.registerReceiver(
            this,
            gatewayReceiver,
            IntentFilter(Telephony.Sms.Intents.SMS_RECEIVED_ACTION).apply { priority = 999 },
            android.Manifest.permission.BROADCAST_SMS,
            null,
            ContextCompat.RECEIVER_EXPORTED,
        )

        setContent {
            TradeRescueApp(viewModel, onRequestPermission = { requestSmsPermission.launch(it) })
        }
    }

    /**
     * Returns true only if the user actually authenticated. Every other
     * outcome -- cancelled, failed, no enrolled factor at all -- is false,
     * and the caller sends nothing.
     */
    private suspend fun authenticate(): Boolean {
        val allowed = BiometricManager.Authenticators.BIOMETRIC_STRONG or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL
        if (BiometricManager.from(this).canAuthenticate(allowed) != BiometricManager.BIOMETRIC_SUCCESS) {
            return false
        }
        return suspendCancellableCoroutine { cont ->
            val prompt = BiometricPrompt(
                this,
                getMainExecutor(this),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        if (cont.isActive) cont.resume(true)
                    }

                    override fun onAuthenticationError(code: Int, message: CharSequence) {
                        if (cont.isActive) cont.resume(false)
                    }

                    // Not resumed: a single bad fingerprint is a retry, not
                    // a refusal. onAuthenticationError ends it either way.
                    override fun onAuthenticationFailed() = Unit
                },
            )
            prompt.authenticate(
                BiometricPrompt.PromptInfo.Builder()
                    .setTitle("Authorise this order")
                    .setSubtitle("TradeRescue signs the order with this device's key")
                    .setAllowedAuthenticators(allowed)
                    .build(),
            )
            cont.invokeOnCancellation { prompt.cancelAuthentication() }
        }
    }

    override fun onDestroy() {
        SmsGatewayReceiver.confirmationListener = null
        viewModel.authPrompt = null
        unregisterReceiver(gatewayReceiver)
        super.onDestroy()
    }

    override fun onResume() {
        super.onResume()
        // Picks up a grant/revoke made in system Settings while we were away.
        viewModel.refreshSmsPermission()
    }
}
