package systems.ambienthome.maverickwall

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints

/**
 * Draw [content] turned [rotation] degrees clockwise, filling the window.
 *
 * A Google TV box outputs landscape whatever the household did with the
 * television, and no app can rotate the system's own screens. What an app can
 * do is turn its own. The wall does it in the page (the display's
 * `data-rotation`); this is the same thing for the few screens the app draws
 * natively, so setup, the pairing code and "connecting…" read the right way up
 * on a television hung on its end.
 *
 * On its side the content is laid out at the window's height by its width, then
 * turned about the window's centre, so a 1920x1080 panel hung portrait lays its
 * screen out at 1080x1920 and fills the glass edge to edge — a turned picture,
 * not a squeezed one. The turn is a graphics layer, which Compose carries
 * through input as well as drawing: a tap lands on what is under the finger,
 * and the remote's arrows move focus by where things are on the glass, so Down
 * on the remote goes to whatever is drawn below.
 */
@Composable
fun Rotated(rotation: Int, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val turn = ScreenRotation.of(rotation) ?: 0
    val sideways = ScreenRotation.isSideways(turn)
    Layout(
        content = content,
        modifier = modifier
            .fillMaxSize()
            .graphicsLayer { rotationZ = turn.toFloat() },
    ) { measurables, constraints ->
        val inner = if (sideways) {
            Constraints(
                minWidth = constraints.minHeight,
                maxWidth = constraints.maxHeight,
                minHeight = constraints.minWidth,
                maxHeight = constraints.maxWidth,
            )
        } else {
            constraints
        }
        val placeables = measurables.map { it.measure(inner) }
        val width = constraints.maxWidth
        val height = constraints.maxHeight
        layout(width, height) {
            // Centred, so turning about the window's centre lands the content
            // exactly over the window: a 1080x1920 box placed at (420, -420)
            // in a 1920x1080 window and turned a quarter fills it.
            for (placeable in placeables) {
                placeable.place((width - placeable.width) / 2, (height - placeable.height) / 2)
            }
        }
    }
}
