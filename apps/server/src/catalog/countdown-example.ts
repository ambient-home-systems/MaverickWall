import type { CatalogEntry } from '../http/catalog.js';

/**
 * The runnable reference *service* module — one you run as its own process.
 * Kept in the store as the example a developer copies. See
 * `examples/example-module` and `docs/adding-to-the-store.md`.
 */
export const entry: CatalogEntry = {
  id: 'countdown-example',
  name: 'Countdown',
  author: 'Maverick Wall',
  description:
    'A big number counting down the days to a date you choose — the runnable ' +
    'reference module. A good first module to try, and to copy.',
  // The glyph vocabulary is twenty-nine drawings and has no hourglass: a store
  // entry does not get to add a drawing to it. The gauge is the nearest thing
  // in it that reads as a dial counting down. Decision D3 (2026-09-24) opened
  // the icon set for occasion motifs, and on a browser wall those — and this
  // entry's hourglass — are bundled emoji artwork rather than new glyph keys
  // (plan item P4.2). Until that artwork ships, the gauge stays.
  glyph: 'pressure',
  preview: ['42', 'days to Holiday'],
  kind: 'service',
  install: {
    hint:
      'Run examples/example-module (node server.mjs, or set PORT/TARGET/LABEL), ' +
      'then paste its address below. It answers on port 9000 by default.',
    url: 'http://localhost:9000',
    source: 'https://github.com/ambient-home-systems/MaverickWall/tree/main/examples/example-module',
  },
};
