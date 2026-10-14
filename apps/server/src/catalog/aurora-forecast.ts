import type { CatalogEntry } from '../http/catalog.js';

/**
 * The planetary K-index forecast from NOAA's Space Weather Prediction Center:
 * how disturbed the Earth's magnetic field is expected to be over the next
 * three days, in three-hour slots, which is what says whether the aurora may
 * reach further south than usual. Key-less. A slot with a geomagnetic storm
 * forecast (G1 to G5) is drawn in the alert colour.
 */
export const entry: CatalogEntry = {
  id: 'aurora-forecast',
  name: 'Aurora forecast',
  author: 'Maverick Wall',
  description:
    "NOAA's forecast of the K-index over the next few days: the higher it is, the further from the " +
    'poles the aurora may be seen. A forecast storm is drawn in the alert colour.',
  glyph: 'illuminance',
  emoji: 'glowing-star',
  kind: 'recipe',
  recipe: {
    name: 'Aurora forecast',
    contract: 1,
    config: [],
    secrets: [],
    fetch: {
      url: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json',
      intervalSeconds: 3600,
      allowLan: false,
      format: 'json',
    },
    lookups: {
      scale: { G1: 'minor storm', G2: 'moderate storm', G3: 'strong storm', G4: 'severe storm', G5: 'extreme storm', '*': '' },
    },
    panel: {
      kind: 'timeline',
      title: 'Aurora (Kp)',
      items: {
        for: '.',
        at: '{time_tag | iso}',
        label: 'Kp {kp | round:1}',
        detail: '{noaa_scale | map:scale}',
        where: [{ path: 'observed', equals: 'predicted' }],
        limit: 6,
        empty: 'NOAA has published no forecast.',
        tone: {
          from: 'noaa_scale',
          map: { G1: 'alert', G2: 'alert', G3: 'alert', G4: 'alert', G5: 'alert' },
        },
      },
    },
    signals: [],
  },
};
