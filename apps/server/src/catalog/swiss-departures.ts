import type { CatalogEntry } from '../http/catalog.js';

/**
 * The next departures from a Swiss station or stop, from transport.opendata.ch,
 * the community API over the Swiss public transport timetable: trains, trams
 * and buses alike, key-less.
 */
export const entry: CatalogEntry = {
  id: 'swiss-departures',
  name: 'Swiss departures',
  author: 'Maverick Wall',
  description:
    'The next trains, trams and buses from a station or stop in Switzerland, from transport.opendata.ch. ' +
    'Type the stop as the SBB app names it.',
  glyph: 'person',
  emoji: 'luggage',
  kind: 'recipe',
  recipe: {
    name: 'Swiss departures',
    contract: 1,
    config: [{ key: 'station', label: 'Station or stop', type: 'string', default: 'Bern' }],
    secrets: [],
    fetch: {
      url: 'https://transport.opendata.ch/v1/stationboard?station={station}&limit=8',
      intervalSeconds: 120,
      allowLan: false,
      format: 'json',
    },
    panel: {
      kind: 'readings',
      title: '{station.name}',
      items: {
        for: 'stationboard',
        label: '{category}{number} {to | truncate:40}',
        value: '{stop.departure | time}',
        limit: 6,
        empty: 'Nothing leaves this stop for a while.',
      },
    },
    signals: [],
  },
};
