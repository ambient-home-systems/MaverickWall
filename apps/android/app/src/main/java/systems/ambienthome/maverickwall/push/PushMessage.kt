package systems.ambienthome.maverickwall.push

import org.json.JSONObject

/**
 * The push contract, on the client side.
 *
 * The shape is fixed by the server (`apps/server/src/api/push.ts`), which fixed
 * it deliberately *before* this app existed so that adding a field later would
 * not strand a version of the app in somebody's hallway that never wakes for a
 * warning. This is the other end of that contract; the two must agree, and
 * `PUSH_PROTOCOL_VERSION` is what a future mismatch is caught against.
 *
 * Only what the app acts on is parsed. The interrupt payload carries a dozen
 * fields for the display; here the single load-bearing one is the top-level
 * `wakeScreen` — the server has already hoisted it out of the list precisely so
 * a client acts on one boolean rather than scanning, and has already decided,
 * server-side and against the household's night hours, that it should be set.
 * So the app's rule is simply: wake iff `wakeScreen`. A browser ignores the
 * field entirely; this app is the only client that turns a screen on.
 */

const val PUSH_PROTOCOL_VERSION = 1

sealed interface PushMessage {
    /**
     * The interrupts in force, and whether any of them asked to wake the screen.
     *
     * `wakeScreen` is the server's own hoisted boolean, not an `and` of anything
     * — the server's comment is explicit that anding it with `piercesNightMode`
     * made a real combination a silent no-op, so the app must not re-derive it.
     */
    data class InterruptPush(
        val sentAt: Long,
        val wakeScreen: Boolean,
        val interruptCount: Int,
    ) : PushMessage

    /** A nudge to re-poll now instead of waiting out the interval. */
    data class ManifestChanged(
        val sentAt: Long,
        val etag: String,
    ) : PushMessage

    /**
     * Anything else — a newer server protocol, or a message this app does not
     * know. Ignored rather than crashed on: an unknown push must never take the
     * socket, or the wall, down.
     */
    data object Unknown : PushMessage

    companion object {
        fun parse(text: String): PushMessage {
            return try {
                val json = JSONObject(text)
                when (json.optString("type")) {
                    "INTERRUPT_PUSH" -> InterruptPush(
                        sentAt = json.optLong("sentAt"),
                        wakeScreen = json.optBoolean("wakeScreen", false),
                        interruptCount = json.optJSONArray("interrupts")?.length() ?: 0,
                    )

                    "MANIFEST_CHANGED" -> ManifestChanged(
                        sentAt = json.optLong("sentAt"),
                        etag = json.optString("etag"),
                    )

                    else -> Unknown
                }
            } catch (_: Exception) {
                // Malformed JSON on the wire is a dropped message, never a crash.
                Unknown
            }
        }
    }
}
