package systems.ambienthome.maverickwall.net

import android.content.Context
import android.net.Uri
import android.util.Base64
import okhttp3.OkHttpClient
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * Making a self-signed HTTPS server both secure and invisible on a LAN.
 *
 * This is the one thing a browser cannot do and the native app can, and it is
 * why the project can support HTTPS without mandating a CA dance
 * (docs/rfc-003-android-tv-app.md §7). A household's box has no public
 * certificate — it is reached by `192.168.x.x` or `something.local`, which no
 * public CA will sign — so ordinary TLS validation would reject it. Instead the
 * app **pins the exact certificate it first saw** and trusts that one and
 * nothing else.
 *
 * Trust-on-first-use, at pairing: the first HTTPS connection records the
 * server's public-key pin; every later connection must match it, or it is
 * refused. A re-pair (a fresh setup) clears the pin and re-learns. On a private
 * LAN, where the window for a first-connection attacker is a household setting
 * up their own screen on their own network, this is the right trade — and it is
 * strictly better than the http default it upgrades from, which is not
 * encrypted at all.
 *
 * Plain http is untouched: no pin, no TLS, the ordinary LAN case. Nothing here
 * mandates HTTPS, and nothing sets HSTS — the server side is explicit that HSTS
 * on a self-signed LAN box is a self-inflicted brick.
 */
object TlsPinning {

    private const val PREFS = "maverick_wall_pins"

    /** The stored SPKI pin for a host, or null if none learned yet. */
    fun pinFor(context: Context, host: String): String? =
        prefs(context).getString(host, null)

    /** Forget a host's pin — a re-pair re-learns the current certificate. */
    fun clear(context: Context, host: String) {
        prefs(context).edit().remove(host).apply()
    }

    /**
     * An HTTP client for this server.
     *
     * For http, the default client. For https, a client that trusts exactly the
     * pinned certificate — capturing it on the first connection and enforcing it
     * on every one after. The hostname check is relaxed because a self-signed
     * LAN cert rarely carries a SAN matching a bare IP; the pin, not the name,
     * is what authenticates the server.
     */
    fun clientFor(context: Context, baseUrl: String, base: OkHttpClient): OkHttpClient {
        val uri = Uri.parse(baseUrl)
        if (uri.scheme?.lowercase() != "https") return base
        val host = uri.host ?: return base

        val trust = TofuPinningTrustManager(context.applicationContext, host)
        val ssl = SSLContext.getInstance("TLS").apply {
            init(null, arrayOf(trust), java.security.SecureRandom())
        }
        return base.newBuilder()
            .sslSocketFactory(ssl.socketFactory, trust)
            // The pin is the credential, not the SAN — accept the host name so a
            // cert issued for an IP or `.local` is not rejected on the name.
            .hostnameVerifier { _, _ -> true }
            .build()
    }

    /** True when this host's certificate matches the pin we hold (WebView SSL). */
    fun matchesPin(context: Context, host: String, cert: X509Certificate): Boolean {
        val stored = pinFor(context, host)
        val pin = spkiPin(cert)
        if (stored == null) {
            // Trust on first use — learn it, then it is enforced from here.
            prefs(context).edit().putString(host, pin).apply()
            return true
        }
        return stored == pin
    }

    /**
     * The SPKI pin: base64(SHA-256(SubjectPublicKeyInfo)), the same form OkHttp
     * uses. Over the public key rather than the whole certificate, so renewing
     * the certificate with the same key does not break the pin.
     */
    fun spkiPin(cert: X509Certificate): String {
        val spki = cert.publicKey.encoded
        val digest = MessageDigest.getInstance("SHA-256").digest(spki)
        return "sha256/" + Base64.encodeToString(digest, Base64.NO_WRAP)
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /**
     * Trusts one certificate: whichever it saw first for this host.
     *
     * Capture and enforcement in one place — the first `checkServerTrusted`
     * stores the pin, every later one requires it. `getAcceptedIssuers` is empty
     * because there is no CA in this model; the pin is the whole of the trust.
     */
    private class TofuPinningTrustManager(
        private val context: Context,
        private val host: String,
    ) : X509TrustManager {
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            val leaf = chain?.firstOrNull()
                ?: throw CertificateException("no certificate presented")
            if (!matchesPin(context, host, leaf)) {
                throw CertificateException("certificate does not match the pinned one for $host")
            }
        }

        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            // No client certificates in this model.
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
}
