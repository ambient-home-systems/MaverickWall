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
4. **Your location, and the people who live here.** Also optional. A latitude
   and longitude for the forecast strip — and, in the United States, for working
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

### A calendar that needs signing in

Open **Sign in to this calendar** under the address and give it a username and
a password. Both, or neither: a username on its own sends nothing, because half
a credential is not a credential.

For **Nextcloud**: open **Settings**, then **Calendar**, then the three dots
beside the calendar you want, and **Copy internal link**. Add `?export` to the
end of what you copied — that is what turns a calendar collection into a single
`.ics` file. Then sign in with **an app password** rather than your account
password: **Settings → Security → Create new app password**. An app password
can be revoked on its own and does not unlock the rest of your account.

Baïkal, Radicale, SOGo and Fastmail work the same way, as does any school or
work feed behind a sign-in.

The password is encrypted at rest beside the address, and never shown again —
the box on the settings row is blank because there is nothing to show you, and
leaving it blank keeps what is stored. To change one, type the new one; to take
it off a calendar that no longer needs it, use **Remove the password**.

If a password stops working — an app password revoked, a school one reissued —
the calendar says so on the Calendars page and **stops trying** rather than
retrying every fifteen minutes. That is deliberate: a wrong password on a loop
is how Nextcloud's brute-force protection and Apple's account lockout get
triggered against your own account. Entering a new one starts it again straight
away.

### An iCloud calendar, or any CalDAV server

**Calendars → Add a CalDAV account.** This is the route for iCloud, and it
works for any server that speaks CalDAV — Nextcloud, Baïkal, Radicale, SOGo,
Fastmail — where one sign-in reaches every calendar on the account rather than
one address per calendar.

For **iCloud** the address is exactly `https://caldav.icloud.com`, your username
is your Apple ID, and the password **must be an app-specific password** made at
[appleid.apple.com](https://appleid.apple.com) under *Sign-In and Security*.
Your Apple ID password will not work, and this is Apple's rule rather than ours.

It then signs in, finds every calendar on the account and asks which ones you
want. Tick them and they arrive as ordinary calendars — their own colour, their
own owner, their own switch for the month grid. Adding more later means opening
the account again rather than typing the password a second time.

**If it asks "is that the right server?", read it.** Apple keeps each account's
calendars on a numbered server — you type `caldav.icloud.com` and your calendars
live somewhere like `p42-caldav.icloud.com` — so the address moves once during
setup. Your password is **not** sent to the second address until you press
Continue, and the answer is remembered so you are never asked again. A
self-hosted server normally does not move at all and this never appears; if it
does appear for a server you did not expect it to, stop and check the address
you typed.

Changing the password later is one field on the account, not one per calendar:
**Calendars → CalDAV accounts → Change password.** That is the whole reason an
account is a thing here rather than a copy of the same password on each
calendar — regenerate an app-specific password, change it once, and all of them
keep working.

**This is not part of first-run setup.** The wizard asks for one ICS address, to
get something on the wall in the first five minutes; a household on iCloud adds
their account from the Calendars page afterwards. Nothing is lost by skipping
the wizard's calendar step entirely.

### Google, iCloud and Microsoft 365, through Home Assistant

If you run Home Assistant, its own integrations are the best route for these —
it does the signing in, and the calendars then appear here like any other.

- **Google Calendar** and **Microsoft 365** have their own Home Assistant
  integrations and keep up promptly.
- **iCloud** has no ICS address worth using. Its **CalDAV** integration with an
  Apple ID and an app-specific password works — and so does adding the same
  account here directly, which needs no Home Assistant at all. Either is fine;
  the direct route is one fewer thing to keep running.
- **Remote Calendar** takes a plain ICS address, and refreshes **once a day** —
  so routing a feed through it is slower than adding the address here directly.

Once Home Assistant has them, **Calendars** offers them under *From Home
Assistant* with no address to find at all.

A Google **secret iCal address** added here directly works, and how fresh it is
is Google's decision rather than ours: Google caches it on its own schedule and
it can be hours behind. If that matters, the Home Assistant route is the one
that fixes it.

## Pairing a screen

**Screens → Add.** You get a link and a QR code.

Open the link on the wall display once. It trades the token for a cookie and
then redirects, so the token appears once and never again in a browser history
somebody later screenshots. That screen is now paired until you revoke it.

Each screen has its own settings: orientation, rotation for a panel mounted on
its side, theme, timezone, and whether it can acknowledge alerts.
