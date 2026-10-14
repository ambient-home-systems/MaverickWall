import type { CatalogEntry } from '../http/catalog.js';

/**
 * The largest recent earthquakes, from the US Geological Survey's own GeoJSON
 * summary feeds: worldwide, key-less and updated every few minutes. A row is
 * coloured by USGS's PAGER alert where the survey has issued one.
 */
export const entry: CatalogEntry = {
  id: 'earthquakes',
  name: 'Earthquakes',
  author: 'Maverick Wall',
  description:
    'The largest recent earthquakes worldwide, from the US Geological Survey. ' +
    'Choose how strong and how recent; a quake the survey expects to do damage is drawn in the alert colour.',
  glyph: 'problem',
  emoji: 'earth-globe-americas',
  kind: 'recipe',
  recipe: {
    name: 'Earthquakes',
    contract: 1,
    config: [
      {
        key: 'feed',
        label: 'Which quakes',
        type: 'select',
        options: [
          { value: 'significant_week', label: 'Significant, past week' },
          { value: '4.5_day', label: '4.5 and over, past day' },
          { value: '4.5_week', label: '4.5 and over, past week' },
          { value: '2.5_day', label: '2.5 and over, past day' },
        ],
        default: '4.5_day',
      },
    ],
    secrets: [],
    fetch: {
      url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/{feed}.geojson',
      intervalSeconds: 600,
      allowLan: false,
      format: 'json',
    },
    panel: {
      kind: 'readings',
      title: 'Earthquakes',
      items: {
        for: 'features',
        label: '{properties.place | truncate:40}',
        value: 'M{properties.mag | round:1} · {properties.time | time}',
        sort: { by: 'properties.mag', order: 'desc', as: 'number' },
        limit: 5,
        empty: 'No earthquakes this size.',
        tone: { from: 'properties.alert', map: { red: 'alert', orange: 'alert', yellow: 'active' } },
      },
    },
    signals: [],
  },
};
