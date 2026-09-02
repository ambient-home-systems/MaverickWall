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
  // The vocabulary is closed at twenty-nine and has no hourglass, which is the
  // point of a closed set: a store entry does not get to add a drawing. The
  // gauge is the nearest thing in it that reads as a dial counting down.
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
