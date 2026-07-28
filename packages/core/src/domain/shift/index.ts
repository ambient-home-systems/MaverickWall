/**
 * Shift rotation.
 *
 * Self-contained by design. Nothing else in core imports from this directory,
 * and this directory imports nothing from core beyond civil date arithmetic.
 * That seam is what keeps the option open to extract it as its own package
 * later without a refactor — and what lets a household that does not work
 * shifts disable the whole feature and lose nothing.
 */
export * from './resolve.js';
export * from './rotation.js';
export * from './presets.js';
