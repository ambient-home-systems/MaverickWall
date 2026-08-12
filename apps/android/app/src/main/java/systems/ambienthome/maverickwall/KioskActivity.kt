package systems.ambienthome.maverickwall

import android.app.KeyguardManager
import android.app.admin.DevicePolicyManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
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
import systems.ambienthome.maverickwall.push.PushBus
import systems.ambienthome.maverickwall.push.PushService

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

        // Hold the push socket open so a warning can wake this screen when it is
        // dark. A foreground service, because the socket must outlive the moment
        // the panel turns off. It degrades to poll-only against a server with no
        // /d/push, so it is safe to start unconditionally.
        PushService.start(this)

        // If we were launched by a wake push, honour it before the first paint.
        handleWakeIntent(intent)

        // Show the native status straight away, so a cold boot is never blank
        // for the moment before the page paints; a good load takes it down.
        showConnecting()
        loadWall(useCache = false)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // singleTask: a wake push while the wall is already the task re-enters
        // here rather than recreating. Turn the screen on and re-poll so the
        // warning is on the glass at once.
        setIntent(intent)
        handleWakeIntent(intent)
    }

    /**
     * A push asked to wake this screen for a warning.
     *
     * `wakeScreen` was decided server-side (and against the household's night
     * hours) — the app's job is only to obey it: show over the keyguard, turn
     * the screen on, ask to dismiss the lock, and re-poll so the display draws
     * the warning immediately rather than on its next interval.
     */
    private fun handleWakeIntent(intent: Intent?) {
        if (intent?.getBooleanExtra(PushService.EXTRA_WAKE, false) != true) return

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            (getSystemService(KeyguardManager::class.java))?.requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                    WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD,
            )
        }

        // Re-poll if the WebView is up; if this wake is also what created the
        // activity, the load that follows draws the warning anyway, and the
        // display's own visibility-change re-poll covers the gap.
        if (::webView.isInitialized) repoll()
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
            context = this,
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
        // A successful load is exactly when the display token cookie is fresh —
        // most importantly right after pairing, which reloads the page. The push
        // service started before pairing and would otherwise wait out its
        // backoff before retrying with the token; this nudges it to connect now.
        PushService.start(this)
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

    /**
     * A remote's OK acknowledges whatever warning is showing.
     *
     * The keys a television remote's centre button actually produces —
     * `DPAD_CENTER`, and `ENTER`/`NUMPAD_ENTER` on some — are forwarded into the
     * display's own acknowledge handler via its `maverickWall.acknowledge()`
     * bridge. That is deliberate over letting the WebView translate the key
     * itself: D-pad focus is inconsistent across the WebViews bolted to walls,
     * and "point at the wall, press OK" has to work on all of them. BACK is
     * *not* handled here — Android BACK sends Escape, which must never clear a
     * warning nobody has read.
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_UP && isOkKey(event.keyCode) && ::webView.isInitialized) {
            webView.evaluateJavascript(
                "window.maverickWall && window.maverickWall.acknowledge()",
                null,
            )
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun isOkKey(keyCode: Int): Boolean =
        keyCode == KeyEvent.KEYCODE_DPAD_CENTER ||
            keyCode == KeyEvent.KEYCODE_ENTER ||
            keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER

    /** Ask the display to poll now (a push nudge, or a wake). */
    private fun repoll() {
        webView.evaluateJavascript("window.maverickWall && window.maverickWall.poll()", null)
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
        if (::webView.isInitialized) {
            webView.onResume()
            // While this wall is the visible one, a push that only asks for a
            // re-poll comes through here; a wake uses an Intent instead.
            PushBus.setPollListener { if (::webView.isInitialized) repoll() }
        }
    }

    override fun onPause() {
        PushBus.setPollListener(null)
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
