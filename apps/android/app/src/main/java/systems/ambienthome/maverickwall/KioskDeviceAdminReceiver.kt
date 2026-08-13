package systems.ambienthome.maverickwall

import android.app.admin.DeviceAdminReceiver

/**
 * The hook that lets a managed install pin the wall (Phase 4).
 *
 * `KioskActivity.tryEnterLockTask` pins the app to a single task **only where
 * the device already permits it** — a plain sideload never does, deliberately,
 * so a household is never stranded by a hard requirement. Permitting it means
 * provisioning this app as the device owner, and a device owner must name a
 * `DeviceAdminReceiver`:
 *
 * ```
 * adb shell dpm set-device-owner \
 *   systems.ambienthome.maverickwall/.KioskDeviceAdminReceiver
 * ```
 *
 * (Only on a factory-fresh device with no accounts — that is Android's rule for
 * device owner, not this app's.) Once set, the owner is granted lock-task for
 * this package, and the kiosk pins itself with no screen-pinning prompt.
 *
 * The receiver is deliberately empty and requests no policies (see
 * `res/xml/device_admin.xml`): it exists to become the owner so lock-task is
 * available, not to manage passwords, wipe the device, or anything else. The
 * blast radius of this admin is exactly "can keep one calendar on the screen".
 */
class KioskDeviceAdminReceiver : DeviceAdminReceiver()
