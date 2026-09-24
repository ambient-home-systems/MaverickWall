/**
 * Every widget type's designed variants (RFC 014 §4.2), decided as data.
 *
 * A variant is the same reading drawn a different way on purpose — the Swiss
 * month grid's shape, one widget along — and it was the clock's alone until
 * the September household review asked for weather, countdown, Home Assistant
 * and calendar looks (plan item P4.1). This file is what `clockVariant` in
 * `clock-face.ts` used to be, generalised: one ordered list of values per
 * type, the default first, one label per value, and one resolver.
 *
 * `variant` is **one enum for every type** (`api/widget-schema.ts`), the way
 * `mode` is, because the editor's Look picker is generic and a key per widget
 * would be six names for one idea. So a stored value a type's list does not
 * name is a variant for some other widget — "not for me" — and that type draws
 * its default, the same way a Weather widget reads a shift field in `fields`
 * as nothing to do with it.
 *
 * **Only the clock's variants draw anything yet.** The other lists are the
 * values the plan names, added ahead of their drawings so the schema, the
 * editor and the panel's honours tables have one shape to grow into; every
 * renderer draws its type's default for every one of them until the session
 * that designs it (P5.1–P5.4). `browser-widget-looks.test.ts` holds the wall
 * to that and `epaper-ink.test.ts` holds the panel to it.
 *
 * Pure, with no DOM, for the reason `widget-options.ts`, `ink.ts` and
 * `ladder.ts` are: the renderer builds nodes and does no thinking, and there is
 * no DOM in this package's test suite, so a rule decided inside a
 * `createElement` call is a rule nothing can check.
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

/**
 * The controls each variant does not use, by the `data-cfg-key` the editor
 * annotates them with (plan item P4.1).
 *
 * `buildClockConfig`'s early returns written down as data: an analogue face
 * has no digits to format and no date line, and a stacked clock always draws
 * its date. An option that does nothing is worse than one not offered, so the
 * editor removes these after the type's own controls are built, reading the
 * lane's own config — so the ink lane asks what the *panel* will draw.
 *
 * Mapped over `VARIANTS`, so every value has to state what it hides, even when
 * the answer is nothing. **Every value but the clock's hides nothing today**,
 * and that is a statement rather than a gap: each one still draws its type's
 * default, so every control on it still does exactly what it did, and hiding
 * one would take a working setting off the screen. The session that designs a
 * look writes its list here — "`today` hides the day count" is P5.1's — and a
 * control's hint has to carry the same key as the control if it is to go with
 * it.
 *
 * Editor-only, so it sits outside the transcribed block: a panel draws a
 * config and never builds a control.
 */
export const VARIANT_HIDES: {
  readonly [T in VariantType]: Readonly<Record<VariantOf<T>, readonly string[]>>;
} = {
  clock: { plain: [], stacked: ['showDate'], analogue: ['clockFormat', 'showDate'] },
  weather: { strip: [], today: [], range: [], colour: [], playful: [] },
  countdown: { number: [], page: [], ticket: [], occasion: [], progress: [], month: [] },
  homeassistant: { list: [], tile: [] },
  calendar: { '': [], planner: [], bold: [] },
};

/** The control keys the variant this config means does not use. */
export function hiddenByVariant(type: string, config?: unknown): readonly string[] {
  if (!hasVariants(type)) return [];
  const hides = VARIANT_HIDES[type] as Readonly<Record<string, readonly string[]>>;
  return hides[variantOf(type, config)] ?? [];
}

/**
 * The most choices the Look draws as one segmented row.
 *
 * Three is the clock's, and the row the inspector's segmented controls were
 * measured at (`browser-inspector.test.ts`): past it a row of segments in a
 * 258px column starts breaking labels, so a type with more looks than this
 * draws them as a small grid of labelled choices instead.
 */
export const LOOK_SEGMENTS_MAX = 3;

/** Whether this type's Look is drawn as a grid rather than a segmented row. */
export function lookIsGrid(type: string): boolean {
  return variantsFor(type).length > LOOK_SEGMENTS_MAX;
}
