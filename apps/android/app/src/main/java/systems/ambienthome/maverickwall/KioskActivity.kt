package systems.ambienthome.maverickwall

import android.app.KeyguardManager
import android.app.admin.DevicePolicyManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ComposeView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.withStarted
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
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
 *
 * And the page's own process dying is survived rather than fatal: the dead
 * WebView is replaced and the wall loaded again ([onRendererGone]), so a crash
 * or a box short of memory does not leave a television on its own home screen.
 */
class KioskActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var wallFrame: FrameLayout
    private lateinit var connecting: ComposeView
    private lateinit var baseUrl: String

    /**
     * Whether the native status is up — Compose state, so the status is only
     * composed (and only takes focus) while it is showing, and read by the key
     * handler, which must not hand the remote's OK to a wall nobody can see.
     */
    private var connectingShown by mutableStateOf(false)

    /** The turn the status is drawn at, read from [ServerConfig.rotation] as it appears. */
    private var connectingRotation by mutableIntStateOf(0)

    /** Why the status is up, so it says what is actually happening. */
    private var connectingReason by mutableStateOf(ConnectingReason.SERVER)

    /**
     * When the page's process died recently, on the monotonic clock, as
     * [RendererRecovery.record] keeps them. In memory only: the app outlives
     * those deaths, which is the point, and a restart of the app is a fresh start.
     */
    private var rendererDeaths by mutableStateOf(emptyList<Long>())

    /** The reload waiting after the page died; cancelled by a load that succeeds first. */
    private var reloadJob: Job? = null

    /** True once we have already fallen back to the disk cache for this load. */
    private var triedCache = false
    private var healthJob: Job? = null

    /**
     * A one-shot pairing token from the device-flow, consumed on the first load.
     *
     * When the app paired the screen itself (Phase 3), the very first navigation
     * goes to `/pair?token=…` so the server sets the display cookie and redirects
     * to the wall — after which the cookie carries it and this is never used
     * again. Null on every ordinary boot, where the cookie already exists.
     */
    private var pendingPairToken: String? = null

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
        pendingPairToken = intent.getStringExtra(EXTRA_PAIR_TOKEN)?.takeIf { it.isNotBlank() }

        // Keep the display awake and in the foreground for as long as it is
        // showing. FLAG_KEEP_SCREEN_ON is scoped to this window, so it lifts
        // itself when the activity is not visible — no wake lock to leak.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        setContentView(R.layout.activity_kiosk)
        wallFrame = findViewById(R.id.wall_frame)
        webView = findViewById(R.id.web_view)
        connecting = findViewById(R.id.connecting)
        connecting.setContent {
            MaverickWallTheme {
                if (connectingShown) {
                    Rotated(connectingRotation) {
                        ConnectingScreen(
                            host = baseUrl,
                            reason = connectingReason,
                            deaths = rendererDeaths.size,
                            onRetry = {
                                reloadJob?.cancel()
                                reloadJob = null
                                triedCache = false
                                loadWall(useCache = false)
                            },
                            onChangeServer = ::openSetup,
                        )
                    }
                }
            }
        }

        applyImmersive()
        configureWebView()
        consumeBackButton()
        tryEnterLockTask()
        mirrorWallRotation()

        // Hold the push socket open so a warning can wake this screen when it is
        // dark. A foreground service, because the socket must outlive the moment
        // the panel turns off. It degrades to poll-only against a server with no
        // /d/push, so it is safe to start unconditionally.
        PushService.start(this)

        // If we were launched by a wake push, honour it before the first paint.
        handleWakeIntent(intent)

        // Show the native status straight away, so a cold boot is never blank
        // for the moment before the page paints; a good load takes it down.
        showConnecting(ConnectingReason.SERVER)
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
            onRendererGone = ::onRendererGone,
        )
    }

    /**
     * The page's process died, and Android is waiting to see whether this app
     * deals with it before ending the app too.
     *
     * Three things, in this order. The dead WebView leaves the window and is
     * destroyed now, before the callback returns — Android ends the app if it
     * is still there. A fresh one takes its place at once, under the status, so
     * every other piece of the kiosk (the push re-poll, the rotation mirror,
     * Retry) always has a live WebView to talk to. And the wall is loaded into
     * it: straight away the first time, later if it keeps dying
     * ([RendererRecovery]), and never while the screen is off — a box that
     * ended the page to free memory in the background would only end the next
     * one too. The display draws its stored calendar before its first poll, so
     * a reload is back on the glass in moments, and the cookie that pairs this
     * wall lives in the WebView's shared store rather than in the dead view.
     */
    private fun onRendererGone(dead: WebView, crashed: Boolean) {
        // An older view that has already been replaced: nothing left to do.
        if (dead !== webView) return

        wallFrame.removeView(dead)
        dead.destroy()
        // The cause, and never the page: what was on it is the household's.
        Log.w(
            TAG,
            if (crashed) {
                "the page crashed; loading the wall again"
            } else {
                "Android ended the page to free memory; loading the wall again"
            },
        )

        rendererDeaths = RendererRecovery.record(rendererDeaths, SystemClock.elapsedRealtime())
        val wait = RendererRecovery.delayFor(rendererDeaths)

        replaceWebView()
        healthJob?.cancel()
        healthJob = null
        showConnecting(if (wait > 0) ConnectingReason.RESTING else ConnectingReason.RESTARTING)

        reloadJob?.cancel()
        reloadJob = lifecycleScope.launch {
            delay(wait)
            lifecycle.withStarted {
                triedCache = false
                loadWall(useCache = false)
            }
        }
    }

    /** A new WebView where the dead one was: under the status, filling the frame. */
    private fun replaceWebView() {
        val fresh = WebView(this).apply { id = R.id.web_view }
        wallFrame.addView(
            fresh,
            0,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        webView = fresh
        configureWebView()
        // A WebView starts running; one made while the wall is not in front
        // waits, like the one it replaces, for onResume.
        if (!lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) fresh.onPause()
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
        // A pairing token is spent on the first load only: exchange it for the
        // cookie at `/pair`, which redirects to the wall. Cleared immediately so
        // a retry or a cache pass loads the wall root, never re-pairs.
        val token = pendingPairToken
        if (token != null) {
            pendingPairToken = null
            webView.loadUrl("$baseUrl/pair?token=${android.net.Uri.encode(token)}")
        } else {
            webView.loadUrl(baseUrl)
        }
    }

    private fun onLoadOk() {
        triedCache = false
        hideConnecting()
        healthJob?.cancel()
        healthJob = null
        // Retry beat a waiting reload to it: the wall is up, so do not load it again.
        reloadJob?.cancel()
        reloadJob = null
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
        showConnecting(ConnectingReason.SERVER)
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

    private fun showConnecting(reason: ConnectingReason) {
        connectingReason = reason
        // Read as it appears: the household may have answered on setup, or the
        // wall's own Wall mounting may have been copied in since the last time.
        connectingRotation = ServerConfig(this).rotation ?: 0
        connectingShown = true
        connecting.visibility = View.VISIBLE
        connecting.requestFocus()
    }

    private fun hideConnecting() {
        connectingShown = false
        connecting.visibility = View.GONE
        // Hand focus back to the wall, so a code being typed into the page's
        // own pairing form lands there rather than nowhere.
        webView.requestFocus()
    }

    /**
     * Keep this screen's rotation in step with the wall's Wall mounting.
     *
     * The server is where a household changes which way up a wall is drawn,
     * and the page already knows the answer, so the app asks it — through the
     * same bridge it presses `poll` and `acknowledge` on — and keeps a copy for
     * the moments it cannot ask: the "connecting…" status is shown exactly when
     * the page is gone. Asked every [MIRROR_INTERVAL_MS] while the wall is on
     * screen, because the page's first answer waits on its first manifest and a
     * change made on the settings page reaches the page on its next poll, not
     * at load. Never while the status is up: the page behind it is not the wall.
     *
     * A page that does not answer with a quarter turn — no manifest yet, the
     * server's stand-in, an older bundle with no `rotation()` — leaves the copy
     * alone. That is what keeps a television answered on first run the right
     * way up while it is still pairing.
     */
    private fun mirrorWallRotation() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                while (true) {
                    delay(MIRROR_INTERVAL_MS)
                    if (connectingShown || !::webView.isInitialized) continue
                    webView.evaluateJavascript(ROTATION_QUERY) { result ->
                        val turn = ScreenRotation.fromPage(result) ?: return@evaluateJavascript
                        val config = ServerConfig(this@KioskActivity)
                        if (config.rotation != turn) config.rotation = turn
                    }
                }
            }
        }
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
        // Not while the native status is up: there, OK is for its Retry button,
        // and the wall behind it is not what anybody is looking at.
        if (event.action == KeyEvent.ACTION_UP && isOkKey(event.keyCode) && ::webView.isInitialized &&
            !connectingShown
        ) {
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
        reloadJob?.cancel()
        if (::webView.isInitialized) {
            // Detach before destroy so the view hierarchy is not left holding a
            // dead WebView.
            (webView.parent as? android.view.ViewGroup)?.removeView(webView)
            webView.destroy()
        }
        super.onDestroy()
    }

    companion object {
        private const val TAG = "MaverickKiosk"

        /**
         * A one-shot device-flow pairing token (Phase 3). When present, the wall
         * loads `/pair?token=…` first to claim its cookie, then behaves exactly
         * as an already-paired screen.
         */
        const val EXTRA_PAIR_TOKEN = "systems.ambienthome.maverickwall.PAIR_TOKEN"

        /** How often the wall's Wall mounting is copied in while the wall is showing. */
        private const val MIRROR_INTERVAL_MS = 20_000L

        /**
         * The page's answer, or `null` from a page with no such bridge — an older
         * display bundle, or the WebView's own error page. Guarded so neither
         * throws into the console of a wall that is otherwise fine.
         */
        private const val ROTATION_QUERY =
            "(function(){var b=window.maverickWall;" +
                "return b&&typeof b.rotation==='function'?b.rotation():null})()"
    }
}
