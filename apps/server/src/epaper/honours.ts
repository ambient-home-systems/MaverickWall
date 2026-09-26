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

/*
 * **A key inside the style lane is written `style.<key>`** (RFC 014 §4.1).
 * `config.style` is one strict object holding a widget's colours, faces,
 * weight, tracking and inset, and a panel honours exactly one of those —
 * `inset` moves the frame's own padding and so moves ink. The rest cannot
 * draw on one bit and are in `PANEL_IGNORES` under the same dotted spelling,
 * so the sentence a household reads is beside the control they set.
 * `epaper-ink.test.ts` expands the schema's `style` key into its members the
 * same way and probes each by *setting it inside `style`* — so `style.inset`
 * is proved to move ink and `style.--bg` proved not to, by rendering, exactly
 * as every top-level key is.
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
const STYLE_INSET = 'style.inset';

/*
 * **`whenEmpty` is honoured by every type that can be left out, and by no
 * other** (RFC 014 §5.3). It is resolved before either renderer, in
 * `keepWidgetsWithSomethingToSay`, so a panel substitutes exactly where the
 * wall does — which is the reason it is in this table at all rather than
 * beside the ink lane. But this table is a fact derived by rendering, and a
 * clock, a calendar, a note, a countdown, a picture and a module's panel are
 * never omitted (`widgetIsSetUp`), so a fallback on one of them cannot move
 * ink and naming it there would be the entry this table exists not to carry.
 * A to-do box is omittable only when it names a list, which is why it is here
 * and why `epaper-ink.test.ts` probes it from a list-backed base.
 */
const WHEN_EMPTY = 'whenEmpty';

export const PANEL_HONOURS: Readonly<Record<string, readonly string[]>> = {
  clock: ['title', 'showTitle', 'align', 'clockFormat', 'showDate', 'variant', STYLE_INSET],
  // `showShifts` since plan item P5.4: the rota's short code beside the day
  // number, in one bit, whichever look the wall wears — so the switch moves
  // ink and the look does not (`PANEL_IGNORES` carries `shiftStyle`).
  calendar: ['title', 'showTitle', 'mode', 'cellEvents', 'count', 'calendars', 'showShifts', STYLE_INSET],
  shift: ['title', 'showTitle', 'people', 'fields', 'shiftName', 'showHours', STYLE_INSET, WHEN_EMPTY],
  // `variant` since P5.1: `range` is drawn as black bars. The panel honours
  // the key and falls back per value — `PANEL_LOOKS` says which values.
  weather: ['title', 'showTitle', 'count', 'fields', 'showLow', 'showIcon', 'variant', STYLE_INSET, WHEN_EMPTY],
  // `variant` since P5.3: the `tile` look is drawn as outlined boxes with a
  // disc filled for a reading that is on or wrong, and `tileLayout`,
  // `hideState` and `showBar` are the tile's own. `showChanged` is not —
  // `PANEL_IGNORES` says why.
  homeassistant: [
    'title', 'showTitle', 'count', 'fields', 'readings', 'variant', 'tileLayout', 'hideState', 'showBar',
    STYLE_INSET, WHEN_EMPTY,
  ],
  external: ['title', 'showTitle', 'count', 'module', STYLE_INSET],
  // `variant` and `unitWords` since P5.2: `page`, `ticket`, `progress` and
  // `month` are drawn as still frames, and "sleeps" is words. `PANEL_LOOKS`
  // says which looks. `from` is the start a progress bar counts from.
  countdown: ['title', 'showTitle', 'target', 'variant', 'unitWords', 'from', STYLE_INSET],
  notes: ['title', 'showTitle', 'align', 'text', STYLE_INSET],
  // `list` and `showDone` are read the way the wall reads them (RFC 012 §6.3):
  // a list absent means the typed items, present means that list's rows.
  todo: ['title', 'showTitle', 'items', 'list', 'showDone', STYLE_INSET, WHEN_EMPTY],
  image: ['title', 'showTitle', 'image', STYLE_INSET],
  /*
   * A group (RFC 014 §5.1) draws its frame, its title and its children's
   * cells: `layout` moves every child and `columns` moves a grid's. Not
   * `whenEmpty`, deliberately — a group carries no fallback of its own, its
   * children are boxes and each resolves theirs, and the group goes whole
   * when none of them has anything to say (`keepWidgetsWithSomethingToSay`).
   */
  group: ['title', 'showTitle', 'layout', 'columns', STYLE_INSET],
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
  // Every clock variant draws on one bit — `stacked` as three lines, and
  // `analogue` as a face rasterised at the box's short side — so the Look is
  // offered on the lane whole, and a panel may take a different one from the
  // wall it follows: a face reads at a glance from a doorway where a small
  // panel's digits do not.
  clock: ['variant', 'clockFormat', 'showDate', 'align'],
  // `showShifts`: whether the panel draws the rota's codes is how much it says,
  // and a following panel may say less than its wall or more than one whose
  // week view keeps them off. The look is the wall's alone.
  calendar: ['mode', 'cellEvents', 'count', 'calendars', 'showShifts'],
  shift: ['people', 'fields', 'shiftName'],
  // The Look, since P5.1 — offered as `INK_LOOKS` narrows it: a panel may
  // take the range where its wall wears the strip, which is density and shape.
  weather: ['count', 'fields', 'variant'],
  // The Look, since P5.3: a panel may draw tiles where its wall draws the
  // list, or the other way round — shape, which is what the lane is for. The
  // tile's own options stay with the wall's settings.
  homeassistant: ['readings', 'fields', 'count', 'variant'],
  external: ['count'],
  notes: ['align'],
  // The Look and the words, since P5.2: a panel may draw the page where its
  // wall draws the number, which is shape — and "sleeps" is a household's
  // own way of counting, which a panel in a child's room may want and the
  // kitchen's may not. The date and the label are identity and stay put.
  countdown: ['variant', 'unitWords'],
  // `list` is honoured and deliberately absent: it is the widget's identity,
  // and the lane offers density and shape, never a different list on the
  // panel from the one on the wall. `showDone` is a display decision the same
  // way, and stays with the wall's own settings.
  todo: [],
  image: [],
  // A panel could honestly lay a group out differently from the wall it
  // follows — a row on the wall, a column on a narrow panel — and that is
  // density and shape, which is what the lane is for. Empty until the editor
  // can make a group at all (RFC 014 §5.1's second session): a lane offered
  // on a box no control can select is a control nobody can reach.
  group: [],
};

/**
 * The Looks each type's panel draws **as their own**, beyond its default —
 * a fact about the renderer, derived back out of it by `epaper-ink.test.ts`,
 * which renders every value on every type and holds this table to which ones
 * moved the frame (plan item P5.1).
 *
 * `PANEL_HONOURS` says a panel *reads* `variant`; this says which values it
 * draws differently. They are separate because a forecast honours the key and
 * falls back per value: `range` is drawn as black bars and `today` as its
 * large reading with the time it was read ("52F at 07:15"), and `colour` and
 * `playful` are drawn as the strip — `colour` because a condition colour is
 * exactly what one bit does not have, and `playful` because its pictures are
 * bundled colour artwork with no one-bit drawing (D3 defers those). A type is
 * here exactly when it honours `variant`.
 */
export const PANEL_LOOKS: Readonly<Record<string, readonly string[]>> = {
  clock: ['stacked', 'analogue'],
  weather: ['range', 'today'],
  // The page, the ticket, the progress bar and the mini month as still frames
  // (P5.2). `occasion` is drawn as the number: its colours, motif and scene
  // are three things one still bit has none of.
  countdown: ['page', 'ticket', 'progress', 'month'],
  // Tiles, as outlined boxes with the disc filled for a reading that is on or
  // wrong (P5.3) — the one colour a tile has, said in the one way a bit can.
  homeassistant: ['tile'],
};

/**
 * The Looks the ink lane offers, per type, where that is fewer than the type
 * has. Absent is every one of them — the clock's three, all drawn on one bit.
 *
 * A forecast's lane offers the strip, `today` and `range`: the default and the
 * two looks the panel draws as its own — `range` as black bars and `today` as
 * a large temperature stamped with its time (P5.1). `colour` and `playful` are
 * never offered here: one has no colour to draw and the other's emoji have no
 * one-bit artwork (D3).
 */
export const INK_LOOKS: Readonly<Record<string, readonly string[]>> = {
  weather: ['strip', 'today', 'range'],
  // The five a panel draws (P5.2). `occasion` is never offered: it falls
  // back to the number on a panel for good, its motif being colour and motion
  // the panel has neither of, so choosing it on the lane would be a control
  // that moves nothing.
  countdown: ['number', 'page', 'ticket', 'progress', 'month'],
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
  /**
   * The widget types the note is about, when it is not every one of them.
   *
   * Absent is every type, which is what every note but one means: a panel
   * draws no shadow on anything. The exception is `variant`, which is one
   * enum shared by every type (plan item P4.1) and honoured by the *clock* —
   * so it cannot be an ignore for every type, and it cannot be left in
   * neither table for the others either, because a household who picks a
   * weather look on the wall deserves the sentence on the panel. A scoped
   * note is held to the same test by rendering, on exactly its types, and
   * `epaper-ink.test.ts` refuses one that names a type which honours its key.
   */
  readonly types?: readonly string[];
  /** The control's own words, so the note names what the household sees. */
  readonly label: string;
  readonly why: string;
}

/**
 * A setting that is a **column beside a widget's config** rather than a key in
 * it (RFC 014 §7): `layout_widgets.custom_css`, the widget's own CSS. Both
 * tables are keyed on `widgetConfigBody` and `epaper-ink.test.ts` closes them
 * against it, so a column has to be named here to be allowed into
 * `PANEL_IGNORES` at all — it is not a config key, and the test's own
 * `SCHEMA_KEYS` would otherwise refuse it as "not a stored option". It is
 * listed there because the sentence beside it is the one the Advanced page
 * states verbatim, and a household deserves to read it wherever the panel's
 * limits are read. `toEpaperWidgets` carries no such field, so the panel's
 * draw cannot read it by any route; the test still probes it by setting the
 * key and watching no ink move, as it does every other entry.
 */
export const WIDGET_ROW_KEYS: readonly string[] = ['customCss'];

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
  /*
   * The rota's look (plan item P5.4). A panel draws the rota as the shift's
   * short code beside the day number — the `label` look — whichever of the
   * four the wall wears, because the other three are a wash, a coloured rule
   * and a coloured dot, and one bit has none of them. `showShifts` itself is
   * honoured: it is what puts the code there or takes it away.
   */
  {
    key: 'shiftStyle',
    types: ['calendar'],
    label: 'Shift style',
    why: 'a panel draws the rota as the shift’s short code beside the date, whichever look is chosen.',
  },
  /*
   * The `playful` forecast's advice line (plan item P5.1). A panel draws that
   * look as its strip — its pictures are colour artwork with no one-bit
   * drawing — and the strip carries no advice, so the switch moves no ink on
   * any panel, and `epaper-ink.test.ts` proves that by setting it.
   */
  {
    key: 'advice',
    label: 'Advice line',
    why: 'a panel draws the playful forecast as its strip, and the strip has no advice line.',
  },
  /*
   * A widget's Look (plan item P4.1), on every type that has looks but the
   * clock, the forecast, the countdown and Home Assistant. The clock's three
   * are drawn on one bit and are in `PANEL_HONOURS`, and so is the forecast's
   * key since P5.1, the countdown's since P5.2 and Home Assistant's since P5.3
   * (`PANEL_LOOKS`);
   * every other type's looks were added to the enum before any of them was
   * designed, and each type's panel draw reads none of them — it draws the
   * type's default, which is also exactly what the wall draws for them until
   * the session that designs each (P5.1–P5.4) decides, per look, what one bit
   * can carry. One note per type, because the sentence is about what *this*
   * widget's panel draws instead, and `epaper-ink.test.ts` probes every value
   * the schema holds on each type to keep both true.
   */
  {
    key: 'variant',
    types: ['calendar'],
    label: 'Look',
    why: 'a panel draws the calendar in its standard look, whichever look is chosen.',
  },
  /*
   * A countdown's picture and its confetti (plan item P5.2). The panel draws
   * the same words — "Today!" on the day, "sleeps" if asked — and neither of
   * these: its alphabet is ASCII and its ink does not move.
   */
  {
    key: 'emoji',
    label: 'Picture',
    why: 'the panel has no colour artwork, so the picture is the wall’s alone.',
  },
  {
    key: 'celebrate',
    label: 'Celebrate on the day',
    why: 'a panel is always still, so it says “Today!” and throws no confetti.',
  },
  /*
   * The `occasion` look's occasion (plan item P5.2). A panel draws that look
   * as the number — its accent pair, its motif and its scene are colour,
   * artwork and motion — so which occasion it is dressed for moves no ink,
   * and `epaper-ink.test.ts` proves it by setting it on an occasion base.
   */
  {
    key: 'occasion',
    label: 'Occasion',
    why: 'a panel draws the occasion as the plain number: its colours, picture and moving scene are the wall’s alone.',
  },
  /*
   * A tile's "5 min ago" (plan item P5.3). A panel shows one frame for as long
   * as an hour, so the words would be wrong within the minute — and keeping
   * them true would refresh a battery panel every minute, the churn P3.5 took
   * out of every frame. `epaper-ink.test.ts` proves it moves no ink from a
   * tile base whose reading carries a time.
   */
  {
    key: 'showChanged',
    label: 'When it changed',
    why: 'a panel shows one picture for up to an hour, so “5 min ago” would be wrong within the minute.',
  },
  /*
   * `showTimes` is accepted and read by nothing, on the wall as here (plan
   * item P5.4, part 6): no control writes it and the schema keeps it only so a
   * stored config carrying it is not refused. `showLocations` is the wall
   * agenda's now — a place after the title where it fits on the title's last
   * line — and a panel's agenda row is one line of time and title, with no
   * room to put one.
   */
  { key: 'showTimes', label: 'Event times', why: 'the panel draws the title alone in a cell.' },
  {
    key: 'showLocations',
    label: 'Event locations',
    why: 'a panel’s agenda row is one line, a time and a title, with no room for the place.',
  },
  /*
   * The comfortable month's four looks (plan item P5.4, part 4). A panel's
   * month is its own drawing in one bit: today is the filled cell and the
   * weeks are the grid's own lines, the box's header already names the month,
   * and an event's calendar is a colour the panel does not have. None of the
   * four moves ink, and `epaper-ink.test.ts` proves each by setting it.
   */
  {
    key: 'todayStyle',
    types: ['calendar'],
    label: 'Today',
    why: 'a panel marks today by filling its cell, whichever look is chosen.',
  },
  {
    key: 'monthHeading',
    types: ['calendar'],
    label: 'Month heading',
    why: 'a panel draws the grid alone, without a heading above it.',
  },
  {
    key: 'eventMark',
    types: ['calendar'],
    label: 'Event marks',
    why: 'a calendar’s mark is its colour, and a panel has one colour.',
  },
  {
    key: 'gridLines',
    types: ['calendar'],
    label: 'Week rules',
    why: 'a panel draws every cell’s own outline, whichever rules are chosen.',
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
  /*
   * The style lane (RFC 014 §4.1), member by member, under the `style.<key>`
   * spelling the note above `PANEL_HONOURS` explains. One reason for the
   * eleven colours and one each for the faces, the weight and the tracking,
   * so the editor can fold them into a line apiece rather than fifteen.
   */
  ...(
    [
      ['--bg', 'Background colour'],
      ['--panel', 'Card colour'],
      ['--rule', 'Rule colour'],
      ['--ink', 'Text colour'],
      ['--muted', 'Muted text colour'],
      ['--faint', 'Faint text colour'],
      ['--accent', 'Accent colour'],
      ['--s-day', 'Day shift colour'],
      ['--s-night', 'Night shift colour'],
      ['--s-break', 'Rest day colour'],
      ['--s-straight', 'Straight shift colour'],
    ] as const
  ).map(([token, label]) => ({
    key: `style.${token}`,
    label,
    why: 'a panel has one colour of ink, so a colour chosen here is the wall’s alone.',
  })),
  {
    key: 'style.--disp',
    label: 'Heading face',
    why: 'the panel draws its own bitmap alphabet, at the size its ladder picks.',
  },
  {
    key: 'style.--f-sans',
    label: 'Text face',
    why: 'the panel draws its own bitmap alphabet, at the size its ladder picks.',
  },
  {
    key: 'style.weight',
    label: 'Weight',
    why: 'the panel’s alphabet has one weight, thickened only where it is reversed out.',
  },
  {
    key: 'style.tracking',
    label: 'Tracking',
    why: 'the panel’s alphabet has one advance per face.',
  },
  // A lane's shadow (P5.3) can only ever be none, and a panel draws no
  // shadow for anything — the `shadow` note's reason, one level down.
  {
    key: 'style.shadow',
    label: 'Shadow',
    why: 'a shadow needs a grey the panel does not have.',
  },
  /*
   * The widget's own CSS (RFC 014 §7, precondition 3), with the sentence the
   * editor states beside the textarea, word for word — `CUSTOM_CSS_PROMISE`
   * in `api/custom-css.ts`, held to this by `custom-css-page.test.ts`. A
   * panel draws one bit from a widget's config and reads no stylesheet, and
   * the same is true of the wall's own block (`screens.custom_css`), which is
   * in neither table for the reason the gutter and the style lane are.
   */
  {
    key: 'customCss',
    label: 'Custom CSS',
    why: "Class names may change between releases; a panel ignores this; the wall's own rules about motion and size are not enforced here.",
  },
];

/*
 * **Where the to-do tick is, and why it is in neither table** (RFC 012 §11).
 *
 * A panel draws a to-do list and cannot tick it. That is right — a sleeping
 * ESP32 has nothing to press and nothing to press it with, and the box has to
 * be *absent* rather than inert, which is what `drawTodo`'s read-only row
 * already draws. The obvious bookkeeping is therefore a `PANEL_IGNORES` entry
 * saying so on the wall's own settings, beside "Run position" and "Shift
 * colours".
 *
 * It does not belong there, and the reason is the shape of these tables rather
 * than a judgement about the tick. Both of them are keyed on **a widget's
 * config** — `widgetConfigBody`'s own keys, which the set is closed against, so
 * a key in neither fails rather than falling quietly between them. Whether a
 * wall may tick is not one: it is `screens.allow_todo`, a fact about the
 * *screen*, set on the wall's settings page beside alert dismissal and the
 * chore tick, and it is not in a widget's config at all. Putting it here would
 * mean inventing a key no schema has, on a table whose whole worth is that it
 * is derived from the renderer by rendering — and `epaper-ink.test.ts` proves
 * `PANEL_IGNORES` by setting each key and watching no ink move, which it could
 * not do for a key that cannot be set.
 *
 * What answers the household's question instead is the switch's own page: an
 * e-paper panel's settings have never offered alert dismissal or the chore tick
 * either, for the identical reason, and a panel that followed a wall's canvas
 * has never inherited that wall's permission — `allow_todo` is read off the
 * screen the request arrived on, and a panel's request reaches no tick
 * endpoint at all.
 */

/*
 * **Where the canvas gutter is, and why it is in neither table** (RFC 014 §4.4).
 *
 * The identical argument as the to-do tick above, and it is worth stating
 * rather than leaving to be re-derived, because the gutter looks far more like
 * a `PANEL_IGNORES` entry than the tick does: it is spacing, a panel plainly
 * does not draw it, and "a panel spaces itself" is exactly the sentence that
 * table exists to put beside a control.
 *
 * It cannot go there. Both tables are keyed on **a widget's config** — the set
 * is closed against `widgetConfigBody`, and `epaper-ink.test.ts` asserts of
 * every entry that `SCHEMA_KEYS` contains its key, then proves the entry by
 * *setting that key on a widget and watching no ink move*. `layout_gutter` is
 * a column on `screens`, like `allow_todo`, `rotation` and `lan_only`: there
 * is no widget config to set it on, so an entry would be a key no schema has
 * on a table whose whole worth is that it is derived by rendering. Adding one
 * turns that file red rather than satisfying it, and the closure check it
 * would supposedly satisfy iterates `SCHEMA_KEYS` and never sees a screen
 * column at all.
 *
 * What answers the household's question instead is the control's own page: the
 * gutter row is on a *wall's* layout settings, and an e-paper panel's settings
 * have never carried it — the same place alert dismissal, the chore tick and
 * the to-do tick are answered. A panel's every measurement is arithmetic on
 * the panel (`epaper/metrics.ts`, and `MARGIN` in particular is derived from
 * its short side), so there is nothing for a wall's step to override even when
 * that panel is *following* the wall: it draws its own frame, at its own
 * geometry, from the same canvas.
 */

/*
 * **Where a wall's Motion switch is, and why it is in neither table** (plan
 * P4.3). `screens.motion` is a column on `screens`, so the gutter's argument
 * above applies verbatim: there is no widget config to set it on. And there is
 * nothing on a panel for it to govern — a frame is a packed 1-bit raster drawn
 * on the server, so every style draws its still frame there whatever the wall
 * it follows is allowed to do. `motion-scope.test.ts` holds the panel path to
 * reaching no stylesheet at all, which is the fact rather than the promise.
 */

/*
 * **Where the wall's default style lane is, and why it is in neither table**
 * (RFC 014 §4.1 / §4.4).
 *
 * `screens.layout_style` is the gutter's argument two paragraphs up, verbatim:
 * a column on `screens` with no widget config to set it on, so an entry would
 * be a key no schema has on a table whose worth is that it is derived by
 * rendering. A widget's *own* `style.inset` is honoured above, because that
 * one is in a widget's config and moves the frame's padding on one bit; the
 * wall-level default is applied on the browser wall's canvas and a panel
 * following that wall draws its own frame at its own geometry from the same
 * canvas, exactly as it does for the gutter step.
 */

/*
 * **A panel follows a wall's default canvas only, and the schedule is in
 * neither table** (RFC 014 §5.2).
 *
 * A wall may hold named canvases the clock picks between — `layout_widgets.slot`
 * and `layout_schedule` — and a panel following that wall draws its *default*
 * slot and nothing else, at every hour. Not a limitation somebody forgot to
 * lift: a battery panel is a glance class, asleep for most of an hour showing
 * a frame it drew earlier, so a canvas that must change at 06:30 is one it
 * cannot honour and must not pretend to. `readLayoutWidgets` reads the default
 * slot unless told otherwise, and neither the frame route nor the design page
 * ever tells it otherwise, so the promise is a property of the reads rather
 * than of a flag. The schedule itself is a table keyed on the screen, not a
 * widget config, so it belongs in neither honours table for the reason the
 * gutter and the style lane above do; the panel's own page says in words that
 * a scheduled layout never reaches it, which is where a household would look.
 */

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
