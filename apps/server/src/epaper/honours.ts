/**
 * What a panel can honour, and what it plainly cannot (RFC 005, direction B).
 *
 * A widget's stored options are one strict object for every screen, and a
 * black-and-white panel reads a *subset* of it. Until now that subset was
 * implicit — a household set a background colour on a widget, the panel drew a
 * hairline rectangle, and nothing anywhere said why. The whole point of the ink
 * lane is that the difference is stated rather than dropped quietly.
 *
 * Three tables, and the distinction between the first two is the load-bearing
 * one:
 *
 * - `PANEL_HONOURS` is a *fact about the renderer*: the keys `drawWidget` and
 *   its draws actually read for each type. It is not an opinion and not a
 *   design choice, and `epaper-ink.test.ts` derives it back out of the renderer
 *   by rendering frames — set a key, decode the frame, see whether the ink
 *   moved. A key that stops being read fails that test rather than becoming a
 *   control that does nothing, which is the `options.json` bug written down.
 *
 * - `INK_LANE` is what the editor *offers* on the ink lane, and it is a
 *   deliberate subset of what the renderer honours: the keys about how much a
 *   widget says, never about what it is. A panel may show three days where the
 *   wall shows seven, or one person where the wall shows the household; it may
 *   not show a different note, a different image or a different module. One
 *   canvas, two media — not two canvases wearing one name.
 *
 * - `PANEL_IGNORES` is every key the renderer does not read at all, with the
 *   reason a household would accept. These are shown against the wall's own
 *   settings, so "the shadow will not draw" is said where the shadow is set
 *   rather than discovered on a panel bolted to a wall in the hall.
 *
 * The tables are served to the editor in its bootstrap JSON rather than
 * transcribed into the display bundle. The ladder is written twice because the
 * *renderers* both need it; this is only ever read by one of them, so a second
 * copy would be a second copy for nothing — and the parity test that guards the
 * ladder is a guard, not a thing to reach for again.
 */

/**
 * The config keys each widget type's 1-bit draw actually reads.
 *
 * Derived from the renderer by test, not from reading it: `epaper-ink.test.ts`
 * renders a frame with each key set and without, and holds this table to what
 * moved. Both directions — a key here that changes nothing is a lie, and a key
 * the renderer reads that is missing here is an option the ink lane cannot
 * offer.
 */
export const PANEL_HONOURS: Readonly<Record<string, readonly string[]>> = {
  clock: ['title', 'showTitle', 'align', 'clockFormat', 'showDate'],
  calendar: ['title', 'showTitle', 'mode', 'cellEvents', 'count', 'calendars'],
  shift: ['title', 'showTitle', 'people', 'fields', 'shiftName', 'showHours'],
  weather: ['title', 'showTitle', 'count', 'fields', 'showLow'],
  homeassistant: ['title', 'showTitle', 'count', 'fields', 'readings'],
  external: ['title', 'showTitle', 'count', 'module'],
  countdown: ['title', 'showTitle', 'target'],
  notes: ['title', 'showTitle', 'align', 'text'],
  todo: ['title', 'showTitle', 'items'],
  image: ['title', 'showTitle', 'image'],
};

/**
 * What the ink lane offers, per type: density and shape, never identity.
 *
 * A subset of `PANEL_HONOURS` by construction (asserted, not assumed). The keys
 * left out are the ones that would let a panel become a *different widget* —
 * its title, its text, its image, its module, its countdown date. A household
 * looking at a wall and a panel showing the same canvas has to be able to
 * believe they are the same canvas.
 *
 * A type with an empty list has nothing worth saying differently in black and
 * white, and the lane says so rather than opening an empty panel.
 *
 * `showHours` and `showLow` are honoured by the renderer and deliberately *not*
 * here: the ladder replaced both switches, so offering them again would be two
 * controls for one decision, one of which the editor no longer draws anywhere.
 */
export const INK_LANE: Readonly<Record<string, readonly string[]>> = {
  clock: ['clockFormat', 'showDate', 'align'],
  calendar: ['mode', 'cellEvents', 'count', 'calendars'],
  shift: ['people', 'fields', 'shiftName'],
  weather: ['count', 'fields'],
  homeassistant: ['readings', 'fields', 'count'],
  external: ['count'],
  notes: ['align'],
  countdown: [],
  todo: [],
  image: [],
};

/** Every key the ink lane can carry, for the schema and for the merge. */
export const INK_KEYS: readonly string[] = [
  ...new Set(Object.values(INK_LANE).flat()),
].sort();

/**
 * A setting no panel draws, and the reason — written for somebody in a kitchen.
 *
 * Shown in the editor against the wall settings a widget actually has set, so
 * the sentence appears where the decision was made. Not a warning: setting a
 * background on a wall is a perfectly good thing to do, and this only says the
 * panel will not repeat it.
 */
export interface PanelIgnores {
  readonly key: string;
  /** The control's own words, so the note names what the household sees. */
  readonly label: string;
  readonly why: string;
}

export const PANEL_IGNORES: readonly PanelIgnores[] = [
  {
    key: 'background',
    label: 'Card background',
    why: 'a panel has one colour, so a card is drawn as a hairline outline instead.',
  },
  { key: 'opacity', label: 'Opacity', why: 'ink is either there or it is not — there is no half.' },
  {
    key: 'density',
    label: 'Density',
    why: 'compact buys its room from gaps and cards, and a panel is already edge to edge.',
  },
  { key: 'corners', label: 'Rounded corners', why: 'the outline is drawn square at this size.' },
  { key: 'shadow', label: 'Drop shadow', why: 'a shadow needs a grey the panel does not have.' },
  {
    key: 'showFace',
    label: 'Show the photo',
    why: 'the panel draws no photographs yet, so a badge is its words.',
  },
  {
    key: 'showRun',
    label: 'Run position',
    why: "the panel's model does not carry which day of a run it is.",
  },
  {
    key: 'showIcon',
    label: 'Weather symbol',
    why: "the panel's font is plain ASCII and has no weather glyph.",
  },
  {
    key: 'showShifts',
    label: 'Shift colours',
    why: 'the colours are the point, and there are none.',
  },
  { key: 'showTimes', label: 'Event times', why: 'the panel draws the title alone in a cell.' },
  {
    key: 'showLocations',
    label: 'Event locations',
    why: 'the panel draws the title alone in a cell.',
  },
  {
    key: 'showWeather',
    label: "The day's weather",
    why: 'the panel draws the date and the titles only.',
  },
  {
    key: 'showWeekNumbers',
    label: 'Week numbers',
    why: 'the panel draws the date and the titles only.',
  },
];

/**
 * The widget's options as the panel reads them: the wall's, with the ink lane
 * laid over the top.
 *
 * One shallow merge, one level deep, at the one place the panel draws a widget
 * — so every reader downstream (`shiftLadder`, `drawWeather`, `drawFrame`) is
 * unchanged and cannot forget to apply it. `ink` itself is dropped on the way
 * through: nothing below reads it, and leaving it would be one more key for a
 * tolerant reader to trip over.
 *
 * Defensive about its input because a stored config is JSON this process wrote
 * *at some version* — a row from a newer server, or one somebody edited by
 * hand. A non-object `ink` is no override rather than a crash on the one screen
 * the household is looking at.
 */
export function withInk(config: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const raw = config['ink'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    if (!('ink' in config)) return config;
    const { ink: _drop, ...rest } = config;
    return rest;
  }
  const { ink: _drop, ...rest } = config;
  return { ...rest, ...(raw as Record<string, unknown>) };
}
