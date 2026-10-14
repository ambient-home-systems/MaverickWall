# Adding a module to the store

The store is the list of modules a household browses on the **Store** screen. It
is maintained **in this repository**, so a module you add ships to everyone in
the next release — no third-party lists, no URLs to hand around.

Adding one is a pull request that drops a single file into
[`apps/server/src/catalog/`](../apps/server/src/catalog/) and lists it in that
directory's `index.ts`. There are two kinds of entry.

## A recipe (the common case)

A **recipe** has no service to host: it names a public web feed and how to draw
it, and Maverick Wall does the fetching. This is what most store entries are.
Copy [`outside-temperature.ts`](../apps/server/src/catalog/outside-temperature.ts),
or whichever entry in that directory draws its feed most like yours, and change
the fields:

```ts
import type { CatalogEntry } from '../http/catalog.js';

export const entry: CatalogEntry = {
  id: 'harbour-tides',              // stable, kebab-case, unique
  name: 'Harbour tides',
  author: 'your name',
  description: 'The next high tide, from a public tide API.',
  glyph: 'moisture',                // a key from the drawn set, never an emoji
  kind: 'recipe',
  recipe: {
    name: 'Tide',
    contract: 1,
    config: [{ key: 'port', label: 'Port', type: 'string' }],
    secrets: [],
    fetch: {
      url: 'https://api.example.com/tide?port={port}',
      intervalSeconds: 900,
      allowLan: false,
    },
    panel: { kind: 'text', title: 'Next tide', text: '{next.height | round:1} m at {next.time | date:short}' },
    signals: [],
  },
};
```

The recipe format — selectors, formatters, templates, `config`, `secrets`,
`signals`, `allowLan` — is documented in
[`building-a-module.md`](./building-a-module.md). Two rules the review checks:

- **Every entry must be real and installable.** Use a feed that actually works,
  key-less if you can. An entry for something nobody can run is worse than none.
- **A store recipe is held to the same schema as any other**, so it is SSRF-
  guarded, sanitised, and — if it uses a `secret` — the household types the key
  in at install and it is stored encrypted. Keep the feed public where possible;
  `allowLan: true` (reaching the household's own network) needs a good reason.

## A service module (advanced)

A **service** module runs as its own process and Maverick Wall reads it over
HTTP. Use this only when a recipe genuinely cannot do the job (custom logic, a
private source, heavy computation). A store entry gives the household guidance
and a suggested address; they add it on the **Advanced** screen. Copy
[`countdown-example.ts`](../apps/server/src/catalog/countdown-example.ts).

## Listing it, and the check

Add your file to the array in
[`apps/server/src/catalog/index.ts`](../apps/server/src/catalog/index.ts):

```ts
import { entry as tideTimes } from './tide-times.js';
export const STORE_ENTRIES: readonly CatalogEntry[] = [tideTimes, /* … */];
```

`test/catalog.test.ts` validates every entry against the schema, so `pnpm test`
fails on a malformed one — never a household's wall.

## Its feed's real answer

A schema can only say a recipe is well-formed, and the store promises that every
entry works. So every recipe in the store is held to what its own feed really
answered, and `test/store-recipes.test.ts` fails on one that is not:

```bash
pnpm --filter @maverick-wall/server build
NODE_USE_ENV_PROXY=1 node scripts/store/capture.mjs harbour-tides
node apps/server/dist/tools/test-recipe.js apps/server/test/fixtures/store/harbour-tides --update
```

The first asks your recipe's own address, with every setting at its default,
and saves the answer, the recipe and the moment it asked under
`apps/server/test/fixtures/store/harbour-tides/` (add the place the default
belongs to, to `ZONES` in the script, so its times read as they would there).
The second records what the recipe builds from that answer as `expected.json`.
**Read it before you commit it**: the test holds the recipe to the answer, and
only a person can say the answer drew something true. Pick defaults that show
the recipe drawing rows on the day you capture, not its empty line.

Open the PR; once it merges it is in the store for everyone.
