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
const reading = z
  .object({
    label: str(60),
    value: str(60),
    glyph: str(24).optional(),
    icon: str(4).optional(),
  })
  .strict()
  .transform(({ label, value, glyph }) =>
    isGlyphKey(glyph) ? { label, value, glyph } : { label, value },
  );

const tile = z.object({ label: str(60), value: str(60) }).strict();

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
]);

export type PanelData = z.infer<typeof panelDataSchema>;
