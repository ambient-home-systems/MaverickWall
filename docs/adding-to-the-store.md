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
Copy [`outside-temperature.ts`](../apps/server/src/catalog/outside-temperature.ts)
and change the fields:

```ts
import type { CatalogEntry } from '../http/catalog.js';

export const entry: CatalogEntry = {
  id: 'tide-times',                 // stable, kebab-case, unique
  name: 'Tide times',
  author: 'your name',
  description: 'The next high tide, from a public tide API.',
  icon: '🌊',                        // one glyph — no images (rule three)
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
    panel: { kind: 'stat', title: 'Next tide', value: '{next.height | round:1}', caption: 'm' },
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
fails on a malformed one — never a household's wall. Open the PR; once it merges
it is in the store for everyone.

<!-- CI control run: this branch is main plus this inert line. Delete after. -->
