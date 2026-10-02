package com.traderescue.app

import android.content.IntentFilter
import android.os.Bundle
import android.provider.Telephony
import androidx.core.content.ContextCompat
import com.traderescue.app.data.SmsGatewayReceiver
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import com.traderescue.app.ui.TradeRescueApp

class MainActivity : ComponentActivity() {
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

    override fun onDestroy() {
        unregisterReceiver(gatewayReceiver)
        super.onDestroy()
    }

    override fun onResume() {
        super.onResume()
        // Picks up a grant/revoke made in system Settings while we were away.
        viewModel.refreshSmsPermission()
    }
}
