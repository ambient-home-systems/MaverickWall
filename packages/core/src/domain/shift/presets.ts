import type { RotationBlock } from './rotation.js';

/**
 * Well-known rotations, offered as starting points in setup.
 *
 * These are shapes, not prescriptions: every one of them gets copied into the
 * household's own flat cycle array on selection and is freely editable
 * afterwards. Nobody's real roster survives contact with a preset — there is
 * always a local variation — so the preset's job is to save typing sixty cells,
 * not to be authoritative.
 *
 * Shift keys are generic (`day`, `night`, `straight`). Labels are the
 * household's business.
 */

export interface RotationPreset {
  readonly key: string;
  readonly name: string;
  /** One line for the picker. */
  readonly summary: string;
  readonly cycleDays: number;
  readonly blocks: readonly RotationBlock[];
  /** True when the cycle only makes sense anchored to a particular weekday. */
  readonly anchorNote?: string;
}

export const ROTATION_PRESETS: readonly RotationPreset[] = [
  {
    key: 'ten-week-federal',
    name: 'Ten week, federal pay periods',
    summary:
      'Five fortnights: Days, Days, Mids, Straights, Mids. Work alternates between the front and back of the week.',
    cycleDays: 70,
    anchorNote:
      'Anchor on the Sunday that begins a Days fortnight. Seventy days is exactly five US federal pay periods, so the two cycles stay locked.',
    blocks: [
      {
        // Stated as explicit days rather than patterns. The Days fortnights run
        // 3 on / 4 off / 4 on / 3 off while the Mids fortnights run
        // 4 on / 3 off / 3 on / 4 off — a different phasing, not a mirror — and
        // Straights covers all fourteen days because it is a status for the
        // fortnight rather than a work pattern. Verified against 84 consecutive
        // observed days with no mismatches.
        shiftTypeKey: null,
        label: 'Ten week rotation',
        cells: [
          // Pay period 1 - Days, front of the week
          'day', 'day', 'day', null, null, null, null,
          'day', 'day', 'day', 'day', null, null, null,
          // Pay period 2 - Days, back of the week: the exact complement
          null, null, null, 'day', 'day', 'day', 'day',
          null, null, null, null, 'day', 'day', 'day',
          // Pay period 3 - Mids, back of the week
          null, null, null, null, 'night', 'night', 'night',
          null, null, null, 'night', 'night', 'night', 'night',
          // Pay period 4 - Straights, the whole fortnight
          'straight', 'straight', 'straight', 'straight', 'straight', 'straight', 'straight',
          'straight', 'straight', 'straight', 'straight', 'straight', 'straight', 'straight',
          // Pay period 5 - Mids, front of the week: the complement of period 3
          'night', 'night', 'night', 'night', null, null, null,
          'night', 'night', 'night', null, null, null, null,
        ],
      },
    ],
  },
  {
    key: 'panama',
    name: 'Panama (2-2-3)',
    summary: 'Two on, two off, three on, two off, two on, three off. Fourteen days, seven worked.',
    cycleDays: 14,
    blocks: [
      { shiftTypeKey: 'day', weeks: 2, pattern: 'panama', label: 'Panama' },
    ],
  },
  {
    key: 'panama-rotating',
    name: 'Panama, rotating days and nights',
    summary: 'Four weeks: a Panama fortnight on days, then the same on nights.',
    cycleDays: 28,
    blocks: [
      { shiftTypeKey: 'day', weeks: 2, pattern: 'panama', label: 'Days' },
      { shiftTypeKey: 'night', weeks: 2, pattern: 'panama', label: 'Nights' },
    ],
  },
  {
    key: 'four-on-four-off',
    name: 'Four on, four off',
    summary: 'Eight day cycle, half of it worked. Common in emergency services.',
    cycleDays: 8,
    blocks: [
      { shiftTypeKey: 'day', days: 8, pattern: 'four-four', label: 'Four on four off' },
    ],
  },
  {
    key: 'dupont',
    name: 'DuPont',
    summary: 'Four weeks rotating nights and days, ending in seven consecutive days off.',
    cycleDays: 28,
    blocks: [
      {
        // DuPont changes shift type inside the cycle, so it states its days
        // rather than being described by a pattern.
        shiftTypeKey: null,
        label: 'DuPont',
        cells: [
          'night', 'night', 'night', 'night',
          null, null, null,
          'day', 'day', 'day',
          null,
          'night', 'night', 'night',
          null, null, null,
          'day', 'day', 'day', 'day',
          null, null, null, null, null, null, null,
        ],
      },
    ],
  },
  {
    key: 'weekdays',
    name: 'Monday to Friday',
    summary: 'A standard week. Useful as the non-shift half of a household.',
    cycleDays: 7,
    blocks: [
      { shiftTypeKey: 'straight', weeks: 1, pattern: 'weekdays', label: 'Weekdays' },
    ],
  },
];

export function presetByKey(key: string): RotationPreset | undefined {
  return ROTATION_PRESETS.find((preset) => preset.key === key);
}
