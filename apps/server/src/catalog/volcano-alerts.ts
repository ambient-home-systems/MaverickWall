import type { CatalogEntry } from '../http/catalog.js';

/**
 * Every US volcano above normal, from the US Geological Survey's Volcano
 * Hazards Program: the five observatories' own aviation colour codes,
 * key-less. Volcanoes in Alaska, Hawaii, the Cascades, Yellowstone and the
 * Marianas; nowhere else, which the description says.
 */
export const entry: CatalogEntry = {
  id: 'volcano-alerts',
  name: 'Volcano alerts',
  author: 'Maverick Wall',
  description:
    'Every US volcano the US Geological Survey has raised above normal, with its colour code. ' +
    'Alaska, Hawaii, the Cascades, Yellowstone and the Marianas only.',
  glyph: 'smoke',
  emoji: 'mountain',
  kind: 'recipe',
  recipe: {
    name: 'Volcano alerts',
    contract: 1,
    config: [],
    secrets: [],
    fetch: {
      url: 'https://volcanoes.usgs.gov/hans-public/api/volcano/getElevatedVolcanoes',
      intervalSeconds: 3600,
      allowLan: false,
      format: 'json',
    },
    lookups: { colour: { YELLOW: 'Advisory', ORANGE: 'Watch', RED: 'Warning', GREEN: 'Normal' } },
    panel: {
      kind: 'readings',
      title: 'Volcanoes',
      items: {
        for: '.',
        label: '{volcano_name}',
        value: '{color_code | map:colour}',
        sort: { by: 'sent_unixtime', order: 'desc', as: 'number' },
        limit: 6,
        empty: 'Every US volcano is at normal.',
        tone: { from: 'color_code', map: { RED: 'alert', ORANGE: 'alert', YELLOW: 'active' }, default: 'idle' },
      },
    },
    signals: [],
  },
};
