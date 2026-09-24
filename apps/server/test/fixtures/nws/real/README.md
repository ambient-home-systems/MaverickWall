# The National Weather Service, captured from a home network

NWS's CDN refuses requests from cloud addresses (an Akamai 403), so these were
captured by the owner from a home network, with the commands in
`docs/plan-2026-09-household-review-prompts.md` ("Owner task"), for the plan's
example location, `38.8894,-77.0352` in Washington, DC. They were committed
unedited in `35ea84d` on 2026-09-24.

The documents date themselves, which is the record of when:

| File | What it is | Its own timestamp |
|---|---|---|
| `points.json` | `/points/38.8894,-77.0352` | `astronomicalData` for 2026-09-24 |
| `stations.json` | `observationStations?limit=5`, nearest first: KDCA, KCGS, KADW, KDAA, KGAI | — |
| `observation-latest.json` | `/stations/KDCA/observations/latest` | `timestamp` 2026-09-24T12:00:00+00:00 |
| `forecast-hourly.json` | `forecastHourly`, 156 periods | `generatedAt` 2026-09-24T11:52:19+00:00 |
| `forecast.json` | `forecast`, 14 periods | `generatedAt` 2026-09-24T12:05:08+00:00 |

Two things about them that the parsers learned from, each held by a test in
`nws-rich.test.ts`:

- **An hourly period has an empty name.** All 156 carry `"name": ""`, so the
  daily schema — whose one required field is the name a row is headed with —
  would have refused every hour. The hourly reader has its own schema.
- **The hourly `isDaytime` is a clock, not the sun.** It turns false at 18:00
  local on a day the sun sets at 19:02, so day and night come from the NOAA
  calculation (`sun.ts`) instead.

## What is missing

**`observation-null-temperature.json`.** The owner task asked for an
observation whose temperature is null, and KDCA's reported 12 °C. The
null-temperature fallback is tested against *this* observation with its
temperature's `value` set to `null` and its `qualityControl` to `Z` — the shape
this same document already uses for four other quantities (wind speed,
direction and gust, and sea-level pressure) — rather than against a document
written from memory. A real one would be better, and replacing the derived case
with it is a one-line change in `nws-rich.test.ts`.
