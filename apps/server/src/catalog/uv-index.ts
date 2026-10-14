import type { CatalogEntry } from '../http/catalog.js';

/**
 * Today's UV index forecast for a US ZIP code, from the US Environmental
 * Protection Agency's Envirofacts service, which publishes the National
 * Weather Service's forecast. Key-less. The bands are the WHO's.
 */
export const entry: CatalogEntry = {
  id: 'uv-index',
  name: 'UV index',
  author: 'Maverick Wall',
  description:
    "Today's UV index forecast for a US ZIP code, from the EPA. Moderate and above is drawn in the " +
    'active colour, high and above in the alert colour.',
  glyph: 'clear',
  emoji: 'sunscreen',
  kind: 'recipe',
  recipe: {
    name: 'UV index',
    contract: 1,
    config: [{ key: 'zip', label: 'ZIP code', type: 'string', default: '20050' }],
    secrets: [],
    fetch: {
      url: 'https://data.epa.gov/efservice/getEnvirofactsUVDAILY/ZIP/{zip}/JSON',
      intervalSeconds: 10800,
      allowLan: false,
      format: 'json',
    },
    lookups: {
      band: {
        '0': 'Low',
        '1': 'Low',
        '2': 'Low',
        '3': 'Moderate',
        '4': 'Moderate',
        '5': 'Moderate',
        '6': 'High',
        '7': 'High',
        '8': 'Very high',
        '9': 'Very high',
        '10': 'Very high',
        '*': 'Extreme',
      },
    },
    panel: {
      kind: 'readings',
      title: 'UV today',
      items: {
        for: '.',
        label: '{CITY}',
        value: '{UV_INDEX} · {UV_INDEX | map:band}',
        limit: 1,
        empty: 'The EPA has no forecast for this ZIP code.',
        tone: {
          from: 'UV_INDEX',
          map: { '0': 'idle', '1': 'idle', '2': 'idle', '3': 'active', '4': 'active', '5': 'active' },
          default: 'alert',
        },
      },
    },
    signals: [],
  },
};
