package systems.ambienthome.maverickwall

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which way up the screen is: the arithmetic and the two readings that are not
 * a layout, so a JVM can check them.
 *
 * The reading of the page's answer is the part with a failure that would not
 * look like one. A page that has not said yet answers `null`, and if that were
 * taken as `0` the app would copy "the right way up" over a television answered
 * on first run — standing every native screen back on its side, which is the
 * bug this feature exists to fix.
 */
class ScreenRotationTest {

    @Test
    fun turnsAQuarterEachWayAndComesBackRound() {
        var turn = 0
        val seen = mutableListOf<Int>()
        repeat(4) {
            turn = ScreenRotation.clockwise(turn)
            seen += turn
        }
        assertEquals(listOf(90, 180, 270, 0), seen)

        seen.clear()
        repeat(4) {
            turn = ScreenRotation.anticlockwise(turn)
            seen += turn
        }
        assertEquals(listOf(270, 180, 90, 0), seen)

        for (value in ScreenRotation.VALUES) {
            assertEquals(value, ScreenRotation.anticlockwise(ScreenRotation.clockwise(value)))
        }
    }

    @Test
    fun takesOnlyTheFourTurns() {
        for (value in ScreenRotation.VALUES) assertEquals(value, ScreenRotation.of(value))
        // Refused, never rounded: a guessed way up is the fault being fixed.
        for (value in listOf(-90, 45, 89, 360, 450)) assertNull("$value", ScreenRotation.of(value))
    }

    @Test
    fun knowsWhenThePictureIsOnItsSide() {
        assertFalse(ScreenRotation.isSideways(0))
        assertTrue(ScreenRotation.isSideways(90))
        assertFalse(ScreenRotation.isSideways(180))
        assertTrue(ScreenRotation.isSideways(270))
    }

    @Test
    fun readsTheTurnThePageAnswered() {
        // `evaluateJavascript` hands back a number JSON-encoded.
        assertEquals(0, ScreenRotation.fromPage("0"))
        assertEquals(90, ScreenRotation.fromPage("90"))
        assertEquals(180, ScreenRotation.fromPage(" 180 "))
        assertEquals(270, ScreenRotation.fromPage("270"))
    }

    @Test
    fun treatsEveryOtherAnswerAsThePageNotSaying() {
        val silent = listOf(
            null,
            // No manifest yet, the server's stand-in, or a bundle with no `rotation()`.
            "null",
            "",
            // A string, which the page never sends: not taken as a number.
            "\"90\"",
            "90.5",
            "-90",
            "360",
            "{}",
            "true",
        )
        for (answer in silent) assertNull("$answer", ScreenRotation.fromPage(answer))
    }
}
