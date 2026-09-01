/**
 * How large a wall is, and how far away it is read from.
 *
 * Two facts about the hardware, the same kind as `screens.rotation` and
 * `screens.orientation`, and the ones nothing in this product has ever had.
 * Every decision about whether a name on a wall can be *read* — a type floor,
 * a minimum scale, how many rows a month cell may spend — is an angle at the
 * eye rather than a count of pixels, and an angle needs a size and a distance.
 * Without them each such constant is a measurement taken on one screen and
 * defended on every other.
 *
 * A household will not fetch a tape measure, so the list below is what they
 * can recognise from across the room: the panel they bought, or the
 * television it is. Only "Enter my own" asks for a measurement, and the
 * distance stays editable whichever they pick, because the size is a fact
 * about the hardware and the distance is a fact about the *room* — the same
 * 32" television in a hall and in a kitchen is read from different places.
 *
 * Top level rather than under `http/` because the form offers these and the
 * manifest bounds-checks against them; a fact both layers read belongs beside
 * `timezone.ts` rather than inside either one.
 */

export interface WallSizePreset {
  /** Stored in no column — it is a form value, resolved to millimetres here. */
  readonly key: string;
  readonly label: string;
  /**
   * The active area, long side first — the panel's own way up, not the wall's.
   *
   * `mountedSize` is what turns a preset to how the thing is actually hung.
   */
  readonly widthMm: number;
  readonly heightMm: number;
  /** Where somebody stands to *read* one of these, not to glance at it. */
  readonly readAtMm: number;
}

/**
 * Active areas, not diagonals-times-a-guess: the numbers below are the drawn
 * picture, which is what the arithmetic needs. A bezel is not legible.
 */
export const WALL_SIZE_PRESETS: readonly WallSizePreset[] = [
  { key: 'eink-7.5', label: '7.5 inch e-ink panel', widthMm: 163, heightMm: 98, readAtMm: 600 },
  { key: 'eink-10.3', label: '10.3 inch e-ink panel', widthMm: 209, heightMm: 157, readAtMm: 700 },
  { key: 'eink-13.3', label: '13.3 inch e-ink panel', widthMm: 270, heightMm: 202, readAtMm: 800 },
  { key: 'tablet-10', label: '10 inch tablet', widthMm: 217, heightMm: 136, readAtMm: 800 },
  { key: 'monitor-24', label: '24 inch monitor', widthMm: 531, heightMm: 299, readAtMm: 1000 },
  { key: 'tv-32', label: '32 inch television', widthMm: 708, heightMm: 398, readAtMm: 1200 },
  { key: 'tv-43', label: '43 inch television', widthMm: 952, heightMm: 535, readAtMm: 1600 },
  { key: 'tv-55', label: '55 inch television', widthMm: 1218, heightMm: 685, readAtMm: 2000 },
];

/** "Enter my own": a form value that is not a preset, named once for both sides. */
export const WALL_SIZE_CUSTOM = 'custom';

/**
 * The band a measurement has to be in to be one.
 *
 * Wide on purpose. Refusing a household's honest answer is worse than taking
 * an odd one, so these only have to exclude a value that cannot be a wall: the
 * smallest panel here draws 98mm and the largest 1218mm, and 20 metres is
 * further than any room this hangs in.
 */
export const PANEL_MM_MIN = 10;
export const PANEL_MM_MAX = 5000;
export const READ_DISTANCE_MM_MIN = 100;
export const READ_DISTANCE_MM_MAX = 20_000;

export function wallSizePreset(key: string): WallSizePreset | undefined {
  return WALL_SIZE_PRESETS.find((preset) => preset.key === key);
}

/**
 * A preset's numbers, turned to how the wall is hung.
 *
 * `canvasFor`'s rule in millimetres: a quarter turn puts the panel's long side
 * vertical, so the pair swaps and a half turn leaves it alone. Stored that way
 * round because the columns are what a person would measure with a tape while
 * standing in front of the thing — "Width" on the form means across the wall,
 * and a 32" television hung on its end is 398mm across.
 *
 * It is a convenience rather than a load-bearing decision, and deliberately so:
 * a household can turn a wall a year later without re-measuring, and a panel
 * the operating system rotates reports no rotation here at all. The derivation
 * reconciles the pair against the frame it is actually drawing
 * (`pxPerArcminute`), so a stale way-up costs nothing.
 */
export function mountedSize(
  preset: WallSizePreset,
  rotation: number,
): { readonly widthMm: number; readonly heightMm: number } {
  const quarter = ((Math.round(rotation / 90) % 4) + 4) % 4;
  return quarter === 1 || quarter === 3
    ? { widthMm: preset.heightMm, heightMm: preset.widthMm }
    : { widthMm: preset.widthMm, heightMm: preset.heightMm };
}

/**
 * Which preset a stored pair came from, whichever way up it was stored.
 *
 * Compared as a set rather than as an ordered pair, because `mountedSize` may
 * have swapped it — a wall hung sideways must still show the television it is
 * rather than dropping the household onto "Enter my own" and implying they
 * typed numbers they never typed.
 */
export function matchWallSize(
  widthMm: number | null,
  heightMm: number | null,
): WallSizePreset | undefined {
  if (widthMm === null || heightMm === null) return undefined;
  const long = Math.max(widthMm, heightMm);
  const short = Math.min(widthMm, heightMm);
  return WALL_SIZE_PRESETS.find(
    (preset) =>
      Math.max(preset.widthMm, preset.heightMm) === long &&
      Math.min(preset.widthMm, preset.heightMm) === short,
  );
}

/**
 * The three, or nothing.
 *
 * All-or-nothing because two of them derive nothing — a size with no distance
 * is not half an answer, it is no answer — and because "absent" has to stay
 * one state rather than four. Out-of-band is read as absent rather than
 * clamped: a clamped typo draws a confidently wrong wall, where dropping it
 * draws the wall the household had yesterday, which is the side rule nine
 * takes.
 */
export interface PhysicalWall {
  readonly panelWidthMm: number;
  readonly panelHeightMm: number;
  readonly readDistanceMm: number;
}

export function physicalWall(
  widthMm: number | null | undefined,
  heightMm: number | null | undefined,
  distanceMm: number | null | undefined,
): PhysicalWall | undefined {
  const sane = (
    value: number | null | undefined,
    low: number,
    high: number,
  ): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high
      ? value
      : undefined;
  const panelWidthMm = sane(widthMm, PANEL_MM_MIN, PANEL_MM_MAX);
  const panelHeightMm = sane(heightMm, PANEL_MM_MIN, PANEL_MM_MAX);
  const readDistanceMm = sane(distanceMm, READ_DISTANCE_MM_MIN, READ_DISTANCE_MM_MAX);
  if (panelWidthMm === undefined || panelHeightMm === undefined || readDistanceMm === undefined) {
    return undefined;
  }
  return { panelWidthMm, panelHeightMm, readDistanceMm };
}

// ---------------------------------------------------------------------------
// The form's three fields, which are one answer
// ---------------------------------------------------------------------------

/** What the wall settings form submits about size, before it means anything. */
export interface WallSizeFields {
  /** A preset key, `custom`, or blank for "not measured". */
  readonly size?: string | undefined;
  readonly widthMm?: string | undefined;
  readonly heightMm?: string | undefined;
  readonly distanceMm?: string | undefined;
}

export type WallSizeChoice =
  | {
      readonly ok: true;
      readonly widthMm: number | null;
      readonly heightMm: number | null;
      readonly distanceMm: number | null;
    }
  | { readonly ok: false; readonly message: string };

/** A whole number of millimetres, or a sentence saying why it is not one. */
function millimetres(
  raw: string | undefined,
  low: number,
  high: number,
  label: string,
): { ok: true; value: number | null } | { ok: false; message: string } {
  const value = (raw ?? '').trim();
  if (value === '') return { ok: true, value: null };
  if (!/^[0-9]+$/.test(value)) {
    return { ok: false, message: `${label} has to be a whole number of millimetres.` };
  }
  const n = Number(value);
  if (n < low || n > high) {
    return { ok: false, message: `${label} has to be between ${low} and ${high} millimetres.` };
  }
  return { ok: true, value: n };
}

/**
 * Three fields, one answer: what to store for this wall's size and distance.
 *
 * Pure, and here rather than inside the handler, for the reason
 * `widget-options.ts` and `ink.ts` are pure: a rule that lives in a route is a
 * rule a test can only reach through a server, one case at a time.
 *
 * Three properties are load-bearing:
 *
 *  - **Blank clears all three, and ignores everything else on the form.** A
 *    browser submits a hidden input just as happily as a visible one, so the
 *    width and height of the wall this used to be are still in the body when
 *    somebody chooses "Not set". Reading them there would make taking a
 *    measurement back impossible from the one control that offers it.
 *  - **A preset fills the size and only *defaults* the distance.** The
 *    distance is a fact about the room, so a household who has typed one keeps
 *    it when they correct the size; one who has not gets the preset's, which
 *    is the whole reason the preset carries one.
 *  - **"Enter my own" wants all three.** Two of them derive nothing, and a
 *    half-filled measurement stored as a measurement is worse than none: it
 *    reads as set on the form and as absent everywhere else.
 */
export function resolveWallSize(fields: WallSizeFields, rotation: number): WallSizeChoice {
  const size = (fields.size ?? '').trim();
  const cleared = { ok: true, widthMm: null, heightMm: null, distanceMm: null } as const;
  if (size === '') return cleared;

  const distance = millimetres(
    fields.distanceMm,
    READ_DISTANCE_MM_MIN,
    READ_DISTANCE_MM_MAX,
    'The reading distance',
  );
  if (!distance.ok) return distance;

  if (size !== WALL_SIZE_CUSTOM) {
    const preset = wallSizePreset(size);
    if (preset === undefined) return { ok: false, message: 'Pick a size from the list.' };
    const mounted = mountedSize(preset, rotation);
    return {
      ok: true,
      widthMm: mounted.widthMm,
      heightMm: mounted.heightMm,
      distanceMm: distance.value ?? preset.readAtMm,
    };
  }

  const width = millimetres(fields.widthMm, PANEL_MM_MIN, PANEL_MM_MAX, 'The width');
  if (!width.ok) return width;
  const height = millimetres(fields.heightMm, PANEL_MM_MIN, PANEL_MM_MAX, 'The height');
  if (!height.ok) return height;
  if (width.value === null || height.value === null || distance.value === null) {
    return {
      ok: false,
      message:
        'Enter the width, the height and the reading distance, or pick a size from the list.',
    };
  }
  return { ok: true, widthMm: width.value, heightMm: height.value, distanceMm: distance.value };
}
