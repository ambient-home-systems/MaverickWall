package systems.ambienthome.maverickwall

/**
 * Which way up this screen is hung, in clockwise quarter turns.
 *
 * The same four values, meaning the same thing, as the wall's own Wall mounting
 * setting on the server (`screens.rotation`), which the display applies as a
 * CSS `rotate()` of the whole page: `90` turns the picture a quarter clockwise.
 * One vocabulary on both sides, so the number the app reports at pairing is the
 * number the server stores, and the number the page reports back is one the
 * app can draw with unchanged.
 *
 * Pure, with no Android in it, so it is the part of this feature a JVM unit
 * test can reach: the rest is a layout and a remote's arrow keys, which only a
 * device can check.
 */
object ScreenRotation {

    /** The four turns, in the order a household meets them turning clockwise. */
    val VALUES: List<Int> = listOf(0, 90, 180, 270)

    /**
     * A stored or reported value, if it is one of the four — never a guess.
     *
     * A value from preferences written by a later build, or a page answering
     * something unexpected, is refused rather than rounded to the nearest
     * quarter: a screen drawn a guessed way up is the fault this exists to fix.
     */
    fun of(value: Int): Int? = if (value in VALUES) value else null

    /** A quarter turn clockwise: what Right on the remote does. */
    fun clockwise(rotation: Int): Int = (rotation + 90) % 360

    /** A quarter turn anticlockwise: what Left on the remote does. */
    fun anticlockwise(rotation: Int): Int = (rotation + 270) % 360

    /** Whether the picture is on its side, so its width and height trade places. */
    fun isSideways(rotation: Int): Boolean = rotation == 90 || rotation == 270

    /**
     * Read what the page's `maverickWall.rotation()` handed back.
     *
     * `WebView.evaluateJavascript` delivers the result JSON-encoded: a number
     * arrives as `"90"`, the page's `null` (no manifest has said yet) and an
     * older bundle with no such function both arrive as `"null"`, and a page
     * that is not the wall at all — the WebView's own error page — as `"null"`
     * too. Only the four turns are taken; anything else is "the page did not
     * say", and the app keeps what it had.
     */
    fun fromPage(result: String?): Int? {
        val trimmed = result?.trim() ?: return null
        if (!Regex("^(0|90|180|270)$").matches(trimmed)) return null
        return of(trimmed.toInt())
    }
}
