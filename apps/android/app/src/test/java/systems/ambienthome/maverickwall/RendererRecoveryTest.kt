package systems.ambienthome.maverickwall

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * When the wall comes back after its page's process dies.
 *
 * The case worth a test is the loop: a page that dies every time it loads must
 * not be reloaded at once for ever, and a box that had one bad evening must
 * not be held to that evening's pace the next morning.
 */
class RendererRecoveryTest {

    private val minute = 60_000L

    /** Deaths at each of [times], recorded in order, as the kiosk records them. */
    private fun deathsAt(vararg times: Long): List<Long> =
        times.fold(emptyList()) { deaths, t -> RendererRecovery.record(deaths, t) }

    @Test
    fun firstDeathReloadsAtOnce() {
        assertEquals(0L, RendererRecovery.delayFor(deathsAt(1_000L)))
    }

    @Test
    fun eachFurtherDeathWaitsLongerUpToFiveMinutes() {
        val start = 100 * minute
        assertEquals(5_000L, RendererRecovery.delayFor(deathsAt(start, start + minute)))
        assertEquals(
            30_000L,
            RendererRecovery.delayFor(deathsAt(start, start + minute, start + 2 * minute)),
        )
        val many = LongArray(20) { start + it * 10_000L }
        assertEquals(5 * minute, RendererRecovery.delayFor(deathsAt(*many)))
    }

    @Test
    fun aDeathOlderThanTheWindowNoLongerCounts() {
        val start = 100 * minute
        val deaths = deathsAt(start, start + RendererRecovery.WINDOW_MS)
        assertEquals(listOf(start + RendererRecovery.WINDOW_MS), deaths)
        assertEquals(0L, RendererRecovery.delayFor(deaths))
    }

    @Test
    fun aQuietSpellAfterALoopStartsTheCountAgain() {
        val start = 100 * minute
        val looping = deathsAt(start, start + 1_000L, start + 2_000L, start + 3_000L)
        assertEquals(5 * minute, RendererRecovery.delayFor(looping))
        val later = RendererRecovery.record(looping, start + 3_000L + RendererRecovery.WINDOW_MS)
        assertEquals(0L, RendererRecovery.delayFor(later))
    }

    @Test
    fun aDeathTheClockPutsInTheFutureIsNotCounted() {
        val deaths = RendererRecovery.record(listOf(50 * minute), 10 * minute)
        assertEquals(listOf(10 * minute), deaths)
        assertEquals(0L, RendererRecovery.delayFor(deaths))
    }

    @Test
    fun everyDeathInTheWindowIsCountedForTheStatus() {
        val start = 100 * minute
        val many = LongArray(20) { start + it * 10_000L }
        assertEquals(20, deathsAt(*many).size)
    }
}
