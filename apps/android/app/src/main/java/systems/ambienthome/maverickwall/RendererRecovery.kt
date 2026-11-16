package systems.ambienthome.maverickwall

/**
 * How soon the wall comes back after its page's process dies.
 *
 * The WebView draws the calendar in a process of its own, and Android ends that
 * process when it crashes or when a box short of memory wants it back. Left
 * unhandled, Android then ends the whole app, and a television sits on its own
 * home screen until somebody notices and opens the wall again. The kiosk loads
 * a fresh page instead (`KioskActivity.onRendererGone`); this decides when.
 *
 * The first death in [WINDOW_MS] reloads at once, because that is nearly
 * always a one-off and the display draws its stored calendar within moments.
 * A page that keeps dying is one that would only die again, and reloading it
 * at once every time is a box spending its whole CPU on a crash loop, so each
 * further death in the window waits longer, up to five minutes. Retry on the
 * status screen still tries at once.
 *
 * Pure, with no Android in it, so a JVM unit test can reach it. The times are a
 * monotonic clock's (`SystemClock.elapsedRealtime`), never the wall clock, which
 * a box with no network can have set to anything.
 */
object RendererRecovery {

    /** How far back a death still counts towards waiting longer. */
    const val WINDOW_MS: Long = 10 * 60_000L

    /** The wait before each reload: the first death in the window, the second, the third, then every later one. */
    private val DELAYS_MS = longArrayOf(0L, 5_000L, 30_000L, 5 * 60_000L)

    /**
     * The deaths still inside the window once one more happens at [now].
     *
     * A time later than [now] is dropped as well as one too old: it can only
     * come from a clock that went backwards, and it is no evidence of a loop.
     * Every death in the window is kept, uncapped, because the status screen
     * says how many there were; the waits above already keep that to a handful.
     */
    fun record(deaths: List<Long>, now: Long): List<Long> =
        deaths.filter { now - it in 0 until WINDOW_MS } + now

    /** How long to wait before loading the wall again, given what [record] returned. */
    fun delayFor(deaths: List<Long>): Long =
        DELAYS_MS[(deaths.size - 1).coerceIn(0, DELAYS_MS.lastIndex)]
}
