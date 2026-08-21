# Changelog

<!--
  Write release notes here, under `## Unreleased`, as you go.

  The release renames this heading to the version being shipped and raises
  config.yaml to match, in one commit, after the image is built and verified.
  Home Assistant shows this text beside the Update button, so it is written for
  somebody standing in a kitchen: what changed for them, not what changed in
  the repository.

  A release refuses to start when this section is empty. That is deliberate —
  an empty heading would otherwise be renamed and shipped as a release note
  saying nothing.
-->

## Unreleased

The upcoming list on your wall reads better from across the room.

Each date now shows its month under the day number, so a row you glance at a
fortnight out tells you what it is without counting. Every event carries a thin
line in its calendar's colour, which is the quickest way to see whose it is
without reading a word — all-day events had one before, but always in the same
colour rather than the calendar's own.

An event that is happening right now shows how far through it is, so you can
tell at a glance whether you have time. An event that runs over several days
says which day you are on — "Day 2 of 4" — instead of leaving you to work it
out. And a day with nothing on it now says so, rather than showing a dash that
could just as easily mean the wall had failed to draw.

## 0.33.2

The Calendar options on an eInk panel now do what they say. Every one of them
was ignored: whichever of Month grid, Week columns or Upcoming list you picked,
the panel drew the same short list of today's events — and Month grid, the one
most people leave alone, was the worst affected, because the layout stores it
by leaving it out and the panel read a missing setting as "not the month".

Month grid draws the month. Week columns draws the coming week as seven
columns with today's inverted. Upcoming list shows the days ahead under their
own date headings, rather than only today, and honours which calendars to
include and how many events to show. "Labelled pills" names the events inside
each day's square instead of shading it, including today's, which are knocked
out of the filled cell so they can still be read.

## 0.33.1

Arranging an eInk panel shows the panel. The Arrange area used to draw your
widgets as the colour cards a browser wall shows, on a tall portrait canvas —
so a wide 800x480 panel was designed on a shape it cannot display, and boxes
dragged there landed somewhere else on the frame. Behind the boxes now is the
panel's own black-and-white picture, redrawn as you drag, the same one the
Preview above shows and the same one the panel fetches. The canvas is the
panel's real proportions, and the orientation and aspect controls are gone in
favour of a line stating what the panel is, because 800x480 landscape is a
fact about the hardware rather than a choice.

## 0.33.0

The settings are usable on a phone. Every page used to open with a block of
eleven navigation buttons filling half the screen before anything you came to
read — ungrouped, and back again on every tap — while sign-out and the
light/dark switch were not reachable at all.

There is a menu button in the top bar instead. It stays put as you scroll, so
the navigation is one tap away wherever you are on a page, and it opens the
same drawer you get on a computer: the sections named, the buttons big enough
to hit, sign-out and the theme switch where they belong. Choosing somewhere
closes it.

## 0.32.4

eInk panels draw their widgets properly now. The clock could lose its last
digit — half past eight drawn as "08:3" — because the type was sized to the
height of its box without checking it still fitted the width, and anything
past the edge was quietly cut off. Text now shrinks to fit the box it is in,
so the clock, the countdown's big number and the rest stay whole. The shift
widget was the worst of it: a whole panel given over to "Daddy: S". It draws
the card the wall does now — who it is, the shift's actual name at whatever
size the box affords, and its hours, which read as a span ("07:00-19:00")
rather than two times with a gap between them.

## 0.32.3

An eInk panel's editor no longer contradicts its own preview. With nothing
placed on the canvas, the editor said "Nothing on this display yet" while the
preview above it showed a full calendar — so after a reset it looked like the
panel was empty and that saving had done nothing. Both now say the same true
thing: with nothing placed, the panel draws its built-in layout, which is
what the preview shows. The note under the canvas also stopped promising a
"stacked layout", which has not existed since 0.27.0.

## 0.32.2

Reset on an eInk panel now does what it says. Pressing Reset in the panel's
layout editor used to replace the arrangement with the wall calendar's layout
and then drop you on the wall Displays page — where nothing about the panel
is visible, so it looked like nothing happened. It now clears the arrangement
back to the panel's built-in layout (the one a fresh panel draws), asks
before doing so in words that say exactly that, and returns you to the
panel's own page with the preview showing the result. Picking a template for
a panel returns to the panel's page too.

## 0.32.1

The eInk layout editor is back. Since the display editor was reworked in
0.30.0, the Arrange section on an eInk panel's page was an empty space — the
drag-and-drop editor never appeared, so a panel could not be rearranged from
the web at all. It loads again now: drag widgets, press "Save this panel",
and the black-and-white preview redraws with your arrangement within a few
seconds, exactly as it did in 0.29.0.

## 0.32.0

The settings screens have a new coat of paint: Material Design, in the wall's
own amber, in dark and light. Same screens, same controls — everything is just
drawn from one consistent palette and type scale now, and it still works
entirely offline.

The controls themselves followed: text boxes with labels that float out of the
way as you type, real toggle switches for on/off settings, rounded buttons,
and clearer tabs and choices. Everything is bigger where fingers land — every
control now has a proper touch target — and easier to follow from the
keyboard. Nothing moved and nothing works differently; it just reads better.

The rooms around the controls got the same treatment: a wider sidebar where
the current screen is a clear rounded highlight, a cleaner header, softer
rounded cards, and warnings in solid colour blocks that are easier to spot.
Same screens, same places — the settings just look like one finished app now.

The first-run wizard and the sign-in page match the new look too: a clearer
step indicator, the same floating-label fields, and error messages in the
same easy-to-spot colour blocks. They still work with no JavaScript at all,
so setting up works even when nothing else does.

When a calendar address points at a machine that is not answering, the error
now says so in plain words — "the connection was refused — nothing is
listening at that address and port", with what to check next — instead of a
raw code like ECONNREFUSED. The same plain wording appears anywhere a feed
fails to fetch, including a calendar's "last sync failed" note.

The settings' icons are now Material Symbols — the same icon family the new
look comes from — so the sidebar, the overview tiles and the little arrows
all match the rest of the design. Still built in, still nothing fetched from
the internet. A small glitch where the selected tab's underline could strike
through its own label is fixed along the way.

And the settings move the way they look now: buttons ripple from where you
press, switches glide, dialogs ease in and out. If your device is set to
reduce motion, all of it stays still — every animation respects that setting.
The first-run wizard stays completely script-free, exactly as before.

Making your own wall theme no longer means picking eleven colours by hand.
On Settings → Themes, pick one colour — the seed — choose dark or light, and
a whole matching theme is worked out from it: background, panels, text, and
the shift colours, every pairing kept readable from across a room. It lands
in the theme builder, so you can still adjust anything afterwards.

And a final polish pass walked every settings screen at phone, tablet and
desktop sizes in both dark and light, and fixed the handful of rough edges it
found: two screens that could scroll sideways on a phone (a long web address
and the eInk screen's buttons), error messages now in the design's own error
colours everywhere, and a few places that still said "Screens" where the page
is called Displays now.

## 0.31.1

The layout editor's live preview now matches the wall. After the widget-scaling
change in 0.31.0, the editor preview still drew the weather, agenda and shift
widgets small and cramped even though the real wall filled them — a
preview-only quirk. The preview now renders exactly as the wall does, so what
you arrange is what you get.

## 0.31.0

Widgets now use the space you give them. Every widget on a display scales to
fill its box — grow the box and the weather, the agenda, the shift and the rest
grow with it instead of staying small in the corner; shrink it and they stay
readable down to a sensible minimum rather than becoming a smudge. A small
"Upcoming" calendar that used to show one oversized, half-cut line now fits its
whole list into the box.

**The month grid now starts on Sunday.** This is a change to every existing
wall: the calendar's left-hand column and the week view now begin on Sunday by
default. If your household reads the week starting on Monday, you can switch it
back under Walls → Displays → Content → "Week starts on".

## 0.30.2

Maintenance release: more build and continuous-integration tooling updates, so
each release keeps building and verifying cleanly on supported infrastructure.
Nothing changes on your wall — the same 0.30.0 experience.

## 0.30.1

Maintenance release: internal build and continuous-integration updates only
(the tools that build and check each release now run on a current, supported
runtime). Nothing changes on your wall — this is the same 0.30.0 experience,
kept building cleanly.

## 0.30.0

A calmer way to set up a wall. Editing a display (Walls → Displays) is now one
tidy screen instead of a long scroll: a live preview on the left that stays in
view while you change how the wall looks on the right, sorted into Look, Content
and Device tabs. There is a single Save button for the whole page now — the
layout and its settings save together — a Layers list you can open to reorder
what sits in front, and picking a starting layout is a gallery of clear preview
cards. Nothing about your existing walls changes; this is only a friendlier way
to arrange them.

## 0.29.0

Build your own eInk layout. If you have a low-power e-paper panel (Walls → eInk
Displays), you can now arrange it with the same drag-and-drop editor the wall
displays use — drop a clock, a calendar, the weather, a shift, notes, a
countdown and more onto the panel, and it is drawn in crisp black and white. A
live preview shows exactly what the panel will look like as you build. Like the
panels themselves this is still early and tested in software rather than on
every screen, so expect some rough edges. Your existing displays are unchanged.

## 0.28.0

eInk (e-paper) displays — a new kind of screen. You can now pair a low-power
e-paper panel, the always-on black-and-white kind that runs for months on a
battery, under Walls → eInk Displays. Maverick Wall draws your calendar to a
picture and serves it; an ESPHome wifi panel fetches it, or Home Assistant
pushes it to an OpenDisplay tag over Bluetooth. The page hands you the image
address and ready-to-paste ESPHome and Home Assistant recipes. This is the
first release of the feature and still early — thoroughly tested in software,
but not yet on every panel out there, so expect some rough edges. Your existing
wall displays are unchanged.

## 0.27.0

Setting up a display is simpler, and building a layout is one clear thing. When
you add a screen you can now go straight to arranging its layout — before, the
pairing code was a dead end. Every display starts from the **Classic** layout
(the kitchen calendar it always drew), which you can rearrange freely or swap
for a ready-made template; there is no longer a confusing "automatic vs custom"
switch. Add anything to the wall from a tidy **Add widget** picker, and drag,
resize and layer it on a larger canvas.

Your walls are unchanged unless you rearrange them: each one keeps its current
look, now as movable widgets you can adjust.

## 0.26.0

Setting up a display is clearer. A display's settings now lead with its
**layout** — what's on the wall, and where — and the **theme** sits underneath
as how that layout looks, so the two no longer read as competing choices. When
you start from a template it tells you which theme it looks best in (and you can
still change it), and the "lighter theme during the day" option is tucked in
under the theme rather than standing on its own. Nothing on the wall itself
changes — this is only the settings screen.

## 0.25.0

The wall has a new set of looks. The default dark theme now reads as a
dashboard — the clock, the week ahead, the weather and the month each sit on
their own card. There are two new light themes for daytime: Household, a warm
paper look, and Blueprint, a cooler technical one; and the Paper Almanac theme
was redrawn with a proper serif so the month reads as a ledger from across the
room. Pick one on the Display screen, or set a light theme to come on
automatically during the day. If you never changed your theme, there is nothing
to do — your wall keeps its dark look.

## 0.24.5

A restart shows a "server is booting" page instead of a dead link. While the
add-on starts up — after an update, or a reboot — the server was unreachable
for a few seconds, so a screen or a browser opening a pairing link in that
window just failed to connect, which looks like a broken box. A tiny holder now
answers the port during startup with a clear, self-refreshing "Maverick Wall
server is booting — your calendar will be back soon" page, and hands over to the
real server the moment it is ready. Existing walls were already fine; this is
for anyone who opens the page mid-restart.

## 0.24.4

Weather and the other panels are readable next to the calendar. In a template
or layout box, a panel like the weather forecast was shrunk to a fraction of
its type — an unreadable sliver beside a full-height calendar. Panels now keep
their type at its intended size in the box, shrinking only when they genuinely
do not fit.

## 0.24.3

A display is one page now, not two tabs. Appearance and Layout were separate
tabs with overlapping controls; a display's settings and its layout editor now
sit together on one page. The two orientation controls that caused the most
confusion stay, but each now says what it does: the one in the settings chooses
which layout the wall shows, and the Portrait/Landscape buttons in the editor
choose which canvas you are arranging.

## 0.24.2

The layout editor reopens on the orientation you last edited. Portrait and
landscape are each saved on their own, but the editor always opened on
portrait — so after arranging landscape it looked like the change had been
lost. It now reopens where you left it.

## 0.24.1

Template calendars now fill their space and show event names. A month calendar
placed in one of the built-in templates was drawing small in the top of its
box, leaving it mostly empty, and showing only a dot on days with something on.
It now stretches to fill the box, and busy days show the event names on
labelled pills instead of dots.

## 0.24.0

Build your wall exactly how you want it. This turns the display into a canvas
you arrange yourself.

- **Start from a template.** Add a display and choose one of a dozen ready-made
  layouts — two of them look like a Skylight family calendar — or start from a
  blank canvas. Every one previews before you pick it.
- **Arrange it yourself.** Drag anything to move it, pull a corner to resize, and
  add a clock, calendar, weather, the house, a rota, notes, a to-do list, a
  countdown or a picture. Portrait and landscape are arranged separately, and the
  wall draws whichever way the screen is actually hung.
- **Backgrounds.** Give a canvas a solid colour, a gradient, or a photo you
  upload.
- **More ways to show the calendar** — a month with colour-coded event labels, or
  the week as day columns, as well as the grid you already have.
- **Choose a 24-hour or 12-hour clock** on the Display settings.
- Snap-to-grid, a layers list, and a "match this screen's size" button keep
  arranging tidy.

Everything a wall already showed stays exactly the same until you pick a template
or start arranging.

## 0.23.0

The forecast now works anywhere in the world. Alongside the US National
Weather Service, you can choose **Open-Meteo** — it covers the whole world and
needs no account or key — and pick Fahrenheit or Celsius. Set it on the Weather
screen. Existing walls are unchanged; weather alerts are still the National
Weather Service and the United States only.

## 0.22.0

People now colour the calendar. Give a calendar an owner on the Calendars
screen and their events take that person's colour everywhere on the wall — Mum
in blue, Dad in green, the way a family calendar reads at a glance. A strip
across the top shows who's who, and each event carries a small face or their
initials so you can tell whose it is without reading it.

You can also reorder people on the People screen with Up and Down, and that
order is the order they appear across the wall.

## 0.21.1

Nothing changes on the wall. This one exists to prove the update path itself.

0.21.0 was published while two faults in that path were still there: Home
Assistant was told an update existed several minutes before the image did, and
the release run went red after the image had already shipped. Both are fixed,
and a release with nothing in it is the cheapest honest way to prove the fix —
better than finding out during a release that matters.

## 0.21.0

A look of its own, and the groundwork for a screen that wakes itself.

- **Maverick Wall has a mark now.** A month grid with one cell lit — on the
  add-on tile, beside the name in the sidebar and the setup wizard, and on the
  browser tab. Only the picture changes: the wall draws exactly as before.
- **Screens can be told the moment a warning is issued.** The server now offers
  a push channel over your own network, instead of every screen waiting for its
  next check. A wall you open in a browser still checks every minute and still
  gets every alert — this is groundwork for the Android app rather than
  something you will see today.
- **Maverick Wall announces itself on your network**, so a screen can find it
  without anybody typing an address or hunting for a port. The announcement
  stays on your own network and never leaves it, and there is a new **mdns**
  option in the Configuration tab if you would rather it did not.

Nothing you have set up changes, and this release alters no data.

## 0.20.0

Shifts is now **Work Schedule**, and you can shape it to how you actually work.

- **Name your own shifts.** The rigid Days / Mids / Straights are gone — rename
  any shift, pick its colour, mark it working or off, add your own (a Swing, an
  On-call), and reorder them. A new **Shift types** screen holds all of it.
- **Time-off types built in.** One-click **Vacation**, **Sick** and **On-call**
  types you can drop into a rotation.
- **Shift times on the wall.** Give a shift a start and end time (say 07:00–19:00)
  and the wall shows it — so it says *when*, not just *that* someone is working.
- **Edit a rotation.** You can now change a saved rotation instead of removing
  it and starting over.

Your existing rotations and shift colours carry over unchanged.

## 0.19.1

A fix for the previews.

- The live preview in the **theme builder**, and the wall preview in the layout
  editor, no longer draw blown up and cut off — they now show the wall at the
  right size as you work.

Nothing else changes.

## 0.19.0

Build your own theme for the wall.

- **A theme builder.** A new **Themes** screen (under Settings) lets you make
  your own look — a colour for each part of the wall, rounded or sharp corners,
  and a choice of fonts — with a live preview and a note on what each colour
  does. A gentle warning appears if a combination might be hard to read from
  across the room; it never stops you.
- **A choice of fonts, built in.** Six typefaces ship with Maverick Wall
  (nothing is downloaded), so a theme can pick a heading, body, and numbers face
  that actually show on the wall.
- **Use it anywhere a built-in theme goes.** A theme you build is selectable as
  the default for every wall, or for a single screen, right beside the four
  built-in ones (Board, Kitchen Slate, Paper Almanac, Glance).

The four built-in themes are unchanged, and a wall already set up keeps its look.

## 0.18.0

Setting up from the Home Assistant sidebar no longer needs a code.

- **One less step on first run.** When you open Maverick Wall from the Home
  Assistant sidebar for the first time, it goes straight to "Create your
  account" — no more finding a setup code in the add-on log and copying it over.
  Home Assistant has already signed you in, so that is proof enough.
- Running Maverick Wall outside Home Assistant (plain Docker) is unchanged: the
  setup code is still printed to the log and still required, because there is no
  Home Assistant login to vouch for you there.

Nothing changes for a wall that is already set up.

## 0.17.0

A maintenance release — nothing changes on the wall.

Behind the scenes, the process that builds and signs each update is sturdier: a
hiccup while signing an image now retries instead of shipping it unsigned, and
the build stops loudly rather than quietly if an image is ever published without
its signature. There is nothing to do and nothing to relearn.

## 0.16.0

The settings are reorganised so everything lives with the thing it sets.

- **Every wall has its own page.** Open **Displays** and choose a wall — or the
  **Default**, which new screens follow. Its theme, how much it shows, and its
  layout are all there now, on two tabs: **Appearance** and **Layout**. The old
  separate "Display" settings page is gone; what was on it now sets the Default.
- **Weather in one place.** The forecast strip and the National Weather Service
  alerts share a single **Weather** page — set your location once, for both.
- **Your modules in the sidebar.** Everything you have installed shows under
  Modules in the sidebar, so you can jump straight to one; an installed module
  you have switched off is marked.
- **A cleaner, easier-to-read look**, and the Store now shows a small preview of
  what each module draws on the wall.

Nothing about your walls, calendars, people or modules changes — only where the
settings live. Any wall you had set up keeps its own look and layout.

## 0.15.0

The Add-ons screen is now a **Store**.

- **Browse and install from one place.** The **Store** (formerly Add-ons) lists
  modules to add — a countdown, the weather, a price — each installed in a click
  and a couple of fields. Everything you install is shown there too.
- **Simpler by design.** The old "add a module by web address" box and the
  raw recipe editor have moved to an **Advanced** screen, off the everyday path.
  Adding a community catalogue by URL has been removed — the store is now one
  curated list that ships with Maverick Wall and grows over time.

Every module you already installed keeps working, unchanged. If you had added a
community catalogue by URL, that list is no longer shown; the modules you
installed from it are unaffected.

## 0.14.0

Recipes can now use a feed that needs an API key.

- A recipe (a module with no service to host) can carry a **secret** — an API
  key or token. You type it in when you add the recipe, in a masked field, and
  Maverick Wall stores it **encrypted** and sends it only to that recipe's own
  web address, in a request header.
- Your key never appears on the wall, in a log, or in the web address itself,
  and a **community** catalogue can never ask for one — a recipe that needs a key
  is one you add yourself.

Nothing changes for a recipe or module you already added.

## 0.13.0

Add a community catalogue of modules.

- **Catalogues.** On **Add-ons → Browse → Catalogues** you can add a list of
  modules someone else publishes, by its web address. Its modules then appear
  when you Browse, alongside the built-in ones, and you install each the same way.
- It is your choice and stays transparent: Maverick Wall checks the address every
  few hours for its list and nothing more. It sends nothing about your household,
  and a catalogue can **never** make a module reach your own network — one that
  asks for that is refused outright.

Turn a catalogue off or remove it any time; your installed modules stay.

## 0.12.0

Install a recipe straight from the catalogue.

- The **Browse** list now includes **recipes** — modules with no service to host —
  alongside services, each tagged so you can tell them apart. Choose a recipe and
  you get a simple form: fill in its settings (a latitude, a station id) and press
  **Add to the wall**. No pasting anything.
- A first recipe ships to try: **Outside temperature**, which shows the current
  temperature where you live from a free, key-less public weather feed — install
  it, enter your latitude and longitude, done.

A recipe is still data, never code: it reads a public web feed over a secure
connection and shows a value from it, and nothing else.

## 0.11.0

Recipes can now raise an alert.

- A **recipe** — a module with no service to host, that reads a public web feed —
  can now show a **banner** or **take over the wall** when something in that feed
  becomes true: a river gauge, a service-status page, a disruption notice. You
  give it a plain rule for when to fire and what to say.
- As with any module, it stays **off until you turn it on**: a recipe's alerts
  use the same **Alerts** setting on the Add-ons screen, Off by default. A recipe
  can never wake a screen that has gone dark, and its alert clears on its own
  once the feed says the thing is over.

Nothing changes for a recipe or module you already added until you turn its
alerts on.

## 0.10.0

Browse modules to add, and add ones with no server to run.

- **Browse the catalogue.** The Add-ons screen has a new **Browse** button with
  a list of modules to choose from. Pick one and it shows you how to run it and
  fills its address in for you — nothing is added until you do it yourself.
- **Recipes — a module with nothing to host.** Choose **Add a recipe** to put a
  value from a public web feed on the wall — a price, a tide time, a countdown —
  with no service of your own to run. You give the feed's address and how to draw
  it; Maverick Wall does the fetching on a timer. A recipe is **data, never
  code**: it can pull out fields and format them, and nothing else. It reaches
  the public internet over a secure connection only, unless you deliberately
  point it at a service on your own network.

Every module, recipe and wall you already have is unchanged.

## 0.9.0

An add-on module can now raise an alert on the wall.

- A module you have added can show a **banner**, or **take over the whole wall**,
  when something it reports becomes true. It is **off until you say so**: each
  module has an **Alerts** setting on the Add-ons screen — Off by default — where
  you choose whether it may show a banner or take over.
- Whatever a module shows, you can always clear it from the wall, and a module
  can **never wake a screen that has gone dark** for the night. That is kept for
  genuine safety alerts, like severe weather.
- A module's alerts are only ever about that module — they can never set off your
  weather alerts, and one module can never speak for another.

A module you already had on the wall shows no alerts until you turn its Alerts
setting on.

## 0.8.0

Place an add-on module anywhere on a wall.

- A module's panel can now be added to a **free-form layout** as a widget, not
  just stacked below the calendar. Add a **Module** widget on the Layout editor,
  choose which of your add-ons it shows, and drag it wherever you like.

Nothing changes for a module you already had on the wall.

## 0.7.0

Add-ons: put a panel from another service on the wall.

- A new **Add-ons** screen lets you register a small module that runs on your own
  network — a bin-day countdown, fuel prices, anything — by pasting its address.
  Maverick Wall reads it every few minutes and draws it beside the calendar, and
  **never runs anything the module sends**: it only ever shows a few simple
  shapes (a reading, a number, a strip, a line of text), never a web page.
- Each module shows whether it is working, and can be turned off or removed. A
  module that stops answering keeps its last panel and says it went quiet.
- A module only ever supplies values to show. It never receives your calendars,
  your Home Assistant token, or anything else about your household.

For developers: the module contract is written up in
`docs/rfc-001-module-framework.md`.

## 0.6.0

A countdown for the wall, and a light mode for the settings.

- **Countdown widget.** Add a countdown to any free-form layout — “135 days ·
  Christmas” — with a name and a date. It counts from the server’s clock, so it
  stays right even on a screen whose own clock has drifted, and reads “Today” on
  the day.
- **Light mode for the settings.** The admin now has **Auto / Light / Dark**,
  chosen from the sidebar. Auto follows your device. It only changes the
  settings pages; the wall keeps its own themes.

## 0.5.0

Weather is easier to set up, and shows that it is working.

- **Use your Home Assistant home location.** A button fills the forecast’s
  latitude and longitude from Home Assistant’s own home zone, so there are no
  coordinates to look up. It only reads the location — Maverick Wall never
  writes to Home Assistant.
- **See the forecast on the settings page.** The current five-day forecast and
  when it was last updated now show right where you turn it on, so you can tell
  it is working instead of guessing.
- A small fix: the “how much to show” numbers below the weather settings now
  save reliably.

The manual latitude and longitude are still there if you prefer them, and the
forecast remains United States only.

## 0.4.0

Choosing Home Assistant readings is far easier.

- The entity picker is now a **searchable, filterable list** instead of one long
  drop-down. Search by name, filter by kind (sensors, locks, people, covers, and
  so on), and see each entity’s **current value** as you browse.
- **Pick several at once** and add them together; the ones you have chosen show
  as removable tags. Adding a single reading can still give it your own name.

It works with no calendar-address hunting and reads Home Assistant only — the
wall still receives resolved values, never a way to reach back into your house.

## 0.3.0

Designing a wall is now one place, and each widget can be set up on its own.

- **Screens and Layout are joined into one “Displays” section.** Click a
  display and you get everything about it on a single page — whether it is
  online, its pairing, how it is hung, its theme, and its layout — instead of
  hopping between two screens.
- **Each widget on a free-form layout has its own settings.** A Calendar widget
  can show a month grid or an upcoming list, limited to the calendars you pick
  and a number of events. A Home Assistant widget can show just the readings you
  choose rather than every one. So ten sensors no longer means ten on the wall.
- **And its own look.** Give any widget a title, align its text, and put a
  background behind it — a colour, a transparency, rounded corners, a shadow.
- **Stack widgets front to back** with Send to back / Bring to front, and the
  order you set is the order the wall draws.
- **The layout preview is the wall.** It now shows exactly what the screen will
  draw — the stacked layout when the free-form layout is off, your arrangement
  when it is on — so there are no surprises after you save.

Every existing wall is untouched until you change it.

## 0.2.2

Fixes the buttons on the Screens page.

- **Unpair** and **Show pairing link** led to a "not found" page when the
  settings were opened through the Home Assistant sidebar or a reverse proxy.
  Both buttons work again wherever the settings are opened from.

## 0.2.1

Setting up a wall screen is far less fiddly.

- A screen with no camera — most **televisions** — can now be paired by
  **typing a short code**. Open Maverick Wall on the screen itself, enter the
  code shown on the Screens page, and it pairs. No more reading a long web
  address off one screen and thumbing it into another with a remote.
- The add-on now **works out its own address**. It asks Home Assistant which
  port your wall screens should connect on and fills the pairing address in for
  you, so there is far less to get exactly right by hand — and if the display
  port is turned off, the Screens page says so plainly instead of handing you a
  link that goes nowhere.
- The **wall display port is on by default**, so a fresh install already has
  somewhere for screens to connect without digging through the Network
  settings.

If a screen was already paired, nothing changes.

## 0.2.0

A new look for the settings.

- The admin has been redesigned around a fixed **sidebar** and an **Overview**
  dashboard: at-a-glance cards for your calendars, screens and shifts, and the
  status of Weather, Home Assistant and the system, so you can take in the whole
  wall from one page. Every screen now wears the wall's own dark, amber "Board"
  look, with clearer cards, headings and status pills throughout.
- The settings carry their own **typeface** instead of fetching one from the
  internet, so they read the same offline and nothing is loaded from anywhere
  outside the add-on.
- Nothing you have set up changes — the same calendars, screens, shifts and
  layouts, in a clearer place.

## 0.1.9

Each wall can now be set up on its own.

- The settings are grouped into **Modules** (Calendars, Shifts, Weather, Home
  Assistant), **Walls**, and **Settings**, instead of one long list — and the
  pages are wider, since they open in the full window.
- A **wall switcher** on the Layout page lets you design each screen
  separately: pick a wall and arrange its own layout, set its orientation,
  theme and how much it shows — all in one place, with a live preview of that
  wall. Leave a wall alone and it follows the shared default.
- The Screens page is now just for pairing a screen; its settings moved to the
  wall's own page.

Existing walls are unchanged: every setting is the shared default until you give
a wall its own.

## 0.1.8

A face for the project, and easier navigation.

- Maverick Wall now has an icon and a logo, so it shows up properly in the
  sidebar and the add-on store instead of a nameless placeholder. The same mark
  appears on the settings pages and in the browser tab.
- The settings gained a row of tabs — Calendars, Display, Layout, People,
  Shifts, Screens, Home Assistant, Weather, System — so you move straight from
  one section to the next instead of going back to a menu each time.

## 0.1.7

Explains the options on the Configuration page.

- `base_url` and `ingress_trust_source` now have a label and help text on the
  add-on's Configuration tab, instead of showing as bare keys. `base_url` says
  to give the full address — scheme and port, like `http://192.168.1.33:8080`.
  `ingress_trust_source` says to leave it blank unless the add-on log tells you
  otherwise.

## 0.1.6

Fixes a crash when `base_url` was set to a bare address.

- Setting `base_url` to just an IP — `192.168.1.33` rather than
  `http://192.168.1.33:8080` — stopped the add-on from starting. It now adds
  the missing `http://`, boots, and prints a line reminding you to include the
  host port the add-on was mapped to. A value it still cannot make sense of
  falls back to the default instead of refusing to start.
- Give `base_url` the full URL — scheme and port — for wall-screen pairing to
  hand out a link a tablet can reach.

## 0.1.5

Adds a free-form layout: arrange widgets on the wall yourself.

- A new **Layout** screen lets you place widgets anywhere — add a Clock,
  Calendar, Weather, Home Assistant or Shift widget, drag it to move, pull the
  corner to resize. The preview shows the real wall as you arrange it, not a
  mock-up. Turn it on to use your layout instead of the stacked one; leave it
  off and nothing changes.
- Widgets are first-party only, by design: there is no web-page or video tile,
  because the wall does not run third-party content. A layout scales to any
  screen resolution of the shape you author it at, and works in a rotation.
- Every existing wall is untouched until you turn a layout on.

## 0.1.4

Stops asking you to sign in to the settings when you open them from the Home
Assistant sidebar — Home Assistant has already authenticated you there.

- The sidebar settings now accept your Home Assistant login. This is only
  granted when the request genuinely comes from the supervisor, checked by its
  network address and not by any header a device on your network could send, so
  it cannot be used to reach the settings from anywhere else. Every case of
  doubt falls back to the normal login.
- If the default is wrong for your install, the add-on log's first
  `[ingress] first request from …` line shows the address it saw and whether it
  was trusted. Set it with the new `ingress_trust_source` option if that line
  reads `trusted supervisor source: no`. A wrong or empty value only ever means
  you still sign in — it can never open the settings to anything it should not.
- Wall displays are unaffected: a screen on the port still pairs with its own
  token, and never uses a Home Assistant login.

## 0.1.3

Lets you pair a wall screen from the sidebar, with no shell.

- The Screens page now has an "Add a screen" button. Before this the only way
  to pair the first screen was a command-line tool, which an add-on has no way
  to run — a sidebar is not a shell.
- The pairing link now points at an address a screen can actually reach. When
  generated through the sidebar it uses the `base_url` you set, rather than
  Home Assistant's own internal address, which is reachable from inside Home
  Assistant and nowhere a tablet on the wall lives. If `base_url` is unset the
  page says so plainly instead of handing over a link to localhost.

  Set `base_url` in the Configuration tab to this box's address on your
  network — like `http://192.168.1.10:8080` — before you pair a screen.

## 0.1.2

Makes the Home Assistant add-on start. Under 0.1.1 it installed and then
refused to start with "/data is not writable by this container".

- The supervisor creates the add-on's data directory itself, owned by root,
  and there is no setting anywhere that changes that. The image ran as a
  normal user and so could not write its own database — the one thing the
  add-on had no way around. The container now takes ownership of the directory
  at startup and then drops to that user before running anything, so it is
  still unprivileged the moment it touches a calendar feed.
- The "not writable" message, when it does still appear, now names the actual
  cause — a read-only mount, or a `--user` that cannot be helped — instead of
  advising a `chown` that does not apply under the supervisor.

## 0.1.1

Fixes the install. 0.1.0 could not be started by the command in its own
documentation.

- The container owns its data directory, so a named volume works with no
  setup. In 0.1.0 that directory belonged to root while the application runs
  as a normal user, and it stopped on the first line with a permission error.
- Home Assistant: the `base_url` option now does something. It sets the
  address wall displays are given when you pair them; left unset a pairing
  link says `localhost`, which is nowhere from a tablet on a wall.
- Removed the `log_level` option. It controlled nothing.

## 0.1.0

First release.

- The wall: today, the week ahead and a month grid, in portrait or landscape,
  with per-screen rotation for a panel mounted on its side.
- Calendars from ICS feeds and from Home Assistant calendar entities.
- Shift rotation, per person, from a pattern or derived from a calendar.
- A few Home Assistant readings beside the calendar. Read-only, always.
- National Weather Service alerts, with a shipped ladder from a banner to a
  full-screen takeover that can wake a dark screen.
- Draws from a stored copy when the server is unreachable, and says how old it
  is.
