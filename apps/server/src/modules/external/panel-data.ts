import { z } from '../../validation.js';

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

const reading = z
  .object({ label: str(60), value: str(60), icon: str(4).optional() })
  .strict();

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
