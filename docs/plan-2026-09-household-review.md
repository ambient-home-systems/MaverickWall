# Implementation plan: the September 2026 household review

**Status: planned, nothing started.** The owner reviewed every admin screen and
the browser wall and raised eleven points. An evaluation followed, then the
owner took decisions, then widened the weather scope. This document is every fix,
bug, enhancement and design change that came out of that, in the order it
should be built.

Nothing here has been implemented. Line numbers were read on `main` at
`5af6ed2` (release 0.66.0) and will drift. Treat them as a starting point for a
search, not as an address.

**How to read an item.** Each one has an ID (`P1.3`), what is wrong or wanted,
the cause where there is one, the change, the files, the tests, and what "done"
means. Sizes are relative: **S** is one focused session, **M** is two or three,
**L** is a phase of its own.

**Discipline.** The same bar as everything else in this repository
(`CLAUDE.md`, "Verification is the job"):

- Measure the computed value, never the class name.
- Check every new assertion by reverting its fix and watching it go red.
- Change a ratchet's baseline only in the same commit as a measured,
  explained change.
- Run `pnpm test`, which builds first.

The two density ratchets, `wall-density` and `browser-classic-proportions`,
must not move for a wall that has not opted into anything new.

---

## Contents

- [Decisions already taken](#decisions-already-taken)
- [Open questions, with proposed defaults](#open-questions-with-proposed-defaults)
- [Phase 0: rules and documentation](#phase-0-rules-and-documentation)
- [Phase 1: bugs](#phase-1-bugs)
- [Phase 2: admin consistency](#phase-2-admin-consistency)
- [Phase 3: richer weather data](#phase-3-richer-weather-data)
- [Phase 4: shared groundwork for widget styles](#phase-4-shared-groundwork-for-widget-styles)
- [Phase 5: widget styles](#phase-5-widget-styles)
- [Phase 6: wallpapers](#phase-6-wallpapers)
- [Traceability: every request to its items](#traceability-every-request-to-its-items)
- [Tests expected to change](#tests-expected-to-change)

---

## Decisions already taken

Decided by the owner on 2026-09-24. Several of them reverse rules written in
`CLAUDE.md`; Phase 0 rewrites those rules **before** any code lands.

| ID | Decision | Consequence |
|---|---|---|
| D1 | A big-number weather style is allowed. | The "no stat tiles" design rule gains an exception for designed widget styles. |
| D2 | Gradients are allowed on screen. | `apps/display/DESIGN.md`'s "zero gradients" lines are rewritten. Twelve templates already ship canvas gradients. |
| D3 | The closed icon set may be opened for occasion motifs. | On browser walls occasion artwork can be emoji (D6). Drawn black-and-white motifs for e-paper are deferred. |
| D4 | A Home Assistant tile-card look is adopted. | The four "not competing with Lovelace" statements in the code are amended. Hard rule 12 is **unchanged**, so tiles show state and never control anything. |
| D5 | The Store's Countdown entry is kept and renamed. | See P1.1. |
| D6 | The "no emoji" rule is dropped for browser walls (weather and countdown named explicitly). | Emoji are drawn from bundled artwork so every screen shows the same picture (P4.2). E-paper keeps drawn icons. |
| D7 | The "no animation" rule is dropped for browser walls (weather and countdown). Confetti is explicitly allowed for countdown. | Animation is phase-locked to the wall clock so the 15-second rebuild does not restart it. It is scoped behind reduce-motion and a per-wall switch (P4.3). E-paper stays still. |
| D8 | The "no shadow" rule is dropped for browser walls (weather named explicitly). | Shadows become a theme token that a theme or an e-ink preset can switch off (P4.4). |
| D9 | Weather gets current conditions and whatever else is needed for richer data, from whatever source is necessary. | Phase 3. |

---

## Open questions, with proposed defaults

Nobody has decided these yet. Each has a default this plan builds unless the
owner says otherwise.

| ID | Question | Proposed default |
|---|---|---|
| Q1 | Calendar "full grid lines" and "weekend shading" conflict with "a month cell is not a card". | Build neither until decided. The other calendar styles (P5.4) do not need them. |
| Q2 | Week views learning to draw shifts: `showShifts` absent means *on*, so every week wall already hanging would suddenly light up. | On week views shifts draw only when `showShifts === true` is explicitly set. Month and list keep "absent means on". |
| Q3 | Which emoji artwork set to bundle? | Twemoji (graphics CC-BY 4.0: attribution only). OpenMoji is CC BY-SA 4.0, whose share-alike terms are heavier. |
| Q4 | Blur (`backdrop-filter`) behind widgets on wallpapers? | Still excluded (`DESIGN.md` "no blurs"). Use a flat ground (P6.3). |
| Q5 | Air quality on by default? | Off. It contacts a new host, so switching it on is the consent, as the update check does. |
| Q6 | Motion on by default per wall? | On. Motion only exists in styles a household picks, and reduce-motion is always respected. E-ink presets default it off. |
| Q7 | Which new styles an e-paper panel honours? | Stated per item below. The rule of thumb: honour what reads in one bit, fall back to the default look otherwise. |
| Q8 | Which extra Home Assistant domains to watch, read-only? | `light`, `switch`, `input_boolean`, `fan`, `cover`, `lock`, `climate` (P5.3). |
| Q9 | Emoji a household types itself (in a countdown title): bundled font or device font? | Device font. A bundled colour font only after it is tested on the oldest supported tablet (P4.2). |
| Q10 | Wallpaper count and categories. | 26 across the categories in P6.2. |

---

## Phase 0: rules and documentation

This comes first. Otherwise the next session reads the old rules and
reintroduces the bans.

### P0.1 Rewrite the design rules the decisions reverse (S)

- **`CLAUDE.md`, "Design rules: do not reintroduce":**
  - **Emoji:** permitted on browser walls, drawn from the bundled artwork set
    (P4.2), never resolved from the device's own emoji font in a designed
    style. Still forbidden anywhere an e-paper panel draws. `no-emoji.test.ts`
    keeps guarding the panel paths.
  - **Transition and animation:** permitted on browser walls, and only:
    - phase-locked to the wall clock (P4.3), so the 15-second rebuild cannot
      restart it;
    - inside `prefers-reduced-motion: no-preference` and the wall's Motion
      switch;
    - animating `transform` and `opacity` only.

    E-paper panels are always still. The admin's existing motion rule is
    unchanged. `motion.test.ts` and `motion-scope.test.ts` are rewritten to
    enforce this scope rather than a ban.
  - **Shadow:** permitted on browser walls through a theme token. A theme, or
    an e-ink screen preset, may set it to none. The reasoning about e-ink
    banding and OLED burn-in stays in the text as the reason the token exists.
  - **Stat tiles:** a designed widget style may carry one large reading (the
    weather "Today" card, the countdown number) under a ratio cap in the clock's
    manner. A dashboard row of tiles is still out.
- **"The design file" and "Current state":** add a short paragraph recording
  D1–D9 with the date, so the narrative does not contradict the rules.
- **`apps/display/DESIGN.md`:**
  - Rewrite 327–337 and 412 ("zero shadows, gradients, or blurs"). Shadows and
    gradients are permitted. Blur stays out (Q4).
  - Amend the lines at 386 and 408 that say every glyph is `currentColor`. A
    colour weather style (P5.1) may paint glyphs from theme tokens.
  - Amend the stat-tile guidance at 127 and 413 (D1).
- **The closed icon set:** say where it is documented (`glyphs.ts` header, the
  Store entry's comment in `catalog/countdown-example.ts`) that D3 opened it for
  occasion motifs, and that wall occasions use emoji artwork.

**Done when** no sentence in `CLAUDE.md` or either `DESIGN.md` forbids something
D1–D8 allow, and every rewritten rule names the test that now enforces it.

### P0.2 Stale comments found during the review (S)

Each of these describes code that no longer exists. Fix them in the item that
touches the file, or all at once here.

- `apps/server/src/http/admin-chores.ts:561-564` and `:610` say "Add a chore" is
  in the app bar. It is not.
- `apps/server/src/http/admin.ts:6884` says `'add'` is the fragment the empty
  state links to. The empty state has no action.
- `apps/server/src/http/html.ts:3109-3112`: `page()`'s doc example ("Add a
  calendar" in the app bar) describes what Calendars deliberately does not do.
- `apps/server/src/http/html.ts:2930`: "A group's tab goes to its first page".
  Groups render no tab strip.
- "Solid colour or gradient" comments that predate image backgrounds:
  - `apps/server/src/db/schema.ts:191-198`
  - `apps/server/src/http/html.ts:1738`
  - `apps/display/src/layout-editor.ts:739, 2452`
  - `apps/server/src/api/widget-schema.ts:369-374`
  - `apps/server/src/api/manifest.ts:521-522`

  Update them again in P6 when wallpapers become a fourth kind.

---

## Phase 1: bugs

Each is small and independent.

### P1.1 Store "Source" link opens an error page (S): request 3

- **Cause:**
  - The Countdown card's **Source** link (`apps/server/src/http/admin-modules.ts:640-643`)
    and the prefill card's **Where to get it** link (`:462-465`) have no
    `target`.
  - Inside the Home Assistant sidebar the admin runs in an iframe, so the link
    navigates that frame to GitHub. GitHub answers `X-Frame-Options: deny` and
    `frame-ancestors 'none'` (verified with `curl` during the review), and the
    browser shows "github.com refused to connect".
  - The URL itself is live (200). Opened on the add-on's own port the link works.
- **Change:** `target="_blank" rel="noopener noreferrer"` on both. They are the
  only absolute outbound links the admin renders.
- **Rename the Store entry (D5).** In `apps/server/src/catalog/countdown-example.ts`:
  - `name` becomes "Countdown (example module)".
  - The description says plainly that it is a developer example that runs as
    its own small program (`node server.mjs`), so a household is not surprised
    that "Install" needs a server address. It should also point to the built-in
    Countdown widget for the everyday case.
  - The card's mark becomes the bundled hourglass (⏳) once P4.2 lands. The
    entry's own comment laments that the closed set had no hourglass. Until
    then it keeps `pressure`.
- **Tests:**
  - A crawl over every admin page (the `admin-origins.test.ts` pattern): every
    `href` starting `http://` or `https://` carries `target="_blank"` and a
    `rel` containing `noopener`.
  - `external-modules.test.ts` updated for the new name.
- **Done when** the link opens a new tab from inside the sidebar and a new
  absolute link without `target` fails the build.

### P1.2 A Shift widget set to two people shows one (M): request 5

- **Cause:** the manifest, the picker and the resolver all keep both people.
  - Manifest: `apps/server/src/api/manifest.ts:1482-1540`, tested at
    `manifest.test.ts:483`.
  - Picker: the checkbox list at `apps/display/src/layout-editor.ts:4526-4543`.
  - Resolver: `shiftWidgetView` at `apps/display/src/widget-options.ts:76-90`.
  - The second person is lost in the tier pass in `apps/display/src/render.ts`:
    - `tierShift` (around 2173–2201) picks the tier from the **whole** box as if
      it held one badge, then draws a full badge **per person**, stacked by
      `.fw-shift.is-several` (`display.css:2716-2720`).
    - `beltShift` then calls `beltItems` (around 2343–2357), which hides every
      item ending below the box except the first.
    - Classic's shift box is 9% of the height in portrait (`templates/classic.ts:73, 86, 150, 168`),
      exactly one badge tall, so person two is always hidden.
  - `stampTier(entry.box, tier, view.entries.length)` also tells the editor two
    are showing.
- **Change:**
  1. Choose the tier per badge: `(inner.h - gap × (n − 1)) / n`.
  2. When `n > 1` and a full badge does not fit per person, draw **every**
     person in the one-line form (`shiftLineBadge`, `render.ts:210-227`). That
     is exactly what the e-paper panel already does (`epaper/widgets.ts:543-551`).
  3. Stamp the count of badges actually visible after the belt.
- **Optional:** RFC 014 §4.2 lists a shift `line` variant ("the ladder's own
  one-rung form as a choice"). Once P4.1 exists it is nearly free, and it gives
  a household with a small box a deliberate two-people-on-one-line look.
- **Tests:**
  - A new `browser-*` file: a paired Classic wall with **two** rota people,
    both `.shift-badge` elements visible (computed `display`, and inside the box
    by rectangle) at 1080x1920 and 1920x1080.
  - The visible-count stamp read back.
  - Mutation check: revert the per-badge height and watch it go red.
- **Done when** both people are on the glass in the shipped Classic box.

The calendar has the same "first person only" fault (`viewmodel.ts:1345`
`day?.shifts[0]`, `render.ts:471`). It is fixed in P5.4, because it needs a
design for two people in one cell.

### P1.3 Home Assistant "Add to the wall" adds nothing to a wall (M): request 10

- **Cause:** `POST /admin/home-assistant/entities` (`apps/server/src/http/admin-ha.ts:753-784`)
  only adds the entity to the watched list, then says "Reading added."
  - A reading is drawn only by a **Home Assistant widget** on a wall's canvas.
  - Classic, which every wall starts on, has none. Only the Command Center and
    Ops Dashboard templates do.
  - The section above the picker is titled "On the wall" (`admin-ha.ts:1516`),
    which is equally untrue.
- **Change:**
  - Relabel:
    - The picker button (`apps/display/src/ha-entity-picker.ts:206`) becomes
      "Add reading" / "Add N readings".
    - The `<noscript>` fallback (`admin-ha.ts:1560`) becomes "Add reading".
    - "On the wall" becomes "Your readings".
    - The saved message in `http/saved.ts` (`ha-entity-added`) becomes true to
      what happened.
  - **Say where each reading is shown.** Each row says either "On: Kitchen,
    Hall" or "Not on any wall yet". This is worked out server-side from every
    wall's canvases (both orientations and every named layout): a
    `homeassistant` widget whose `readings` is empty (meaning all) or includes
    this reading.
  - When **no** wall shows readings at all, a card at the top explains that a
    wall needs a Home Assistant widget, and links to each wall.
  - The Store's recipe install button, "Add to the wall"
    (`admin-modules.ts:710`), has the same fault: it installs a module and
    places nothing. It becomes "Install", with the same "not on any wall yet"
    guidance on the module's row.
- **Related bug, fixed in the same item: readings are chosen by label.**
  - The widget stores `readings` as **labels** (`api/widget-schema.ts:230`;
    `render.ts:419-422`). Renaming a reading therefore silently drops it from
    every widget that picked it.
  - Fix, modelled on the to-do widget:
    - Store the entity id in the widget's config on the server.
    - Rewrite it to an opaque handle in `displayConfig` on the way out; the
      `todoListHandle` pattern already exists.
    - Key the manifest's readings by the same handle.
  - The display still never sees an entity id (hard rule 12).
  - Back-compatibility needs no migration: at read time an entry that matches
    a current label is treated as that entity, and the editor writes handles
    from then on.
- **Tests:**
  - Rendered-page assertions for the new copy.
  - The "shown on" computation against real walls, including a named-layout slot.
  - `homeassistant.test.ts`: the manifest still carries no entity id, with a
    readings-filtered widget placed.
  - Renaming a reading keeps it on the widget.
  - `admin-vocabulary` must stay green.
- **Done when** no button or heading on the Home Assistant or Store screens
  claims something reached a wall that did not.

### P1.4 Overview buttons point at a retired page (S): found during the review

- `apps/server/src/http/admin.ts:1467-1468`: "Edit what shows" and "Arrange
  layout" link to `admin/walls/default`, which now redirects to System.
- **Change:** point them at the walls list. With exactly one wall, point
  straight at that wall's page and its Layout tab.
- **Test:** crawl the Overview's links and assert none resolves to a redirect.

### P1.5 "eInk" and "e-paper" both in use (S): request 4, vocabulary half

- The owner saw "Add an eInk panel". The current build says "e-paper" in most
  places and "eInk" in others: `saved.ts:130` ("eInk wall removed."), the
  preview's `alt` at `admin-epaper.ts:1358`, and `admin-ha.ts:1719`.
- **Change:** "e-paper" everywhere a household reads it. The ESPHome config's
  `name: eInk source` (`admin-epaper.ts:306`) is a device-config identifier
  rather than copy; leave it unless it is visible as a label.
- **Test:** add "eInk" to `admin-vocabulary`'s retired set with a zero
  allow-list. The button text itself is P2.2.

---

## Phase 2: admin consistency

### P2.1 One place for "Add", everywhere (L): request 1

**Today.** Themes is the only screen with its create action in the app bar
("New theme", `admin-themes.ts:357`). Walls has a row of three buttons under
the header (`admin-walls.ts:302-307`). The four Household pages (Calendars,
People, Work Schedule, Chores), Shift types, and most Home Assistant screens
carry an inline add form at the **bottom** of the page.

The last arrangement was deliberate. `admin.ts:6751-6762` records that a filled
"Add" in the app bar competed with the form's own filled "Add" on the same page:
two main buttons for one act.

**The rule this plan adopts:**

- A list page's **only** create action is one button in the app bar's
  top-right slot (`pageHeader`'s `action`, `components.ts:56-76`).
- That button always opens a **dedicated add page**, never a scroll.
- A list page carries no add form, which removes the objection above: there is
  one main button because there is one form, and it is elsewhere.
- Empty states link to the same add page.
- **One verb:** "Add a calendar", "Add a person", "Add a theme", with a short
  form ("Add calendar") if the 390px app bar needs it, **measured** rather than
  guessed.

| Screen | Today | After |
|---|---|---|
| Calendars (`calendarsPage`, `admin.ts:6672`) | Add form, CalDAV `<details>` and HA rows at the bottom (6821–6886, 6508–6574, 6577) | App bar "Add a calendar" → `/admin/calendars/new`, a **chooser**: an iCal or web address, an iCloud or CalDAV account, or from Home Assistant. The HA option is shown when connected; otherwise it explains that connecting is a way in. The RFC 013 "Google and iCloud through Home Assistant" section moves there |
| People (`peoplePage`, `admin.ts:4219`) | "Add someone" at the bottom (4301–4317) | App bar "Add a person" → `/admin/people/new` |
| Work Schedule (`shiftsPage`, `admin.ts:3695`) | "Add a rotation" at the bottom (3750–3816) → POST `admin/shifts/new` → `draftPage` | App bar "Add a rotation" → GET `/admin/shifts/new` (step 1 as a page), step 2 unchanged |
| Shift types (`admin-shifts.ts:229`) | Two add forms at the bottom (247–293); a body link "← Work Schedule" (243) | App bar "Add a shift type" → `/admin/shifts/types/new`, with the common presets on that page; the way back becomes the header's back link |
| Chores (`admin-chores.ts:535`) | "Add a chore" at the bottom (575–612) | App bar "Add a chore" → `/admin/chores/new` |
| HA · Readings (`admin-ha.ts:1452`) | Picker in the second section | App bar "Add readings" → `…/readings/new` (the picker page) |
| HA · Calendars (`admin-ha.ts:1610`) | Form at the bottom | App bar "Add a calendar" → `…/calendars/new` |
| HA · To-do lists (`admin-ha.ts:1671`) | Form at the bottom | App bar "Add a list" → `…/lists/new` |
| HA · Tell me when… (`admin-ha.ts:1753`) | Form and template rows at the bottom | App bar "Add a rule" → `…/alerts/new`, with the templates on that page |
| HA · Connection | Not a collection | Unchanged |
| Walls (`admin-walls.ts:278`) | Three buttons under the header | App bar "Add a wall" → `/admin/walls/new`, a **chooser**: browser wall or e-paper wall (P2.2). "Approve a pairing code" becomes a secondary link in the page intro and on the chooser |
| Themes (`admin-themes.ts:297`) | "New theme" in the app bar; "Generate from a colour" form at the bottom (369–388) | App bar "Add a theme" → `/admin/themes/new`; "Generate from a colour" moves onto that page |
| Store / Advanced / Add a recipe / Install (`admin-modules.ts:473, 551, 694`) | The app bar's filled action used for **"Back to…"** links | Those become the header's `back` link. The action slot is only ever "Add". Store cards keep "Install" per card, which is not a page-level create |
| Wall and panel editors | "+ Add widget" in the Layout toolbar | Unchanged (an editor, not a list) |

**Details that must survive the move:**

- **Echo on 400 moves with each form.** The add page re-renders itself with the
  body echoed, as every form does today. Error messages sit above the form.
- **`savedRedirect`** returns to the list page with the existing tokens, so the
  strip still confirms.
- **The dirty-form guard and `data-dirty`** apply on the add pages unchanged.
- **Old `#add` fragments** (`/admin/chores#add` in `browser-admin.test.ts`,
  `advanced?install=…#add` in `external-modules.test.ts:426`) are
  updated. A stale bookmark lands on the list page, which is harmless.
- **Relative links only,** so the single `<base>` keeps working under ingress.
- **`pageHeader`** gets a test for `action` (none exists:
  `admin-components.test.ts:214-248` covers crumb and back only). The test
  asserts the action is an `<a class="btn …">` to a `…/new` route.

**Tests to rewrite** (they pin today's placement and must be changed
deliberately, each with a sentence saying why):

- `admin-walls-list.test.ts:199-235`
- `add-display-parity.test.ts:200-211`
- `admin-saved.test.ts:740-748`
- `browser-calendars.test.ts:263+` ("no app-bar Add competing with the form")
- `feed-credential-forms.test.ts:378-394`
- `admin-calendars.test.ts:847-854`
- `ha-screens.test.ts:224-231`
- `browser-ha-phone.test.ts:62-73` (re-measure the first control at 390px)
- `browser-admin.test.ts:904, 954`
- `external-modules.test.ts:426`
- `wall-editor.test.ts:184`
- `admin-vocabulary.test.ts`: the crawl must reach every new add page,
  including conditional sections.

**Also add** a test that walks every list page in the nav and asserts that each
has exactly one app-bar action, labelled `Add …`, linking to a `/new`-style
route, and **no** inline create form in its body.

**Done when** every collection screen has its create action in the same place
with the same verb, and the phone measurements are re-taken.

### P2.2 Walls: one door, matching names (S, rides on P2.1): request 4

| | Browser wall | E-paper wall |
|---|---|---|
| Button today | "Pair a browser wall" | "Add an e-paper panel" |
| Heading today | "Pair a new wall" (`admin.ts:5309`) | "Add an e-paper wall" (`admin-epaper.ts:619`) |
| Final button today | "Add wall" | "Create" (`admin-epaper.ts:722`) |

Both the verb and the noun differ.

- **Change:**
  - The chooser offers "Add a browser wall" and "Add an e-paper wall", each with
    one line saying what it is: a tablet or television showing a web page, or
    an ESPHome or OpenDisplay panel.
  - Headings match the choice.
  - Both final buttons read "Add wall".
  - "Pair" is reserved for the step that pairs a browser (the QR and link page).
- **Tests:** `admin-walls-list`, `add-display-parity` and `admin-vocabulary`
  updated. The parity test also asserts the two headings and the two final
  buttons use the same words.

### P2.3 Weather: find the location without knowing coordinates (M): request 2

- **Today** (`apps/server/src/http/admin-alerts.ts:530-580`):
  - Latitude and longitude text fields, with a hint to long-press in a phone
    map app.
  - "Use my Home Assistant home location" is a script-free `formaction` button
    that only appears when Home Assistant is connected (566–574).
- **Change:**
  1. **Find a place.** Add a "Town, city or postcode" field and a **Look up**
     submit (`formaction="admin/weather/find-place"`, script-free, like the HA
     button).
     - The server calls Open-Meteo's key-less geocoding service
       (`https://geocoding-api.open-meteo.com/v1/search?name=…&count=5&format=json`)
       through the SSRF-guarded fetcher (public https only).
     - The response is parsed with Zod, one result at a time, so one odd entry
       does not cost the rest.
     - The page re-renders with the whole form echoed, plus up to five matches
       as radio choices ("Springfield, Illinois, United States").
     - **Use this place** (`formaction="admin/weather/use-place"`) writes the
       chosen coordinates **and saves the rest of the form**. It uses the same
       narrower schema `use-ha-location` uses, so it cannot fail on a
       half-typed coordinate.
     - The failure sentences are "no place by that name", "the lookup service
       is not answering right now" and "type a town first". None is a bare error.
     - A hint names the host the typed text is sent to.
  2. **The Enter-key trap.** The form's first submit is `defaultSubmit()`
     (Save), so Enter in the place field would **save** and ignore the place.
     The Save handler must treat "place typed, no coordinates" as a lookup.
     There must be a test for exactly this; the weather page has already had
     one data-loss bug through implicit submission.
  3. **Use this device's location** (progressive enhancement).
     - A button rendered `hidden`, which the settings script reveals only when
       `window.isSecureContext && 'geolocation' in navigator`.
     - It fills both fields and marks the form dirty.
     - It will not appear on plain-http LAN installs (most Docker installs), and
       probably fails inside the Home Assistant sidebar iframe (no
       `allow="geolocation"`). That is fine as long as it stays hidden rather
       than broken.
  4. **Home Assistant not connected:** one line saying that connecting it adds a
     one-click option, linking to the connection screen.
  5. **Keep the number fields**, for fine-tuning. A city's centre point can fall
     in the neighbouring county, and US alert zones are worked out from the
     point. The hint should say so.
- **Tests:**
  - The parser against a real Open-Meteo geocoding response committed as a
    fixture (reachable from CI, and captured during the review).
  - The route through the app with an injected fetcher, the pattern the weather
    provider tests use: lookup, choose, saved coordinates.
  - The echo keeps unsaved fields.
  - Enter in the place field.
  - "No results" and "service down" sentences.
  - A browser test that the device-location button stays hidden on http.
- **Done when** a household with no coordinates and no Home Assistant can set
  a location by typing their town.

---

## Phase 3: richer weather data

Decision D9. It lands before the weather styles, because two of them need it.

### What each source provides

During the review, Open-Meteo was checked live. NWS refused requests from the
cloud environment (Akamai 403), so its fields were confirmed from the real
responses already committed at `apps/server/test/fixtures/nws-points.json` and
`nws-forecast.json`. The station-observation document is not among them and must
be captured from a home network (P3.6).

| Data | Open-Meteo (worldwide) | NWS (US) |
|---|---|---|
| Current: temperature, feels-like, condition, humidity, wind and gusts, day or night, UV | `current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,cloud_cover,uv_index` (15-minute interval) | The nearest station's `/stations/{id}/observations/latest`, from `observationStations` in the points document. Temperature is often `null`, so fall back to the first `forecastHourly` period. The values are SI units and must be converted. Feels-like is `windChill ?? heatIndex ?? temperature` |
| Hourly, next 24 h | `hourly=temperature_2m,precipitation_probability,weather_code,is_day` | `forecastHourly` (its URL is in the cached points document) |
| Daily rain chance | `precipitation_probability_max` | `probabilityOfPrecipitation.value` on the day and night periods; take the higher |
| Daily rain amount | `precipitation_sum` (set `precipitation_unit`, or it answers in mm) | Only in the grid data (`forecastGridData`), so left absent for NWS |
| Daily wind | `wind_speed_10m_max` | Period `windSpeed` strings ("5 to 10 mph"): parse the maximum |
| Daily UV | `uv_index_max` | Not offered, so absent |
| Sunrise and sunset | `daily=sunrise,sunset` | Not per day (`astronomicalData` is today's only). Calculate instead (P3.3) |
| Longer text | None | `detailedForecast`, and the existing `shortForecast` (`summary`), which the wall currently **drops** (`weatherFrom`, `viewmodel.ts:907-944`) |
| Air quality (optional) | `air-quality-api.open-meteo.com/v1/air-quality?current=us_aqi,european_aqi,pm2_5,…`; pollen in Europe only | None. Use Open-Meteo's for both |

### P3.1 The data model (M)

All new fields are **optional and spread**: a source that cannot supply one
leaves it out, never sends `null`. The rule is the one already used for
`layoutGutter`: an absent field is what keeps the manifest and its ETag
byte-identical for a household that gains nothing.

```ts
// modules/weather: WeatherPanel gains
current?: {
  observedAt: number;            // ms; when it was measured or modelled
  source: 'observed' | 'modelled';
  temp: number; feelsLike?: number;
  condition: string;             // words: "Light rain", "Mostly cloudy"
  glyph: GlyphKey | null; isDay: boolean;
  humidity?: number; windSpeed?: number; windGust?: number;
  windDir?: string;              // compass point, "NW"
  uv?: number;
};
hourly?: Array<{ at: number; temp: number; glyph: GlyphKey | null; isDay: boolean; precipChance?: number }>; // next 24
units?: { temp: 'F' | 'C'; wind: 'mph' | 'km/h'; precip: 'in' | 'mm' };
air?: { aqi: number; scale: 'us' | 'eu'; label: string; observedAt: number };

// ForecastDay (nws.ts:28-44) gains
precipChance?: number; precipAmount?: number; windMax?: number; uvMax?: number;
sunrise?: string; sunset?: string;   // local ISO time
detail?: string;                      // NWS detailedForecast
```

- **Condition words.** Open-Meteo gets a WMO-code-to-words table beside
  `glyphForCode` (`open-meteo.ts:34-48`). NWS uses the observation's
  `textDescription`.
- **Units** follow the existing `weather_units` setting (imperial or metric).
  Open-Meteo needs `wind_speed_unit` and `precipitation_unit` set explicitly.
- **Where it is parsed:**
  - `open-meteo.ts`: widen `forecastUrl` (60–75) and the document schema
    (56–65).
  - `nws.ts`: widen `nwsPeriod` for `probabilityOfPrecipitation`, `windSpeed`
    and `detailedForecast`, and let `pointsDocument` read `forecastHourly` and
    `observationStations`.
  - A new `nws-observations.ts` for the station reading.
  - Every schema uses per-field `.catch`, as today.

### P3.2 Fetch cadence and caching (M)

- **Split the job:**
  - Today the weather job fetches once an hour (`modules/weather/index.ts`,
    `intervalMs: 60 * 60_000`).
  - It becomes a 15-minute job that decides per part what is due, from each
    cache row's `expiresAt`:
    - current conditions every 15 minutes;
    - hourly and daily every 60 minutes;
    - air quality every 60 minutes, and only when switched on.
  - A module has one `job`, so the scheduling lives inside it.
- **Request budget:**
  - Open-Meteo: current, hourly and daily in **one** request, about 96 a day,
    far inside the free non-commercial limit. Air quality adds 24 a day to a
    second host.
  - NWS: the station observation every 20 minutes, plus `forecast` and
    `forecastHourly` hourly.
  - The station list is resolved once and cached like `nws:point`
    (`nws:stations`), and re-resolved only when the coordinates change.
- **Cache keys** are namespaced per provider and part: `openmeteo:current`,
  `nws:hourly`, and so on, so switching provider never reads the other's rows.
- **Keep-last-good per part.** A failed refresh of one part leaves the others
  and its own old copy.

### P3.3 Sunrise and sunset, calculated (S)

- A pure `modules/weather/sun.ts` implementing the NOAA solar-position
  algorithm. It takes date, latitude, longitude and zone, and returns local
  sunrise and sunset. There is no `Intl` inside; the zone offset is passed in,
  like `packages/core`'s interrupts.
- It is used for NWS days, and as the source of `isDay` whenever a provider
  omits it. Open-Meteo's own values are preferred when present.
- **Tests:** within ±2 minutes of Open-Meteo's answer for a spread of latitudes
  and dates, including a polar edge (no sunrise), and against the NWS
  `astronomicalData` fixture.

### P3.4 Staleness and fallback (S)

- Current conditions older than **90 minutes** are not presented as "now". The
  panel omits `current`, and styles fall back to today's high and low (P5.1).
- An NWS observation with `null` temperature, or older than 90 minutes, falls
  back to the first `forecastHourly` period, with `source: 'modelled'`.
- The existing six-hour forecast note is kept.

### P3.5 E-paper frames must not churn (M)

- **The problem:**
  - A panel's frame ETag hashes the **whole** manifest
    (`apps/server/src/epaper/frame.ts:239`, `manifestEtag(manifest)`).
  - `current` changing every 15 minutes would move every paired panel's ETag
    every 15 minutes, **including panels with no weather on them**, and a
    battery panel would full-refresh on each wake.
  - Home Assistant readings already cause some of this. Weather would make it
    universal.
- **Change:**
  - Build a panel's preimage from the manifest **minus**
    `panels.weather.current`, `panels.weather.hourly` and `panels.weather.air`,
    unless that panel's canvas holds a weather widget whose variant draws them
    (P5.1).
  - Better, and worth doing if it is not much harder: hash only the panel slices
    the panel's widgets read.
- **When a panel does draw current conditions,** it labels them with their
  time ("52° at 07:15"), because a panel may sleep for an hour.
- **Tests:** the same panel's ETag is unchanged across two manifests that differ
  only in `current`, and changed when its canvas has a weather widget drawing
  current conditions. Pinned byte-identical frames stay identical.

### P3.6 Real fixtures (S)

- **Open-Meteo:** capture a full forecast (current, hourly and daily) and an
  air-quality response from the live API (reachable from CI and from the review
  environment).
- **NWS:** capture `observations/latest`, `forecastHourly`, a `/stations` list,
  and an observation with a `null` temperature, **from a home network**.
  - NWS's CDN refused the cloud container outright, so fixtures cannot be taken
    from there.
  - Record where and when each was captured in the fixture directory, as the
    CalDAV `real/` fixtures do.
- Every parser test reads real bytes. Invented fixtures are only for the
  hostile cases (a wrong type, a missing array).

### P3.7 The display reads it (S)

- `weatherFrom` (`apps/display/src/viewmodel.ts:907-944`) reads the new fields
  defensively. An older bundle ignores them.
- `WeatherDayModel` (260–281) gains the per-day fields, a new
  `CurrentWeatherModel` is added, and `summary` is carried rather than dropped.
- `epaper/widgets.ts`'s `forecastDays` (around 755–779) reads the same fields
  for the panel styles that honour them.
- The calendar's list view (`showWeather`) may show the day's rain chance beside
  the day's numbers. That is optional and follows the list view's density rules.

### P3.8 Settings (S)

- **Weather page:** an "Air quality" switch, which needs a migration adding an
  additive `air_quality_enabled` column that defaults off (Q5). The switch
  names the second host it contacts.
- **Provider choice:** the "Forecast from" select explains what each provider
  offers (NWS: US only, observed conditions; Open-Meteo: worldwide, modelled
  conditions, UV).

### Out of scope, recorded

- Weather **alerts** outside the United States. Open-Meteo has none; MeteoAlarm
  (Europe, CAP/Atom) would be a later module-sized addition.

---

## Phase 4: shared groundwork for widget styles

Phase 5 is built on this.

### P4.1 Widget styles ("variants") for every type, not just the clock (M)

- **Today:**
  - One `variant` enum for every type (`api/widget-schema.ts:176-192`,
    `plain | stacked | analogue`).
  - The clock's own allowlist resolves it (`apps/display/src/clock-face.ts:36-43`).
  - The editor's Look picker returns early for anything but a clock
    (`layout-editor.ts:3926-3947`, the `if (widget.type !== 'clock') return;`
    at 3927).
- **Change:**
  - Extend the one enum with the new values:
    - weather: `strip`, `today`, `range`, `colour`, `playful`
    - countdown: `number`, `page`, `ticket`, `occasion`, `progress`, `month`
    - homeassistant: `list`, `tile`
    - calendar: `planner`, `bold`

    A value a type does not know is still "not for me", drawn as that type's
    default.
  - A new `apps/display/src/variants.ts` holds one allowlist and one label
    table per type, generalising `clockVariant`. A server transcription
    `epaper/variants.ts` is held character-identical by a parity test, the
    `tier-parity` and `clock-face-parity` pattern.
  - `buildLookField` reads the per-type table. With more than three options it
    becomes a small grid of labelled choices rather than a segmented control.
  - Per-variant control pruning follows `buildClockConfig`'s pattern
    (4463–4482): a variant hides the controls it does not use.
  - **Honours:** for each type, decide whether the panel honours `variant`
    (P5.x per item). `epaper-ink.test.ts`'s `PROBES` (245–248) gains every new
    value, so the tables are still proved by rendering.
  - `inkOverrideBody` already picks `variant` for every type (`widget-schema.ts:325`).
    `INK_LANE` gains `variant` for each type whose panel honours it.
- **Tests:**
  - Unit tests per allowlist, including a foreign value reading as the default.
  - The parity test.
  - The editor offers exactly the type's variants.
  - `epaper-ink` closure stays green.

### P4.2 Bundled emoji artwork (M): D6 and D3

- **Why:**
  - The image ships no emoji font, so each device draws its own maker's
    artwork: iPad, Samsung and Fire tablets all differ, and some old Linux
    kiosks draw empty boxes.
  - An e-paper panel's font covers ASCII only, so emoji vanish there.
- **Change:**
  - Ship a curated subset (about 150) of Twemoji SVGs (Q3) under
    `apps/server/assets/emoji/`, served from `/assets/emoji/<name>.svg` with
    immutable caching, following the fonts pattern (`http/static.ts`,
    `Dockerfile`, the boot check).
  - SVG served from our own origin and drawn as `<img>` runs no script, and
    `img-src 'self'` already permits it.
  - The manifest carries **keys**, never code points. Designed styles use an
    `emojiNode(key)` helper that draws `<img alt="…">`.
  - The curated set covers weather conditions, occasions, advice lines, the
    countdown picker, and the Store hourglass.
- **Emoji a household types itself** (a countdown title) render with the
  device's own font (Q9). A bundled colour font is a later step, only after it
  is measured on the oldest supported tablet (COLRv0 and COLRv1 support differs
  across old Safari and WebView).
- **Licensing:** a `LICENSES.md` beside the artwork (per the fonts precedent)
  and a `NOTICE` line. CC-BY 4.0 needs attribution.
- **`no-emoji.test.ts`:**
  - Narrow its scope to the e-paper renderer and its tests (`apps/server/src/epaper/**`).
  - Keep `asciiTitle` as the panel's guard.
  - Add an assertion that designed wall styles draw emoji as bundled `<img>`,
    never as text code points, so the device font does not creep back in.
- **Offline:** the service worker caches `/assets/*` at runtime in a secure
  context. On http the HTTP cache covers it.

### P4.3 Motion that survives the 15-second rebuild (M): D7

- **The trap:** `draw()` empties and rebuilds the whole wall every 15 seconds
  (`apps/display/src/render.ts:3157`, `root.textContent = ''`;
  `TICK_MS = 15_000` in `main.ts:108`). Any CSS animation restarts on every
  tick.
- **Change:**
  - **Looping effects** (clouds drifting, snow falling, balloons floating): a
    pure `motion.ts` helper `phaseDelay(durationMs, wallNowMs)` returns
    `animation-delay: -(now mod duration)`. The rebuilt element resumes exactly
    where the old one was, so the loop is continuous.
  - **One-shot effects** (confetti on the day, a page flip at midnight, a
    split-flap change):
    - A per-widget memory in `main.ts`, keyed by widget id plus the event key
      (for example the target date).
    - It uses the same mechanism as the to-do widget's error sentence, which
      already survives redraws.
    - An effect fires once per event, not every tick. A celebration may replay
      on a fixed cadence (hourly), stated in the widget's help.
  - **Scope:**
    - Every `@keyframes` and `animation` declaration sits inside
      `@media (prefers-reduced-motion: no-preference)` and under
      `.canvas[data-motion="on"]`.
    - Only `transform` and `opacity` are animated.
    - Particle counts are capped, and 2D only, for old tablets.
  - **Per-wall Motion switch:** an additive `screens.motion` column (null means
    on, Q6) on the wall's Device and time pane. The e-ink presets of the
    wall-size picker default it off. `main.ts` stamps `data-motion`.
  - E-paper panels draw each style's still frame.
- **Tests:**
  - Rewrite `apps/display/test/motion.test.ts` and
    `apps/server/test/motion-scope.test.ts` to enforce the scope rather than a
    ban: no animation outside the scoped block, and keyframes touching only
    `transform` and `opacity`.
  - Keep the admin half of `motion-scope` as it is.
  - A browser test: an animated element's computed animation time is
    continuous across a redraw (read before and after a tick).
  - A one-shot does not refire on the next tick.
  - `sw-shell.test.ts` still passes once the new modules are in `main.ts`'s
    import graph.

### P4.4 Shadows as a theme token (S): D8

- `--shadow-card` per built-in theme in `apps/display/src/theme.ts`, transcribed
  to `api/builtin-themes.ts` (the parity test covers it). Values:
  - Panels and Household: a soft shadow.
  - Blueprint and Swiss: none.
  - Almanac: a paper-like one.
- Custom themes derive a default, and the theme builder gains a "Shadows: none /
  soft" control.
- The widget `shadow` config is **honoured again**:
  - `applyWidgetFormat` (`render.ts:1755-1785`) stopped reading it.
  - The schema still accepts it, so walls that stored `shadow: true` light up
    as intended.
  - The Style tab's control is restored.
- The e-ink presets set the token to none. It stays in `PANEL_IGNORES`.

### P4.5 New theme tokens for the new styles (M)

- Add these tokens to all five built-in themes and to custom-theme derivation
  (`customTokens` and `withTints`, kept as mirrors):
  - **Weather condition colours:** `--wx-sun`, `--wx-cloud`, `--wx-rain`,
    `--wx-snow`, `--wx-storm`, `--wx-fog`.
  - **Temperature scale:** `--temp-cold` … `--temp-hot`, as three or four stops.
  - **Home Assistant state:** `--state-active`, `--state-alert`, `--state-idle`.
  - **Occasion accents:** handled per style in P5.2.
- Each token that paints text or a glyph over a ground is contrast-checked
  against that theme's ground, the way `--ink-scaffold` is.
- Sky-gradient palettes (P5.1) are tokens too, so a custom theme can restyle
  them.

---

## Phase 5: widget styles

RFC 014 §4.2's rule holds: each variant is designed, measured on paired
1080x1920 and 1920x1080 walls (nothing clipped, tabular figures, role sizes),
and checked on a panel exactly as the honours table says. One widget per
session.

### P5.1 Weather: five styles (L): request 6, D1 D2 D6 D7 D8, needs P3 and P4

| Variant | Look | Data it needs | Panel |
|---|---|---|---|
| `strip` (default, absent) | Today's strip, unchanged | — | Honoured (today) |
| `today` ("iOS widget") | A large current temperature (the lede, capped against the rest the way the clock is: D1). Below it the condition words, feels-like, and high and low. Then a row of the next hours (P3 `hourly`) or, in a short box, the next days as one line. A **sky gradient** keyed on glyph and `isDay` (clear day blue, clear night indigo, cloudy grey, rain slate, snow pale, storm deep violet), from tokens. A soft card shadow. Optional ambient motion per condition (clouds drift, rain streaks, snow falls, sun glow): phase-locked, and still under reduce-motion. With no `current` (P3.4) it degrades to today's high and low as the lede | `current`, `hourly`, sunrise and sunset | Honoured: a 1-bit version with the large temperature and its "at HH:MM" stamp, no gradient |
| `range` ("iOS 10-day") | One row per day: name, glyph, rain chance, low, a **range bar** spanning the week's minimum to maximum, filled cool to warm from the temperature tokens, then high. A dot marks the current temperature on today's bar when present | Daily only (rain chance optional) | Honoured: bars in black, no gradient |
| `colour` | Today's strip with glyphs painted in condition colours (`--wx-*`) and temperatures tinted on the temperature scale. Two-tone glyphs (a sun behind a cloud) need the glyph paths split into named parts, a change in `glyphs.ts` only; the e-paper cells are unaffected | — | Falls back to `strip` |
| `playful` | A large bundled emoji per condition (☀️ ⛅ 🌧️ ⛈️ ❄️ 🌫️ 💨) that floats or bobs gently, big day names, and an **advice line** in plain words with an emoji: "Umbrella day ☔" (rain chance ≥ 50%), "Coat weather 🧥" (high below 10°C / 50°F), "Shorts weather 🩳" (high ≥ 24°C / 75°F), "Sunscreen 🧴" (UV ≥ 6), "Windy 💨" (≥ 30 km/h) | Rain chance, UV, wind | Falls back to `strip` |

- **The advice rules** live in a pure `apps/display/src/weather-advice.ts` with
  table-driven tests. The thresholds are stated in both unit systems.
- **Tiers:**
  - Each variant gets its own table in `widget-tiers.ts`; `WEATHER_TIERS`
    (138–143) stays the strip's.
  - `today` gives up the hourly row, then feels-like, then the condition words,
    and keeps the lede.
  - `range` gives up days from the bottom, then the rain chance, then the glyph.
- **The panel falls back per value while honouring per key:**
  - `variant` joins `PANEL_HONOURS.weather`.
  - `drawWeather` (`epaper/widgets.ts:781`) draws `today` and `range` and maps
    the other two to the strip.
  - The ink lane offers only `strip`, `today` and `range`.
  - `epaper-ink` probes all five.
- **Editor:**
  - The Look picker shows the five.
  - `today` hides the day count.
  - `playful` shows an "Advice line" switch.
- **Tests:**
  - One `browser-weather-<variant>` file per variant, with real fixture data
    from P3.
  - A `today` wall with `current` removed shows the fallback lede.
  - Motion is scoped and continuous (P4.3).
  - Emoji are `<img>` from `/assets/emoji/` (P4.2).
  - The panel frames for the honoured variants.
  - Classic's ratchets unmoved (Classic uses `strip`).

### P5.2 Countdown: styles, occasions and a celebration (L): request 8, D3 D6 D7

- **Today:**
  - `title` and `target` only (`widget-schema.ts:231-235`).
  - `renderCountdownWidget` (`render.ts:1524-1549`).
  - No tier table: it sizes by `--buw`/`--buh` (`display.css:2751-2803`).
- **New config**, all optional and absent by default:
  - `from`: a start date, used by `progress`. Validated `from < target`,
    rejected rather than coerced.
  - `unitWords`: `days` (default) or `sleeps` ("12 sleeps until Christmas").
  - `emoji`: a key from the bundled set, shown with the title. The picker is
    the curated grid.
  - `occasion`: `christmas`, `birthday`, `halloween`, `vacation`,
    `schools-out`, `new-year` or `custom`.
  - `celebrate`: default on.

| Variant | Look | Motion | Panel |
|---|---|---|---|
| `number` (default) | Today's number, unit and label, plus the optional emoji and "sleeps" wording | None | Honoured |
| `page` (tear-off calendar) | The count on a drawn calendar page with a binder strip and the target's month and day | The page flips **once**, when the count changes at midnight (one-shot) | Honoured, still |
| `ticket` (boarding pass) | The destination (the title) large, "Departs in 12 days", a perforated rule, and departure-board digits | The digits flip only when the number changes (one-shot) | Honoured, still |
| `occasion` | The number styled for the occasion: an accent pair from tokens, an emoji motif, and an ambient loop. Christmas 🎄: falling snow. Birthday 🎂: rising balloons. Halloween 🎃: drifting leaves. Vacation 🏖️: sun and waves. School's out 🎒: paper planes. New Year 🎆: fireworks | Phase-locked loop | Falls back to `number` |
| `progress` | A bar of days gone from `from` to `target`, with the count and the percentage | Fills on change, one-shot | Honoured: a 1-bit bar |
| `month` | A small month with the target date circled and today marked, plus the count | None | Honoured: 1-bit mini month |

- **Celebration:** on the target day every variant shows "Today! 🎉". When
  `celebrate` is on, it plays a **confetti** burst once, then again at most once
  an hour (one-shot memory, P4.3). After the target it keeps today's "N days
  ago".
- **Tiers:** the new variants get `COUNTDOWN_TIERS` per variant (the mini month
  and the ticket have content to give up). `number` keeps the `--buw`/`--buh`
  mechanism, so an existing countdown is pixel-identical.
- **Editor:**
  - The Look picker lists the variants.
  - An occasion picker appears for `occasion`, and a start date for `progress`.
  - The emoji picker grid, and a "Celebrate on the day" switch.
  - Today the Format tab hides Title for a countdown (`layout-editor.ts:3825-3827`);
    the title is edited in Content, as it is now.
- **Panel:** `drawCountdown` (`epaper/widgets.ts:412-438`) draws the honoured
  variants, and emoji are stripped (`asciiTitle`). `INK_LANE.countdown`
  (currently `[]`) gains `variant` and `unitWords`.
- **Tests:**
  - A `browser-countdown-<variant>` file per variant.
  - The celebration fires once, not per tick.
  - `from ≥ target` is refused with a sentence.
  - `sleeps` wording.
  - The panel frames.
  - A countdown with no new keys stays byte-identical on the wall and the panel.

### P5.3 Home Assistant tile cards (L): request 11, D4

**Data (server).** Everything is computed server-side, and the display still
never receives an entity id or a token.

- **An `active` flag per reading.** In `toReading`
  (`modules/homeassistant/entities.ts:275-287`), add `tone: 'active' | 'alert' | null`
  to `EntityReading` (254–263), from a per-domain and per-device-class table:
  - binary_sensor door, window, garage_door or opening: on is `alert` (open).
  - lock: unlocked is `alert`.
  - moisture, smoke, gas, safety or problem: on is `alert`.
  - motion, occupancy or presence: on is `active`.
  - person or device_tracker: home is `active`.
  - light, switch, fan or input_boolean: on is `active`.
  - cover: open is `active`.
  - climate: heating or cooling (`hvac_action`) is `active`.
  - sensor and weather: `null`.
  - Tested table-first.
- **`changedAt`.** `HaState.lastChangedAt` already exists (`entities.ts:62-71`)
  but only reaches `signals()`. Carry it, so a tile can say "Open · 5 min ago".
  The relative time updates on each tick, and the manifest only changes when
  the state does.
- **Watch more domains, read-only (Q8).**
  - Widen `SUPPORTED_DOMAINS` (`entities.ts:26-32`, today `sensor`,
    `binary_sensor`, `weather`, `person`, `device_tracker`) with `light`,
    `switch`, `input_boolean`, `fan`, `cover`, `lock` and `climate`.
  - `readState` (208–244) humanises each ("On · 60%", "Open · 40%",
    "Heating · 21°").
  - The cache stores an **allowlist** of attributes per domain, not just
    `device_class` (`modules/homeassistant/index.ts:284`): light `brightness`,
    cover `current_position`, climate `current_temperature`,
    `temperature` and `hvac_action`, fan `percentage`.
  - Reading a state is a GET. Hard rule 12 governs service calls, so it is
    untouched: `HA_SERVICES` stays exactly two members, and `ha-write-boundary`
    must stay green.
- **Glyphs** for the new domains (a bulb, a power switch, a fan, blinds, a
  thermostat) join the vocabulary (D3). Each is drawn three times (wall,
  server/admin, 1-bit) with the glyph-parity test.

**Display.**

- `variant: 'tile'` for `homeassistant` (`list` stays the default). Each reading
  is a rounded tile:
  - The glyph in a filled circle coloured by `tone` (`--state-active`,
    `--state-alert`, `--state-idle`), the name, and the state line with its unit.
  - Optionally "· 5 min ago".
  - Optionally a **read-only bar** for brightness, position or fan speed: the
    tile card's "features" row, displayed and never interactive.
- **Options** (widget config, all optional):
  - `tileLayout`: horizontal or vertical.
  - `hideState`.
  - `showChanged`.
  - `showBar`.
- **The grid** is the box's own: `HOUSE_TILE_TIERS`, in characters and ems of
  the name role, decides columns and how many tiles fit. Tiles flow; nothing is
  scaled.
- **Style:**
  - A soft shadow (P4.4), overridable through the style lane.
  - A per-reading icon override is optional: a glyph picker on the Readings
    screen, stored server-side like the label.
- **Not built, and the widget's help says so:**
  - Toggles, sliders and tap actions (hard rule 12).
  - Entity pictures, which would put a Home Assistant address on the wall.
- **Amend the four "not competing with Lovelace" statements** (D4):
  - `db/schema.ts` (`haEntityCache.displayMode`)
  - `modules/homeassistant/entities.ts:11-16`
  - `apps/display/src/render.ts:397-399`
  - `apps/display/src/display.css:824-832`
- **Panel:** `drawHouse` (`epaper/widgets.ts:982`) draws tiles as outlined
  rounded boxes, with the circle filled for `active` and `alert` and the text
  knocked out. `variant` joins `PANEL_HONOURS.homeassistant`.
- **Tests:**
  - `homeassistant.test.ts`: the manifest has no entity id, token or base URL,
    now with new domains and tiles.
  - The tone table.
  - Attribute allowlisting (an unlisted attribute never reaches the cache).
  - `ha-write-boundary` unchanged.
  - `browser-ha-tile.test.ts`: tiles fit their box at both sizes, the circle
    colour is **computed** per tone, and the bar width matches brightness.
  - The panel frames.
  - A `list` widget byte-identical to today.

### P5.4 Calendar: shift styles, two people, week views, and more looks (L): request 7

- **What exists:**
  - A shift switch exists: "Show work schedules" (`layout-editor.ts:4312-4321`).
  - It appears on Month and List only. It is hidden on Week because neither
    week renderer draws shifts at all (`render.ts:1906-1934`, `3440-3473`;
    comment at `layout-editor.ts:4303-4310`).
  - There is one look: the whole cell tinted plus a coloured top rule
    (`.hz-cell.has-shift`, `display.css:1239`). Swiss uses the rule only
    (1769); compact uses the fill only (1954). The list view uses an edge plus a
    text chip.
  - `HorizonCell.shiftCode` is built (`viewmodel.ts:248, 1369`) and **never
    drawn**.

**1. `shiftStyle`**, beside the switch, with `showShifts: false` still the off
switch:

| Value | Look |
|---|---|
| `tint` (default, absent) | Today's fill and rule |
| `label` | The short code as text **in the date line**, beside the numeral in `.hz-top` (`render.ts:647-649`), so it costs no row: "Nothing that annotates an event costs it a row". The list view keeps its chip |
| `edge` | A coloured rule along the cell's top or left, with no fill |
| `dot` | A small disc beside the numeral |

**2. Two or more people** (the calendar half of request 5):

- `HorizonCell` gains `shifts: Array<{ token, color, code, initial }>` in place
  of the single `[0]` (`viewmodel.ts:1345`). The agenda row stops at `[0]`
  (`render.ts:471`).
- How each style shows several people:
  - `label`: "A·D B·N" by initial.
  - `tint`: the top rule split into segments, one per person, with the fill
    taken from the first.
  - `dot`: one dot per person, up to three.
  - `edge`: segments.
  - The agenda draws one chip per person.
- The legend (`legendFor`, `render.ts:985-1004`) is unchanged.
- The test comment at `viewmodel.test.ts:832` ("only the month grid cannot")
  is rewritten.

**3. Week views draw shifts** in the column head: a tint, label, edge or dot per
the same style. Per Q2 they draw only when `showShifts` is set true
explicitly, so no hanging week wall lights up. The switch is then shown on
every view.

**4. More looks:**

- **`todayStyle`:** ring, fill, or numeral (the Swiss accent numeral).
- **`monthHeading`:** large, small or hidden.
- **`eventMark`** (text mode): colour dot, colour bar, or coloured text.
- **`gridLines`:** week rules (today's default, absent) or none. A full grid
  is the deferred half (Q1).
- **Calendar `variant`:**
  - `planner`: paper ground, ruled week lines, Fraunces numerals.
  - `bold`: heavy numerals, high-contrast rules.

  Both are built from tokens and the style lane.
- **Deferred (Q1):** full grid lines and weekend shading.

**5. The month filter.**

- The month grid ignores the `calendars` picker; the editor offers it only on
  Week and List (`layout-editor.ts:4373-4407`; the month branch returns before
  `render.ts:1863`). The panel ignores it on the month too, so the two agree
  today.
- Offer "Which calendars" on Month as well, applied the same way in both
  renderers.
- Per-calendar `show_in_grid` stays the household-wide switch.

**6. Orphaned keys.**

- `showTimes` and `showLocations` are in the schema (`widget-schema.ts:104-105`)
  and in `PANEL_IGNORES` (`honours.ts:207-209`), but no control writes them and
  the wall never reads them.
- Either implement them on the list view, if the manifest carries locations (a
  "Show locations" switch), or record them as accepted-and-ignored. Do not
  delete them from the `.strict()` schema, which would refuse any stored config
  that has them.

**Density.** Every new mark must be proved to cost no event its row:

- `tiers.ts` budgets.
- `wall-density` and `browser-classic-proportions` unmoved for a wall on
  defaults.
- A measured wall with `label` on names the same events as with `tint`.

**Panel:**

- `EpaperGridCell` (`epaper/viewmodel.ts:97-117`) gains shift codes.
- `drawMonthBox` (`epaper/render.ts:462`) draws `label` in 1 bit.
- `showShifts` and `shiftStyle` move to `PANEL_HONOURS.calendar` for `label`,
  with a sentence that the other styles are colour and fall back to `label`.
  **Or** they stay in `PANEL_IGNORES` if the label does not fit a 7.5" cell;
  decide by rendering.

**Tests:**

- `browser-calendar-shift-styles` at both sizes, per style, with two rota people.
- Week views draw only when opted in.
- The month filter on both renderers.
- `epaper-ink` probes.
- `calendar-view-parity` if view resolution changes.
- The ratchets.

---

## Phase 6: wallpapers

Request 9. D2 allows gradients.

### P6.1 A fourth kind of background (M)

- **What exists (RFC 005 Phase 3/3b):** a canvas background is `solid`,
  `gradient` or an uploaded `image`:
  - `backgroundSchema`, `api/widget-schema.ts:378-392`
  - `parseBackground`, `api/manifest.ts:524-567`
  - `backgroundCss`, `apps/display/src/render.ts:2402-2411` (`cover`,
    applied at 2941–2945)
  - the editor's `drawBackgroundPanel`, `layout-editor.ts:2455-2531`
  - per orientation, per wall, falling back to the household value
    (`api/queries.ts:674-675`)
- **Change:** add `{ type: 'wallpaper', id: <catalogue id> }` in four places:
  `backgroundSchema`, `parseBackground`, the display's `CanvasBackground`
  (`apps/display/src/manifest.ts:17, 206-207`), and `backgroundCss`.
  - The id is checked against the catalogue.
  - An unknown id is dropped (rule five, reject rather than coerce), and the
    canvas falls back to the theme's ground (rule nine).
- **Serving:**
  - `apps/server/assets/wallpapers/`, served at `/assets/wallpapers/<name>` with
    `public, max-age=31536000, immutable`, following the fonts route
    (`http/app.ts:401-402, 2040-2052`).
  - Content-hashed file names, so an updated picture is a new URL.
  - `http/static.ts`'s `CONTENT_TYPES` gains `.jpg` and `.jpeg` (today only
    `.png` among images), and `SAFE_NAME` stays slash-free.
  - A `WALLPAPERS_DIR` beside `FONTS_DIR`, the `Dockerfile` copy, and the
    boot-time directory check.
  - The CSP already allows same-origin images (`img-src 'self' data:`).
  - The service worker caches `/assets/*` at runtime.
- **The editor preview** runs under the admin's `<base>`, so it needs the
  relative/absolute base split the media store already has (`'admin/media/'`
  vs `/d/media/`). `admin-asset-urls.test.ts` covers that class of 404.
- **Redraw cost:** the canvas background is re-set on every 15-second rebuild.
  Measure decode and paint on a low-end tablet with the largest size.

### P6.2 Making 20–30 wallpapers (L)

- **Generate them, don't license them.**
  - A committed, seeded generator: `scripts/wallpapers/generate.mjs`, beside
    `docs/brand`'s build scripts.
  - Each wallpaper is a parametric SVG built from a seed, rasterised by the
    bundled headless Chromium to **JPEG** (old kitchen iPads cannot show WebP).
  - They are our own work, so there is no stock-photo licence question (stock
    licences often forbid redistribution in a bundle). They can be regenerated
    or edited by changing a seed.
- **Two sizes:** a long edge of about 1600px and about 2880px.
  - The renderer picks by the canvas's pixel size.
  - Each is square and **composed with no focal point near the edges**, so
    `cover` crops one master cleanly to portrait and landscape.
  - Each has an optional per-wallpaper focal position for `background-position`.
- **Budget:** about 10–15 MB on a 437 MB image. A test pins the directory's
  total size, so growth is a decision rather than drift.
- **Proposed set (26, Q10):**
  - soft gradients: 4 dark, 3 light
  - paper, linen and watercolour textures: 4, light
  - contour lines: 2 dark, 1 light
  - geometric (Bauhaus shapes, terrazzo, grid): 3
  - landscapes (layered hills, dunes, dawn sky, dusk sky): 4
  - seasonal (autumn, winter, spring, summer): 4
  - fun (confetti, night sky with stars): 2
- **Metadata per wallpaper:** id, name, `tone: 'light' | 'dark'`, a dominant
  colour (the `background-color` while it loads and the fallback), the focal
  point, and the suggested themes.
- **Licensing:** a `LICENSES.md` in the directory stating "generated by
  `scripts/wallpapers`, project licence", plus a `NOTICE` line, per the fonts
  precedent.

### P6.3 Keeping text readable over a picture (M)

- **The gap:** every contrast guarantee in the display is measured against a
  flat `--bg` (`--ink-scaffold`'s 4.5:1, the tints, `contrast-guidance.ts`).
  Nothing measures text over an image, and blur remains out (Q4). Widgets are
  transparent by default (`.fw`, `display.css:2398-2441`), so today text sits
  straight on the picture.
- **Changes:**
  1. **Tone matching.** The picker offers wallpapers whose `tone` matches the
     wall's theme: dark for Panels and Swiss, light for Household, Almanac and
     Blueprint. "Show all" reveals the rest with a warning. This is RFC 015
     §3.6's argument that a background is authored for its theme.
  2. **Widget ground.** A wall setting, "Widget ground: None / Soft / Solid",
     defaulting to Soft when a wallpaper is set.
     - Soft is the theme's `--panel` at a high opacity. Solid is `--panel`
       opaque.
     - A theme-aware replacement for the widget "Card background" default, which
       today is hard-coded `#111820` whatever the theme (`layout-editor.ts:2475,
       2491, 3869`). That default is fixed in the same change.
  3. **A contrast test per wallpaper.** Sample each JPEG's lightest and darkest
     regions. With the Soft ground's opacity composited over them, assert that
     the matching themes' `--ink` and `--ink-scaffold` still reach 4.5:1. A new
     wallpaper that fails does not ship.
- **Burn-in:** lean dark and low-contrast. The OLED concern that motivated the
  shadow rule is real for bright static pictures. The picker marks
  high-luminance wallpapers "not for OLED screens".

### P6.4 The picker (M)

- `drawBackgroundPanel` gains **Wallpaper**, beside None, Solid, Gradient and
  Image: a grid of thumbnails (small JPEGs shipped with the set), filtered by
  tone as in P6.3.
- Applied per orientation, with "use for both" as the default action.
- Templates may name a wallpaper; `templateCanvasSchema.background` already
  accepts a background.
- **E-paper** never draws a canvas background (nothing under `epaper/` reads
  it). That is stated in the panel's settings rather than added to a
  widget-keyed honours table.
- **Tests:**
  - A `browser-wallpaper` file at both orientations: the wallpaper covers the
    canvas, the ground paints behind each widget, and the computed contrast
    holds.
  - A missing file falls back to the theme's ground (rule nine).
  - A manifest with an unknown id draws the theme's ground.
  - The size budget.
  - The stale "solid or gradient" comments (P0.2) now say four kinds.

---

## Traceability: every request to its items

**The owner's eleven points:**

| # | Request | Items |
|---|---|---|
| 1 | The "new" button is in a different place on each screen; make it consistent everywhere | P2.1 (all screens), P2.2 (Walls), P0.2 (stale comments), P1.4 (Overview links found on the way) |
| 2 | An easy way to set the weather location without knowing coordinates | P2.3 |
| 3 | Store: "Source" on Countdown opens an error page | P1.1 |
| 4 | "Pair a browser wall" and "Add an eInk panel" should match | P2.2, P1.5 |
| 5 | Shifts for two people don't both display | P1.2 (widget); P5.4 part 2 (calendar) |
| 6 | More weather styles: colour, fun, iOS-like, 4–5 of them | P5.1, with P3, P4.1–P4.5 |
| 7 | Calendar style options; a way to enable or disable shifts; several ways to show them (text per day, colour) | P5.4 parts 1–6 |
| 8 | Countdown style options: fun, vacation, holiday | P5.2 |
| 9 | Preinstalled wallpapers (20–30), all resolutions, portrait and landscape, readable text | P6.1–P6.4 |
| 10 | HA "Add to wall" doesn't add to a wall | P1.3 |
| 11 | HA widget styled like a tile card, with its options | P5.3 |

**Decisions and follow-up instructions:**

| Source | Items |
|---|---|
| Emoji, animation and shadows allowed for weather (#6) | D6–D8, P0.1, P4.2–P4.4, P5.1 |
| Animation, confetti and emoji allowed for countdown (#8) | D6–D7, P0.1, P4.2–P4.3, P5.2 |
| Decision 1 (big-number weather style) | D1, P0.1, P5.1 `today` |
| Decision 2 (gradients) | D2, P0.1, P5.1 sky gradients, P6 |
| Decision 3 (icon set opened) | D3, P0.1, P4.2, P5.2, P5.3 glyphs |
| Decision 4 (HA tile look) | D4, P5.3 |
| Decision 5 (keep and rename the Countdown Store entry) | D5, P1.1 |
| Richer weather data | D9, P3.1–P3.8 |

**Findings made during the review that nobody asked for, all included:**

- Overview links to a retired page: P1.4.
- Stale comments: P0.2.
- `stampTier` misreports visible badges: P1.2.
- Readings keyed by label: P1.3.
- The Store's recipe "Add to the wall": P1.3.
- "Back to…" links in the filled header action: P2.1.
- The Enter-key trap on the weather form: P2.3.
- E-paper ETag churn: P3.5.
- Summary dropped by the wall: P3.7.
- `shiftCode` never drawn: P5.4.
- The month grid ignores the calendar filter: P5.4.
- Orphaned `showTimes` and `showLocations`: P5.4.
- The widget card background hard-coded `#111820`: P6.3.
- The `shadow` config accepted and ignored: P4.4.
- "eInk" and "e-paper" both in copy: P1.5.
- NWS blocks cloud IPs, so fixtures must be captured from home: P3.6.
- Weather alerts are US-only: recorded under Phase 3's out of scope.

---

## Tests expected to change

These are changed deliberately, each with a sentence in the test saying why the
letter moved and the intent did not. None may be weakened to make a build pass.

- **Placement:**
  - `admin-walls-list`
  - `add-display-parity`
  - `admin-saved`
  - `browser-calendars`
  - `feed-credential-forms`
  - `admin-calendars`
  - `ha-screens`
  - `browser-ha-phone`
  - `browser-admin`
  - `external-modules`
  - `wall-editor`
  - `admin-components` (new `action` test)
  - `admin-vocabulary` (new routes, "eInk" retired)
- **Rules:**
  - `no-emoji` (narrowed to e-paper)
  - `motion` and `motion-scope` (scope, not ban)
- **Tables:**
  - `epaper-ink` `PROBES` (every new variant value, `shiftStyle`)
  - `glyph-parity` (new glyphs)
  - `builtin-themes-parity` and `themes` mirrors (new tokens)
- **Home Assistant:**
  - `homeassistant` (domains, tone, changedAt, still no entity id)
  - `viewmodel` (two-people shifts, weather fields)
- **Weather:**
  - `open-meteo` and NWS parser tests (new fixtures)
  - `epaper-weather-widget` (honoured variants)
  - the frame ETag tests (P3.5)
