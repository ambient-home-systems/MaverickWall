package systems.ambienthome.maverickwall.pairing

import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import systems.ambienthome.maverickwall.KioskActivity
import systems.ambienthome.maverickwall.MaverickWallTheme
import systems.ambienthome.maverickwall.R
import systems.ambienthome.maverickwall.ServerConfig
import systems.ambienthome.maverickwall.SetupActivity

/**
 * Frictionless pairing on the screen itself (RFC 003 Phase 3).
 *
 * The screen starts a device-authorization flow, shows a short code and a QR,
 * and waits. The household approves it from a phone (scan the QR) or the admin
 * Screens page (type the code) — behind their login, which is the whole reason
 * the short code is safe. When the poll comes back approved, the token is handed
 * to the WebView via `/pair?token=…`, exactly the cookie exchange every other
 * pairing ends with, and the wall starts drawing.
 *
 * Rule nine runs through every exit. A server too old for the flow, or a
 * household that would rather type the code into the wall itself, both fall
 * straight through to the display's own on-screen pairing — never a dead end.
 */
class PairingActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val baseUrl = intent.getStringExtra(EXTRA_BASE_URL) ?: ServerConfig(this).baseUrl
        if (baseUrl.isNullOrBlank()) {
            // Nothing to pair against; go back to choosing a server.
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        val client = DeviceFlowClient(this, baseUrl)

        setContent {
            MaverickWallTheme {
                var state by remember { mutableStateOf<PairingUi>(PairingUi.Starting) }

                // One effect runs the whole flow: start, then poll on the
                // server's interval until a terminal answer. Cancelling the
                // composition (the activity leaving) cancels the loop.
                LaunchedEffect(Unit) {
                    when (val started = client.start()) {
                        StartResult.Unsupported -> openKiosk(baseUrl, null)
                        is StartResult.Failed -> state = PairingUi.Problem(started.reason)
                        is StartResult.Started -> {
                            val qr = withContext(Dispatchers.Default) {
                                QrCode.bitmap(started.verifyUrl, QR_SIZE_PX)
                            }
                            state = PairingUi.Waiting(started.userCode, started.verifyUrl, qr)

                            val intervalMs = started.pollIntervalSec.coerceAtLeast(1) * 1000L
                            while (isActive) {
                                delay(intervalMs)
                                when (val poll = client.poll(started.deviceCode)) {
                                    is PollResult.Approved -> {
                                        openKiosk(baseUrl, poll.token)
                                        return@LaunchedEffect
                                    }
                                    PollResult.Denied -> {
                                        state = PairingUi.Problem(getString(R.string.pair_declined))
                                        return@LaunchedEffect
                                    }
                                    PollResult.Expired -> {
                                        state = PairingUi.Problem(getString(R.string.pair_expired))
                                        return@LaunchedEffect
                                    }
                                    // Pending and transient failures both mean
                                    // "keep waiting" — the next poll carries the truth.
                                    PollResult.Pending -> Unit
                                    is PollResult.Failed -> Unit
                                }
                            }
                        }
                    }
                }

                PairingScreen(
                    state = state,
                    onPairOnScreen = { openKiosk(baseUrl, null) },
                    onRetry = { recreate() },
                )
            }
        }
    }

    /**
     * Hand off to the wall.
     *
     * With a token, the WebView is pointed at `/pair?token=…` first, which sets
     * the display cookie and redirects to the wall — so a device-flow screen is
     * indistinguishable downstream from a QR-paired one. Without a token (the
     * fallback paths) the wall loads its own pairing screen.
     */
    private fun openKiosk(baseUrl: String, token: String?) {
        ServerConfig(this).baseUrl = baseUrl
        startActivity(
            Intent(this, KioskActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                if (token != null) putExtra(KioskActivity.EXTRA_PAIR_TOKEN, token)
            },
        )
        finish()
    }

    companion object {
        /** The server origin to pair against. */
        const val EXTRA_BASE_URL = "systems.ambienthome.maverickwall.BASE_URL"

        /** A generous square; the household photographs it from across a room. */
        private const val QR_SIZE_PX = 640
    }
}

/** What the pairing screen is showing. */
private sealed interface PairingUi {
    data object Starting : PairingUi
    data class Waiting(val userCode: String, val verifyUrl: String, val qr: Bitmap?) : PairingUi
    data class Problem(val message: String) : PairingUi
}

@Composable
private fun PairingScreen(
    state: PairingUi,
    onPairOnScreen: () -> Unit,
    onRetry: () -> Unit,
) {
    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier
                .padding(40.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            when (state) {
                PairingUi.Starting -> {
                    CircularProgressIndicator(color = MaterialTheme.colorScheme.onBackground)
                    Text(
                        text = stringResource(R.string.pair_preparing),
                        color = MaterialTheme.colorScheme.onBackground,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(top = 16.dp),
                    )
                }

                is PairingUi.Waiting -> {
                    Text(
                        text = stringResource(R.string.pair_title),
                        color = MaterialTheme.colorScheme.onBackground,
                        style = MaterialTheme.typography.headlineMedium,
                    )
                    Text(
                        text = stringResource(R.string.pair_instructions),
                        color = MaterialTheme.colorScheme.onBackground,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(top = 8.dp, bottom = 24.dp),
                    )
                    if (state.qr != null) {
                        Image(
                            bitmap = state.qr.asImageBitmap(),
                            contentDescription = null,
                            modifier = Modifier
                                .size(240.dp)
                                .background(Color.White)
                                .padding(12.dp),
                        )
                    }
                    Text(
                        text = stringResource(R.string.pair_code_hint),
                        color = MaterialTheme.colorScheme.onBackground,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(top = 24.dp),
                    )
                    Text(
                        text = formatCode(state.userCode),
                        color = MaterialTheme.colorScheme.onBackground,
                        style = MaterialTheme.typography.displaySmall,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                    Text(
                        text = state.verifyUrl,
                        color = MaterialTheme.colorScheme.onBackground,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(top = 16.dp),
                    )
                    TextButton(
                        onClick = onPairOnScreen,
                        modifier = Modifier.padding(top = 24.dp),
                    ) {
                        Text(stringResource(R.string.pair_on_screen_instead))
                    }
                }

                is PairingUi.Problem -> {
                    Text(
                        text = state.message,
                        color = MaterialTheme.colorScheme.onBackground,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                    Button(onClick = onRetry, modifier = Modifier.padding(top = 24.dp)) {
                        Text(stringResource(R.string.pair_try_again))
                    }
                    TextButton(onClick = onPairOnScreen, modifier = Modifier.padding(top = 8.dp)) {
                        Text(stringResource(R.string.pair_on_screen_instead))
                    }
                }
            }
        }
    }
}

/** `ABCD-EFGH` for a code that reads easily off a wall. Others pass through. */
private fun formatCode(code: String): String =
    if (code.length == 8) "${code.substring(0, 4)}-${code.substring(4)}" else code
