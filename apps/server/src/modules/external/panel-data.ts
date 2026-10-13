import { z } from '../../validation.js';
import { isGlyphKey } from '../../glyphs.js';
import { QR_MAX_BYTES } from '../../api/qr-payload.js';

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

/**
 * An instant (plan item M7.5): an ISO 8601 date and time with its offset, or
 * `Z`, and nothing a reader has to guess the zone of. A wall reads it against
 * its own corrected clock and draws it in the household's zone, so a module
 * never has to know where the wall hangs.
 */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const instant = z
  .string()
  .max(40)
  .refine((value) => INSTANT.test(value) && Number.isFinite(Date.parse(value)), {
    message: 'A time is an ISO 8601 date and time with its offset, such as 2026-10-16T07:00:00+01:00.',
  });

/**
 * A picture's address (plan item M7.5): http or https, with no name or
 * password in it. The wall never sees it — the server fetches the picture
 * through the guard under the module's own network policy, checks it is a
 * picture by its bytes, and hands the wall a handle (`module-images.ts`).
 */
const pictureUrl = z
  .string()
  .max(2000)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '';
      } catch {
        return false;
      }
    },
    { message: 'A picture’s address is http or https, with no name or password in it.' },
  );

const timelineItem = z
  .object({
    at: instant,
    label: str(60),
    detail: str(60).optional(),
    tone: tone.optional(),
  })
  .strict();

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
  /*
   * A QR code (plan item M7.5): `text` is what the code carries, encoded by
   * the wall's own encoder, so at most the 213 bytes one code holds here;
   * `label` is the words under it. The text is never drawn as words, so it is
   * kept exactly as sent — a vCard's or a Wi-Fi code's line breaks matter.
   */
  z
    .object({
      kind: z.literal('qr'),
      title: str(60).optional(),
      text: z
        .string()
        .min(1)
        .refine((value) => new TextEncoder().encode(value).length <= QR_MAX_BYTES, {
          message: `A code holds at most ${QR_MAX_BYTES} bytes.`,
        }),
      label: str(60).optional(),
    })
    .strict(),
  /*
   * A countdown to an instant (plan item M7.5). The wall works out what is
   * left from its own corrected clock on every draw, so it goes on counting
   * with the server gone; the module says when, never how long.
   */
  z
    .object({ kind: z.literal('countdown'), title: str(60).optional(), label: str(60), at: instant })
    .strict(),
  /*
   * A schedule (plan item M7.5): up to twelve things at their times, in order
   * of time. Refused out of order rather than sorted, so which item is next is
   * never a guess about what the module meant.
   */
  z
    .object({
      kind: z.literal('timeline'),
      title: str(60).optional(),
      items: z.array(timelineItem).min(1).max(12),
    })
    .strict()
    .refine(
      (timeline) => timeline.items.every((item, i, all) => i === 0 || Date.parse(item.at) >= Date.parse(all[i - 1]!.at)),
      { message: 'A timeline’s items are in order of time.' },
    ),
  /*
   * A picture (plan item M7.5), by its address, with a caption under it. See
   * `pictureUrl`: the address stays on the server.
   */
  z
    .object({ kind: z.literal('image'), title: str(60).optional(), url: pictureUrl, caption: str(120).optional() })
    .strict(),
]);

export type PanelData = z.infer<typeof panelDataSchema>;
