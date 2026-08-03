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

1. Install **Fully Kiosk** or any browser that can be pinned.
2. Open the pairing link once.
3. On the screen's settings in the admin, turn on **This screen can acknowledge
   alerts** — the remote's OK button then clears whatever the wall is showing.

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
