# First run

Open `http://<the-machine>:8080`.

## The setup code

The first account is the only one that can be created, and the only way to
create it is a code printed in the container's log:

```bash
docker logs maverick-wall
```

```
  Nobody has set this up yet. Open:

    http://localhost:8080/setup?token=...

  Or go to http://localhost:8080/setup and enter this code:  NAWQZWNY
```

Reaching the log is what stands in for proving you are the person who installed
this. Before the code existed, the first sign-up was open to anybody who could
reach the port. It lasts thirty minutes and a new one is printed when it
expires — restart the container if you missed it.

## Four steps

1. **Your account.** Email and a password. This is stored on your machine and
   sent nowhere.
2. **Timezone.** Everything all-day is anchored to it. Getting it wrong puts
   birthdays on the wrong day.
3. **A calendar.** Optional, and skippable — a feed can fail for reasons you do
   not control, and a wizard you cannot finish because Google is having a bad
   morning would leave a wall blank on the evening you installed it.
4. **Your location, and who lives here.** Also optional. A latitude and
   longitude for the forecast strip — and, in the United States, for working
   out which National Weather Service zones to watch — and the name of one
   person. A person is somebody for the wall to know about: their colour marks
   their events once a calendar is assigned to them, and a rota once one
   exists.

Setup is complete after the timezone.

Skipping the fourth step costs nothing and hides nothing. The wall leaves out
the widgets it has nothing to put in, rather than drawing a box that says
"Nothing to show yet." for ever. Add a location on **Weather** and the forecast
strip appears where it always was; **Walls → Layout** marks any widget the wall
is leaving out and names the screen that fixes it.

A name on its own changes nothing on the glass, and that is worth knowing
before you look for it. A person's colour marks events on a calendar assigned
to them, which is done on **Calendars**; the rota badge appears once a rotation
exists on **Shifts**. Adding a person creates neither — it creates the person
both of those then attach to.

**No weather alert rule is armed until a zone is being watched.** The zones are
worked out from the location, so there are none without one — and none at all
outside National Weather Service coverage, wherever the coordinates point. A
rule that reported itself as on in either case would be reporting something
that could not happen. **Weather** shows the zones as soon as there are any.

## Adding a calendar

**Calendars → Add.** Paste the address of any ICS feed.

For Google: **Settings → Settings for my calendars → Integrate calendar →
Secret address in iCal format.** Use the *secret* address, not the public one.
The "Test feed" button fetches and shows you the next few events before storing
anything, because pasting the wrong one of those two links is easy and the
difference is invisible until nothing shows up.

That address is a password in effect — anybody holding it can read your
calendar for ever. It is encrypted at rest here, and only the hostname is ever
shown or logged.

## Pairing a screen

**Screens → Add.** You get a link and a QR code.

Open the link on the wall display once. It trades the token for a cookie and
then redirects, so the token appears once and never again in a browser history
somebody later screenshots. That screen is now paired until you revoke it.

Each screen has its own settings: orientation, rotation for a panel mounted on
its side, theme, timezone, and whether it can acknowledge alerts.
