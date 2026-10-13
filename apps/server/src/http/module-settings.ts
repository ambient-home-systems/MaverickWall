import type { SqliteDatabase } from '../db/open.js';
import { readWatched } from '../modules/homeassistant/store.js';
import { fieldValue, normaliseConfig, recipeSchema, type ConfigField, type RecipeConfig } from '../modules/external/recipe.js';
import { readEnabledExternalModules } from '../api/external-modules.js';
import { escapeHtml, selectField, switchRow, textField } from './html.js';

/**
 * A recipe's settings as controls (plan item M7.6): text, a number, a switch,
 * one of a list, or one of the household's Home Assistant readings — on the
 * install page, script-free. The Module widget's inspector draws the same five
 * from the same fields, so a setting means one thing in both places.
 */

/** A watched reading, as a setting offers it: the id it stores and the name it shows. */
export interface ReadingChoice {
  readonly id: string;
  readonly name: string;
}

/** The readings a setting may name: the ones the household watches, by their own names. */
export function watchedReadingChoices(db: SqliteDatabase): ReadingChoice[] {
  return readWatched(db)
    .filter((row) => row.watched === 1)
    .map((row) => ({ id: row.entityId, name: row.label ?? row.friendlyName ?? row.entityId }));
}

/** The form name a setting posts under. */
const formName = (field: ConfigField): string => `cfg_${field.key}`;

/**
 * Every setting as its control, each pre-filled with what was typed (an echo
 * after a refusal) or the recipe's default. `host` is where a reading's value
 * is sent, which the control says before the household chooses one.
 */
export function settingsControls(
  fields: readonly ConfigField[],
  values: RecipeConfig | undefined,
  readings: readonly ReadingChoice[],
  host: string,
): string {
  return fields.map((field) => settingControl(field, values?.[field.key], readings, host)).join('');
}

function settingControl(
  field: ConfigField,
  value: string | undefined,
  readings: readonly ReadingChoice[],
  host: string,
): string {
  const hint = field.hint;
  switch (field.type) {
    case 'string':
      return textField({
        label: field.label,
        name: formName(field),
        value: value ?? field.default ?? '',
        attrs: 'maxlength="280"',
        ...(hint === undefined ? {} : { hint }),
      });
    case 'number': {
      const attrs = [
        'inputmode="decimal"',
        field.min === undefined ? '' : `min="${field.min}"`,
        field.max === undefined ? '' : `max="${field.max}"`,
        `step="${field.step ?? 'any'}"`,
      ]
        .filter((a) => a !== '')
        .join(' ');
      return textField({
        label: field.label,
        name: formName(field),
        type: 'number',
        value: value ?? field.default ?? '',
        attrs,
        ...(hint === undefined ? {} : { hint }),
      });
    }
    case 'boolean':
      return switchRow({
        label: field.label,
        name: formName(field),
        value: 'true',
        checked: (value ?? field.default ?? 'false') === 'true',
        ...(hint === undefined ? {} : { hint }),
      });
    case 'select': {
      const chosen = value ?? field.default ?? field.options[0]?.value;
      const options = field.options
        .map(
          (o) =>
            `<option value="${escapeHtml(o.value)}"${o.value === chosen ? ' selected' : ''}>${escapeHtml(o.label)}</option>`,
        )
        .join('');
      return selectField({
        label: field.label,
        name: formName(field),
        optionsHtml: options,
        ...(hint === undefined ? {} : { hint }),
      });
    }
    case 'ha_reading': {
      const options =
        `<option value="">None</option>` +
        readings
          .map(
            (r) =>
              `<option value="${escapeHtml(r.id)}"${r.id === value ? ' selected' : ''}>${escapeHtml(r.name)}</option>`,
          )
          .join('');
      // Said before anything is chosen: this is the one setting that sends
      // something about the house to somebody else.
      const sends = `Sends this reading’s current value, and nothing else about it, to ${host}.`;
      return selectField({
        label: field.label,
        name: formName(field),
        optionsHtml: options,
        hint:
          readings.length === 0
            ? 'Watch a reading under Home Assistant › Readings to choose one here.'
            : hint === undefined
              ? sends
              : `${hint} ${sends}`,
      });
    }
  }
}

/**
 * The settings a form posted, each refused rather than coerced (rule five): a
 * number out of range or a choice not on the list comes back as a sentence
 * naming the setting, with everything typed echoed. A blank is no value, and
 * the recipe's default stands. A switch not sent is off, because an unticked
 * checkbox is not sent at all.
 */
export function readSettingsForm(
  fields: readonly ConfigField[],
  body: Readonly<Record<string, unknown>>,
): { readonly values: RecipeConfig; readonly error?: string } {
  const values: RecipeConfig = {};
  let error: string | undefined;
  for (const field of fields) {
    const raw = body[formName(field)];
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (field.type === 'boolean') {
      values[field.key] = text === 'true' ? 'true' : 'false';
      continue;
    }
    values[field.key] = text;
    if (text !== '' && fieldValue(field, text) === undefined && error === undefined) {
      error = refusal(field);
    }
  }
  return error === undefined ? { values } : { values, error };
}

/** Which of a pasted config's values a recipe would not take, as a sentence. */
export function invalidSetting(fields: readonly ConfigField[], supplied: RecipeConfig): string | undefined {
  for (const field of fields) {
    const raw = supplied[field.key];
    if (raw === undefined || raw === '') continue;
    if (typeof raw !== 'string' || fieldValue(field, raw) === undefined) return refusal(field);
  }
  return undefined;
}

function refusal(field: ConfigField): string {
  switch (field.type) {
    case 'number': {
      const range =
        field.min !== undefined && field.max !== undefined
          ? ` from ${field.min} to ${field.max}`
          : field.min !== undefined
            ? ` of at least ${field.min}`
            : field.max !== undefined
              ? ` of at most ${field.max}`
              : '';
      return `“${field.label}” needs a number${range}.`;
    }
    case 'select':
      return `“${field.label}” needs one of its choices.`;
    case 'ha_reading':
      return `“${field.label}” needs one of the readings you watch.`;
    case 'boolean':
      return `“${field.label}” is on or off.`;
    case 'string':
      return `“${field.label}” is too long.`;
  }
}

/**
 * The installed modules as the layout editor offers them: a recipe's settings
 * and the install's values beside its name, so a Module widget can set its own
 * (plan item M7.6). A service module, and a recipe that declares none, has no
 * settings to offer. The install's values may hold an entity id; this is the
 * admin's own page, where the Readings picker already lists them.
 */
export function editorModules(db: SqliteDatabase): {
  readonly id: string;
  readonly name: string;
  readonly fields: readonly ConfigField[];
  readonly values: RecipeConfig;
}[] {
  return readEnabledExternalModules(db).map((module) => {
    const recipe = module.kind === 'recipe' ? recipeSchema.safeParse(module.recipe) : undefined;
    if (recipe === undefined || !recipe.success) return { id: module.id, name: module.name, fields: [], values: {} };
    const install =
      module.config !== null && typeof module.config === 'object' ? (module.config as RecipeConfig) : {};
    return {
      id: module.id,
      name: module.name,
      fields: recipe.data.config,
      values: normaliseConfig(recipe.data, install),
    };
  });
}
