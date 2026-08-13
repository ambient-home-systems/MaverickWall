package systems.ambienthome.maverickwall

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
 */
class SetupActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val config = ServerConfig(this)

        setContent {
            MaverickWallTheme {
                SetupScreen(
                    initial = config.baseUrl ?: "",
                    onChoose = { typed ->
                        val normalized = ServerConfig.normalize(typed) ?: return@SetupScreen false
                        openPairing(normalized)
                        true
                    },
                    onChooseDiscovered = { server -> openPairing(server.baseUrl) },
                )
            }
        }
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
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun SetupScreenPreview() {
    MaverickWallTheme {
        SetupScreen(initial = "192.168.1.10:8080", onChoose = { true }, onChooseDiscovered = {})
    }
}
