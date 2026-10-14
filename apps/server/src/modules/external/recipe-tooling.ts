import { readBody } from './source-formats.js';
import { DEFAULT_TIMEZONE } from '../../timezone.js';
import {
  isHouseSource,
  recipeSchema,
  runRecipePanel,
  runRecipeSignals,
  type Recipe,
} from './recipe.js';

/**
 * Running a recipe against answers somebody already has, rather than against
 * the network (plan item M7.10).
 *
 * The preview on the recipe page, the `test-recipe` command and the live half
 * of `diagnose-module` all come here, so the three cannot disagree about what a
 * recipe draws from a given answer — and all three reach the panel through the
 * same `runRecipePanel` the poll does, so neither can a recipe's author and the
 * wall. What this adds is what an author needs and a household does not: which
 * step went wrong, and where in the built panel the schema refused it.
 */

/** The step a run stopped at, so a message can say what to look at. */
export type RecipeStage = 'recipe' | 'answer' | 'panel' | 'signals';

export type RecipeRun =
  | {
      readonly ok: true;
      readonly recipe: Recipe;
      readonly panel: unknown;
      readonly signals: readonly unknown[];
    }
  | {
      readonly ok: false;
      readonly stage: RecipeStage;
      readonly error: string;
      /** Where in the built panel the schema refused it, for the panel and signals stages. */
      readonly detail?: string;
    };

/** A recipe as an author pastes or saves it: refused with its first fault named, as the add form does. */
export function readRecipe(text: string): { ok: true; recipe: Recipe } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That recipe is not valid JSON.' };
  }
  const parsed = recipeSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first !== undefined && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
    return { ok: false, error: `This recipe is not valid — ${where}${first?.message ?? 'not a valid recipe'}.` };
  }
  return { ok: true, recipe: parsed.data };
}

/**
 * What each request answered, as text: the main fetch's, and each named
 * source's by name. A house source's is the list of readings its body would be,
 * written as JSON, because there is no request to stand in for.
 */
export interface RecipeAnswers {
  readonly main: string;
  readonly sources?: Readonly<Record<string, string>>;
}

export interface RecipeRunOptions {
  readonly now: number;
  readonly timezone?: string;
}

/** Run a recipe against answers in hand. Never throws, and never asks the network. */
export function runRecipeOnAnswers(recipe: Recipe, answers: RecipeAnswers, options: RecipeRunOptions): RecipeRun {
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;

  const main = readBody(recipe.fetch.format, answers.main);
  if (!main.ok) return { ok: false, stage: 'answer', error: `The main answer ${main.why}.` };

  const sources: Record<string, unknown> = {};
  for (const [name, source] of Object.entries(recipe.sources ?? {})) {
    const text = answers.sources?.[name];
    if (text === undefined) return { ok: false, stage: 'answer', error: `There is no answer for the source “${name}”.` };
    if (isHouseSource(source)) {
      let list: unknown;
      try {
        list = JSON.parse(text);
      } catch {
        list = undefined;
      }
      if (!Array.isArray(list)) {
        return {
          ok: false,
          stage: 'answer',
          error: `The answer for the house source “${name}” is not a JSON list of readings.`,
        };
      }
      sources[name] = list;
      continue;
    }
    const read = readBody(source.format, text);
    if (!read.ok) return { ok: false, stage: 'answer', error: `The answer for the source “${name}” ${read.why}.` };
    sources[name] = read.body;
  }

  const panel = runRecipePanel(recipe, main.body, options.now, sources, timezone);
  if (!panel.ok) return { ok: false, stage: 'panel', error: panel.error, detail: panel.detail };
  const signals = runRecipeSignals(recipe, main.body, options.now, sources, timezone);
  if (!signals.ok) return { ok: false, stage: 'signals', error: signals.error, detail: signals.detail };
  const list = (signals.signals as { signals?: unknown[] }).signals ?? [];
  return { ok: true, recipe, panel: panel.panel, signals: list };
}

/**
 * Two runs' answers compared, as the places they differ: `panel.items.2.value`
 * and the like, each with the two values side by side. An empty list is a match.
 */
export function differences(expected: unknown, actual: unknown, at = ''): string[] {
  if (Object.is(expected, actual)) return [];
  const bothObjects =
    expected !== null && actual !== null && typeof expected === 'object' && typeof actual === 'object';
  if (bothObjects && Array.isArray(expected) === Array.isArray(actual)) {
    const keys = new Set([...Object.keys(expected as object), ...Object.keys(actual as object)]);
    const out: string[] = [];
    for (const key of keys) {
      out.push(
        ...differences(
          (expected as Record<string, unknown>)[key],
          (actual as Record<string, unknown>)[key],
          at === '' ? key : `${at}.${key}`,
        ),
      );
    }
    return out;
  }
  const show = (value: unknown): string => (value === undefined ? '(nothing)' : JSON.stringify(value));
  return [`${at === '' ? '(top)' : at}: expected ${show(expected)}, got ${show(actual)}`];
}
