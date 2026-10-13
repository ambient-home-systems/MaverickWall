import { z } from '../../validation.js';
import { isGlyphKey } from '../../glyphs.js';

/**
 * The Panel Data Schema — the vocabulary a third-party module may put on the
 * wall. See docs/rfc-001-module-framework.md.
 *
 * This is the boundary between a module's HTTP body and the manifest. Strict and
 * capped: an unknown key, a wrong shape, or an over-long string is a rejected
 * poll and a visible `last_error`, never a half-drawn panel (rule five —
 * reject, not coerce). The display sanitises again on the way in; this is where
 * the shape and the limits are enforced.
 *
 * Kept deliberately small: it is both the safety boundary and what keeps a
 * module's panel looking like the wall rather than an arbitrary dashboard.
 */

const str = (max: number): z.ZodString => z.string().max(max);

/**
 * One reading. `glyph` is a key from the first-party vocabulary and nothing
 * else — never a character, never a URL.
 *
 * `icon` is the field this replaced and it is still **accepted and then
 * dropped**, which is deliberate on both halves. Accepted, because the schema
 * is `.strict()` and a module written against the old contract would otherwise
 * have its whole panel refused — a wall losing a widget over a field nobody
 * reads is rule nine. Dropped, because what it carried was an emoji: a
 * third-party asset resolved on the device, which is the fault this change
 * exists to remove and which a module is no more entitled to than we were.
 */
/**
 * What a row is doing (plan item M7.2, contract 2): `active` for a thing that
 * is on, `alert` for one that wants somebody, `idle` for one that is neither —
 * the three the Home Assistant tiles colour their circle by (P5.3). A word from
 * a closed list, never a colour: the theme decides what each looks like, and a
 * module cannot put a colour on the wall that the theme has not measured.
 */
const tone = z.enum(['active', 'alert', 'idle']);

/**
 * How far along something is (plan item M7.3), as a percentage. A number from
 * 0 to 100 and nothing else: a value outside it is a module that has got its
 * arithmetic wrong, and a bar drawn past its own end, or a ring wound twice,
 * would say something the module did not mean. Refused rather than clamped.
 */
const progress = z.number().finite().min(0).max(100);

/**
 * A short run of numbers (plan item M7.4), drawn as a sparkline: from 2 to 48
 * of them, oldest first, and `null` for a gap the line breaks at. Finite or a
 * gap and nothing else — a line through infinity is no picture of anything.
 */
const series = z.array(z.number().finite().nullable()).min(2).max(48);

const reading = z
  .object({
    label: str(60),
    value: str(60),
    glyph: str(24).optional(),
    icon: str(4).optional(),
    tone: tone.optional(),
    progress: progress.optional(),
    series: series.optional(),
  })
  .strict()
  .transform(({ label, value, glyph, tone: rowTone, progress: rowProgress, series: rowSeries }) => ({
    label,
    value,
    ...(isGlyphKey(glyph) ? { glyph } : {}),
    ...(rowTone === undefined ? {} : { tone: rowTone }),
    ...(rowProgress === undefined ? {} : { progress: rowProgress }),
    ...(rowSeries === undefined ? {} : { series: rowSeries }),
  }));

const tile = z
  .object({
    label: str(60),
    value: str(60),
    tone: tone.optional(),
    progress: progress.optional(),
    series: series.optional(),
  })
  .strict();

export const panelDataSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('readings'),
      title: str(60).optional(),
      items: z.array(reading).min(1).max(12),
    })
    .strict(),
  z
    .object({
      kind: z.literal('stat'),
      title: str(60).optional(),
      value: str(60),
      caption: str(60).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('tiles'),
      title: str(60).optional(),
      items: z.array(tile).min(1).max(12),
    })
    .strict(),
  z
    .object({ kind: z.literal('text'), title: str(60).optional(), text: str(280) })
    .strict(),
  /*
   * One reading drawn as a ring (plan item M7.3): how full the ring is is
   * `progress`, and `value` is the words in the middle, which the module
   * writes ("45%", "3 of 8") because only it knows what its number is of.
   * The one large reading a module panel may carry, and capped against the
   * event text the way the clock is (decision D1), so it can never be a stat
   * tile with a ring round it.
   */
  z
    .object({
      kind: z.literal('gauge'),
      title: str(60).optional(),
      label: str(60),
      value: str(60),
      progress,
      tone: tone.optional(),
    })
    .strict(),
  /*
   * A small table (plan item M7.4): one to four named columns and up to twelve
   * rows, every row exactly as many cells as there are columns. Fixed columns,
   * so the wall can lay them out from the column count alone and a box too
   * short for every row gives up whole rows, never a cell.
   */
  z
    .object({
      kind: z.literal('table'),
      title: str(60).optional(),
      columns: z.array(str(24)).min(1).max(4),
      rows: z.array(z.array(str(40)).min(1).max(4)).min(1).max(12),
    })
    .strict()
    .refine((table) => table.rows.every((row) => row.length === table.columns.length), {
      message: 'Every row of a table has one cell for each column.',
    }),
]);

export type PanelData = z.infer<typeof panelDataSchema>;
