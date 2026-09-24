/**
 * Every widget type's designed variants, on the panel (RFC 014 §4.2, plan
 * item P4.1).
 *
 * The block between the markers is `apps/display/src/variants.ts`'s character
 * for character, and `variants-parity.test.ts` holds the two to it — a panel
 * following a wall reads the same stored `variant`, and one that resolved it
 * differently from the wall would be `shifts[0]` in a Look picker. The wall is
 * the spec: where these disagree, the display file is right.
 *
 * What the panel honours of it is a separate fact, and it lives in
 * `honours.ts` where `epaper-ink.test.ts` derives it by rendering: the clock
 * draws all three of its looks on one bit, the forecast draws `range` as
 * black bars (plan item P5.1) and every other forecast look as its strip, and
 * every other type's looks are, for now, values the panel draws as that type's
 * default — which is what the wall draws for them too, until the sessions that
 * design them. Which looks a panel draws as their own is `PANEL_LOOKS`.
 * The labels are carried with the lists because they are one table per type;
 * the panel draws no picker and reads none of them.
 */

/*
 * variants:begin
 *
 * **This block is transcribed into `apps/server/src/epaper/variants.ts`
 * character for character** and `variants-parity.test.ts` compares the two as
 * text — the seam `tiers.ts`, `month-spans.ts` and `clock-face.ts` already sit
 * at, for the reason they do: the display bundle has no bundler and cannot
 * import the server's copy. A panel following a wall reads the same stored
 * `variant`, and a panel that resolved it differently from the wall would be
 * `shifts[0]` in a Look picker.
 */

/**
 * Every value `config.variant` can hold that each type draws, the default
 * first.
 *
 * The default is also what an absent `variant` means, so a canvas saved before
 * a type had a list sends a byte-identical config and no stored ETag churns.
 * Four of the five defaults are schema members as well as absences, because an
 * ink lane may one day have to say "the default on the panel" beside a wall
 * that says otherwise — the clock's `plain` already does.
 *
 * **The calendar's default is the empty string, and that is an absence rather
 * than a value.** The plan names two calendar looks and no name for the one
 * every calendar already draws, and nothing needs to store it: a panel draws a
 * calendar one way whatever look the wall wears, so no ink lane will ever have
 * to write "the default" for one. The empty string is how the editor's picker
 * spells "leave the key out", the idiom its "Follow the household" time format
 * already uses, and the schema refuses it as a stored value.
 */
export const VARIANTS = {
  clock: ['plain', 'stacked', 'analogue'],
  weather: ['strip', 'today', 'range', 'colour', 'playful'],
  countdown: ['number', 'page', 'ticket', 'occasion', 'progress', 'month'],
  homeassistant: ['list', 'tile'],
  calendar: ['', 'planner', 'bold'],
} as const;

/** A widget type that has designed variants. */
export type VariantType = keyof typeof VARIANTS;
/** The values one type draws. */
export type VariantOf<T extends VariantType> = (typeof VARIANTS)[T][number];

/**
 * The words the editor's Look picker shows for each value.
 *
 * Mapped over `VARIANTS` rather than written beside it, so the compiler holds
 * the two to each other: a value added to a list without a label here, or a
 * label for a value no list names, is a type error rather than a picker with a
 * blank choice in it.
 */
export const VARIANT_LABELS: { readonly [T in VariantType]: Readonly<Record<VariantOf<T>, string>> } = {
  clock: { plain: 'Plain', stacked: 'Stacked', analogue: 'Analogue' },
  weather: { strip: 'Strip', today: 'Today', range: 'Range', colour: 'Colour', playful: 'Playful' },
  countdown: {
    number: 'Number',
    page: 'Tear-off page',
    ticket: 'Ticket',
    occasion: 'Occasion',
    progress: 'Progress',
    month: 'Month',
  },
  homeassistant: { list: 'List', tile: 'Tiles' },
  calendar: { '': 'Standard', planner: 'Planner', bold: 'Bold' },
};

/**
 * Whether a widget type has designed variants at all.
 *
 * An own-property check rather than `in`, because a widget's type is a string
 * from a stored row and `'constructor' in VARIANTS` is true of every object.
 */
export function hasVariants(type: string): type is VariantType {
  return Object.prototype.hasOwnProperty.call(VARIANTS, type);
}

/** The values a type draws, the default first — none for a type without any. */
export function variantsFor(type: string): readonly string[] {
  return hasVariants(type) ? VARIANTS[type] : [];
}

/**
 * The variant a stored config means for this type: its own `variant` when the
 * type's list names it, and the type's default for anything else — absent, a
 * value that belongs to another type, or not a string at all.
 */
export function variantOf<T extends VariantType>(type: T, config?: unknown): VariantOf<T> {
  const raw =
    typeof config === 'object' && config !== null ? (config as Record<string, unknown>)['variant'] : undefined;
  const values: readonly unknown[] = VARIANTS[type];
  return (values.includes(raw) ? raw : values[0]) as VariantOf<T>;
}

/* variants:end */
