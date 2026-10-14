import type { CatalogEntry } from '../http/catalog.js';

/**
 * Today's tides at a United States tide station, from NOAA's CO-OPS data API:
 * key-less, and the same predictions NOAA publishes. A timeline, so the wall
 * marks the tides that have gone and the one that is next by its own clock.
 *
 * NOAA's `date=today` is the day in the zone the times are asked for, and they
 * are asked for in `gmt` because a zone-less time is read as UTC. So on the
 * US east coast after eight in the evening the list is tomorrow's, which is
 * the list worth showing then; the wall's clock still says which is next.
 */
export const entry: CatalogEntry = {
  id: 'tide-times',
  name: 'Tide times',
  author: 'Maverick Wall',
  description:
    "Today's high and low tides at a US tide station, from NOAA. Find your " +
    "station's number on tidesandcurrents.noaa.gov; the wall marks which tide is next.",
  glyph: 'moisture',
  emoji: 'ship',
  kind: 'recipe',
  recipe: {
    name: 'Tide times',
    contract: 1,
    config: [
      { key: 'station', label: 'NOAA station number', type: 'string', default: '8518750' },
    ],
    secrets: [],
    fetch: {
      url:
        'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&station={station}' +
        '&datum=MLLW&time_zone=gmt&units=metric&interval=hilo&format=json&date=today&application=maverick_wall',
      intervalSeconds: 21600,
      allowLan: false,
      format: 'json',
    },
    lookups: { tide: { H: 'High tide', L: 'Low tide' } },
    panel: {
      kind: 'timeline',
      title: 'Tides',
      items: {
        for: 'predictions',
        at: '{t | iso}',
        label: '{type | map:tide}',
        detail: '{v | round:1} m',
        empty: 'NOAA has no tides for this station today.',
      },
    },
    signals: [],
  },
};
