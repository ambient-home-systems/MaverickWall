import type { CatalogEntry } from '../http/catalog.js';

/**
 * A US river gauge's latest reading, from the US Geological Survey's Water
 * Services: how high the water stands and how much is flowing, measured every
 * fifteen minutes or so, key-less. A gauge measures one or both; the panel
 * draws whichever it does.
 */
export const entry: CatalogEntry = {
  id: 'river-level',
  name: 'River level',
  author: 'Maverick Wall',
  description:
    "A US river gauge's latest height and flow, from the US Geological Survey. Find your gauge's " +
    'site number on waterdata.usgs.gov.',
  glyph: 'moisture',
  emoji: 'droplet',
  kind: 'recipe',
  recipe: {
    name: 'River level',
    contract: 1,
    config: [{ key: 'site', label: 'USGS site number', type: 'string', default: '01646500' }],
    secrets: [],
    fetch: {
      url: 'https://waterservices.usgs.gov/nwis/iv/?format=json&sites={site}&parameterCd=00065,00060&siteStatus=active',
      intervalSeconds: 900,
      allowLan: false,
      format: 'json',
    },
    lookups: {
      what: { '00065': 'Height', '00060': 'Flow' },
      unit: { ft: 'ft', 'ft3/s': 'ft³/s', m: 'm', 'm3/s': 'm³/s' },
    },
    panel: {
      kind: 'readings',
      title: '{value.timeSeries[0].sourceInfo.siteName | truncate:60}',
      items: {
        for: 'value.timeSeries',
        label: '{variable.variableCode[0].value | map:what}',
        value: '{values[0].value[0].value} {variable.unit.unitCode | map:unit}',
        empty: 'This gauge has no reading now.',
      },
    },
    signals: [],
  },
};
