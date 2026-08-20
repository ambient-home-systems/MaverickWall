/**
 * GENERATED — do not edit by hand. Regenerate with:
 *
 *     node scripts/generate-m3-tokens.mjs        # from apps/server
 *
 * Material Design 3 colour schemes for the admin, derived from the Board amber
 * (seed #E8A33D, variant TonalSpot, contrast 0, 2021 spec) with the Board
 * status colours harmonized in as custom roles. The generator's doc comment
 * holds the reasoning; test/m3-tokens.test.ts holds the schemes to their
 * contrast guarantees, including after any hand edit that ignores this header.
 *
 * Committed rather than generated at build time so the runtime image gains no
 * dependency and no build step (@material/material-color-utilities is a
 * devDependency only).
 */

/** The seed every scheme is derived from — the Board amber. */
export const M3_SEED = '#E8A33D';

export interface M3Scheme {
  /** System roles, emitted as `--md-sys-color-<role>`. */
  readonly sys: Readonly<Record<string, string>>;
  /** Harmonized custom roles, emitted as `--md-custom-color-<role>`. */
  readonly custom: Readonly<Record<string, string>>;
}

export const M3_SCHEMES: Readonly<Record<'dark' | 'light', M3Scheme>> = {
  dark: {
    sys: {
      'error': '#FFB4AB',
      'error-container': '#93000A',
      'inverse-on-surface': '#362F27',
      'inverse-primary': '#805611',
      'inverse-surface': '#EDE0D4',
      'on-error': '#690005',
      'on-error-container': '#FFDAD6',
      'on-primary': '#462B00',
      'on-primary-container': '#FFDDB5',
      'on-secondary': '#3E2D16',
      'on-secondary-container': '#FBDEBC',
      'on-surface': '#EDE0D4',
      'on-surface-variant': '#D3C4B4',
      'on-tertiary': '#253514',
      'on-tertiary-container': '#D5EABA',
      'outline': '#9C8F80',
      'outline-variant': '#4F4539',
      'primary': '#F6BC6F',
      'primary-container': '#643F00',
      'scrim': '#000000',
      'secondary': '#DEC2A2',
      'secondary-container': '#57432B',
      'shadow': '#000000',
      'surface': '#18120B',
      'surface-bright': '#3F3830',
      'surface-container': '#251F17',
      'surface-container-high': '#302921',
      'surface-container-highest': '#3B342B',
      'surface-container-low': '#211B13',
      'surface-container-lowest': '#130D07',
      'surface-dim': '#18120B',
      'surface-tint': '#F6BC6F',
      'surface-variant': '#4F4539',
      'tertiary': '#B9CDA0',
      'tertiary-container': '#3B4C29',
    },
    custom: {
      'night': '#BAC3FF',
      'night-container': '#2E3E95',
      'on-night': '#12257E',
      'on-night-container': '#DEE0FF',
      'on-success': '#003913',
      'on-success-container': '#A3F5AA',
      'on-warning': '#442B00',
      'on-warning-container': '#FFDDB1',
      'success': '#88D990',
      'success-container': '#00531F',
      'warning': '#FEBA4B',
      'warning-container': '#624000',
    },
  },
  light: {
    sys: {
      'error': '#BA1A1A',
      'error-container': '#FFDAD6',
      'inverse-on-surface': '#FCEFE2',
      'inverse-primary': '#F6BC6F',
      'inverse-surface': '#362F27',
      'on-error': '#FFFFFF',
      'on-error-container': '#93000A',
      'on-primary': '#FFFFFF',
      'on-primary-container': '#643F00',
      'on-secondary': '#FFFFFF',
      'on-secondary-container': '#57432B',
      'on-surface': '#211B13',
      'on-surface-variant': '#4F4539',
      'on-tertiary': '#FFFFFF',
      'on-tertiary-container': '#3B4C29',
      'outline': '#817568',
      'outline-variant': '#D3C4B4',
      'primary': '#805611',
      'primary-container': '#FFDDB5',
      'scrim': '#000000',
      'secondary': '#705B40',
      'secondary-container': '#FBDEBC',
      'shadow': '#000000',
      'surface': '#FFF8F4',
      'surface-bright': '#FFF8F4',
      'surface-container': '#F9ECDF',
      'surface-container-high': '#F3E6DA',
      'surface-container-highest': '#EDE0D4',
      'surface-container-low': '#FFF1E5',
      'surface-container-lowest': '#FFFFFF',
      'surface-dim': '#E5D8CC',
      'surface-tint': '#805611',
      'surface-variant': '#F0E0D0',
      'tertiary': '#52643F',
      'tertiary-container': '#D5EABA',
    },
    custom: {
      'night': '#4757AF',
      'night-container': '#DEE0FF',
      'on-night': '#FFFFFF',
      'on-night-container': '#00105B',
      'on-success': '#FFFFFF',
      'on-success-container': '#002108',
      'on-warning': '#FFFFFF',
      'on-warning-container': '#291800',
      'success': '#1A6C31',
      'success-container': '#A3F5AA',
      'warning': '#815600',
      'warning-container': '#FFDDB1',
    },
  },
};
