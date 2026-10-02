package com.traderescue.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Same palette as ui/index.html, so a screenshot of either build reads as
// the same product.
val StatusOnline = Color(0xFF35D18C)
val StatusOffline = Color(0xFFE14C3E)
val Emergency = Color(0xFFF5A623)
val EmergencyText = Color(0xFF17110A)

private val DarkColors = darkColorScheme(
    background = Color(0xFF05070B),
    surface = Color(0xFF131824),
    onBackground = Color(0xFFE8EAED),
    onSurface = Color(0xFFE8EAED),
    primary = Emergency,
    onPrimary = EmergencyText,
    outline = Color(0xFF232B3D),
)

private val LightColors = lightColorScheme(
    background = Color(0xFFEEF0F3),
    surface = Color(0xFFFFFFFF),
    onBackground = Color(0xFF14161C),
    onSurface = Color(0xFF14161C),
    primary = Color(0xFFC9820A),
    onPrimary = EmergencyText,
    outline = Color(0xFFE2E4E9),
)

@Composable
fun TradeRescueTheme(content: @Composable () -> Unit) {
    val colors = if (isSystemInDarkTheme()) DarkColors else LightColors
    MaterialTheme(colorScheme = colors, content = content)
}
