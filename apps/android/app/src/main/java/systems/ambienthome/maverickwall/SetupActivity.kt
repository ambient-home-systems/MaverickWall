package systems.ambienthome.maverickwall

import android.app.UiModeManager
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import systems.ambienthome.maverickwall.net.ServerFinder
import systems.ambienthome.maverickwall.pairing.PairingActivity

/**
 * First run, and "point at a different box" — choose the server.
 *
 * Two ways in, one of them typed and one of them not. The app browses the LAN
 * for servers advertising themselves over mDNS (RFC 003 Phase 3) and lists them
 * to tap; manual entry stays underneath as the always-available fallback for a
 * segmented or guest network where discovery is blocked, so it never goes away.
 *
 * Choosing a server hands off to [PairingActivity], which runs the
 * device-authorization flow — a code and a QR on the screen, approved from the
 * household's phone or admin page. The old path (load the wall, type a code off
 * `/admin/screens` into it) still works as the fallback inside pairing, but it
 * is no longer the front door.
 *
 * Before either, on a television, it asks which way up the screen is hung. A
 * Google TV box outputs landscape whatever the household did with the panel, so
 * on one hung on its end everything this app draws natively is sideways until
 * it knows — and that includes this screen. The answer turns setup, pairing and
 * the "connecting…" status, and pairing reports it so the wall starts the same
 * way up (see [ServerConfig.rotation]).
 */
class SetupActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val config = ServerConfig(this)

        /*
         * Ask which way up first, on a television nobody has asked yet.
         *
         * A television is the device that gets hung on its end — the cheapest
         * portrait wall there is — and it cannot turn its own picture, so every
         * screen after this one would be sideways. A tablet turns itself, and
         * asking there would only stack a second turn on the one its own
         * sensor already made, so it is not asked; the link under the chooser
         * is there for the one that needs it anyway.
         */
        val askFirst = config.rotation == null && isTelevision()

        setContent {
            MaverickWallTheme {
                var rotation by remember { mutableIntStateOf(config.rotation ?: 0) }
                var choosingRotation by remember { mutableStateOf(askFirst) }

                Rotated(rotation) {
                    if (choosingRotation) {
                        RotationScreen(
                            rotation = rotation,
                            onTurn = { rotation = it },
                            onKeep = {
                                config.rotation = rotation
                                choosingRotation = false
                            },
                        )
                    } else {
                        SetupScreen(
                            initial = config.baseUrl ?: "",
                            onChoose = { typed ->
                                val normalized = ServerConfig.normalize(typed) ?: return@SetupScreen false
                                openPairing(normalized)
                                true
                            },
                            onChooseDiscovered = { server -> openPairing(server.baseUrl) },
                            onTurnScreen = { choosingRotation = true },
                        )
                    }
                }
            }
        }
    }

    /**
     * Whether this is a television: in TV mode, or built as one.
     *
     * Both, because cheap boxes are inconsistent about the first — some report
     * a normal UI mode while shipping the leanback launcher that makes them a
     * TV — and the question costs one OK press on a television hung the right
     * way up, which is the side to be wrong on.
     */
    private fun isTelevision(): Boolean {
        val mode = getSystemService(UiModeManager::class.java)?.currentModeType
        return mode == Configuration.UI_MODE_TYPE_TELEVISION ||
            packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
    }

    private fun openPairing(baseUrl: String) {
        ServerConfig(this).baseUrl = baseUrl
        startActivity(
            Intent(this, PairingActivity::class.java).apply {
                putExtra(PairingActivity.EXTRA_BASE_URL, baseUrl)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            },
        )
        finish()
    }
}

/**
 * The chooser: discovered servers to tap, and a field to type one.
 *
 * `onChoose` returns false when what was typed is not a usable address, and the
 * screen shows the hint rather than navigating — so a fat-fingered entry is
 * corrected in place instead of loading a wall that can never connect.
 */
@Composable
private fun SetupScreen(
    initial: String,
    onChoose: (String) -> Boolean,
    onChooseDiscovered: (ServerFinder.Server) -> Unit,
    onTurnScreen: () -> Unit,
) {
    val context = LocalContext.current
    var address by remember { mutableStateOf(initial) }
    var showError by remember { mutableStateOf(false) }
    var discovered by remember { mutableStateOf<List<ServerFinder.Server>>(emptyList()) }

    // Browse while this screen is showing; stop when it leaves. The finder never
    // throws — a device with no mDNS simply reports nothing and the field below
    // carries the household through.
    DisposableEffect(Unit) {
        val finder = ServerFinder(context)
        finder.start { servers -> discovered = servers }
        onDispose { finder.stop() }
    }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = stringResource(R.string.setup_title),
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.onBackground,
            )
            Text(
                text = stringResource(R.string.setup_description),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onBackground,
                modifier = Modifier.padding(top = 8.dp, bottom = 24.dp),
            )

            if (discovered.isNotEmpty()) {
                Text(
                    text = stringResource(R.string.setup_found_label),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onBackground,
                    modifier = Modifier.padding(bottom = 8.dp),
                )
                for (server in discovered) {
                    OutlinedButton(
                        onClick = { onChooseDiscovered(server) },
                        modifier = Modifier
                            .fillMaxWidth()
                            .widthIn(max = 520.dp)
                            .padding(vertical = 4.dp),
                    ) {
                        Text("${server.name} · ${server.host}:${server.port}")
                    }
                }
                Text(
                    text = stringResource(R.string.setup_or_type),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onBackground,
                    modifier = Modifier.padding(top = 24.dp, bottom = 8.dp),
                )
            }

            OutlinedTextField(
                value = address,
                onValueChange = {
                    address = it
                    showError = false
                },
                singleLine = true,
                isError = showError,
                label = { Text(stringResource(R.string.setup_field_label)) },
                placeholder = { Text(stringResource(R.string.setup_field_hint)) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier
                    .fillMaxWidth()
                    .widthIn(max = 520.dp),
            )

            if (showError) {
                Text(
                    text = stringResource(R.string.setup_error),
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }

            Button(
                onClick = { if (!onChoose(address)) showError = true },
                modifier = Modifier.padding(top = 24.dp),
            ) {
                Text(stringResource(R.string.setup_save))
            }

            // Always here, so a screen answered wrongly on first run — or a
            // tablet that turned out to need it — is never stuck sideways.
            TextButton(onClick = onTurnScreen, modifier = Modifier.padding(top = 16.dp)) {
                Text(stringResource(R.string.setup_turn_screen))
            }
        }
    }
}

/**
 * "Is this the right way up?" — asked once, on the screen itself.
 *
 * The picture turns as the household presses, so the answer is the one they
 * can see is right rather than one they have to work out: Left and Right on a
 * remote turn it a quarter each way, and OK keeps it. The arrows are taken
 * before focus sees them, because on this screen there is nothing to move
 * between that a remote needs — the turn buttons are for a fingertip, and OK
 * lands on "This way up", which has focus from the start.
 */
@Composable
private fun RotationScreen(
    rotation: Int,
    onTurn: (Int) -> Unit,
    onKeep: () -> Unit,
) {
    val keep = remember { FocusRequester() }
    LaunchedEffect(Unit) { keep.requestFocus() }

    Surface(
        modifier = Modifier
            .fillMaxSize()
            .onPreviewKeyEvent { event ->
                val turn = when (event.key) {
                    Key.DirectionLeft -> ScreenRotation.anticlockwise(rotation)
                    Key.DirectionRight -> ScreenRotation.clockwise(rotation)
                    else -> return@onPreviewKeyEvent false
                }
                // Turn on the press; swallow the release too, so neither moves focus.
                if (event.type == KeyEventType.KeyDown) onTurn(turn)
                true
            },
        color = MaterialTheme.colorScheme.background,
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            // An arrow rather than an icon set: one glyph every bundled face
            // has, pointing at what the household is being asked to make "up".
            Text(
                text = "\u2191",
                style = MaterialTheme.typography.displayLarge,
                color = MaterialTheme.colorScheme.primary,
            )
            Text(
                text = stringResource(R.string.rotate_title),
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.onBackground,
                modifier = Modifier.padding(top = 16.dp),
            )
            Text(
                text = stringResource(R.string.rotate_description),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onBackground,
                modifier = Modifier
                    .widthIn(max = 520.dp)
                    .padding(top = 8.dp),
            )
            Text(
                text = stringResource(R.string.rotate_remote_hint),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onBackground,
                modifier = Modifier
                    .widthIn(max = 520.dp)
                    .padding(top = 8.dp, bottom = 24.dp),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(onClick = { onTurn(ScreenRotation.anticlockwise(rotation)) }) {
                    Text(stringResource(R.string.rotate_left))
                }
                Button(onClick = onKeep, modifier = Modifier.focusRequester(keep)) {
                    Text(stringResource(R.string.rotate_keep))
                }
                OutlinedButton(onClick = { onTurn(ScreenRotation.clockwise(rotation)) }) {
                    Text(stringResource(R.string.rotate_right))
                }
            }
            Text(
                text = stringResource(R.string.rotate_later),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onBackground,
                modifier = Modifier
                    .widthIn(max = 520.dp)
                    .padding(top = 24.dp),
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun SetupScreenPreview() {
    MaverickWallTheme {
        SetupScreen(
            initial = "192.168.1.10:8080",
            onChoose = { true },
            onChooseDiscovered = {},
            onTurnScreen = {},
        )
    }
}
