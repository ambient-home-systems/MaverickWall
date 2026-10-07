# Weather providers (plan item M5.8)

The five providers M5.8 adds, as their answers look. Which of these are
captures and which are not matters, so it is said file by file.

## Captured from the live service (`real/`)

Byte for byte, nothing edited, captured at **01:33 UTC on 7 October 2026**
from a laptop Open-Meteo answers:

| File | Request |
|---|---|
| `real/dwd-berlin-metric.json` | `forecastUrl({52.52, 13.405}, 'metric', 5, 'dwd-icon')`: `api.open-meteo.com/v1/dwd-icon` with the full `current`, `hourly` and `daily` lists, Celsius, km/h, mm |
| `real/dwd-dc-imperial.json` | The same at `38.8894,-77.0352` in Fahrenheit, mph, inches |

ICON reports no UV index, so `uv_index` and `uv_index_max` are null in both,
and the current conditions come at a fifteen-minute step (`interval: 900`).

## Not captures

The other three need a household's key, which nobody building this had, so
each fixture is built from what the provider itself publishes:

| File | Built from |
|---|---|
| `pirate-weather-ca.json` | The response example in Pirate Weather's own documentation (`docs.pirateweather.net/en/latest/API/response-example/`), `units=ca`, kept as printed. Its elided `hourly`, `daily` and `day_night` entries are filled in with entries of the same shape; day 2 carries 3 cm of snow in `precipAccumulation` beside 0.05 cm of `liquidAccumulation`, so a reader taking the wrong one is caught. |
| `openweathermap-weather-metric.json` | The `/data/2.5/weather` example at `openweathermap.org/current`, restated in `units=metric` (the documentation's own is in Kelvin). |
| `openweathermap-forecast-metric.json` | Forty three-hour steps in the `/data/2.5/forecast` field list at `openweathermap.org/forecast5`, whose example is collapsed behind a script. `rain.3h` is millimetres whatever the units, as that page says. |
| `wunderground-5day-metric.json` | Every key, in order, of a real `/v3/wx/forecast/daily/5day` answer published at `github.com/whilei/weatherunderground-influxdb` (`forecast-example.json`), with values of its own: six days from Monday 5 October 2026, answered in the evening, so today's day part is null as it is after the afternoon. |
| `wunderground-pws-metric.json` | Every key of a real `/v2/pws/observations/current` answer from the same repository (`example-kwafruit1.json`), with values of its own. |

The Home Assistant weather entity is not a file: `fake-home-assistant.ts`
answers `/api/states/weather.*` and `weather.get_forecasts` in core's shapes,
refusing a forecast type the entity does not have with core's own sentence.

**Still unproven where it counts:** no real key has been used against
OpenWeatherMap, Pirate Weather or Weather Underground, and no real Home
Assistant weather entity has been read. In particular, Pirate Weather's
`apikey` header is taken from its documentation and has not been tried.
