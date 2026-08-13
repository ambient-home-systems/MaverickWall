package systems.ambienthome.maverickwall.pairing

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import systems.ambienthome.maverickwall.net.TlsPinning
import java.util.concurrent.TimeUnit

/**
 * The device-authorization pairing client (RFC 003 Phase 3).
 *
 * This is the frictionless flow: a keyboard-less screen asks the server to start
 * a pairing, shows a short code and a QR, and the household approves it from a
 * phone or the admin page they are already signed in to. The token then lands on
 * the screen with nobody typing it. The server halves are `/d/pair/device-start`
 * and `/d/pair/device-poll`; the household half is `/admin/screens/approve`,
 * behind their login — which is why an eight-character code is safe.
 *
 * Two properties this client must honour, both from the server design:
 *
 *  - **The device code is the secret, not the user code.** The 32-byte device
 *    code returned by `start` is what `poll` presents to collect the token; it
 *    never leaves the device. The short user code is only for the household to
 *    read and approve. So the device code is kept in memory here and never shown.
 *  - **An older server has no endpoint, and that is not an error.** A server
 *    built before Phase 3 answers `device-start` with 404. That maps to
 *    `Unsupported`, and the app falls back to the wall's own on-screen pairing —
 *    never a dead end (rule nine). The socket-degrades-to-polling reasoning, one
 *    flow over.
 *
 * The connection is made through `TlsPinning`, so pairing is exactly when a
 * self-signed HTTPS server's certificate is captured and pinned — the same
 * trust-on-pairing moment §7 of the RFC describes.
 */
class DeviceFlowClient(context: Context, private val baseUrl: String) {

    private val http: OkHttpClient = TlsPinning.clientFor(
        context.applicationContext,
        baseUrl,
        OkHttpClient.Builder()
            // A poll should not hang a screen: bound the whole call. Comfortably
            // longer than a healthy LAN round-trip, short enough that a stalled
            // request retries rather than wedging the pairing UI.
            .callTimeout(15, TimeUnit.SECONDS)
            .build(),
    )

    /** Begin a flow. Runs off the main thread; safe to call from a coroutine. */
    suspend fun start(): StartResult = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("$baseUrl/d/pair/device-start")
            .post(FormBody.Builder().build())
            .build()
        try {
            http.newCall(request).execute().use { response ->
                // 404: a server too old to know this flow. Fall back cleanly.
                if (response.code == 404) return@withContext StartResult.Unsupported
                val body = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    return@withContext StartResult.Failed("HTTP ${response.code}")
                }
                val json = JSONObject(body)
                StartResult.Started(
                    deviceCode = json.getString("deviceCode"),
                    userCode = json.getString("userCode"),
                    verifyUrl = json.getString("verifyUrl"),
                    pollIntervalSec = json.optInt("pollIntervalSec", 5),
                    expiresInSec = json.optInt("expiresInSec", 600),
                )
            }
        } catch (e: Exception) {
            StartResult.Failed(e.message ?: "network error")
        }
    }

    /**
     * Poll once with the device code. A `Failed` here is transient — the caller
     * keeps polling — while `Denied`/`Expired`/`Approved` are terminal.
     */
    suspend fun poll(deviceCode: String): PollResult = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("$baseUrl/d/pair/device-poll")
            .post(FormBody.Builder().add("deviceCode", deviceCode).build())
            .build()
        try {
            http.newCall(request).execute().use { response ->
                val body = response.body?.string().orEmpty()
                if (!response.isSuccessful) return@withContext PollResult.Failed("HTTP ${response.code}")
                when (JSONObject(body).optString("status")) {
                    "pending" -> PollResult.Pending
                    "denied" -> PollResult.Denied
                    "expired" -> PollResult.Expired
                    "approved" -> {
                        val json = JSONObject(body)
                        PollResult.Approved(
                            token = json.getString("token"),
                            screenName = json.optString("screenName"),
                        )
                    }
                    // A shape we do not recognise is treated as transient rather
                    // than fatal — the truth is the next poll away.
                    else -> PollResult.Failed("unexpected status")
                }
            }
        } catch (e: Exception) {
            PollResult.Failed(e.message ?: "network error")
        }
    }
}

/** The outcome of `start`. */
sealed interface StartResult {
    data class Started(
        val deviceCode: String,
        val userCode: String,
        val verifyUrl: String,
        val pollIntervalSec: Int,
        val expiresInSec: Int,
    ) : StartResult

    /** The server is too old for device-flow. Fall back to on-screen pairing. */
    data object Unsupported : StartResult

    /** A network or server error. The caller may offer a retry. */
    data class Failed(val reason: String) : StartResult
}

/** The outcome of one `poll`. */
sealed interface PollResult {
    data object Pending : PollResult
    data class Approved(val token: String, val screenName: String) : PollResult
    data object Denied : PollResult
    data object Expired : PollResult

    /** Transient — the caller keeps polling on its interval. */
    data class Failed(val reason: String) : PollResult
}
