import type { CatalogEntry } from '../http/catalog.js';

/**
 * The runnable reference *service* module — one you run as its own process.
 * Kept in the store as the example a developer copies. See
 * `examples/example-module` and `docs/adding-to-the-store.md`.
 */
export const entry: CatalogEntry = {
  id: 'countdown-example',
  name: 'Countdown (example module)',
  author: 'Maverick Wall',
  description:
    'A developer example, not an everyday widget: it runs as its own small ' +
    'program (node server.mjs) you start yourself, so Install asks for that ' +
    'program’s address. For a countdown on your wall, use the built-in ' +
    'Countdown widget instead — this is the reference a module author copies.',
  // The glyph vocabulary is thirty-four drawings and has no hourglass: a store
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
