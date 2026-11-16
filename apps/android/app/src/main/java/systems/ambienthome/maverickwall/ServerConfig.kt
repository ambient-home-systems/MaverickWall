package systems.ambienthome.maverickwall

import android.content.Context
import android.net.Uri

/**
 * Where the wall's server lives, remembered across reboots.
 *
 * A wall screen is paired once and then left alone for months, so the one thing
 * it must not forget is which box to talk to. That is a single string — the
 * server's origin — kept in shared preferences. Everything else (the display
 * token, the manifest, the theme) lives on the server and travels in the
 * manifest; the app stores none of it, with one exception, [rotation], which it
 * needs before a server exists to ask. In Phase 3 mDNS discovery fills the
 * origin in automatically, but manual entry is the always-available fallback.
 */
class ServerConfig(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** The server origin, e.g. `http://192.168.1.10:8080`, or null if unset. */
    var baseUrl: String?
        get() = prefs.getString(KEY_BASE_URL, null)
        set(value) {
            prefs.edit().apply {
                if (value.isNullOrBlank()) remove(KEY_BASE_URL) else putString(KEY_BASE_URL, value)
            }.apply()
        }

    val isConfigured: Boolean
        get() = !baseUrl.isNullOrBlank()

    /**
     * Which way up this screen is hung, or null if nobody has said.
     *
     * The second thing the app keeps, and the reason is that it is needed
     * before there is a server to ask: a television hung on its end draws the
     * app's own screens — setup, the pairing code, "connecting…" — sideways
     * until it knows. The household answers on first run; pairing reports the
     * answer so the wall starts the same way up; and once the wall is paired the
     * app copies the server's Wall mounting back into here, so the server stays
     * the one place it is changed. Null rather than `0` until then, because a
     * television that has never been asked is not the same as one that said it
     * is the right way up — only the first gets the question.
     */
    var rotation: Int?
        get() = if (prefs.contains(KEY_ROTATION)) ScreenRotation.of(prefs.getInt(KEY_ROTATION, 0)) else null
        set(value) {
            val turn = value?.let(ScreenRotation::of)
            prefs.edit().apply {
                if (turn == null) remove(KEY_ROTATION) else putInt(KEY_ROTATION, turn)
            }.apply()
        }

    companion object {
        private const val PREFS = "maverick_wall"
        private const val KEY_BASE_URL = "base_url"
        private const val KEY_ROTATION = "rotation"

        /**
         * Turn what a household typed into an origin, or null if it cannot be one.
         *
         * Mirrors the server's own `normalizeBaseUrl`: scheme and host (and port
         * if given), nothing else. A bare address is assumed http, because that
         * is the LAN default the whole app is built around — a household types
         * `192.168.1.10:8080`, not a URL. A path or query is dropped: the app
         * always loads the root, and the display routes itself from there.
         */
        fun normalize(raw: String): String? {
            val trimmed = raw.trim()
            if (trimmed.isEmpty()) return null

            val withScheme =
                if (Regex("^[a-z][a-z0-9+.-]*://", RegexOption.IGNORE_CASE).containsMatchIn(trimmed)) {
                    trimmed
                } else {
                    "http://$trimmed"
                }

            val uri = Uri.parse(withScheme)
            val scheme = uri.scheme?.lowercase() ?: return null
            if (scheme != "http" && scheme != "https") return null
            val host = uri.host?.takeIf { it.isNotEmpty() } ?: return null
            val port = uri.port // -1 when absent

            return buildString {
                append(scheme).append("://").append(host)
                if (port != -1) append(':').append(port)
            }
        }
    }
}
