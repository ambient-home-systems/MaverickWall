import type { CatalogEntry } from '../http/catalog.js';

/**
 * Pollen in the air now, from Open-Meteo's air-quality service, which runs the
 * Copernicus (CAMS) European model: key-less, and Europe only — elsewhere the
 * service answers nothing for every plant, which the description says.
 */
export const entry: CatalogEntry = {
  id: 'pollen',
  name: 'Pollen',
  author: 'Maverick Wall',
  description:
    'Grass, birch, alder, mugwort, olive and ragweed pollen in the air now, in grains per cubic metre, ' +
    'from Open-Meteo. Europe only.',
  glyph: 'humidity',
  emoji: 'sunflower',
  kind: 'recipe',
  recipe: {
    name: 'Pollen',
    contract: 1,
    config: [
      { key: 'lat', label: 'Latitude', type: 'string', default: '51.5074' },
      { key: 'lon', label: 'Longitude', type: 'string', default: '-0.1278' },
    ],
    secrets: [],
    fetch: {
      url:
        'https://air-quality-api.open-meteo.com/v1/air-quality?latitude={lat}&longitude={lon}' +
        '&current=grass_pollen,birch_pollen,alder_pollen,mugwort_pollen,olive_pollen,ragweed_pollen',
      intervalSeconds: 3600,
      allowLan: false,
      format: 'json',
    },
    panel: {
      kind: 'text',
      title: 'Pollen, grains/m³',
      text:
        'Grass {current.grass_pollen | round:0} · Birch {current.birch_pollen | round:0} · ' +
        'Alder {current.alder_pollen | round:0} · Mugwort {current.mugwort_pollen | round:0} · ' +
        'Olive {current.olive_pollen | round:0} · Ragweed {current.ragweed_pollen | round:0}',
    },
    signals: [],
  },
};
