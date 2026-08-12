package systems.ambienthome.maverickwall

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * A dark scheme for the native chrome, drawn from the display's Board theme.
 *
 * Deliberately fixed dark, not system-following: a wall's default theme is
 * Board (dark, amber), and the setup and status screens are the household's
 * first sight of the product — they should look like the wall they are about to
 * see, not like the phone's light mode. These are approximations of the design
 * tokens, enough for the chrome to feel of a piece; the wall itself gets the
 * exact tokens from the server, never from here.
 */
private val WallColorScheme = darkColorScheme(
    primary = Color(0xFFE7A93C),
    onPrimary = Color(0xFF10130A),
    background = Color(0xFF0B0E11),
    onBackground = Color(0xFFE9EEF4),
    surface = Color(0xFF141A20),
    onSurface = Color(0xFFE9EEF4),
    error = Color(0xFFE5766A),
)

@Composable
fun MaverickWallTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = WallColorScheme, content = content)
}
