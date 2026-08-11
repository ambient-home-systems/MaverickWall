import { z } from '../validation.js';
import { recipeSchema } from '../modules/external/recipe.js';

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
const common = {
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
};

/** A module the household runs, added by URL (RFC 001). */
const serviceEntry = z
  .object({
    ...common,
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

/**
 * A recipe the wall runs itself (RFC 002 B1/B2). The whole recipe manifest is
 * embedded and validated by the *same* `recipeSchema` the raw-paste form uses —
 * so a catalogue recipe can do nothing a hand-written one cannot, and the
 * config fields to prompt for come straight off `recipe.config`. Installing it
 * is filling those in, not pasting JSON.
 */
const recipeEntry = z
  .object({
    ...common,
    kind: z.literal('recipe'),
    recipe: recipeSchema,
  })
  .strict();

const entrySchema = z.discriminatedUnion('kind', [serviceEntry, recipeEntry]);

export const catalogSchema = z.object({ version: z.literal(1), modules: z.array(entrySchema) });

/**
 * The schema a *remote* catalogue is held to (A2). Everything the built-in one
 * is, plus one hard refusal: a recipe entry may not ask to reach the LAN
 * (`fetch.allowLan`). The household authored neither the source nor its recipes,
 * so a community catalogue that wanted a recipe pointed at `192.168.x.x` — or at
 * `http://supervisor` — is refused outright, the whole source. A household that
 * genuinely wants a recipe on their own network pastes its manifest themselves
 * (B1), which is their own explicit act. Remote recipes are public-internet
 * only, and the SSRF guard enforces it a second time at fetch.
 */
export const remoteCatalogSchema = catalogSchema.superRefine((cat, ctx) => {
  cat.modules.forEach((entry, i) => {
    if (entry.kind === 'recipe' && entry.recipe.fetch.allowLan) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modules', i],
        message: 'a remote catalogue may not ask a recipe to reach your local network',
      });
    }
  });
});

export type CatalogEntry = z.infer<typeof entrySchema>;
export type ServiceEntry = z.infer<typeof serviceEntry>;
export type RecipeEntry = z.infer<typeof recipeEntry>;
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
    {
      id: 'outside-temperature',
      name: 'Outside temperature',
      author: 'Maverick Wall',
      description:
        'The current temperature where you live, from Open-Meteo — a free, ' +
        'key-less public weather feed. A good first recipe: install it, fill in ' +
        'your latitude and longitude, done.',
      icon: '🌡️',
      kind: 'recipe',
      recipe: {
        name: 'Outside temperature',
        contract: 1,
        config: [
          { key: 'lat', label: 'Latitude', type: 'string', default: '51.5074' },
          { key: 'lon', label: 'Longitude', type: 'string', default: '-0.1278' },
        ],
        fetch: {
          url: 'https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m',
          intervalSeconds: 900,
          allowLan: false,
        },
        panel: {
          kind: 'stat',
          title: 'Outside',
          value: '{current.temperature_2m | round:1}',
          caption: '°C',
        },
        signals: [],
      },
    },
  ],
};

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.modules.find((entry) => entry.id === id);
}
