package systems.ambienthome.maverickwall

import android.graphics.Bitmap
import android.net.Uri
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * The WebView's gatekeeper: it may only ever be the household's own wall.
 *
 * Two jobs, both from the RFC's security posture:
 *
 *   1. **A URL allowlist.** The WebView is locked to the configured server
 *      origin. Event titles come from calendars the household does not control,
 *      and while the display renders them as text and never as links, a kiosk
 *      that could be navigated off its own server by any means is a kiosk that
 *      can be turned into a browser pointed anywhere. Anything off-origin is
 *      refused here rather than trusted not to happen.
 *   2. **Turning a failed load into the native fallback.** A main-frame error
 *      or a server 5xx on the document means the wall could not be reached;
 *      `onPageError` lets the activity show the "connecting…" status and start
 *      polling. A clean load calls `onPageOk`, which takes the status away.
 *
 * Sub-resource errors (a missing image, one panel's fetch) are ignored on
 * purpose: the display copes with those itself and must keep drawing. Only the
 * main document failing is a reason to cover the wall.
 */
class WallWebViewClient(
    private val allowedOrigin: String,
    private val onPageError: () -> Unit,
    private val onPageOk: () -> Unit,
) : WebViewClient() {

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        // true == "we handled it" == do not navigate. An allowed URL returns
        // false so the WebView loads it normally.
        return !isAllowed(request.url)
    }

    override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError,
    ) {
        if (request.isForMainFrame) onPageError()
    }

    override fun onReceivedHttpError(
        view: WebView,
        request: WebResourceRequest,
        errorResponse: WebResourceResponse,
    ) {
        // A 5xx on the document itself is a failed load. A 4xx is the server
        // answering (an unpaired wall's manifest is a 401, which the display
        // handles as its pairing screen), so those are left to the page.
        if (request.isForMainFrame && errorResponse.statusCode >= 500) onPageError()
    }

    override fun onPageFinished(view: WebView, url: String) {
        // Only a finished load of the *server* counts as the wall being up.
        // A fresh WebView finishes `about:blank` first, and treating that as a
        // good load would take the "connecting…" status away before anything
        // had actually loaded.
        if (isServerOrigin(Uri.parse(url))) onPageOk()
    }

    private fun isAllowed(uri: Uri): Boolean {
        // `about:blank` is what a fresh WebView holds before the first load; it
        // is not a navigation and must not be blocked as one.
        if (uri.scheme == "about") return true
        return isServerOrigin(uri)
    }

    private fun isServerOrigin(uri: Uri): Boolean {
        val scheme = uri.scheme?.lowercase() ?: return false
        if (scheme != "http" && scheme != "https") return false
        val host = uri.host ?: return false
        val origin = buildString {
            append(scheme).append("://").append(host)
            if (uri.port != -1) append(':').append(uri.port)
        }
        return origin.equals(allowedOrigin, ignoreCase = true)
    }

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
        // Nothing yet; the hook is here so Phase 2's wake/re-poll bridge has an
        // obvious place to note when a fresh document begins.
    }
}
