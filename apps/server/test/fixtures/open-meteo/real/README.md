# Open-Meteo, captured from the live API

Every file here is a response Open-Meteo sent, byte for byte, captured on
**2026-09-24 between 12:30 and 12:41 UTC** from the cloud environment that
built plan items P3.1–P3.4 and P3.6–P3.8 (Open-Meteo answers there; NWS does
not). Nothing here was edited. The parser tests read them because a
hand-written document agrees with whatever the parser happens to do.

| File | Request |
|---|---|
| `forecast-dc-imperial.json` | `api.open-meteo.com/v1/forecast?latitude=38.8894&longitude=-77.0352` with the full `current`, `hourly` and `daily` lists `forecastUrl` asks for, `temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto&forecast_days=5&forecast_hours=24` |
| `forecast-london-metric.json` | The same at `51.5074,-0.1278` with `celsius`, `kmh` and `mm` |
| `air-quality-dc.json` | `air-quality-api.open-meteo.com/v1/air-quality?latitude=38.8894&longitude=-77.0352&current=us_aqi,european_aqi&timezone=auto` |
| `air-quality-london.json` | The same at `51.5074,-0.1278` |
| `sun-spread.json` | `daily=sunrise,sunset,daylight_duration&timezone=auto&start_date=2026-06-25&end_date=2026-10-09` for ten places at once: Quito, Singapore, Washington DC, London, Reykjavik, Tromsø, Sydney, Ushuaia, 86°N 0°E and McMurdo |

`38.8894,-77.0352` is the plan's example location and the one the owner's NWS
captures under `../../nws/real/` are for, so the two providers can be read
against the same place on the same morning.

Three facts about these documents that a made-up one would get wrong, each
relied on by a test:

- **A wind speed's unit prints as `mp/h`**, not `mph`, in `current_units` and
  `daily_units`. Nothing reads the unit string; the request decides the unit.
- **Every local time is in the one `utc_offset_seconds` the response
  carries**, even across a clock change — Sydney's sunrises in
  `sun-spread.json` run on without a jump across the 4 October change to
  daylight time. That offset, not the zone's, is what turns them back into
  instants.
- **A day with no sunrise, or no sunset, is a sentinel**: sunrise at `T00:00`,
  sunset at the same instant (polar night) or at the next day's `T00:00`
  (polar day), with `daylight_duration` 0 or 86400. Drawn as a time, that is a
  wall saying the sun rose at midnight.

To re-capture, run the requests above from anywhere Open-Meteo answers. The
free tier is rate-limited per address and a shared cloud address can be over
its daily allowance; a refused request comes back as
`{"error":true,"reason":"Daily API request limit exceeded…"}` with a 429,
which is not a fixture.
