import { z } from '../validation.js';
import { GLYPH_KEYS } from '../glyphs.js';
import { recipeSchema } from '../modules/external/recipe.js';
import { STORE_ENTRIES } from '../catalog/index.js';

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
  /**
   * A key from the first-party glyph vocabulary — never a fetched image (rule
   * three), and no longer an emoji either.
   *
   * An emoji here was a third-party asset resolved on whatever device is
   * looking, which the store card shares with the wall; and a store entry's
   * mark can reach a panel, where an emoji is stripped to nothing. `z.enum`
   * rather than a string, so a catalogue entry naming a glyph nobody drew fails
   * the build (`catalog.test.ts`) rather than a household's wall.
   */
  glyph: z.enum(GLYPH_KEYS),
  /**
   * An optional preview of what the module draws — a "screenshot" spelled out in
   * glyphs and text, never a fetched image (rule three). A few short lines: the
   * first is the headline (a big value), the rest a caption or two, echoing how
   * a stat panel reads on the wall. Shown beside the glyph on the store card.
   */
  preview: z.array(z.string().min(1).max(24)).min(1).max(4).optional(),
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

export type CatalogEntry = z.infer<typeof entrySchema>;
export type ServiceEntry = z.infer<typeof serviceEntry>;
export type RecipeEntry = z.infer<typeof recipeEntry>;
export type Catalog = z.infer<typeof catalogSchema>;

/**
 * The store — the curated, in-repo list of modules a household can install.
 *
 * The entries live one-file-per-module in `apps/server/src/catalog/`, listed by
 * its `index.ts`; this is only the schema and the assembly. A module is added by
 * pull request against that directory (`docs/adding-to-the-store.md`) and ships
 * to everyone in the next release. Baked into the image, so it works on a wall
 * with no internet. Every entry advertised here is real and installable — an
 * entry for a module nobody could run would be worse than an empty list.
 */
export const CATALOG: Catalog = { version: 1, modules: [...STORE_ENTRIES] };

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.modules.find((entry) => entry.id === id);
}

/**
 * The glyph-only preview lines for a store card, or none.
 *
 * An authored `preview` wins — a person wrote it to read well. Failing that, a
 * *recipe* derives one from its own `panel`, so a recipe author gets a preview
 * for free and it can never drift from what the module actually draws. A
 * service with no authored preview has nothing to derive from — its panel lives
 * in a process we do not run — and shows its glyph alone.
 */
export function previewFor(entry: CatalogEntry): readonly string[] | undefined {
  if (entry.preview !== undefined) return entry.preview;
  if (entry.kind === 'recipe') return recipePreview(entry.recipe);
  return undefined;
}

/** A live value the preview cannot compute without fetching — shown as this. */
const LIVE_VALUE = '—';

/**
 * One template part as the preview should show it. A literal (interpolating
 * nothing) is shown as written; a part that reads live data (`{selector}`)
 * becomes the placeholder — so the preview carries the panel's authored labels
 * and marks where a live value goes, without inventing data.
 */
function literalOr(part: string | undefined, placeholder: string): string {
  if (part === undefined) return '';
  return part.includes('{') ? placeholder : part;
}

/**
 * A preview derived from a recipe's own `panel` shape. Not authored, so it
 * shows the shape rather than data: the panel's literal labels, with a
 * placeholder where the live value would be, mirroring how each kind reads on
 * the wall (a stat's value+unit over its title; a readings row; …).
 */
export function recipePreview(recipe: RecipeEntry['recipe']): readonly string[] | undefined {
  const panel = recipe.panel;
  const lines: string[] = [];
  if (panel.kind === 'stat') {
    const value = literalOr(panel.value, LIVE_VALUE);
    const caption = literalOr(panel.caption, '');
    lines.push(caption === '' ? value : `${value} ${caption}`);
    lines.push(literalOr(panel.title, ''));
  } else if (panel.kind === 'text') {
    lines.push(literalOr(panel.title, ''));
    lines.push(literalOr(panel.text, LIVE_VALUE));
  } else {
    // readings / tiles: a repeater over live rows. A literal title is kept; an
    // absent or templated one falls back to the kind's name, so the line is
    // never blank or a bare placeholder.
    const literalTitle = panel.title !== undefined && !panel.title.includes('{');
    lines.push(literalTitle ? panel.title! : panel.kind === 'tiles' ? 'Tiles' : 'Readings');
    lines.push(
      `${literalOr(panel.items.label, LIVE_VALUE)} ${literalOr(panel.items.value, LIVE_VALUE)}`.trim(),
    );
  }
  const kept = lines
    .filter((line) => line !== '')
    .map((line) => (line.length > 24 ? line.slice(0, 23) + '…' : line))
    .slice(0, 4);
  return kept.length === 0 ? undefined : kept;
}
