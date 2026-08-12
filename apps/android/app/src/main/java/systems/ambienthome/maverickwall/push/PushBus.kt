package systems.ambienthome.maverickwall.push

import android.os.Handler
import android.os.Looper

/**
 * A one-wire channel from the push service to the visible wall.
 *
 * The service and the activity share a process, so a push that only needs the
 * wall to re-poll (a manifest changed while the screen is already on) does not
 * warrant starting an activity — it just calls the poll the visible wall
 * registered. A *wake* is different and does not come through here: it has to
 * bring a backgrounded, possibly dark activity to the front, which only an
 * Intent can do (see `PushService.wake`). This carries the cheap case; the
 * Intent carries the loud one.
 *
 * The listener is whatever the foreground activity set and cleared with its own
 * lifecycle, so a push arriving while nothing is visible is simply dropped —
 * correct, because the next poll (or the visibility-change re-poll when a wake
 * does bring the wall up) covers it.
 */
object PushBus {
    private val main = Handler(Looper.getMainLooper())

    @Volatile
    private var pollListener: (() -> Unit)? = null

    /** The visible wall registers here; a backgrounded one clears it (null). */
    fun setPollListener(listener: (() -> Unit)?) {
        pollListener = listener
    }

    /** Ask the visible wall to poll now. No-op if nothing is visible. */
    fun requestPoll() {
        main.post { pollListener?.invoke() }
    }
}
