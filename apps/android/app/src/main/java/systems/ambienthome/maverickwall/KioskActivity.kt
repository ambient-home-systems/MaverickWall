package systems.ambienthome.maverickwall

import android.app.admin.DevicePolicyManager
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * The wall.
 *
 * This activity is a host, not a renderer. The calendar is `apps/display`,
 * loaded over the LAN from the household's server exactly as a browser screen
 * loads it — so every fix and every theme the web display gains, the wall gains
 * too, and the two can never drift (docs/rfc-003-android-tv-app.md, "the one
 * thing we do not build"). All the native code here does is the handful of
 * things a browser tab on a wall cannot: keep the screen on and in front, stay
 * locked to its own server, and never show a blank rectangle when the server is
 * briefly unreachable.
 *
 * Rule nine — never a blank screen — is carried in three layers, native-first:
 *   1. The display renders its last manifest from IndexedDB before its first
 *      poll and survives the server coming and going while loaded.
 *   2. On a load failure the WebView is retried against its own disk cache
 *      (`LOAD_CACHE_ELSE_NETWORK`), so a cached shell paints at a cold boot
 *      even with the server still starting.
 *   3. If even that cannot draw, the native "connecting…" status shows — a
 *      branded screen, never a blank one — and hands back the instant
 *      `/healthz` answers.
 */
class KioskActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var connecting: View
    private lateinit var baseUrl: String

    /** True once we have already fallen back to the disk cache for this load. */
    private var triedCache = false
    private var healthJob: Job? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val configured = ServerConfig(this).baseUrl
        if (configured.isNullOrBlank()) {
            // Nothing to point at yet: send them to enter the address, and do
            // not stay in the back stack behind it.
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        baseUrl = configured

        // Keep the display awake and in the foreground for as long as it is
        // showing. FLAG_KEEP_SCREEN_ON is scoped to this window, so it lifts
        // itself when the activity is not visible — no wake lock to leak.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        setContentView(R.layout.activity_kiosk)
        webView = findViewById(R.id.web_view)
        connecting = findViewById(R.id.connecting)
        findViewById<TextView>(R.id.connecting_host).text = getString(R.string.connecting_to, baseUrl)
        findViewById<Button>(R.id.retry).setOnClickListener {
            triedCache = false
            loadWall(useCache = false)
        }
        findViewById<Button>(R.id.change_server).setOnClickListener { openSetup() }

        applyImmersive()
        configureWebView()
        consumeBackButton()
        tryEnterLockTask()

        // Show the native status straight away, so a cold boot is never blank
        // for the moment before the page paints; a good load takes it down.
        showConnecting()
        loadWall(useCache = false)
    }

    private fun configureWebView() {
        webView.setBackgroundColor(0xFF000000.toInt())
        webView.overScrollMode = View.OVER_SCROLL_NEVER
        webView.isVerticalScrollBarEnabled = false
        webView.isHorizontalScrollBarEnabled = false
        webView.settings.apply {
            javaScriptEnabled = true
            // The display caches its last manifest in IndexedDB and reads it
            // before the first poll; that needs DOM storage on.
            domStorageEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            mediaPlaybackRequiresUserGesture = false
            // A wall is not pinch-zoomed.
            setSupportZoom(false)
            builtInZoomControls = false
        }
        webView.webViewClient = WallWebViewClient(
            allowedOrigin = baseUrl,
            onPageError = ::onLoadError,
            onPageOk = ::onLoadOk,
        )
    }

    /**
     * Load the wall — normally, or from the disk cache when the network failed.
     *
     * The cache pass is what lets a wall coming back from a power cut paint the
     * shell it last saw before the server has even finished starting.
     */
    private fun loadWall(useCache: Boolean) {
        webView.settings.cacheMode =
            if (useCache) WebSettings.LOAD_CACHE_ELSE_NETWORK else WebSettings.LOAD_DEFAULT
        webView.loadUrl(baseUrl)
    }

    private fun onLoadOk() {
        triedCache = false
        hideConnecting()
        healthJob?.cancel()
        healthJob = null
    }

    private fun onLoadError() {
        // First failure: try the disk cache in place, so a cached wall can draw
        // rather than a native status when one is available.
        if (!triedCache) {
            triedCache = true
            loadWall(useCache = true)
            return
        }
        // Cache could not draw either: the honest, branded status, and poll for
        // the server to come back.
        showConnecting()
        startHealthPolling()
    }

    private fun startHealthPolling() {
        if (healthJob?.isActive == true) return
        healthJob = lifecycleScope.launch {
            HealthProbe.awaitHealthy(baseUrl)
            // The server answered. Reload fresh from the network; a good load
            // will hide the status via onLoadOk.
            triedCache = false
            loadWall(useCache = false)
        }
    }

    private fun showConnecting() {
        connecting.visibility = View.VISIBLE
    }

    private fun hideConnecting() {
        connecting.visibility = View.GONE
    }

    private fun openSetup() {
        startActivity(Intent(this, SetupActivity::class.java))
    }

    /**
     * Lock to a single task, but only where the device let us.
     *
     * A managed install (device-owner provisioning) can pin the app so a remote
     * or a stray touch cannot leave it. A plain sideload cannot, and calling
     * `startLockTask` there triggers an intrusive screen-pinning prompt — so it
     * is attempted only when already permitted, and the household is never
     * stranded by a hard requirement. Documented, never mandated.
     */
    private fun tryEnterLockTask() {
        val dpm = getSystemService(DevicePolicyManager::class.java) ?: return
        if (dpm.isLockTaskPermitted(packageName)) {
            try {
                startLockTask()
            } catch (_: Exception) {
                // Not permitted after all; the wall runs fine unpinned.
            }
        }
    }

    private fun consumeBackButton() {
        // A wall must not exit or navigate on BACK. Android BACK also sends
        // Escape into the page, which must never clear a warning nobody has
        // read — so it is swallowed here entirely.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = Unit
        })
    }

    private fun applyImmersive() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // The system bars creep back after a dialog or a notification shade;
        // re-hide them whenever the wall is what the household is looking at.
        if (hasFocus) applyImmersive()
    }

    override fun onResume() {
        super.onResume()
        // Guarded: on first run with no server configured this activity
        // redirects to setup and finishes before the WebView is ever created,
        // so the lifecycle callbacks must not touch the lateinit — or the whole
        // process crashes on the way out (it did, on the first device launch).
        if (::webView.isInitialized) webView.onResume()
    }

    override fun onPause() {
        if (::webView.isInitialized) webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        healthJob?.cancel()
        if (::webView.isInitialized) {
            // Detach before destroy so the view hierarchy is not left holding a
            // dead WebView.
            (webView.parent as? android.view.ViewGroup)?.removeView(webView)
            webView.destroy()
        }
        super.onDestroy()
    }
}
