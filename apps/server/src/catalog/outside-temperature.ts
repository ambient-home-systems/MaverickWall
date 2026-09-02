import type { CatalogEntry } from '../http/catalog.js';

/**
 * A recipe — no service to host. Maverick Wall fetches a public feed and draws
 * a value from it. This is the shape most store entries take; copy it to add
 * your own (docs/adding-to-the-store.md).
 */
export const entry: CatalogEntry = {
  id: 'outside-temperature',
  name: 'Outside temperature',
  author: 'Maverick Wall',
  description:
    'The current temperature where you live, from Open-Meteo — a free, ' +
    'key-less public weather feed. A good first recipe: install it, fill in ' +
    'your latitude and longitude, done.',
  glyph: 'temperature',
  preview: ['19.4°', 'Outside'],
  kind: 'recipe',
  recipe: {
    name: 'Outside temperature',
    contract: 1,
    config: [
      { key: 'lat', label: 'Latitude', type: 'string', default: '51.5074' },
      { key: 'lon', label: 'Longitude', type: 'string', default: '-0.1278' },
    ],
    secrets: [],
    fetch: {
      url: 'https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m',
      intervalSeconds: 900,
      allowLan: false,
    },
    panel: {
      kind: 'stat',
      title: 'Outside',
      value: '{current.temperature_2m | round:1}',
      caption: '°C',
    },
    signals: [],
  },
};
