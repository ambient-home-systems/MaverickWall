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
4. **Where it is, and who it is for.** Also optional. A latitude and longitude
   for the forecast strip — and, in the United States, for working out which
   National Weather Service zones to watch — and the name of one person, whose
   colour marks their events.

Setup is complete after the timezone.

Skipping the fourth step costs nothing and hides nothing. The wall simply
leaves out the widgets it has nothing to put in, rather than drawing a box that
says "Nothing to show yet." for ever, and **no weather alert rule is armed
until a location exists** — there are no zones to watch without one, so a rule
that reported itself as on would be reporting something that could not happen.
Fill either in later on **Weather** and **People**, and both come back.

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
