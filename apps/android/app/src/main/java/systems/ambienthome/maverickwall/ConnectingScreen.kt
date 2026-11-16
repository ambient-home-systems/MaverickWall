package systems.ambienthome.maverickwall

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The native "connecting…" status: rule nine's third layer, shown only when
 * neither the page nor its disk cache can draw.
 *
 * It was an XML layout, and it moved to Compose for one reason: it has to be
 * drawn the right way up on a television hung on its end, and a turned view
 * tree keeps its focus search in the unturned layout — the remote's Right would
 * move between buttons drawn one above the other. [Rotated] carries the turn
 * through Compose's focus search as well as its drawing, which is the same
 * mechanism setup and pairing use, so all three of the app's own screens turn
 * one way.
 *
 * Retry takes focus when the status appears, so the remote's OK — which the
 * kiosk otherwise forwards to the wall — presses it.
 *
 * It says why it is up ([reason]), because "waiting for the server" over a
 * server that is answering is a sentence the household would check and find
 * false. [deaths] is how many times the page has died in the window
 * [RendererRecovery] counts, and is read only while [reason] is
 * [ConnectingReason.RESTING].
 */
@Composable
fun ConnectingScreen(
    host: String,
    reason: ConnectingReason,
    deaths: Int,
    onRetry: () -> Unit,
    onChangeServer: () -> Unit,
) {
    val retry = remember { FocusRequester() }
    LaunchedEffect(Unit) { retry.requestFocus() }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = stringResource(R.string.app_name),
                color = MaterialTheme.colorScheme.primary,
                fontSize = 28.sp,
                fontWeight = FontWeight.Bold,
            )
            CircularProgressIndicator(
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(top = 24.dp),
            )
            Text(
                text = when (reason) {
                    ConnectingReason.SERVER -> stringResource(R.string.connecting_to, host)
                    ConnectingReason.RESTARTING -> stringResource(R.string.restarting_title)
                    ConnectingReason.RESTING -> stringResource(R.string.resting_title)
                },
                color = MaterialTheme.colorScheme.onBackground,
                fontSize = 16.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .widthIn(max = 520.dp)
                    .padding(top = 24.dp),
            )
            Text(
                text = when (reason) {
                    ConnectingReason.SERVER -> stringResource(R.string.connecting_hint)
                    ConnectingReason.RESTARTING -> stringResource(R.string.restarting_hint)
                    ConnectingReason.RESTING ->
                        pluralStringResource(R.plurals.resting_hint, deaths, deaths)
                },
                // `wall_text_dim`, the quieter ink the XML status used.
                color = Color(0xFF9AA6B2),
                fontSize = 13.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .widthIn(max = 520.dp)
                    .padding(top = 8.dp),
            )
            Row(
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.padding(top = 28.dp),
            ) {
                Button(onClick = onRetry, modifier = Modifier.focusRequester(retry)) {
                    Text(stringResource(R.string.retry))
                }
                OutlinedButton(onClick = onChangeServer) {
                    Text(stringResource(R.string.change_server))
                }
            }
        }
    }
}

/** Why the native status is up, which decides what it says. */
enum class ConnectingReason {
    /** The server has not answered: a cold boot, or a load that failed. */
    SERVER,

    /** The page's process died and the wall is loading again now. */
    RESTARTING,

    /** It has died more than once in a few minutes, so the reload is waiting. */
    RESTING,
}
