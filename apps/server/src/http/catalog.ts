import { z } from '../validation.js';

/**
 * The module catalogue (docs/rfc-002-module-catalog-and-recipes.md, Phase A1).
 *
 * A curated list a household browses to find a module, rather than having to
 * already know its address. This is *discovery only* — a catalogue entry grants
 * no new trust and can do nothing installing the module by hand could not. It
 * describes a module and how to get it; the module itself is still a service the
 * household runs (RFC 001), reached by URL through the SSRF guard.
 *
 * Baked into the image on purpose, for now. A remote, community-authored
 * catalogue fetched with consent is Phase A2 — the same argument as the update
 * check, that contacting a third party to read a list reveals this house runs
 * Maverick Wall, and so must be asked for rather than done on first paint. A
 * built-in list needs no network and works on a wall with no internet, which is
 * the right default to start from. The `catalogSchema` here is deliberately the
 * one that remote fetch will reuse, so the contract is fixed before it travels.
 *
 * Lives beside the admin screen, like `RULE_TEMPLATES`, because it is a fact
 * about what the household can be shown — not about the domain.
 */

// Every string is capped, and rendered with `escapeHtml`. The caps matter more
// once A2 lets these strings come from a stranger's catalogue over the network;
// fixing them now means the schema does not change when the source does.
const entrySchema = z
  .object({
    /** Stable, kebab-case. Referenced by the install deep-link. */
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/, 'lower-case letters, digits and hyphens only'),
    name: z.string().min(1).max(60),
    author: z.string().min(1).max(60),
    description: z.string().min(1).max(280),
    /** A single glyph the device already has — never a fetched image (rule three). */
    icon: z.string().min(1).max(4),
    /**
     * Phase A1 is service modules only: a module the household runs, added by
     * URL. `recipe` (a module Maverick Wall runs itself) is Phase B.
     */
    kind: z.literal('service'),
    install: z
      .object({
        /** Plain guidance: what to run, and where its address comes from. */
        hint: z.string().min(1).max(280),
        /**
         * A suggested address to pre-fill, when there is a sensible default
         * (the example module's local port). Usually absent: a service runs
         * where the household put it, and only they know that address.
         */
        url: z.string().max(2048).optional(),
        /** Where to get the module — a repository or add-on link, shown as-is. */
        source: z.string().max(2048).optional(),
      })
      .strict(),
  })
  .strict();

export const catalogSchema = z.object({ version: z.literal(1), modules: z.array(entrySchema) });

export type CatalogEntry = z.infer<typeof entrySchema>;
export type Catalog = z.infer<typeof catalogSchema>;

/**
 * The built-in catalogue.
 *
 * Starts with the one service module that actually exists and runs — the
 * example in `examples/example-module`. An entry that advertised a module
 * nobody could install would be worse than an empty list: the whole point of a
 * catalogue is that what it lists is real. Community entries arrive by pull
 * request against this list (and, in A2, a remote catalogue).
 */
export const CATALOG: Catalog = {
  version: 1,
  modules: [
    {
      id: 'countdown-example',
      name: 'Countdown',
      author: 'Maverick Wall',
      description:
        'A big number counting down the days to a date you choose — the runnable ' +
        'reference module. A good first module to try, and to copy.',
      icon: '⏳',
      kind: 'service',
      install: {
        hint:
          'Run examples/example-module (node server.mjs, or set PORT/TARGET/LABEL), ' +
          'then paste its address below. It answers on port 9000 by default.',
        url: 'http://localhost:9000',
        source: 'https://github.com/ambient-home-systems/MaverickWall/tree/main/examples/example-module',
      },
    },
  ],
};

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.modules.find((entry) => entry.id === id);
}
