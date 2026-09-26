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
  // The glyph vocabulary is thirty-four drawings and has no hourglass, and
  // `glyph` is required of every entry regardless — the gauge is the nearest
  // thing in the closed set that reads as a dial counting down, and it is
  // what the schema keeps on file even though `emoji` below is what the card
  // actually draws now that P4.2's bundled artwork has shipped.
  glyph: 'pressure',
  emoji: 'hourglass',
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
