# Session prompts: the September 2026 household review

These are ready-to-paste prompts for building
[`plan-2026-09-household-review.md`](plan-2026-09-household-review.md), one
Claude Code session each, with the model and effort level each one should run
at. Every item in the plan appears in exactly one session; the coverage table
at the end proves it.

**Before the first session:** merge the plan's pull request so every session
finds the plan on `main`.

---

## Choosing a model and effort

### How to set them

Checked against Claude Code 2.1.281, the version this was written with.

| Where | Model | Effort |
|---|---|---|
| Command line | `claude --model opus` (aliases `fable`, `opus`, `sonnet`, or a full name such as `claude-opus-5-5`) | `claude --effort xhigh` |
| Inside a session, CLI or web | `/model` | `/effort xhigh`. `/effort auto` returns to the model's own default |
| Claude Code on the web | The model picker when starting the session | Send `/effort <level>` as the first message, then paste the prompt |
| A default for every session | `"model"` in `settings.json` | `"effortLevel"` in `settings.json`, or the `CLAUDE_CODE_EFFORT_LEVEL` environment variable |

- **Set the effort explicitly every time.** `auto` means each model's own
  default, and those differ between models, so a session left on `auto` will not
  necessarily match the table below.
- **`/effort ultracode` is not used here.** It runs multi-agent workflows,
  multiplies the cost, and none of these sessions needs it.
- **Plan mode:** for S10, S12, S20 and S23, starting in plan mode
  (`--permission-mode plan`, or Shift+Tab in the CLI) lets you approve the
  approach before anything is written. Do not use it for an unattended cloud
  session: plan mode stops and waits for approval that nobody is there to give.

### The rubric this document uses

| Model | Price (input / output, per million tokens) | Used here for |
|---|---|---|
| **Claude Fable 5.1** | $10 / $50 | The two sessions where a wrong first attempt costs the most: the calendar's shift styles, where the density ratchets decide whether a change ships, and the wallpaper set, where visual quality and a measured contrast guarantee both have to hold. Fable does best with the goal and the constraints rather than step-by-step instructions, so its prompts are written that way. |
| **Claude Opus 5.5** | $4 / $20 | The default: most feature work, anything touching a security boundary, anything with browser measurement. |
| **Claude Sonnet 5** | $2 / $10 | Small, well-specified sessions: copy changes, a link attribute, an asset route. |
| **Claude Haiku 4.5** | $1 / $5 | Not used. It takes no effort setting, and this repository's verification bar (measure, mutation-check, browser tests) is the wrong place to save the difference. |

| Effort | Used for |
|---|---|
| `medium` | Mechanical sessions: renames, attributes, copy. |
| `high` | Normal feature work with a clear specification. |
| `xhigh` | Subtle work: layout and measurement, two renderers that must agree, security boundaries, cross-cutting groundwork. |
| `max` | Not planned. Use it for a **retry** when a session at `xhigh` has failed or produced a change that did not hold up in review. |

**Review every pull request before merging it.** Run `/code-review <PR number> high`
in an Opus 5.5 session. For the sessions marked
**security review**, also run `/security-review`: they add an outbound fetch, a
new served route, or touch the Home Assistant boundary.

---

## Order and dependencies

- **S01 goes first,** because every later session reads the rules it rewrites.
- **A session can start once everything in its "Needs" column has merged.**
  Sessions whose needs are met can run in parallel, each opening its own pull
  request. S05 and S06, S14 and S15, S16 and S17, and S20 and S21 edit the same
  files, which is why each second one needs the first.
- **S09 must ship in the same release as S08.** Current conditions change every
  15 minutes, and until S09 lands that change moves every e-paper panel's frame
  ETag, so battery panels would redraw on every wake.
- **The owner task** (capturing NWS responses from a home network) has no
  prerequisites and can be done at any time before S08.

| Session | Plan items | Model | Effort | Needs | Extra review |
|---|---|---|---|---|---|
| S01 | P0.1, P0.2 | Opus 5.5 | high | — | — |
| S02 | P1.1, P1.4, P1.5 | Sonnet 5 | medium | S01 | — |
| S03 | P1.2 | Opus 5.5 | xhigh | S01 | — |
| S04 | P1.3 | Opus 5.5 | xhigh | S01 | security review |
| S05 | P2.1 (household, themes, Store) | Opus 5.5 | high | S01 | — |
| S06 | P2.1 (Home Assistant), P2.2 | Opus 5.5 | high | S05 | — |
| S07 | P2.3 | Sonnet 5 | high | S01 | security review |
| owner | P3.6 (NWS capture) | — | — | — | — |
| S08 | P3.1–P3.4, P3.6–P3.8 | Opus 5.5 | xhigh | S01, owner | security review |
| S09 | P3.5 | Opus 5.5 | xhigh | S08 | — |
| S10 | P4.1 | Opus 5.5 | xhigh | S01 | — |
| S11 | P4.2 | Sonnet 5 | high | S02 | security review |
| S12 | P4.3 | Opus 5.5 | xhigh | S01 | — |
| S13 | P4.4, P4.5 | Opus 5.5 | high | S01 | — |
| S14 | P5.1 (`range`, `colour`) | Opus 5.5 | high | S10, S13 | — |
| S15 | P5.1 (`today`, `playful`) | Opus 5.5 | xhigh | S09, S11, S12, S14 | — |
| S16 | P5.2 (`number` extras, `page`, `ticket`, celebration, emoji picker) | Opus 5.5 | high | S10, S11, S12, S13 | — |
| S17 | P5.2 (`occasion`, `progress`, `month`) | Opus 5.5 | high | S16 | — |
| S18 | P5.3 (data) | Opus 5.5 | xhigh | S01 | security review |
| S19 | P5.3 (tiles) | Opus 5.5 | xhigh | S10, S13, S18 | — |
| S20 | P5.4 parts 1–3 | **Fable 5.1** | xhigh | S10, S13 | — |
| S21 | P5.4 parts 4–6 | Opus 5.5 | high | S20 | — |
| S22 | P6.1, P6.4 | Opus 5.5 | high | S13 | security review |
| S23 | P6.2, P6.3 | **Fable 5.1** | xhigh | S22 | — |

---

## The block every prompt carries

Each prompt below already includes this block at its end, so every prompt can
be pasted on its own. It is written out once here so a change to it is
reviewable.

> Read `CLAUDE.md` first, then the items named above in
> `docs/plan-2026-09-household-review.md`. Build only those items; anything else
> you notice goes in the pull request description, not the diff. The plan's line
> numbers were read at `5af6ed2` and have drifted: search for the code rather
> than trusting the address. Where the plan lists an open question (Q1–Q10),
> build its proposed default and say so in the pull request. Verify the way
> `CLAUDE.md` asks: measure computed values rather than class names, revert each
> fix once to prove its test goes red, never move a ratchet baseline without a
> measured reason, and run `pnpm test` before pushing. Add a paragraph to
> `CLAUDE.md`'s "Current state" recording what shipped and the measured test
> count. Open one pull request.

---

## S01 · Rules and documentation

**Opus 5.5 · high.** Plan items P0.1, P0.2.

```text
Rewrite the rules in CLAUDE.md and apps/display/DESIGN.md that the owner's decisions on 2026-09-24 reverse, before any code depends on them. This is documentation only: no source, style or test changes.

The decisions are D1–D9 in the plan's "Decisions already taken" table. Emoji, animation and shadows are now permitted on browser walls, each under the conditions P0.1 spells out. E-paper keeps its old rules. The admin's own motion rule is unchanged. Hard rule 12 is unchanged. Write each rewritten rule in this repository's voice: say why the old rule existed, what now replaces it, and which test enforces the new version. The tests themselves change in later sessions (S11 for emoji, S12 for motion), so name them as "enforced by … once S11/S12 lands" rather than claiming enforcement that does not exist yet.

Also record D1–D9, with the date, in "The design file" and "Current state" sections, so the narrative stops contradicting the rules. Then fix every stale comment P0.2 lists; those are comment edits in source files, which is the one exception to "documentation only".

Done when no sentence in CLAUDE.md or either DESIGN.md forbids something D1–D8 allow.

Read CLAUDE.md first, then the items named above in docs/plan-2026-09-household-review.md. Build only those items; anything else you notice goes in the pull request description, not the diff. The plan's line numbers were read at 5af6ed2 and have drifted: search for the code rather than trusting the address. Where the plan lists an open question (Q1–Q10), build its proposed default and say so in the pull request. Verify the way CLAUDE.md asks: measure computed values rather than class names, revert each fix once to prove its test goes red, never move a ratchet baseline without a measured reason, and run `pnpm test` before pushing. Add a paragraph to CLAUDE.md's "Current state" recording what shipped and the measured test count. Open one pull request.
```

## S02 · Quick fixes: the Store link, the Overview links, one word for e-paper

**Sonnet 5 · medium.** Plan items P1.1, P1.4, P1.5.

```text
Three small fixes from the plan.

P1.1: the Store's "Source" and "Where to get it" links open inside the Home Assistant sidebar's iframe, where GitHub refuses to be framed, so the household sees "github.com refused to connect". Give both links target="_blank" rel="noopener noreferrer", and add a test that crawls every admin page and fails on any absolute http(s) link without them. Rename the Countdown Store entry to "Countdown (example module)" and rewrite its description as the plan says. Keep its `pressure` glyph for now; S11 swaps it for the bundled hourglass.

P1.4: the Overview's "Edit what shows" and "Arrange layout" buttons point at the retired admin/walls/default. Point them at the walls list, or straight at the wall when there is exactly one, and add a test that no Overview link resolves to a redirect.

P1.5: use "e-paper" everywhere a household reads it, and retire "eInk" in admin-vocabulary.test.ts with a zero allow-list. Leave the ESPHome config identifier alone.

Read CLAUDE.md first, then the items named above in docs/plan-2026-09-household-review.md. Build only those items; anything else you notice goes in the pull request description, not the diff. The plan's line numbers were read at 5af6ed2 and have drifted: search for the code rather than trusting the address. Where the plan lists an open question (Q1–Q10), build its proposed default and say so in the pull request. Verify the way CLAUDE.md asks: measure computed values rather than class names, revert each fix once to prove its test goes red, never move a ratchet baseline without a measured reason, and run `pnpm test` before pushing. Add a paragraph to CLAUDE.md's "Current state" recording what shipped and the measured test count. Open one pull request.
```

## S03 · A Shift widget with two people shows one

**Opus 5.5 · xhigh.** Plan item P1.2.

```text
Fix P1.2: a Shift widget set to two people draws only the first on a browser wall.

The plan traces the cause. tierShift in apps/display/src/render.ts chooses the tier from the whole box as if it held one badge, then draws a full badge per person. beltItems then hides every badge ending below the box except the first, and Classic's shift box is one badge tall. stampTier also reports both badges as visible.

Fix it as the plan describes:
1. Choose the tier per badge.
2. Fall back to the one-line form for every person when full badges do not fit, which is what the e-paper panel already does.
3. Stamp the count actually visible.

Prove it with a browser test on a paired Classic wall with two rota people: both badges visible by computed display and by rectangle, at 1080x1920 and 1920x1080. Revert the per-badge height and watch the test go red. wall-density and browser-classic-proportions must not move for a one-person wall.

Do not touch the calendar's shifts[0]; that is S20.

Read CLAUDE.md first, then the items named above in docs/plan-2026-09-household-review.md. Build only those items; anything else you notice goes in the pull request description, not the diff. The plan's line numbers were read at 5af6ed2 and have drifted: search for the code rather than trusting the address. Where the plan lists an open question (Q1–Q10), build its proposed default and say so in the pull request. Verify the way CLAUDE.md asks: measure computed values rather than class names, revert each fix once to prove its test goes red, never move a ratchet baseline without a measured reason, and run `pnpm test` before pushing. Add a paragraph to CLAUDE.md's "Current state" recording what shipped and the measured test count. Open one pull request.
```

## S04 · Home Assistant "Add to the wall" adds nothing to a wall

**Opus 5.5 · xhigh · security review.** Plan item P1.3.

```text
Fix P1.3. Adding a Home Assistant reading only watches the entity, yet the button, the section heading and the saved message all say it went on the wall. Nothing is drawn unless a wall has a Home Assistant widget, and Classic has none. The Store's recipe install button says the same untrue thing.

1. Relabel the button, the noscript fallback, the section heading, the saved message and the recipe install button as the plan says.
2. Show on each reading which walls draw it ("On: Kitchen, Hall" / "Not on any wall yet"), computed server-side across every wall's canvases, both orientations and every named layout.
3. When no wall shows readings at all, add the explaining card.

Then fix the related bug in the same item. Widgets choose readings by label, so renaming a reading silently drops it from every widget that picked it. Store entity ids in the widget config on the server and rewrite them to opaque handles on the way to the wall, the way the to-do widget's `list` is rewritten through todoListHandle. Treat a stored label that matches a current reading as that entity, so no migration is needed.

Hard rule 12 is the constraint to hold: the manifest must never carry an entity id, the token or the Home Assistant address. Extend homeassistant.test.ts to prove it with a readings-filtered widget placed. HA_SERVICES and ha-write-boundary.test.ts must be untouched.

Read CLAUDE.md first, then the items named above in docs/plan-2026-09-household-review.md. Build only those items; anything else you notice goes in the pull request description, not the diff. The plan's line numbers were read at 5af6ed2 and have drifted: search for the code rather than trusting the address. Where the plan lists an open question (Q1–Q10), build its proposed default and say so in the pull request. Verify the way CLAUDE.md asks: measure computed values rather than class names, revert each fix once to prove its test goes red, never move a ratchet baseline without a measured reason, and run `pnpm test` before pushing. Add a paragraph to CLAUDE.md's "Current state" recording what shipped and the measured test count. Open one pull request.
```

## S05 · One place for "Add": the household screens, Themes and the Store

**Opus 5.5 · high.** Plan item P2.1, first half.

```text
Build the first half of P2.1. Every list screen's only create action becomes one "Add …" button in the app bar's action slot, and it always opens a dedicated add page. The list page loses its inline form, which answers the objection recorded in admin.ts ("two primaries for one act"): there is now one primary because there is one form, and it is elsewhere.

This session covers:
- Calendars: a chooser at /admin/calendars/new offering an iCal address, a CalDAV account or Home Assistant. The RFC 013 "Google and iCloud through Home Assistant" section moves there.
- People, Work Schedule (step 1 becomes a GET page), Shift types (with the common presets), Chores.
- Themes: "Add a theme", with "Generate from a colour" moving onto the builder page.
- The Store family: its "Back to…" links move out of the filled action slot into pageHeader's `back`.

Home Assistant's screens and Walls are S06.

Keep every existing behaviour the plan lists under "Details that must survive the move":
- echo-on-400 on each new add page;
- savedRedirect tokens back to the list;
- the dirty-form guard;
- relative links under the single <base>.

Measure the app bar at 390px, and use short labels only if the long ones do not fit.

Several tests pin today's placement and must be rewritten deliberately; the plan lists them. Add a sentence in each saying why the letter moved and the intent did not. Add the new test that walks every list page and asserts one app-bar "Add …" action to a /new route and no inline create form. It will fail on the Home Assistant and Walls screens until S06: mark those screens as expected failures with a named TODO, and state that in the pull request.

Read CLAUDE.md first, then the items named above in docs/plan-2026-09-household-review.md. Build only those items; anything else you notice goes in the pull request description, not the diff. The plan's line numbers were read at 5af6ed2 and have drifted: search for the code rather than trusting the address. Where the plan lists an open question (Q1–Q10), build its proposed default and say so in the pull request. Verify the way CLAUDE.md asks: measure computed values rather than class names, revert each fix once to prove its test goes red, never move a ratchet baseline without a measured reason, and run `pnpm test` before pushing. Add a paragraph to CLAUDE.md's "Current state" recording what shipped and the measured test count. Open one pull request.
```

## S06 · One place for "Add": Home Assistant and Walls

**Opus 5.5 · high.** Plan items P2.1 (second half) and P2.2. Run after S05.

```text
Finish P2.1 and build P2.2, following the pattern S05 established.

Home Assistant screens: the Readings, Calendars, To-do lists and "Tell me when…" screens each get one app-bar "Add …" action to its own add page. The rule templates move onto the rules add page. Connection is not a collection and stays as it is.

Walls (P2.2): the three buttons under the header become one app-bar "Add a wall", leading to a chooser between "Add a browser wall" and "Add an e-paper wall", each with the one-line description the plan gives. The two add pages' headings match those words, and both final buttons read "Add wall". "Pair" is kept only for the step that pairs a browser. "Approve a pairing code" becomes a secondary link in the Walls intro and on the chooser.

Remove S05's expected-failure markers, so the "every list page" test covers every screen. Re-measure browser-ha-phone at 390px. Update admin-walls-list, add-display-parity (asserting both headings and final buttons use the same words) and admin-vocabulary.

Read CLAUDE.md first, then the items named above in docs/plan-2026-09-household-review.md. Build only those items; anything else you notice goes in the pull request description, not the diff. The plan's line numbers were read at 5af6ed2 and have drifted: search for the code rather than trusting the address. Where the plan lists an open question (Q1–Q10), build its proposed default and say so in the pull request. Verify the way CLAUDE.md asks: measure computed values rather than class names, revert each fix once to prove its test goes red, never move a ratchet baseline without a measured reason, and run `pnpm test` before pushing. Add a paragraph to CLAUDE.md's "Current state" recording what shipped and the measured test count. Open one pull request.
```

## S07 · Weather: find the location by town or postcode

**Sonnet 5 · high · security review.** Plan item P2.3.

```text
Build P2.3 so a household with no coordinates and no Home Assistant can set its weather location by typing its town.

Add a "Town, city or postcode" field with a script-free Look up submit (a formaction, like the existing Home Assistant button). The server queries Open-Meteo's geocoding service through the SSRF-guarded fetcher (public https only) and parses each result with Zod separately, so one bad entry does not cost the rest. The page re-renders with the whole form echoed plus up to five matches as radio choices. "Use this place" saves the chosen coordinates and the rest of the form, using the same narrower schema use-ha-location uses. Write a plain sentence for each failure: no match, service down, nothing typed. Name the host the typed text is sent to.

Handle the Enter-key trap the plan describes. defaultSubmit() is Save, so Enter in the place field must be treated as a lookup when a place is typed and no coordinates are. This form has lost data to implicit submission before; test exactly this case.

Also:
- The hidden "Use this device's location" button, revealed only in a secure context with geolocation available.
- The line pointing to connecting Home Assistant when it is not connected.
- The fine-tuning hint about US county boundaries.

Commit a real Open-Meteo geocoding response as the parser's fixture (the API is reachable).

Read CLAUDE.md first, then the items named above in docs/plan-2026-09-household-review.md. Build only those items; anything else you notice goes in the pull request description, not the diff. The plan's line numbers were read at 5af6ed2 and have drifted: search for the code rather than trusting the address. Where the plan lists an open question (Q1–Q10), build its proposed default and say so in the pull request. Verify the way CLAUDE.md asks: measure computed values rather than class names, revert each fix once to prove its test goes red, never move a ratchet baseline without a measured reason, and run `pnpm test` before pushing. Add a paragraph to CLAUDE.md's "Current state" recording what shipped and the measured test count. Open one pull request.
```

## Owner task · Capture the NWS responses from a home network

Not a Claude session. NWS's CDN refuses cloud IP addresses, so S08 cannot fetch
these itself. Run the following on any machine at home; the coordinates are the
plan's example location in Washington, DC:

```bash
UA="MaverickWall fixtures (you@example.com)"
mkdir -p nws && cd nws
curl -sSA "$UA" https://api.weather.gov/points/38.8894,-77.0352 > points.json
curl -sSA "$UA" "$(jq -r .properties.observationStations points.json)?limit=5" > stations.json
STATION=$(jq -r '.features[0].properties.stationIdentifier' stations.json)
curl -sSA "$UA" "https://api.weather.gov/stations/$STATION/observations/latest" > observation-latest.json
curl -sSA "$UA" "$(jq -r .properties.forecastHourly points.json)" > forecast-hourly.json
curl -sSA "$UA" "$(jq -r .properties.forecast points.json)" > forecast.json
```

Commit the five files under `apps/server/test/fixtures/nws/real/`, with a short
`README.md` saying where and when they were captured. If
`observation-latest.json` has a non-null temperature, keep trying other stations
from `stations.json`, or re-run it at another time, until one reports
`"temperature": {"value": null}`, and save that one as
`observation-null-temperature.json`. S08 tests the fallback against it.

## S08 · Richer weather data

**Opus 5.5 · xhigh · security review.** Plan items P3.1–P3.4 and P3.6–P3.8.
Needs the owner's NWS fixtures. Ship in the same release as S09.

```text
Build the weather data in Phase 3 of the plan, everything except P3.5 (that is S09).

The weather panel gains optional current conditions, a 24-hour forecast, extra per-day fields (rain chance and amount, wind, UV, sunrise and sunset, NWS's detailed text) and optional air quality.
- Open-Meteo supplies all of it in one request, plus a second host for air quality.
- NWS supplies current conditions from the nearest station's latest observation, falling back to the first hourly period when the temperature is null or older than 90 minutes, plus hourly and per-period rain chance and wind.
- Sunrise and sunset come from a pure NOAA-algorithm module for every provider, with Open-Meteo's own values preferred.

Every new field is optional and spread (absent, never null), so a household that gains nothing keeps a byte-identical manifest and ETag.

Refresh current conditions every 15 minutes and the forecast hourly, with per-part caching and keep-last-good per part. Units follow the existing imperial/metric setting; Open-Meteo needs wind_speed_unit and precipitation_unit set explicitly. Add the "Air quality" switch (a new column, default off) naming the host it contacts, and the provider description on the Weather page. The wall's weatherFrom reads everything defensively, and stops dropping `summary`. Optionally, the calendar's list view shows each day's rain chance beside its numbers (P3.7), within the list view's density rules.

Every parser test reads real bytes:
- Open-Meteo forecast and air-quality responses captured from the live API.
- NWS: the fixtures the owner committed under apps/server/test/fixtures/nws/real/. If they are not there yet, stop and say so rather than inventing NWS documents.

Test the null-temperature fallback, the 90-minute staleness rule, and sun times within ±2 minutes of Open-Meteo for a spread of latitudes, including one with no sunrise.

Read CLAUDE.md first, then the items named above in docs/plan-2026-09-household-review.md. Build only those items; anything else you notice goes in the pull request description, not the diff. The plan's line numbers were read at 5af6ed2 and have drifted: search for the code rather than trusting the address. Where the plan lists an open question (Q1–Q10), build its proposed default and say so in the pull request. Verify the way CLAUDE.md asks: measure computed values rather than class names, revert each fix once to prove its test goes red, never move a ratchet baseline without a measured reason, and run `pnpm test` before pushing. Add a paragraph to CLAUDE.md's "Current state" recording what shipped and the measured test count. Open one pull request.
```

## S09 · E-paper frames must not churn

**Opus 5.5 · xhigh.** Plan item P3.5. Ship in the same release as S08.

```text
Build P3.5. An e-paper panel's frame ETag hashes the whole manifest (manifestEtag inside apps/server/src/epaper/frame.ts), so once S08's current conditions refresh every 15 minutes, every paired panel's ETag would move every 15 minutes, including panels with no weather on them. A battery panel would then do a full refresh on every wake.

Build the panel's preimage without panels.weather.current, panels.weather.hourly and panels.weather.air unless that panel's canvas holds a weather widget whose variant draws them. If it is not much harder, do the more general version the plan names: hash only the panel slices the panel's widgets actually read. When a panel does draw current conditions, it labels them with their time ("52° at 07:15").

Tests:
- The same panel's ETag is unchanged across two manifests differing only in `current`.
- It changes when the panel's canvas draws current conditions.
- Every pinned byte-identical frame stays identical.

Revert the preimage change and watch the first test go red. Bump EPAPER_RENDERER_VERSION only if a pixel changes.

Read CLAUDE.md first, then the items named above in docs/plan-2026-09-household-review.md. Build only those items; anything else you notice goes in the pull request description, not the diff. The plan's line numbers were read at 5af6ed2 and have drifted: search for the code rather than trusting the address. Where the plan lists an open question (Q1–Q10), build its proposed default and say so in the pull request. Verify the way CLAUDE.md asks: measure computed values rather than class names, revert each fix once to prove its test goes red, never move a ratchet baseline without a measured reason, and run `pnpm test` before pushing. Add a paragraph to CLAUDE.md's "Current state" recording what shipped and the measured test count. Open one pull request.
```

## S10 · Widget styles for every type

**Opus 5.5 · xhigh.** Plan item P4.1.

```text
Build P4.1: the groundwork that lets every widget type have styles, which today only the clock has.

1. Extend the one shared `variant` enum with every new value the plan lists (weather, countdown, homeassistant, calendar).
2. Generalise clock-face.ts's clockVariant into apps/display/src/variants.ts, one allowlist and one label table per type, where a value a type does not know draws that type's default.
3. Transcribe it to the server for the panel, held character-identical by a parity test in the tier-parity / clock-face-parity pattern.
4. Widen the editor's Look picker to read the per-type table. With more than three options it becomes a small grid of labelled choices rather than a segmented control.
5. Add per-variant control pruning in buildClockConfig's style.

No new variant draws anything yet: each type's renderer keeps drawing its default for every new value, and the sessions that follow design them. So every non-clock variant is, for now, a value the panel ignores. Put that in the honours tables as an ignore with a true sentence, and extend epaper-ink.test.ts's PROBES with every new value so the tables stay proved by rendering. The clock's behaviour and frames must be byte-identical.

Read CLAUDE.md first, then the items named above in docs/plan-2026-09-household-review.md. Build only those items; anything else you notice goes in the pull request description, not the diff. The plan's line numbers were read at 5af6ed2 and have drifted: search for the code rather than trusting the address. Where the plan lists an open question (Q1–Q10), build its proposed default and say so in the pull request. Verify the way CLAUDE.md asks: measure computed values rather than class names, revert each fix once to prove its test goes red, never move a ratchet baseline without a measured reason, and run `pnpm test` before pushing. Add a paragraph to CLAUDE.md's "Current state" recording what shipped and the measured test count. Open one pull request.
```

## S11 · Bundled emoji artwork

**Sonnet 5 · high · security review.** Plan item P4.2. Needs S02.

```text
Build P4.2 so emoji look the same on every wall. The image ships no emoji font, so today each tablet draws its own maker's emoji, or an empty box.

1. Curate about 150 Twemoji SVGs (Q3) covering:
   - weather conditions;
   - the occasions (Christmas, birthday, Halloween, vacation, school's out, New Year);
   - the advice lines (umbrella, coat, shorts, sunscreen, wind);
   - a general countdown picker set;
   - an hourglass.
2. Ship them under apps/server/assets/emoji/, served at /assets/emoji/<name>.svg with immutable caching, following the fonts route: static.ts, the Dockerfile copy, the boot check.
3. Add an emojiNode(key) helper in the display that draws <img alt="…">. The manifest carries keys, never code points.
4. Add LICENSES.md (CC-BY 4.0 attribution) beside the files, and a NOTICE line.
5. Swap the Store's "Countdown (example module)" mark to the hourglass, which S02 left as `pressure`. The Store's card renders a glyph key today, so it needs a small change to accept an emoji key.

Narrow no-emoji.test.ts to the e-paper renderer and its tests, keeping asciiTitle as the panel's guard. Add an assertion that designed wall styles draw emoji as bundled <img>, never as text code points. Emoji a household types itself keep the device font (Q9).

Check that the new route serves nothing outside the directory: the name must be slash-free, and served files must be SVG-only.

Read CLAUDE.md first, then the items named above in docs/plan-2026-09-household-review.md. Build only those items; anything else you notice goes in the pull request description, not the diff. The plan's line numbers were read at 5af6ed2 and have drifted: search for the code rather than trusting the address. Where the plan lists an open question (Q1–Q10), build its proposed default and say so in the pull request. Verify the way CLAUDE.md asks: measure computed values rather than class names, revert each fix once to prove its test goes red, never move a ratchet baseline without a measured reason, and run `pnpm test` before pushing. Add a paragraph to CLAUDE.md's "Current state" recording what shipped and the measured test count. Open one pull request.
```

## S12 · Motion that survives the 15-second rebuild

**Opus 5.5 · xhigh.** Plan item P4.3.

```text
Build P4.3. Animation is now allowed on browser walls, but draw() empties and rebuilds the whole wall every 15 seconds, so any CSS animation restarts on every tick.

Solve it the two ways the plan describes:
1. Looping effects: a pure motion.ts phaseDelay(durationMs, wallNowMs) that sets a negative animation-delay from the corrected wall clock, so a rebuilt element resumes exactly where the old one was.
2. One-shot effects: a per-widget memory in main.ts keyed by widget id and event (the mechanism the to-do widget's error sentence uses to survive redraws), so a confetti burst or a page flip fires once per event rather than every tick.

Scope every @keyframes and animation declaration inside prefers-reduced-motion: no-preference and under .canvas[data-motion="on"], and animate transform and opacity only. Add the per-wall Motion switch (screens.motion, null meaning on) to the wall's Device and time pane, and default it off in the e-ink presets. E-paper panels stay still.

Rewrite apps/display/test/motion.test.ts and the display half of apps/server/test/motion-scope.test.ts to enforce this scope instead of a ban; leave the admin half as it is. Add a browser test that an animation's computed current time is continuous across a redraw, and one that a one-shot does not refire on the next tick. Ship one small demonstration animation, a test fixture rather than a product feature, so the tests have something to measure; S15 and S16 bring the real ones. Keep sw-shell.test.ts green.

Read CLAUDE.md first, then the items named above in docs/plan-2026-09-household-review.md. Build only those items; anything else you notice goes in the pull request description, not the diff. The plan's line numbers were read at 5af6ed2 and have drifted: search for the code rather than trusting the address. Where the plan lists an open question (Q1–Q10), build its proposed default and say so in the pull request. Verify the way CLAUDE.md asks: measure computed values rather than class names, revert each fix once to prove its test goes red, never move a ratchet baseline without a measured reason, and run `pnpm test` before pushing. Add a paragraph to CLAUDE.md's "Current state" recording what shipped and the measured test count. Open one pull request.
```

## S13 · Shadows and the new theme tokens

**Opus 5.5 · high.** Plan items P4.4, P4.5.

```text
Build P4.4 and P4.5.

Shadows become a theme token, --shadow-card, set per built-in theme as the plan lists:
- soft for Panels and Household;
- none for Blueprint and Swiss;
- paper-like for Almanac.

Transcribe the values to api/builtin-themes.ts under the existing parity test, derive a default for custom themes, and add a "Shadows: none / soft" control to the theme builder. The widget `shadow` config is honoured again in applyWidgetFormat, and its Style-tab control is restored; walls that stored shadow: true light up as intended. The e-ink presets set the token to none.

Add the new tokens to all five built-in themes and to custom-theme derivation, keeping customTokens and withTints as character-identical mirrors:
- weather condition colours;
- a temperature scale;
- Home Assistant state colours;
- sky-gradient palettes.

Contrast-check every token that paints text or a glyph against its theme's ground, the way --ink-scaffold is checked. No shipped wall's pixels may change except where a stored shadow: true now draws.

Read CLAUDE.md first, then the items named above in docs/plan-2026-09-household-review.md. Build only those items; anything else you notice goes in the pull request description, not the diff. The plan's line numbers were read at 5af6ed2 and have drifted: search for the code rather than trusting the address. Where the plan lists an open question (Q1–Q10), build its proposed default and say so in the pull request. Verify the way CLAUDE.md asks: measure computed values rather than class names, revert each fix once to prove its test goes red, never move a ratchet baseline without a measured reason, and run `pnpm test` before pushing. Add a paragraph to CLAUDE.md's "Current state" recording what shipped and the measured test count. Open one pull request.
```

## S14 · Weather styles: range bars and colour

**Opus 5.5 · high.** Plan item P5.1, the `range` and `colour` variants. Needs S10 and S13.

```text
Design and build two weather styles from P5.1.
- `range` (the iOS 10-day look): one row per day with name, glyph, rain chance when present, low, a range bar spanning the week's minimum to maximum filled cool to warm, then high.
- `colour`: today's strip with glyphs painted in the condition colours and temperatures tinted on the temperature scale. Two-tone glyphs need the paths in glyphs.ts split into named parts; the e-paper cells are unaffected.

Give each its own tier table in widget-tiers.ts, giving up content in the order the plan states. Nothing is scaled; nothing is clipped through a row. On e-paper, `range` is honoured as black bars and `colour` falls back to the strip. That means `variant` moves into PANEL_HONOURS.weather, the ink lane offers strip, today and range, and epaper-ink proves both.

Measure each on paired 1080x1920 and 1920x1080 walls in its own browser-weather-<variant> test: nothing clipped, tabular figures, role sizes. Classic uses the strip, so its ratchets must not move.

Read CLAUDE.md first, then the items named above in docs/plan-2026-09-household-review.md. Build only those items; anything else you notice goes in the pull request description, not the diff. The plan's line numbers were read at 5af6ed2 and have drifted: search for the code rather than trusting the address. Where the plan lists an open question (Q1–Q10), build its proposed default and say so in the pull request. Verify the way CLAUDE.md asks: measure computed values rather than class names, revert each fix once to prove its test goes red, never move a ratchet baseline without a measured reason, and run `pnpm test` before pushing. Add a paragraph to CLAUDE.md's "Current state" recording what shipped and the measured test count. Open one pull request.
```

## S15 · Weather styles: the "Today" card and the playful style

**Opus 5.5 · xhigh.** Plan item P5.1, the `today` and `playful` variants. Needs S08, S09, S11, S12 and S14.

```text
Design and build the last two weather styles from P5.1.

`today` (the iOS widget look):
- A large current temperature as the lede, capped against the rest in the clock's manner (decision D1).
- The condition words, feels-like, and high and low.
- A row of the next hours, or the next days as one line in a short box.
- A sky gradient keyed on glyph and day/night from the S13 tokens, and a soft card shadow.
- Optional ambient motion per condition, phase-locked through S12's helper and still under reduce-motion.
- With no current conditions (stale or absent), it degrades to today's high and low as the lede.

`playful`:
- A large bundled emoji per condition (from S11) that floats or bobs gently, and big day names.
- An optional advice line in plain words with an emoji.
- The advice rules live in a pure weather-advice.ts with table-driven tests, using the plan's thresholds in both unit systems.

Both get their own tier tables. On e-paper, `today` is honoured as a 1-bit version with its "at HH:MM" stamp, and `playful` falls back to the strip.

Measure both on paired walls at both sizes in their own browser tests, using the real fixture data from S08. Prove motion is scoped and continuous across a redraw, and that emoji are <img> from /assets/emoji/.

Read CLAUDE.md first, then the items named above in docs/plan-2026-09-household-review.md. Build only those items; anything else you notice goes in the pull request description, not the diff. The plan's line numbers were read at 5af6ed2 and have drifted: search for the code rather than trusting the address. Where the plan lists an open question (Q1–Q10), build its proposed default and say so in the pull request. Verify the way CLAUDE.md asks: measure computed values rather than class names, revert each fix once to prove its test goes red, never move a ratchet baseline without a measured reason, and run `pnpm test` before pushing. Add a paragraph to CLAUDE.md's "Current state" recording what shipped and the measured test count. Open one pull request.
```

## S16 · Countdown: the number, the tear-off page, the boarding pass, the celebration

**Opus 5.5 · high.** Plan item P5.2, first half. Needs S10–S13.

```text
Build the first half of P5.2.

New optional config: `unitWords` (days / sleeps), `emoji` (a key from the S11 set, with a picker grid in the editor), and `celebrate` (default on).

Variants:
- `number`: gains the emoji and "sleeps" wording. Every existing countdown must stay pixel-identical on the wall and the panel.
- `page`: a tear-off calendar page that flips once, when the count changes at midnight, as a one-shot through S12.
- `ticket`: a boarding pass, where the destination is the title, "Departs in 12 days", a perforated rule, and departure-board digits that flip only when the number changes.

The celebration: on the target day every variant shows "Today! 🎉", and with `celebrate` on plays a confetti burst once, then at most once an hour, through the one-shot memory.

Give `page` and `ticket` tier tables; `number` keeps its --buw/--buh sizing. On e-paper, `number`, `page` and `ticket` are honoured as still frames with emoji stripped, and INK_LANE.countdown gains variant and unitWords.

Tests:
- One browser test per variant at both sizes.
- The celebration fires once, not per tick.
- `sleeps` wording.
- The panel frames.
- Byte-identity for a countdown with no new keys.

Read CLAUDE.md first, then the items named above in docs/plan-2026-09-household-review.md. Build only those items; anything else you notice goes in the pull request description, not the diff. The plan's line numbers were read at 5af6ed2 and have drifted: search for the code rather than trusting the address. Where the plan lists an open question (Q1–Q10), build its proposed default and say so in the pull request. Verify the way CLAUDE.md asks: measure computed values rather than class names, revert each fix once to prove its test goes red, never move a ratchet baseline without a measured reason, and run `pnpm test` before pushing. Add a paragraph to CLAUDE.md's "Current state" recording what shipped and the measured test count. Open one pull request.
```

## S17 · Countdown: occasions, progress and the mini month

**Opus 5.5 · high.** Plan item P5.2, second half. Run after S16.

```text
Build the second half of P5.2.

`occasion`, with an `occasion` config (christmas, birthday, halloween, vacation, schools-out, new-year, custom). Each is an accent pair from tokens, a bundled emoji motif and a phase-locked ambient loop:
- snow for Christmas;
- rising balloons for a birthday;
- drifting leaves for Halloween;
- sun and waves for a vacation;
- paper planes for school's out;
- fireworks for New Year.

`progress`, with a new `from` start date that is refused (not coerced) when it is not before `target`, with a plain sentence. It draws a bar of days gone with the count and a percentage, and fills on change as a one-shot.

`month`: a small month with the target circled, today marked, and the count.

Editor: an occasion picker for `occasion` and a start date for `progress`. On e-paper, `progress` (a 1-bit bar) and `month` (a 1-bit mini month) are honoured, and `occasion` falls back to `number`.

Measure each on paired walls at both sizes. Test the refused start date and the panel frames.

Read CLAUDE.md first, then the items named above in docs/plan-2026-09-household-review.md. Build only those items; anything else you notice goes in the pull request description, not the diff. The plan's line numbers were read at 5af6ed2 and have drifted: search for the code rather than trusting the address. Where the plan lists an open question (Q1–Q10), build its proposed default and say so in the pull request. Verify the way CLAUDE.md asks: measure computed values rather than class names, revert each fix once to prove its test goes red, never move a ratchet baseline without a measured reason, and run `pnpm test` before pushing. Add a paragraph to CLAUDE.md's "Current state" recording what shipped and the measured test count. Open one pull request.
```

## S18 · Home Assistant: the data a tile needs

**Opus 5.5 · xhigh · security review.** Plan item P5.3, the data half.

```text
Build the server-side data P5.3 needs for tile cards. Hard rule 12 still holds: the display never receives an entity id, the token or the Home Assistant address.

1. `tone` per reading ('active' | 'alert' | null), worked out in toReading from the plan's per-domain and per-device-class table, and tested table-first.
2. `changedAt` from HaState.lastChangedAt, which today only reaches signals().
3. Watch these domains read-only (Q8): light, switch, input_boolean, fan, cover, lock and climate.
   - Humanise each in readState ("On · 60%", "Open · 40%", "Heating · 21°").
   - Cache an allowlist of attributes per domain rather than only device_class.
   - Reading state is a GET, so HA_SERVICES stays exactly two members and ha-write-boundary.test.ts must stay green and unedited.
4. Draw glyphs for the new domains in all three places (the wall, the server/admin, and 1-bit), under glyph-parity.

The existing `list` widget must draw exactly what it drew for every reading it could already show.

Tests:
- homeassistant.test.ts proves the manifest carries no entity id, token or base URL with the new domains present.
- An unlisted attribute never reaches the cache.
- The tone table.
- changedAt travels, and the manifest changes only when the state does.

Read CLAUDE.md first, then the items named above in docs/plan-2026-09-household-review.md. Build only those items; anything else you notice goes in the pull request description, not the diff. The plan's line numbers were read at 5af6ed2 and have drifted: search for the code rather than trusting the address. Where the plan lists an open question (Q1–Q10), build its proposed default and say so in the pull request. Verify the way CLAUDE.md asks: measure computed values rather than class names, revert each fix once to prove its test goes red, never move a ratchet baseline without a measured reason, and run `pnpm test` before pushing. Add a paragraph to CLAUDE.md's "Current state" recording what shipped and the measured test count. Open one pull request.
```

## S19 · Home Assistant tile cards

**Opus 5.5 · xhigh.** Plan item P5.3, the display half. Needs S10, S13 and S18.

```text
Build the `tile` variant for the Home Assistant widget from P5.3 (decision D4).

Each reading is a rounded tile:
- the glyph in a filled circle coloured by tone from the S13 state tokens;
- the name, and the state line with its unit;
- optionally "· 5 min ago" from changedAt, updated each tick;
- optionally a read-only bar for brightness, position or fan speed. It is displayed only, never interactive.

Options: tileLayout (horizontal / vertical), hideState, showChanged, showBar, and an optional per-reading icon override chosen on the Readings screen. The box decides columns and how many tiles fit through a HOUSE_TILE_TIERS table in characters and ems of the name role. Tiles flow; nothing is scaled. Soft shadow from the token, overridable through the style lane.

Amend the four "not competing with Lovelace" statements the plan lists. Say in the widget's help that toggles, sliders, tap actions and entity pictures are deliberately absent (hard rule 12, and no Home Assistant address on the wall). On e-paper, tiles are outlined rounded boxes with the circle filled for active and alert and the text knocked out; `variant` joins PANEL_HONOURS.homeassistant.

Tests:
- A browser-ha-tile test on paired walls at both sizes: tiles fit their box, the circle's colour is computed per tone, the bar's width matches brightness.
- The panel frames.
- A `list` widget byte-identical to before.

Read CLAUDE.md first, then the items named above in docs/plan-2026-09-household-review.md. Build only those items; anything else you notice goes in the pull request description, not the diff. The plan's line numbers were read at 5af6ed2 and have drifted: search for the code rather than trusting the address. Where the plan lists an open question (Q1–Q10), build its proposed default and say so in the pull request. Verify the way CLAUDE.md asks: measure computed values rather than class names, revert each fix once to prove its test goes red, never move a ratchet baseline without a measured reason, and run `pnpm test` before pushing. Add a paragraph to CLAUDE.md's "Current state" recording what shipped and the measured test count. Open one pull request.
```

## S20 · Calendar: shift styles, two people, week views

**Fable 5.1 · xhigh.** Plan item P5.4, parts 1–3. Needs S10 and S13.

This is the one session where most of the difficulty is in the constraints, not
the feature, so its prompt states the goal and the constraints and leaves the
approach to the model.

```text
Goal: the calendar widget shows rota shifts in the way a household chooses, for everyone on the rota, on every view. Plan item P5.4, parts 1–3.

What the household gets:
- A "Shift style" choice beside the existing "Show work schedules" switch: the current tint, a text label, an edge rule, or a dot. The label draws the day's short code (HorizonCell.shiftCode is already built and never drawn).
- Two or more people on the same day are all shown: by initial in the label, as rule segments in tint and edge, one dot each up to three, and one chip each in the list view. Today the month cell and the agenda row read only shifts[0].
- The week views draw shifts too, only when showShifts is explicitly true (Q2), so no week wall already hanging lights up. The switch then shows on every view.
- An e-paper panel draws the label style in one bit if a 7.5" cell can hold it. Decide by rendering, and put the key in whichever honours table the rendering proves.

Constraints that decide whether this ships:
- "Nothing that annotates an event costs it a row." The label sits in the date line beside the numeral, and every style must be proved to cost no event its row against tiers.ts' budgets.
- wall-density and browser-classic-proportions must not move for a wall on defaults.
- A measured wall with the label style must name the same events as with tint.
- The two renderers must agree on what one stored value means. This project's most repeated bug is shifts[0], display_mode and cellEvents each read two ways.

Prove every claim with a browser measurement at 1080x1920 and 1920x1080 with two rota people. Revert each fix to see its assertion go red.

Read CLAUDE.md first, then the items named above in docs/plan-2026-09-household-review.md. Build only those items; anything else you notice goes in the pull request description, not the diff. The plan's line numbers were read at 5af6ed2 and have drifted: search for the code rather than trusting the address. Where the plan lists an open question (Q1–Q10), build its proposed default and say so in the pull request. Verify the way CLAUDE.md asks: measure computed values rather than class names, revert each fix once to prove its test goes red, never move a ratchet baseline without a measured reason, and run `pnpm test` before pushing. Add a paragraph to CLAUDE.md's "Current state" recording what shipped and the measured test count. Open one pull request.
```

## S21 · Calendar: more looks, the month filter, orphaned keys

**Opus 5.5 · high.** Plan item P5.4, parts 4–6. Run after S20.

```text
Build P5.4 parts 4–6.

Looks:
- todayStyle: ring, fill, or numeral.
- monthHeading: large, small or hidden.
- eventMark in text mode: colour dot, colour bar or coloured text.
- gridLines: week rules (the default) or none.
- Two calendar variants from S10's table, built from tokens and the style lane: `planner` (paper ground, ruled week lines, Fraunces numerals) and `bold` (heavy numerals, high-contrast rules).

Do not build full grid lines or weekend shading. They conflict with "a month cell is not a card" and are deferred (Q1).

The month filter: the month grid ignores the "Which calendars" picker, and the editor only offers it on Week and List. Offer it on Month and apply it identically in both renderers.

The orphaned keys: showTimes and showLocations are in the schema and in PANEL_IGNORES, but nothing writes or reads them. Implement "Show locations" on the list view if the manifest carries locations; otherwise record both as accepted-and-ignored. Never delete them from the strict schema, which would refuse stored configs that carry them.

Every new option must cost no event its row. The ratchets must not move on defaults. Measure each look on paired walls at both sizes.

Read CLAUDE.md first, then the items named above in docs/plan-2026-09-household-review.md. Build only those items; anything else you notice goes in the pull request description, not the diff. The plan's line numbers were read at 5af6ed2 and have drifted: search for the code rather than trusting the address. Where the plan lists an open question (Q1–Q10), build its proposed default and say so in the pull request. Verify the way CLAUDE.md asks: measure computed values rather than class names, revert each fix once to prove its test goes red, never move a ratchet baseline without a measured reason, and run `pnpm test` before pushing. Add a paragraph to CLAUDE.md's "Current state" recording what shipped and the measured test count. Open one pull request.
```

## S22 · Wallpapers: the plumbing and the picker

**Opus 5.5 · high · security review.** Plan items P6.1, P6.4. Needs S13.

```text
Build P6.1 and P6.4: a fourth kind of canvas background, `{ type: 'wallpaper', id }`, and the picker for it. The set of wallpapers is S23; ship this with three placeholder wallpapers so it can be tested end to end.

1. Add the kind in backgroundSchema, parseBackground, the display's CanvasBackground and backgroundCss. An unknown id is dropped, and the canvas falls back to the theme's ground (rules five and nine).
2. Serve apps/server/assets/wallpapers/ at /assets/wallpapers/<name> with immutable caching and content-hashed file names, following the fonts route. static.ts gains .jpg and .jpeg; SAFE_NAME stays slash-free. Add a WALLPAPERS_DIR, the Dockerfile copy and the boot check.
3. The editor preview needs the relative/absolute base split the media store already has.
4. The renderer picks the smaller or larger file by the canvas's pixel size.
5. The editor's background panel gains Wallpaper: a thumbnail grid filtered by tone to match the wall's theme, with "show all" behind a warning, applied per orientation, "use for both" by default. Templates may name a wallpaper.
6. Add the wall's "Widget ground: None / Soft / Solid" setting (default Soft when a wallpaper is set), and replace the widget card background's hard-coded #111820 default with a theme-derived one.

Update the stale "solid or gradient" comments to say four kinds. E-paper never draws a canvas background; say so on the panel's settings.

Measure the decode and paint cost of the largest file on the 15-second rebuild.

Tests:
- A browser-wallpaper test at both orientations: the wallpaper covers the canvas and the ground paints behind each widget.
- A missing file and an unknown id both fall back to the theme's ground.
- admin-asset-urls stays green.

Read CLAUDE.md first, then the items named above in docs/plan-2026-09-household-review.md. Build only those items; anything else you notice goes in the pull request description, not the diff. The plan's line numbers were read at 5af6ed2 and have drifted: search for the code rather than trusting the address. Where the plan lists an open question (Q1–Q10), build its proposed default and say so in the pull request. Verify the way CLAUDE.md asks: measure computed values rather than class names, revert each fix once to prove its test goes red, never move a ratchet baseline without a measured reason, and run `pnpm test` before pushing. Add a paragraph to CLAUDE.md's "Current state" recording what shipped and the measured test count. Open one pull request.
```

## S23 · Wallpapers: the set, and keeping text readable

**Fable 5.1 · xhigh.** Plan items P6.2, P6.3. Needs S22.

Like S20, this states the goal and the constraints rather than the steps.

```text
Goal: a set of 26 preinstalled wallpapers that make a wall look designed rather than a flat block of white or black, and over which every widget stays readable. Plan items P6.2 and P6.3. S22 built the plumbing; replace its placeholders with the real set.

What to make:
- A committed, seeded generator in scripts/wallpapers/: parametric SVG, rasterised by the bundled headless Chromium to JPEG, so the set is our own work, reproducible, and editable by changing a seed.
- Two sizes per wallpaper (about 1600 and about 2880 pixels on the long edge), square, and composed with no focal point near the edges, so `cover` crops one master cleanly to portrait and landscape.
- Small thumbnails for the picker.
- The categories in P6.2 (Q10).
- Metadata per wallpaper: id, name, light or dark tone, dominant colour, focal point, suggested themes.
- LICENSES.md and a NOTICE line.

Constraints that decide whether this ships:
- Every contrast guarantee on the wall is measured against a flat ground, and nothing measures text over a picture. Blur stays out (Q4). Add a test that samples each wallpaper's lightest and darkest regions and asserts that, with the Soft widget ground composited over them, the matching themes' --ink and --ink-scaffold still reach 4.5:1. A wallpaper that fails does not ship.
- Lean dark and low-contrast. Mark high-luminance wallpapers "not for OLED screens" in the picker.
- The directory's total size is pinned by a test, at roughly 10–15 MB, so growth is a decision rather than drift.
- Old kitchen iPads cannot show WebP. Measure decode on the largest size.

Look at every wallpaper rendered behind the shipped Classic wall in both orientations before committing it. That is the check this project counts.

Read CLAUDE.md first, then the items named above in docs/plan-2026-09-household-review.md. Build only those items; anything else you notice goes in the pull request description, not the diff. The plan's line numbers were read at 5af6ed2 and have drifted: search for the code rather than trusting the address. Where the plan lists an open question (Q1–Q10), build its proposed default and say so in the pull request. Verify the way CLAUDE.md asks: measure computed values rather than class names, revert each fix once to prove its test goes red, never move a ratchet baseline without a measured reason, and run `pnpm test` before pushing. Add a paragraph to CLAUDE.md's "Current state" recording what shipped and the measured test count. Open one pull request.
```

---

## Coverage: every plan item to its session

| Plan item | Session |
|---|---|
| P0.1, P0.2 | S01 |
| P1.1 | S02 (the hourglass mark: S11) |
| P1.2 | S03 |
| P1.3 | S04 |
| P1.4, P1.5 | S02 |
| P2.1 | S05, S06 |
| P2.2 | S06 |
| P2.3 | S07 |
| P3.1–P3.4, P3.7, P3.8 | S08 |
| P3.5 | S09 |
| P3.6 | Owner task (NWS), S08 (Open-Meteo, parsers) |
| P4.1 | S10 |
| P4.2 | S11 |
| P4.3 | S12 |
| P4.4, P4.5 | S13 |
| P5.1 | S14 (`range`, `colour`), S15 (`today`, `playful`) |
| P5.2 | S16, S17 |
| P5.3 | S18 (data), S19 (tiles) |
| P5.4 | S20 (parts 1–3), S21 (parts 4–6) |
| P6.1, P6.4 | S22 |
| P6.2, P6.3 | S23 |
