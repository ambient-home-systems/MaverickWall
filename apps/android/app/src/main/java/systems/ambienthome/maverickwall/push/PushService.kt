package systems.ambienthome.maverickwall.push

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import systems.ambienthome.maverickwall.KioskActivity
import systems.ambienthome.maverickwall.R
import systems.ambienthome.maverickwall.ServerConfig
import systems.ambienthome.maverickwall.net.TlsPinning
import java.util.concurrent.TimeUnit

/**
 * The push socket, held alive so a warning can wake a dark screen.
 *
 * This is the reason Phase 2 exists. A browser screen learns about a tornado
 * warning on its next sixty-second poll and cannot turn a dark panel on; this
 * service holds a WebSocket to the household's own server (the endpoint the
 * Phase 0 work built) and, when a push says a warning wants the screen, wakes
 * it. Everything else it does is a latency shortcut over polling — the socket
 * is an optimisation, never a dependency, so if it drops the wall still gets
 * every interrupt on its next poll.
 *
 * No cloud (rule three): the socket is the household's server talking to the
 * household's screen over the LAN, authenticated with the same display token
 * the wall polls with. No FCM, no relay.
 */
class PushService : Service() {

    private val main = Handler(Looper.getMainLooper())
    private var client: OkHttpClient? = null
    private var webSocket: WebSocket? = null
    private var baseUrl: String = ""
    private var reconnectAttempt = 0
    private var running = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForegroundNotification()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val configured = ServerConfig(this).baseUrl
        if (configured.isNullOrBlank()) {
            stopSelf()
            return START_NOT_STICKY
        }
        running = true
        if (configured != baseUrl) {
            // First start, or the household pointed the wall at a different box.
            // Drop the old socket and connect to the new one.
            baseUrl = configured
            webSocket?.close(1000, "server changed")
            webSocket = null
            reconnectAttempt = 0
            connect()
        } else if (webSocket == null) {
            // An explicit (re)start while disconnected — the wall just loaded
            // with a fresh pairing cookie, say. Treat it as "try now" rather
            // than continuing to back off from earlier unauthenticated attempts.
            reconnectAttempt = 0
            connect()
        }
        // START_STICKY: a wall's push socket should come back if the system
        // reclaims the service, the same way the activity relaunches on boot.
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        main.removeCallbacksAndMessages(null)
        webSocket?.close(1001, "service stopping")
        webSocket = null
        super.onDestroy()
    }

    private fun connect() {
        if (!running) return
        val base = OkHttpClient.Builder()
            // The socket is meant to stay open; ping keeps it alive through NAT
            // and lets a silently dropped connection be noticed and retried.
            .pingInterval(30, TimeUnit.SECONDS)
            .build()
        val http = TlsPinning.clientFor(this, baseUrl, base)
        client = http

        val builder = Request.Builder().url("$baseUrl$PUSH_PATH")
        // The display token — the same credential the wall polls with, read from
        // the cookie the pairing set. HttpOnly blocks JS, not the platform store.
        displayToken()?.let { builder.header("Cookie", "$DISPLAY_COOKIE=$it") }

        webSocket = http.newWebSocket(builder.build(), listener)
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            reconnectAttempt = 0
            Log.i(TAG, "push socket connected")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            handle(PushMessage.parse(text))
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            // A refused or dropped socket is not an error to a wall — polling
            // still carries interrupts. Back off and try again. The server
            // being an older build with no /d/push lands here too, and correctly
            // degrades to poll-only.
            Log.i(TAG, "push socket down (${t.message}); will retry")
            scheduleReconnect()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (running) scheduleReconnect()
        }
    }

    private fun handle(message: PushMessage) {
        when (message) {
            is PushMessage.InterruptPush -> {
                // The one field that matters. The server already decided,
                // server-side and against the household's night hours, whether
                // this should light a dark screen — so the app does not re-derive
                // it, it acts on it.
                if (message.wakeScreen) wake()
                // Draw the new state promptly whether or not it woke the screen.
                PushBus.requestPoll()
            }

            is PushMessage.ManifestChanged -> PushBus.requestPoll()

            PushMessage.Unknown -> {
                // A newer protocol or an unrecognised message. Ignored, never
                // fatal — the poll still carries the truth.
            }
        }
    }

    /**
     * Wake a dark screen for a warning.
     *
     * Two steps, because they answer different questions. A brief wake lock
     * powers the panel on from the service (which may be all that is running if
     * the screen went dark); then the activity is brought to the front with a
     * wake flag, and it is the activity that shows-when-locked, dismisses the
     * keyguard and re-polls so the warning is on the glass. Starting the
     * activity is the only thing that reliably foregrounds a backgrounded wall.
     */
    private fun wake() {
        val power = getSystemService(POWER_SERVICE) as? PowerManager
        @Suppress("DEPRECATION")
        val lock = power?.newWakeLock(
            PowerManager.FULL_WAKE_LOCK or
                PowerManager.ACQUIRE_CAUSES_WAKEUP or
                PowerManager.ON_AFTER_RELEASE,
            "$TAG:wake",
        )
        // Held only long enough to get the screen on; the activity's
        // FLAG_KEEP_SCREEN_ON takes over once it is showing.
        lock?.acquire(10_000L)
        main.postDelayed({ if (lock?.isHeld == true) lock.release() }, 8_000L)

        startActivity(
            Intent(this, KioskActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra(EXTRA_WAKE, true)
            },
        )
    }

    private fun scheduleReconnect() {
        webSocket = null
        if (!running) return
        // 2s doubling to a 60s ceiling — quick to recover from a blip, gentle on
        // a long outage.
        val delay = (2_000L shl reconnectAttempt.coerceAtMost(5)).coerceAtMost(60_000L)
        reconnectAttempt++
        main.postDelayed({ if (running && webSocket == null) connect() }, delay)
    }

    /** The `mw_display` value from the platform cookie store, or null. */
    private fun displayToken(): String? {
        val cookies = try {
            CookieManager.getInstance().getCookie(baseUrl)
        } catch (_: Exception) {
            null
        } ?: return null
        for (part in cookies.split(';')) {
            val trimmed = part.trim()
            if (trimmed.startsWith("$DISPLAY_COOKIE=")) {
                return trimmed.substringAfter('=').ifBlank { null }
            }
        }
        return null
    }

    private fun startForegroundNotification() {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.push_channel_name),
                // Low: an ongoing "connected" line, not something that should
                // buzz. The warnings themselves are on the wall, not here.
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = getString(R.string.push_channel_desc) }
            manager.createNotificationChannel(channel)
        }

        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, KioskActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(getString(R.string.push_notif_title))
            .setContentText(getString(R.string.push_notif_text))
            .setOngoing(true)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        ServiceCompat.startForeground(
            this,
            NOTIF_ID,
            notification,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            } else {
                0
            },
        )
    }

    companion object {
        private const val TAG = "MaverickPush"
        private const val PUSH_PATH = "/d/push"
        private const val DISPLAY_COOKIE = "mw_display"
        private const val CHANNEL_ID = "maverick_push"
        private const val NOTIF_ID = 1

        /** Intent extra on the wake path — see `KioskActivity`. */
        const val EXTRA_WAKE = "systems.ambienthome.maverickwall.WAKE"

        /** Start (or refresh) the push service for the configured server. */
        fun start(context: android.content.Context) {
            val intent = Intent(context, PushService::class.java)
            androidx.core.content.ContextCompat.startForegroundService(context, intent)
        }
    }
}
