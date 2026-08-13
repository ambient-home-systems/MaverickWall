package systems.ambienthome.maverickwall.pairing

import android.graphics.Bitmap
import android.graphics.Color
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/**
 * A QR of the approve link, drawn on the TV for a phone to scan.
 *
 * The household scans this with a phone already on the LAN and lands on the
 * approve page behind their session — the convenience path over reading and
 * typing the short code. The link only ever encodes the LAN address the app
 * actually reached (the server builds `verifyUrl` from a reachable origin), so
 * it cannot carry an address a phone cannot open — the direct fix for the old
 * pairing QR that scanned as an internal Docker host.
 *
 * ZXing is a pure-Java, offline encoder bundled in the APK: nothing is fetched
 * to draw this, in keeping with the no-cloud rule. It is the app's counterpart
 * to the server's own `http/qr.ts`, which draws the browser-side pairing QR for
 * the same reason.
 */
object QrCode {

    /**
     * Encode [text] as a square QR bitmap [sizePx] on a side, or null if it
     * cannot be encoded (a payload too long, say) — the caller shows the code
     * and link as text instead, so a missing QR is never a dead end.
     */
    fun bitmap(text: String, sizePx: Int): Bitmap? {
        if (sizePx <= 0) return null
        return try {
            val hints = mapOf(
                // A tight quiet zone; the composable adds its own padding.
                EncodeHintType.MARGIN to 1,
                // Level M matches the server's encoder — enough recovery for a
                // screen photographed across a room.
                EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
            )
            val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, sizePx, sizePx, hints)
            val bitmap = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888)
            for (x in 0 until sizePx) {
                for (y in 0 until sizePx) {
                    bitmap.setPixel(x, y, if (matrix[x, y]) Color.BLACK else Color.WHITE)
                }
            }
            bitmap
        } catch (_: Exception) {
            null
        }
    }
}
