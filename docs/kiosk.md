# Kiosk devices

Anything that runs a reasonably modern browser and can be told to stay on one
page. Three that work well, in order of how little they cost.

## Amazon Fire tablet

The cheapest wall display there is. A Fire HD 8 on sale is about the price of a
takeaway.

1. Install **Fully Kiosk Browser** from the Amazon Appstore.
2. Start URL: the pairing link. It becomes a cookie on first load.
3. Turn on **Keep screen on**, **Kiosk mode**, and **Auto reload on
   connection restored**.
4. Turn *off* **Screensaver** — this is the screensaver.

Fire tablets do not charge well from the sleepy USB port on a mains adapter
under a cabinet; use a proper 2A supply or it will discharge while plugged in.

## Google TV / Android TV

A television you already own, or a £30 dongle.

**The Maverick Wall app is the best way to run one** — it boots straight into the
wall, keeps the screen on, pairs itself with a code and a QR (no typing an
address on a remote), and can turn a dark screen *on* for a tornado warning,
which no browser can. Download the signed APK from the repository's
[Releases](https://github.com/ambient-home-systems/maverick-wall/releases)
(`maverick-wall-X.Y.Z.apk`) and sideload it:

1. Enable **Developer options → USB/Network debugging** on the TV, then
   `adb install -r maverick-wall-X.Y.Z.apk` (or use a file-manager sideload).
2. Open it. Pick the server it found on the network — or type its address — and
   approve the pairing from your phone or the Maverick Wall settings.
3. On the screen's settings in the admin, turn on **This screen can acknowledge
   alerts** — the remote's OK button then clears whatever the wall is showing.

See [`apps/android/README.md`](../apps/android/README.md) for the app, and
[`docs/releasing-the-app.md`](releasing-the-app.md) for cutting a release. A
managed install can pin it as a locked-down kiosk (device-owner provisioning);
a plain sideload runs unpinned, which is fine for most walls.

No app? Any browser that can be pinned — **Fully Kiosk** is the usual pick —
works too: open the pairing link once and it becomes a cookie. You lose only the
native wake and boot-start.

A television is landscape, so it gets the two-column layout. If you have hung
it on its end, set the rotation per screen rather than fighting the
television's own settings — plenty of panels cannot rotate and plenty of the
ones that can forget after a power cut.

## Raspberry Pi

A Pi 4 or 5 driving a monitor, if you want something you fully control.

```bash
sudo apt install --no-install-recommends chromium-browser unclutter
```

```bash
chromium-browser \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --check-for-update-interval=31536000 \
  --app="http://<the-machine>:8080/pair?token=<paired-token>"
```

Run it from a systemd user service so it comes back after a power cut. The wall
keeps its last calendar in the browser's own storage, so a reboot paints
something in milliseconds even before the network is up.

## Anything else

The only requirements are a browser and the ability to open one URL and stay
there. The display uses no framework, fetches nothing from a third party, and
targets ES2019 — it works on browsers considerably older than the device it
came on.
