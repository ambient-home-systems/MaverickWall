/**
 * Generates src/http/m3-tokens.ts — the Material Design 3 colour schemes the
 * admin stylesheet is built on.
 *
 * Run by hand, output committed, exactly like the build scripts in docs/brand:
 * the runtime image gains no dependency and no build step, and rule three is
 * untouched because nothing here ever runs on a household's box. The library
 * (@material/material-color-utilities, Apache-2.0) is a devDependency only.
 *
 *     node scripts/generate-m3-tokens.mjs        # from apps/server
 *
 * Choices, so nobody re-derives them:
 *
 * - Seed is #E8A33D, the Board amber — the admin should look like the wall it
 *   configures, and that is the wall's one lit cell.
 * - Variant is TonalSpot, the M3 default (what m3.material.io's theme builder
 *   emits for a seed), at contrast level 0 and the 2021 spec — the mapping the
 *   published role documentation describes, and the one whose tone deltas the
 *   contrast test relies on.
 * - The custom roles are the Board palette's own status colours — ok, warn,
 *   night — pulled toward the seed with Blend.harmonize (via customColor(),
 *   which is harmonize plus the spec's custom-colour tone mapping) so a green
 *   tag no longer fights an amber primary. --danger is not here: M3 already
 *   has an error role and a second red would compete with it.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  argbFromHex,
  customColor,
  hexFromArgb,
  Hct,
  SchemeTonalSpot,
} from '@material/material-color-utilities';

const SEED = '#E8A33D';

/**
 * The Board palette's status colours (the dark-scheme originals in html.ts —
 * the light variants were derived from these by hand and carry no extra
 * information). Each becomes a full role group: colour, on-colour, container,
 * on-container, per scheme.
 */
const CUSTOM = [
  { name: 'success', value: '#35916A' },
  { name: 'warning', value: '#D9A13E' },
  { name: 'night', value: '#4C7FD1' },
];

/** camelCase role → kebab-case token suffix, e.g. onSurfaceVariant → on-surface-variant. */
const kebab = (name) => name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();

/**
 * The system roles emitted, by their DynamicScheme getter names. The complete
 * 2021 set the stylesheet and the coming component phase draw from; the 2025
 * additions (primaryFixed, primaryDim, …) are left out until something needs
 * them — an unused token is a token nobody notices going stale.
 */
const SYSTEM_ROLES = [
  'primary', 'onPrimary', 'primaryContainer', 'onPrimaryContainer', 'inversePrimary',
  'secondary', 'onSecondary', 'secondaryContainer', 'onSecondaryContainer',
  'tertiary', 'onTertiary', 'tertiaryContainer', 'onTertiaryContainer',
  'error', 'onError', 'errorContainer', 'onErrorContainer',
  'surface', 'onSurface', 'surfaceVariant', 'onSurfaceVariant',
  'surfaceDim', 'surfaceBright',
  'surfaceContainerLowest', 'surfaceContainerLow', 'surfaceContainer',
  'surfaceContainerHigh', 'surfaceContainerHighest',
  'outline', 'outlineVariant',
  'inverseSurface', 'inverseOnSurface',
  'surfaceTint', 'scrim', 'shadow',
];

function systemScheme(isDark) {
  const scheme = new SchemeTonalSpot(Hct.fromInt(argbFromHex(SEED)), isDark, 0);
  const out = {};
  for (const role of SYSTEM_ROLES) out[kebab(role)] = hexFromArgb(scheme[role]).toUpperCase();
  return out;
}

function customScheme(isDark) {
  const seed = argbFromHex(SEED);
  const out = {};
  for (const { name, value } of CUSTOM) {
    const group = customColor(seed, { name, value: argbFromHex(value), blend: true });
    const roles = isDark ? group.dark : group.light;
    out[name] = hexFromArgb(roles.color).toUpperCase();
    out[`on-${name}`] = hexFromArgb(roles.onColor).toUpperCase();
    out[`${name}-container`] = hexFromArgb(roles.colorContainer).toUpperCase();
    out[`on-${name}-container`] = hexFromArgb(roles.onColorContainer).toUpperCase();
  }
  return out;
}

/** A sorted, quoted record literal — deterministic output, so diffs mean something. */
function record(entries, indent) {
  const pad = ' '.repeat(indent);
  const lines = Object.keys(entries)
    .sort()
    .map((key) => `${pad}'${key}': '${entries[key]}',`);
  return `{\n${lines.join('\n')}\n${' '.repeat(indent - 2)}}`;
}

const schemes = {
  dark: { sys: systemScheme(true), custom: customScheme(true) },
  light: { sys: systemScheme(false), custom: customScheme(false) },
};

const source = `/**
 * GENERATED — do not edit by hand. Regenerate with:
 *
 *     node scripts/generate-m3-tokens.mjs        # from apps/server
 *
 * Material Design 3 colour schemes for the admin, derived from the Board amber
 * (seed ${SEED}, variant TonalSpot, contrast 0, 2021 spec) with the Board
 * status colours harmonized in as custom roles. The generator's doc comment
 * holds the reasoning; test/m3-tokens.test.ts holds the schemes to their
 * contrast guarantees, including after any hand edit that ignores this header.
 *
 * Committed rather than generated at build time so the runtime image gains no
 * dependency and no build step (@material/material-color-utilities is a
 * devDependency only).
 */

/** The seed every scheme is derived from — the Board amber. */
export const M3_SEED = '${SEED}';

export interface M3Scheme {
  /** System roles, emitted as \`--md-sys-color-<role>\`. */
  readonly sys: Readonly<Record<string, string>>;
  /** Harmonized custom roles, emitted as \`--md-custom-color-<role>\`. */
  readonly custom: Readonly<Record<string, string>>;
}

export const M3_SCHEMES: Readonly<Record<'dark' | 'light', M3Scheme>> = {
  dark: {
    sys: ${record(schemes.dark.sys, 6)},
    custom: ${record(schemes.dark.custom, 6)},
  },
  light: {
    sys: ${record(schemes.light.sys, 6)},
    custom: ${record(schemes.light.custom, 6)},
  },
};
`;

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'http', 'm3-tokens.ts');
writeFileSync(out, source);
console.log(`wrote ${out}`);
console.log(`  dark  primary ${schemes.dark.sys['primary']}  surface ${schemes.dark.sys['surface']}  success ${schemes.dark.custom['success']}`);
console.log(`  light primary ${schemes.light.sys['primary']}  surface ${schemes.light.sys['surface']}  success ${schemes.light.custom['success']}`);
