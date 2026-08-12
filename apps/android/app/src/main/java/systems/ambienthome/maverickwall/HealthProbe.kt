package systems.ambienthome.maverickwall

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

/**
 * Waiting for the server to come back.
 *
 * When the WebView cannot load — a cold boot with the box still starting, a
 * router reboot, the server updating — the native shell shows a "connecting…"
 * status and polls here until the server answers, then hands back. `/healthz`
 * is the endpoint for exactly this: unauthenticated by design, so the probe
 * needs no display token to ask "are you there yet?".
 *
 * Any HTTP response at all means the server is up; the body is not read and the
 * status code is not judged. A reachable server that returns 500 is still a
 * server the WebView should be pointed at, because the display draws its last
 * cached manifest and its own error state far better than a native screen can.
 */
object HealthProbe {

    private const val CONNECT_TIMEOUT_MS = 3_000
    private const val READ_TIMEOUT_MS = 3_000
    private const val FIRST_DELAY_MS = 1_000L
    private const val MAX_DELAY_MS = 15_000L

    /**
     * Suspend until `<baseUrl>/healthz` is reachable.
     *
     * Backs off from one second to fifteen so a wall waiting out a long outage
     * is not hammering the network, but a server that returns quickly is picked
     * up almost at once. `onAttempt` lets the caller show a heartbeat in the UI.
     */
    suspend fun awaitHealthy(baseUrl: String, onAttempt: (attempt: Int) -> Unit = {}) {
        var attempt = 0
        var backoff = FIRST_DELAY_MS
        while (true) {
            attempt += 1
            onAttempt(attempt)
            if (isReachable(baseUrl)) return
            delay(backoff)
            backoff = (backoff * 2).coerceAtMost(MAX_DELAY_MS)
        }
    }

    private suspend fun isReachable(baseUrl: String): Boolean = withContext(Dispatchers.IO) {
        var connection: HttpURLConnection? = null
        try {
            connection = (URL("$baseUrl/healthz").openConnection() as HttpURLConnection).apply {
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                requestMethod = "GET"
                // The mere fact of a response is the signal; do not follow the
                // body or chase redirects that could leave the household's box.
                instanceFollowRedirects = false
            }
            // Reading the status forces the request. Any code back means the
            // TCP + HTTP server is answering.
            connection.responseCode > 0
        } catch (_: Exception) {
            false
        } finally {
            connection?.disconnect()
        }
    }
}
