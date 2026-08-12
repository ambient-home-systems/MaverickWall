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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp

/**
 * First run, and "point at a different box" — enter the server's address.
 *
 * In Phase 1 this is the only way in; Phase 3's mDNS discovery will offer a
 * list and pre-fill it, but manual entry is the always-available fallback for a
 * segmented or guest network where discovery is blocked, so it never goes away.
 *
 * Pairing is *not* done here. Once the address is saved and the wall loads, the
 * display's own pairing screen takes over: the household reads the code off
 * `/admin/screens` and types it into the wall. The app only needs to know which
 * server to show; everything after is the display's, unchanged from a browser
 * screen.
 */
class SetupActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val config = ServerConfig(this)

        setContent {
            MaverickWallTheme {
                SetupScreen(
                    initial = config.baseUrl ?: "",
                    onSave = { typed ->
                        val normalized = ServerConfig.normalize(typed) ?: return@SetupScreen false
                        config.baseUrl = normalized
                        // A fresh task, so the kiosk reads the new address in
                        // onCreate and nothing stale sits behind it.
                        startActivity(
                            Intent(this, KioskActivity::class.java).apply {
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                            },
                        )
                        finish()
                        true
                    },
                )
            }
        }
    }
}

/**
 * The address form.
 *
 * `onSave` returns false when what was typed is not a usable address, and the
 * screen shows the hint rather than navigating — so a fat-fingered entry is
 * corrected in place instead of loading a wall that can never connect.
 */
@Composable
private fun SetupScreen(initial: String, onSave: (String) -> Boolean) {
    var address by remember { mutableStateOf(initial) }
    var showError by remember { mutableStateOf(false) }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier
                .fillMaxSize()
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
                onClick = { if (!onSave(address)) showError = true },
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
        SetupScreen(initial = "192.168.1.10:8080", onSave = { true })
    }
}
