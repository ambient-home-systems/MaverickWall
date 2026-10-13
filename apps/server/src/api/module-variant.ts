import { createHash } from 'node:crypto';

/**
 * Which panel a Module widget draws, from its own settings (plan item M7.6).
 * Pure, so the manifest, the e-paper renderer and the poll all ask one
 * function and cannot come to disagree about a key.
 */

/** A setting's key, as a recipe declares one. */
const SETTING_KEY = /^[a-z0-9_]+$/;

/**
 * A widget's settings for a module, read defensively: string values under
 * declared-shaped keys, and nothing else. `null` for none, which is a widget
 * drawing the install's own panel.
 */
export function widgetSettings(config: unknown): Record<string, string> | null {
  if (config === null || typeof config !== 'object') return null;
  const raw = (config as Record<string, unknown>)['settings'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (SETTING_KEY.test(key) && typeof value === 'string') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The handle a widget's settings are known by: a hash of the module and the
 * settings as stored, sorted by key. It names the variant's panel in the
 * manifest (`ext:<id>~<key>`) and its row here, so the wall and a panel find
 * the same panel and neither is ever handed a setting — one may be an entity
 * id (rule 12), and none is the wall's business.
 *
 * Hashed from the settings as stored rather than as the recipe reads them, so
 * the key needs no recipe and no cache to compute, on either renderer; two
 * keys whose settings resolve to the same request share their fetch in the
 * poll, which is where the deduplication belongs.
 */
export function moduleVariantKey(moduleId: string, settings: Readonly<Record<string, string>>): string {
  const sorted = Object.keys(settings)
    .sort()
    .map((key) => [key, settings[key]]);
  return createHash('sha256')
    .update(`mw-module-variant\n${moduleId}\n${JSON.stringify(sorted)}`)
    .digest('hex')
    .slice(0, 16);
}

/** The manifest's key for a variant's panel. */
export function variantBlockKey(moduleId: string, variantKey: string): string {
  return `ext:${moduleId}~${variantKey}`;
}

