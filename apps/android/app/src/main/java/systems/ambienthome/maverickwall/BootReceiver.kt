package systems.ambienthome.maverickwall

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Bring the wall back up when the device powers on.
 *
 * A wall screen is not a phone somebody unlocks; it is a panel on a kitchen
 * wall that has to be showing the calendar again the moment the power returns,
 * with nobody there to open an app. This receiver is what makes that happen —
 * and a `BOOT_COMPLETED` receiver is allowed to start an activity from the
 * background, which is the one exemption that lets it.
 *
 * The OEM variants matter: plenty of cheap TV boxes never send the standard
 * `BOOT_COMPLETED` and only emit `QUICKBOOT_POWERON`, so a wall relying on the
 * standard action alone would stay dark on exactly the hardware most likely to
 * be bolted to a wall.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in BOOT_ACTIONS) return
        // Only relaunch a wall that has been set up. An unconfigured device
        // waking straight into the address-entry screen, unattended, helps
        // nobody — it waits for someone to open it deliberately.
        if (!ServerConfig(context).isConfigured) return

        context.startActivity(
            Intent(context, KioskActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            },
        )
    }

    private companion object {
        val BOOT_ACTIONS = setOf(
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_LOCKED_BOOT_COMPLETED,
            "android.intent.action.QUICKBOOT_POWERON",
            "com.htc.intent.action.QUICKBOOT_POWERON",
        )
    }
}
