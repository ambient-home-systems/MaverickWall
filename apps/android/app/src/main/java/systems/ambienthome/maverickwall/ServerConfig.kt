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
 * manifest; the app stores none of it. In Phase 3 mDNS discovery fills this in
 * automatically, but manual entry is the always-available fallback and the only
 * path in Phase 1.
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

    companion object {
        private const val PREFS = "maverick_wall"
        private const val KEY_BASE_URL = "base_url"

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
