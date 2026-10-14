import type { CatalogEntry } from '../http/catalog.js';

/**
 * The tropical storms the US National Hurricane Center is tracking now, in the
 * Atlantic and the eastern and central Pacific, with their strongest sustained
 * wind. Key-less. A hurricane is drawn in the alert colour and a tropical
 * storm in the active one.
 */
export const entry: CatalogEntry = {
  id: 'hurricanes',
  name: 'Hurricanes',
  author: 'Maverick Wall',
  description:
    'The storms the US National Hurricane Center is tracking now, in the Atlantic and the eastern ' +
    'and central Pacific, with their wind speed. A hurricane is drawn in the alert colour.',
  glyph: 'wind',
  emoji: 'cyclone',
  kind: 'recipe',
  recipe: {
    name: 'Hurricanes',
    contract: 1,
    config: [],
    secrets: [],
    fetch: {
      url: 'https://www.nhc.noaa.gov/CurrentStorms.json',
      intervalSeconds: 1800,
      allowLan: false,
      format: 'json',
    },
    lookups: {
      kind: {
        HU: 'Hurricane',
        TS: 'Tropical storm',
        TD: 'Tropical depression',
        STS: 'Subtropical storm',
        STD: 'Subtropical depression',
        PTC: 'Potential tropical cyclone',
        PC: 'Post-tropical cyclone',
      },
    },
    panel: {
      kind: 'readings',
      title: 'Tropical storms',
      items: {
        for: 'activeStorms',
        label: '{classification | map:kind} {name}',
        value: '{intensity} kt',
        sort: { by: 'intensity', order: 'desc', as: 'number' },
        limit: 6,
        empty: 'No tropical storms are being tracked.',
        tone: { from: 'classification', map: { HU: 'alert', TS: 'active', STS: 'active' }, default: 'idle' },
      },
    },
    signals: [],
  },
};
