package com.traderescue.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.traderescue.app.AppViewModel
import com.traderescue.app.Channel
import com.traderescue.app.Screen
import com.traderescue.app.data.Holding
import java.text.NumberFormat
import java.util.Locale

private val inr: NumberFormat = NumberFormat.getCurrencyInstance(Locale("en", "IN"))
private fun rupees(v: Double) = inr.format(v)

@Composable
private fun mutedColor() = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)

@Composable
fun TradeRescueApp(vm: AppViewModel, onRequestPermission: (String) -> Unit) {
    // A gateway phone has to stay awake to keep listening.
    val view = LocalView.current
    DisposableEffect(vm.gatewayMode) {
        view.keepScreenOn = vm.gatewayMode
        onDispose { view.keepScreenOn = false }
    }
    TradeRescueTheme {
        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            // System back walks the flow backwards instead of closing the app
            // mid-order. On the dashboard it is left alone (exits as usual);
            // while an order is in flight it is swallowed.
            BackHandler(enabled = vm.screen != Screen.DASHBOARD) {
                when (vm.screen) {
                    Screen.SETTINGS, Screen.SELECT_HOLDING -> vm.goTo(Screen.DASHBOARD)
                    Screen.QUANTITY -> vm.goTo(Screen.SELECT_HOLDING)
                    Screen.PIN -> vm.goTo(Screen.QUANTITY)
                    Screen.EXECUTING -> if (!vm.execBusy) vm.goTo(Screen.QUANTITY)
                    Screen.SUCCESS -> vm.returnToDashboard()
                    Screen.DASHBOARD -> Unit
                }
            }
            Box(Modifier.fillMaxSize().safeDrawingPadding()) {
                when (vm.screen) {
                    Screen.DASHBOARD -> DashboardScreen(vm)
                    Screen.SETTINGS -> SettingsScreen(vm, onRequestPermission)
                    Screen.SELECT_HOLDING -> SelectHoldingScreen(vm)
                    Screen.QUANTITY -> QuantityScreen(vm)
                    Screen.PIN -> PinScreen(vm)
                    Screen.EXECUTING -> ExecutingScreen(vm)
                    Screen.SUCCESS -> SuccessScreen(vm)
                }
            }
        }
    }
}

@Composable
private fun ScreenScaffold(
    title: String? = null,
    onBack: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(Modifier.fillMaxSize().padding(20.dp)) {
        if (onBack != null) {
            TextButton(onClick = onBack, contentPadding = PaddingValues(0.dp)) { Text("‹ Back") }
        }
        if (title != null) {
            Text(title, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(top = 4.dp, bottom = 12.dp))
        }
        content()
    }
}

@Composable
private fun DashboardScreen(vm: AppViewModel) {
    val total = vm.holdings.sumOf { it.qty * it.price }
    Column(Modifier.fillMaxSize().padding(20.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("TradeRescue", style = MaterialTheme.typography.titleLarge)
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { vm.goTo(Screen.SETTINGS) }) { Text("⚙", fontSize = 18.sp) }
                Spacer(Modifier.width(4.dp))
                StatusPill(
                    online = vm.isOnline,
                    label = when {
                        vm.isOnline -> "Online"
                        vm.networkAvailable -> "Offline · test"
                        else -> "Offline"
                    },
                    onClick = vm::toggleSimulatedOutage,
                )
            }
        }

        Spacer(Modifier.height(16.dp))
        Text("Portfolio value", style = MaterialTheme.typography.labelMedium, color = mutedColor())
        Text(rupees(total), style = MaterialTheme.typography.displaySmall)
        if (vm.backendUrl.isEmpty()) {
            Text(
                "Simulation mode — add a backend in ⚙ to place real orders",
                style = MaterialTheme.typography.bodySmall,
                color = Emergency,
                modifier = Modifier.padding(top = 4.dp),
            )
        } else {
            val error = vm.syncError
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    when {
                        error != null -> "Could not sync with server: $error"
                        vm.lastSynced && vm.isOnline -> "Live from server"
                        vm.lastSynced -> "Last synced before going offline"
                        else -> "Not synced with server yet"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = if (error != null) StatusOffline else mutedColor(),
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = vm::refreshHoldings, enabled = vm.isOnline) { Text("↻ Refresh") }
            }
        }

        if (vm.gatewayMode) {
            Surface(
                shape = RoundedCornerShape(12.dp),
                border = BorderStroke(1.dp, Emergency),
                color = Color.Transparent,
                modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
            ) {
                Column(Modifier.padding(12.dp)) {
                    Text(
                        if (vm.smsReceiveGranted) "Gateway mode — listening for emergency SMS"
                        else "Gateway mode — SMS permission missing, open ⚙",
                        style = MaterialTheme.typography.labelLarge,
                        color = if (vm.smsReceiveGranted) Color.Unspecified else StatusOffline,
                    )
                    Text(
                        vm.gatewayLog.ifEmpty { "No packet received yet. Keep this app open." },
                        style = MaterialTheme.typography.bodySmall,
                        color = mutedColor(),
                    )
                }
            }
        }

        Spacer(Modifier.height(12.dp))
        HorizontalDivider()
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            vm.holdings.forEach { h -> HoldingRow(h) }
        }

        Button(
            onClick = { vm.goTo(Screen.SELECT_HOLDING) },
            modifier = Modifier.fillMaxWidth().height(56.dp),
            shape = RoundedCornerShape(16.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Emergency, contentColor = EmergencyText),
        ) {
            Text("🚨 Emergency Sell", fontSize = 17.sp)
        }
        Text(
            if (vm.isOnline) "Online now. Tap the status pill to rehearse an outage."
            else "Data is down — orders go out as a signed SMS packet.",
            style = MaterialTheme.typography.bodySmall,
            color = mutedColor(),
            modifier = Modifier.padding(top = 8.dp).align(Alignment.CenterHorizontally),
        )
    }
}

@Composable
private fun StatusPill(online: Boolean, label: String, onClick: () -> Unit) {
    val color = if (online) StatusOnline else StatusOffline
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(20.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
        color = Color.Transparent,
    ) {
        Row(Modifier.padding(horizontal = 11.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(7.dp).background(color, CircleShape))
            Spacer(Modifier.width(6.dp))
            Text(label, color = color, fontSize = 13.sp)
        }
    }
}

@Composable
private fun HoldingRow(h: Holding) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 14.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column {
            Text(h.symbol, style = MaterialTheme.typography.titleMedium)
            Text("${h.qty} shares", style = MaterialTheme.typography.bodySmall, color = mutedColor())
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(rupees(h.price), style = MaterialTheme.typography.bodyLarge)
            val up = h.changePct >= 0
            Text(
                (if (up) "▲ " else "▼ ") + "%.1f%%".format(kotlin.math.abs(h.changePct)),
                color = if (up) StatusOnline else StatusOffline,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
    HorizontalDivider()
}

@Composable
private fun SettingsScreen(vm: AppViewModel, onRequestPermission: (String) -> Unit) {
    var urlField by remember { mutableStateOf(vm.backendUrl) }
    var smsField by remember { mutableStateOf(vm.smsDestinationNumber) }
    ScreenScaffold(title = "Backend connection", onBack = { vm.goTo(Screen.DASHBOARD) }) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Text(
                "Your deployed API's base URL (Render, or wherever you host it). Empty runs the flow in simulation mode.",
                style = MaterialTheme.typography.bodySmall,
                color = mutedColor(),
            )
            OutlinedTextField(
                value = urlField, onValueChange = { urlField = it },
                placeholder = { Text("https://your-app.onrender.com") },
                singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
            )
            Spacer(Modifier.height(16.dp))
            Text(
                "The number real emergency SMS gets sent to (e.g. your Twilio number, once deployed).",
                style = MaterialTheme.typography.bodySmall,
                color = mutedColor(),
            )
            OutlinedTextField(
                value = smsField, onValueChange = { smsField = it },
                placeholder = { Text("+1XXXXXXXXXX") },
                singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
            )

            Spacer(Modifier.height(20.dp))
            Text("Status", style = MaterialTheme.typography.labelMedium, color = mutedColor())
            StatusLine("Data connection", if (vm.networkAvailable) "Available" else "Down", vm.networkAvailable)
            StatusLine("SMS permission", if (vm.smsPermissionGranted) "Granted" else "Not granted", vm.smsPermissionGranted)
            if (!vm.smsPermissionGranted) {
                TextButton(onClick = { onRequestPermission(android.Manifest.permission.SEND_SMS) }, contentPadding = PaddingValues(0.dp)) {
                    Text("Grant SMS permission")
                }
            }

            Spacer(Modifier.height(20.dp))
            HorizontalDivider()
            Row(Modifier.fillMaxWidth().padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Gateway mode", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "Turn on only on the receiving phone. It forwards incoming emergency SMS to the backend above and texts the confirmation back. Needs a saved Backend URL and a data connection.",
                        style = MaterialTheme.typography.bodySmall,
                        color = mutedColor(),
                    )
                }
                Spacer(Modifier.width(12.dp))
                Switch(
                    checked = vm.gatewayMode,
                    onCheckedChange = { on ->
                        vm.updateGatewayMode(on)
                        if (on && !vm.smsReceiveGranted) onRequestPermission(android.Manifest.permission.RECEIVE_SMS)
                    },
                )
            }
            if (vm.gatewayMode) {
                StatusLine("Receive SMS permission", if (vm.smsReceiveGranted) "Granted" else "Not granted", vm.smsReceiveGranted)
                StatusLine("Reply SMS permission", if (vm.smsPermissionGranted) "Granted" else "Not granted", vm.smsPermissionGranted)
                if (!vm.smsReceiveGranted) {
                    TextButton(onClick = { onRequestPermission(android.Manifest.permission.RECEIVE_SMS) }, contentPadding = PaddingValues(0.dp)) {
                        Text("Grant receive permission")
                    }
                }
                Text("Last gateway activity", style = MaterialTheme.typography.labelMedium, color = mutedColor(), modifier = Modifier.padding(top = 12.dp))
                Text(
                    vm.gatewayLog.ifEmpty { "Nothing yet — no TradeRescue SMS has reached this app." },
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (urlField.isBlank()) {
                    Text("Add the Backend URL above, or nothing can be forwarded.", style = MaterialTheme.typography.bodySmall, color = StatusOffline, modifier = Modifier.padding(top = 6.dp))
                }
            }
            Spacer(Modifier.height(16.dp))
        }
        Button(
            onClick = { vm.saveSettings(urlField, smsField) },
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) { Text("Save") }
    }
}

@Composable
private fun StatusLine(label: String, value: String, ok: Boolean) {
    Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Text(value, style = MaterialTheme.typography.bodyMedium, color = if (ok) StatusOnline else StatusOffline)
    }
}

@Composable
private fun SelectHoldingScreen(vm: AppViewModel) {
    ScreenScaffold(title = "What do you need to sell?", onBack = { vm.goTo(Screen.DASHBOARD) }) {
        Text(
            "Each holding has a pre-authorized emergency limit, checked before anything executes.",
            style = MaterialTheme.typography.bodySmall,
            color = mutedColor(),
            modifier = Modifier.padding(bottom = 14.dp),
        )
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            vm.holdings.forEach { h ->
                val cap = h.maxSellable
                Surface(
                    onClick = { vm.selectHolding(h) },
                    enabled = cap > 0,
                    shape = RoundedCornerShape(14.dp),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
                    modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp),
                ) {
                    Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        Column {
                            Text(h.symbol, style = MaterialTheme.typography.titleMedium, color = if (cap > 0) Color.Unspecified else mutedColor())
                            Text(
                                if (cap > 0) "Authorized up to $cap shares" else "Nothing left to sell",
                                style = MaterialTheme.typography.bodySmall,
                                color = mutedColor(),
                            )
                        }
                        Text(rupees(h.price), style = MaterialTheme.typography.bodyLarge, color = if (cap > 0) Color.Unspecified else mutedColor())
                    }
                }
            }
        }
    }
}

@Composable
private fun QuantityScreen(vm: AppViewModel) {
    val h = vm.activeHolding ?: return
    val cap = vm.maxSellable()
    ScreenScaffold(onBack = { vm.goTo(Screen.SELECT_HOLDING) }) {
        Column(Modifier.fillMaxWidth().padding(vertical = 20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(h.symbol, color = mutedColor())
            Text("${vm.sellQty}", style = MaterialTheme.typography.displayLarge, modifier = Modifier.padding(vertical = 8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                FilledTonalIconButton(onClick = { vm.changeQty(-1) }, enabled = vm.sellQty > 1, modifier = Modifier.size(52.dp)) { Text("–", fontSize = 22.sp) }
                FilledTonalIconButton(onClick = { vm.changeQty(1) }, enabled = vm.sellQty < cap, modifier = Modifier.size(52.dp)) { Text("+", fontSize = 22.sp) }
            }
            TextButton(onClick = { vm.changeQty(cap) }, enabled = vm.sellQty < cap) { Text("Sell max ($cap)") }
            Text(
                "Max $cap shares authorized for emergency sell",
                style = MaterialTheme.typography.bodySmall,
                color = mutedColor(),
            )
        }
        Surface(
            shape = RoundedCornerShape(14.dp),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(Modifier.padding(16.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("Estimated proceeds", style = MaterialTheme.typography.labelMedium, color = mutedColor())
                Text(rupees(vm.sellQty * h.price), style = MaterialTheme.typography.headlineSmall)
                Text(
                    if (vm.isOnline) "Will go over the direct connection" else "Will go over the emergency SMS channel",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (vm.isOnline) StatusOnline else Emergency,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
        Spacer(Modifier.weight(1f))
        Button(
            onClick = { vm.openPin() },
            modifier = Modifier.fillMaxWidth().height(56.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Emergency, contentColor = EmergencyText),
        ) { Text("Confirm Emergency Sell") }
    }
}

@Composable
private fun PinScreen(vm: AppViewModel) {
    val locked = vm.pinLockSeconds > 0
    ScreenScaffold(onBack = { vm.goTo(Screen.QUANTITY) }) {
        Column(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("Confirm it's you", style = MaterialTheme.typography.headlineSmall)
            Text(
                "Enter your PIN to authorize this emergency sell",
                style = MaterialTheme.typography.bodySmall,
                color = mutedColor(),
                modifier = Modifier.padding(top = 4.dp, bottom = 20.dp),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                repeat(4) { i ->
                    val filled = i < vm.enteredPin.length
                    Box(
                        Modifier.size(15.dp)
                            .background(if (filled) MaterialTheme.colorScheme.onSurface else Color.Transparent, CircleShape)
                            .border(1.5.dp, if (filled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.outline, CircleShape)
                    )
                }
            }
            if (vm.pinError.isNotEmpty()) {
                Text(
                    if (locked) "${vm.pinError} — try again in ${vm.pinLockSeconds}s" else vm.pinError,
                    color = StatusOffline,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 12.dp),
                )
            }
        }
        Spacer(Modifier.weight(1f))
        PinKeypad(enabled = !locked, onDigit = vm::pressPinDigit, onBackspace = vm::backspacePin)
        Text(
            "Demo PIN: 1234",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
            modifier = Modifier.padding(top = 16.dp).align(Alignment.CenterHorizontally),
        )
    }
}

@Composable
private fun PinKeypad(enabled: Boolean, onDigit: (Int) -> Unit, onBackspace: () -> Unit) {
    val rows = listOf(listOf(1, 2, 3), listOf(4, 5, 6), listOf(7, 8, 9))
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        rows.forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.padding(bottom = 14.dp)) {
                row.forEach { d ->
                    FilledTonalButton(onClick = { onDigit(d) }, enabled = enabled, shape = CircleShape, modifier = Modifier.size(64.dp), contentPadding = PaddingValues(0.dp)) {
                        Text("$d", fontSize = 20.sp)
                    }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Spacer(Modifier.size(64.dp))
            FilledTonalButton(onClick = { onDigit(0) }, enabled = enabled, shape = CircleShape, modifier = Modifier.size(64.dp), contentPadding = PaddingValues(0.dp)) {
                Text("0", fontSize = 20.sp)
            }
            FilledTonalButton(onClick = onBackspace, enabled = enabled, shape = CircleShape, modifier = Modifier.size(64.dp), contentPadding = PaddingValues(0.dp)) {
                Text("⌫", fontSize = 18.sp)
            }
        }
    }
}

/** The signed packet exactly as it goes over the air — the point of the demo. */
@Composable
private fun PacketCard(wire: String) {
    Surface(
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
        modifier = Modifier.fillMaxWidth().padding(top = 14.dp),
    ) {
        Column(Modifier.padding(14.dp)) {
            Text("Signed packet · ${wire.length} of 160 SMS characters", style = MaterialTheme.typography.labelMedium, color = mutedColor())
            SelectionContainer {
                Text(wire, fontFamily = FontFamily.Monospace, fontSize = 12.sp, lineHeight = 17.sp, modifier = Modifier.padding(top = 6.dp))
            }
        }
    }
}

@Composable
private fun ExecutingScreen(vm: AppViewModel) {
    ScreenScaffold(title = "Executing") {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.Center) {
            vm.execLog.forEach { line ->
                Row(Modifier.padding(vertical = 8.dp)) {
                    Text("✓ ", color = StatusOnline)
                    Text(line)
                }
            }
            if (vm.execBusy) {
                Row(Modifier.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(10.dp))
                    Text("Working…", color = mutedColor())
                }
            }
            vm.wirePacket?.let { PacketCard(it) }
            vm.execError?.let { err ->
                Row(Modifier.padding(top = 14.dp, bottom = 8.dp)) {
                    Text("✕ ", color = StatusOffline)
                    Text(err, color = StatusOffline)
                }
                Text("Nothing was sold. Your holdings are unchanged.", style = MaterialTheme.typography.bodySmall, color = mutedColor())
                Button(onClick = { vm.goTo(Screen.QUANTITY) }, modifier = Modifier.padding(top = 12.dp)) { Text("Back") }
            }
        }
    }
}

@Composable
private fun SuccessScreen(vm: AppViewModel) {
    val r = vm.saleResult ?: return
    val via = when (r.channel) {
        Channel.DIRECT -> "the direct connection"
        Channel.SMS -> "the emergency SMS channel"
        Channel.HTTP_FALLBACK -> "the emergency channel (HTTP fallback)"
        Channel.SIMULATED -> "simulation mode"
    }
    val proceeds = rupees(r.qty * r.price)
    Column(Modifier.fillMaxSize().padding(20.dp)) {
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Box(Modifier.size(64.dp).background(if (r.confirmed) StatusOnline else Emergency, CircleShape), contentAlignment = Alignment.Center) {
                Text("✓", fontSize = 26.sp, color = Color(0xFF06251A))
            }
            Text(
                if (r.confirmed) "Order executed" else "Order sent",
                style = MaterialTheme.typography.headlineSmall,
                modifier = Modifier.padding(top = 18.dp, bottom = 8.dp),
            )
            Text(
                if (r.confirmed)
                    "Sold ${r.qty} shares of ${r.symbol} at ${rupees(r.price)} — proceeds $proceeds, via $via."
                else
                    "Sell ${r.qty} shares of ${r.symbol} went out via $via. Estimated proceeds $proceeds at the last known price; the broker confirms the fill once it processes the packet.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                textAlign = TextAlign.Center,
            )
            r.wirePacket?.let { PacketCard(it) }
        }
        OutlinedButton(onClick = { vm.returnToDashboard() }, modifier = Modifier.fillMaxWidth().height(52.dp)) { Text("Done") }
    }
}
