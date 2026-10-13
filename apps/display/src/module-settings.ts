/**
 * A Module widget's own settings, as the inspector edits them (plan item M7.6).
 *
 * Pure, like `ink.ts` and `omission.ts`: what a control writes is decided here,
 * where a test can reach it, and the click handler only calls it.
 *
 * The one rule is that a widget stores only what it changes. A setting left at
 * the install's value is no setting, and follows the install if the household
 * changes it there — so two widgets that both "use the install's city" go on
 * agreeing, and a widget whose every setting matches the install sends exactly
 * what a widget with none does.
 */

/** A recipe's setting, as the editor's bootstrap carries it. Read defensively. */
export type ModuleField =
  | { readonly key: string; readonly label: string; readonly hint?: string; readonly type: 'string' }
  | {
      readonly key: string;
      readonly label: string;
      readonly hint?: string;
      readonly type: 'number';
      readonly min?: number;
      readonly max?: number;
      readonly step?: number;
    }
  | { readonly key: string; readonly label: string; readonly hint?: string; readonly type: 'boolean' }
  | {
      readonly key: string;
      readonly label: string;
      readonly hint?: string;
      readonly type: 'select';
      readonly options: readonly { readonly value: string; readonly label: string }[];
    }
  | { readonly key: string; readonly label: string; readonly hint?: string; readonly type: 'ha_reading' };

const TYPES = new Set(['string', 'number', 'boolean', 'select', 'ha_reading']);

/** The fields a bootstrap entry carries, keeping only the ones that make sense. */
export function moduleFields(raw: unknown): ModuleField[] {
  if (!Array.isArray(raw)) return [];
  const out: ModuleField[] = [];
  for (const one of raw) {
    if (one === null || typeof one !== 'object') continue;
    const f = one as Record<string, unknown>;
    if (typeof f['key'] !== 'string' || typeof f['label'] !== 'string' || !TYPES.has(f['type'] as string)) continue;
    if (f['type'] === 'select' && !Array.isArray(f['options'])) continue;
    out.push(f as unknown as ModuleField);
  }
  return out;
}

/** What a setting is for this widget: its own value, else the install's. */
export function effectiveSetting(
  key: string,
  install: Readonly<Record<string, string>>,
  settings: Readonly<Record<string, string>> | undefined,
): string {
  return settings?.[key] ?? install[key] ?? '';
}

/**
 * The widget's settings after one control writes `value`. Blank, or the
 * install's own value, takes the setting off; nothing left is no settings at
 * all, which is the widget drawing the install's panel.
 */
export function nextSettings(
  current: Readonly<Record<string, string>> | undefined,
  install: Readonly<Record<string, string>>,
  key: string,
  value: string,
): Record<string, string> | undefined {
  const out: Record<string, string> = { ...(current ?? {}) };
  if (value === '' || value === (install[key] ?? '')) delete out[key];
  else out[key] = value;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A widget's stored settings, read defensively. */
export function storedSettings(config: Readonly<Record<string, unknown>>): Record<string, string> | undefined {
  const raw = config['settings'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
