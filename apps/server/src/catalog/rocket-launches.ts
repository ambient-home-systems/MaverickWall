import type { CatalogEntry } from '../http/catalog.js';

/**
 * The next rocket launches anywhere in the world, from The Space Devs' Launch
 * Library 2: key-less, at fifteen requests an hour, which is why it asks once.
 * A timeline, so the wall marks the one that has gone and the one that is next.
 */
export const entry: CatalogEntry = {
  id: 'rocket-launches',
  name: 'Rocket launches',
  author: 'Maverick Wall',
  description: 'The next rocket launches anywhere in the world, with where they fly from, from The Space Devs.',
  glyph: 'wind',
  emoji: 'rocket',
  kind: 'recipe',
  recipe: {
    name: 'Rocket launches',
    contract: 1,
    config: [],
    secrets: [],
    fetch: {
      url: 'https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=6&mode=list',
      intervalSeconds: 3600,
      allowLan: false,
      format: 'json',
    },
    panel: {
      kind: 'timeline',
      title: 'Launches',
      items: {
        for: 'results',
        at: '{net | iso}',
        label: '{name | truncate:60}',
        detail: '{location | truncate:60}',
        limit: 5,
        empty: 'No launches are scheduled.',
      },
    },
    signals: [],
  },
};
