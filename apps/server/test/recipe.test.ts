import { describe, expect, it } from 'vitest';
import {
  normaliseConfig,
  recipeFetchHost,
  recipePolicy,
  recipeSchema,
  resolveFetchUrl,
  resolveHeaders,
  runRecipePanel,
  runRecipeSignals,
  type Recipe,
} from '../src/modules/external/recipe.js';

/**
 * The recipe engine (docs/rfc-002-module-catalog-and-recipes.md, Phase B1).
 *
 * The transform is the safety boundary, so the tests are as much about what the
 * schema refuses as what the interpreter computes: an unknown formatter is a
 * rejected recipe, not a runtime surprise; the selector language traverses and
 * nothing more; and whatever a recipe builds is validated against the same
 * Panel Data schema a service module answers with.
 */

const NOW = Date.UTC(2026, 7, 11); // 2026-08-11

function parse(input: unknown): Recipe {
  const result = recipeSchema.safeParse(input);
  if (!result.success) throw new Error(`expected a valid recipe: ${result.error.message}`);
  return result.data;
}

const fuelRecipe = {
  name: 'Fuel',
  contract: 1,
  config: [{ key: 'station', label: 'Station', type: 'string' }],
  fetch: { url: 'https://api.example.com/fuel/{station}' },
  panel: {
    kind: 'tiles',
    title: 'Fuel',
    items: { for: 'prices', label: '{fuel | upper}', value: '{pence | currency:GBP}' },
  },
};

describe('recipe schema', () => {
  it('accepts a well-formed recipe', () => {
    expect(recipeSchema.safeParse(fuelRecipe).success).toBe(true);
  });

  it('rejects a template that names an unknown formatter', () => {
    const bad = { ...fuelRecipe, panel: { kind: 'stat', value: '{x | evil}' } };
    expect(recipeSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown top-level key rather than ignoring it', () => {
    expect(recipeSchema.safeParse({ ...fuelRecipe, code: 'alert(1)' }).success).toBe(false);
  });

  it('rejects a fetch URL that references an undeclared config field', () => {
    const bad = { ...fuelRecipe, fetch: { url: 'https://x/{missing}' } };
    expect(recipeSchema.safeParse(bad).success).toBe(false);
  });

  it('defaults to public https only, and opts into the LAN explicitly', () => {
    const publicOnly = recipePolicy(parse(fuelRecipe));
    expect(publicOnly).toEqual({ allowHttp: false, allowPrivateNetwork: false, allowLoopback: false });
    const lan = recipePolicy(parse({ ...fuelRecipe, fetch: { url: 'http://10.0.0.5/x', allowLan: true } }));
    expect(lan).toEqual({ allowHttp: true, allowPrivateNetwork: true, allowLoopback: true });
  });
});

describe('fetch URL resolution', () => {
  it('substitutes config, URL-encoding the value', () => {
    const recipe = parse(fuelRecipe);
    expect(resolveFetchUrl(recipe, { station: 'a b/c' })).toBe('https://api.example.com/fuel/a%20b%2Fc');
  });
});

describe('the interpreter', () => {
  it('maps an array to tiles with formatters applied', () => {
    const recipe = parse(fuelRecipe);
    const body = { prices: [{ fuel: 'petrol', pence: 146.9 }, { fuel: 'diesel', pence: 151 }] };
    const out = runRecipePanel(recipe, body, NOW);
    expect(out).toEqual({
      ok: true,
      panel: {
        kind: 'tiles',
        title: 'Fuel',
        items: [
          { label: 'PETROL', value: '£146.90' },
          { label: 'DIESEL', value: '£151.00' },
        ],
      },
    });
  });

  it('resolves nested and indexed paths for a stat', () => {
    const recipe = parse({
      name: 'Temp',
      contract: 1,
      fetch: { url: 'https://x/y' },
      panel: { kind: 'stat', title: 'Now', value: '{main.temps[0] | round:1}', caption: '°C' },
    });
    const out = runRecipePanel(recipe, { main: { temps: [19.44, 12] } }, NOW);
    expect(out).toEqual({ ok: true, panel: { kind: 'stat', title: 'Now', value: '19.4', caption: '°C' } });
  });

  it('renders a missing selector as empty, and default fills it', () => {
    const recipe = parse({
      name: 'D',
      contract: 1,
      fetch: { url: 'https://x/y' },
      panel: { kind: 'text', text: 'Status: {state | default:unknown}' },
    });
    expect(runRecipePanel(recipe, {}, NOW)).toEqual({ ok: true, panel: { kind: 'text', text: 'Status: unknown' } });
  });

  it('formats a date relative to now', () => {
    const recipe = parse({
      name: 'Bin',
      contract: 1,
      fetch: { url: 'https://x/y' },
      panel: { kind: 'stat', value: '{next | date:relative}' },
    });
    const tomorrow = new Date(NOW + 86_400_000).toISOString();
    expect(runRecipePanel(recipe, { next: tomorrow }, NOW)).toEqual({
      ok: true,
      panel: { kind: 'stat', value: 'tomorrow' },
    });
  });

  it('an array selector that resolves to a non-array yields no rows', () => {
    const recipe = parse(fuelRecipe);
    // No `prices` array in the body → an empty tiles panel, which the Panel Data
    // schema rejects (tiles needs at least one item), so the recipe fails safely.
    const out = runRecipePanel(recipe, { prices: 'nope' }, NOW);
    expect(out.ok).toBe(false);
  });

  it('caps a runaway array at twelve rows', () => {
    const recipe = parse({
      name: 'Many',
      contract: 1,
      fetch: { url: 'https://x/y' },
      panel: { kind: 'readings', items: { for: 'xs', label: '{n}', value: '{n}' } },
    });
    const body = { xs: Array.from({ length: 50 }, (_, i) => ({ n: String(i) })) };
    const out = runRecipePanel(recipe, body, NOW);
    expect(out.ok).toBe(true);
    if (out.ok) expect((out.panel as { items: unknown[] }).items).toHaveLength(12);
  });

  it('validates its output against the Panel Data schema — an oversize value is rejected', () => {
    const recipe = parse({
      name: 'X',
      contract: 1,
      fetch: { url: 'https://x/y' },
      panel: { kind: 'text', text: '{msg}' },
    });
    // The built panel crosses the same `panelDataSchema` a service module's body
    // does (the display sanitises control characters on the way in, as it does
    // for every module). A value past the cap fails there rather than drawing.
    const out = runRecipePanel(recipe, { msg: 'x'.repeat(400) }, NOW);
    expect(out.ok).toBe(false);
  });
});

describe('recipe signals', () => {
  const alertRecipe = {
    name: 'Flood',
    contract: 1,
    fetch: { url: 'https://api.example.com/gauge' },
    panel: { kind: 'stat', value: '{level | round:1}', caption: 'm' },
    signals: [
      {
        when: 'alert.active',
        key: '{alert.id}',
        title: 'Flood warning: {alert.river}',
        severity: 'Severe',
      },
    ],
  };

  it('raises a signal when its truthy `when` holds', () => {
    const recipe = parse(alertRecipe);
    const body = { level: 3.2, alert: { active: true, id: 'w1', river: 'Thames' } };
    expect(runRecipeSignals(recipe, body, NOW)).toEqual({
      ok: true,
      signals: { signals: [{ key: 'w1', title: 'Flood warning: Thames', severity: 'Severe' }] },
    });
  });

  it('raises nothing when the `when` value is falsy', () => {
    const recipe = parse(alertRecipe);
    const body = { level: 0.4, alert: { active: false, id: 'w1', river: 'Thames' } };
    expect(runRecipeSignals(recipe, body, NOW)).toEqual({ ok: true, signals: { signals: [] } });
  });

  it('supports an equals predicate', () => {
    const recipe = parse({
      name: 'Status',
      contract: 1,
      fetch: { url: 'https://x/status' },
      panel: { kind: 'text', text: '{state}' },
      signals: [{ when: { path: 'state', equals: 'disrupted' }, key: 'svc', title: 'Service disrupted' }],
    });
    expect(runRecipeSignals(recipe, { state: 'disrupted' }, NOW)).toEqual({
      ok: true,
      signals: { signals: [{ key: 'svc', title: 'Service disrupted' }] },
    });
    expect(runRecipeSignals(recipe, { state: 'operational' }, NOW)).toEqual({
      ok: true,
      signals: { signals: [] },
    });
  });

  it('rejects a signal template that names an unknown formatter, at parse time', () => {
    const bad = { ...alertRecipe, signals: [{ when: 'a', key: '{x | evil}', title: 't' }] };
    expect(recipeSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a `when` that is not a selector path', () => {
    const bad = { ...alertRecipe, signals: [{ when: 'a && b', key: 'k', title: 't' }] };
    expect(recipeSchema.safeParse(bad).success).toBe(false);
  });

  it('a panel-only recipe has no signals', () => {
    const recipe = parse(fuelRecipe);
    expect(recipe.signals).toEqual([]);
  });
});

describe('recipe secrets', () => {
  const secretRecipe = {
    name: 'Priced',
    contract: 1,
    config: [{ key: 'sym', label: 'Symbol' }],
    secrets: [{ key: 'api_key', label: 'API key' }],
    fetch: {
      url: 'https://api.example.com/price?symbol={sym}',
      headers: { 'X-Api-Key': '{secret:api_key}', 'X-Symbol': '{sym}' },
    },
    panel: { kind: 'stat', value: '{price}' },
  };

  it('accepts a recipe using a secret in a header', () => {
    expect(recipeSchema.safeParse(secretRecipe).success).toBe(true);
  });

  it('resolves headers with config and the decrypted secret', () => {
    const recipe = parse(secretRecipe);
    expect(resolveHeaders(recipe, { sym: 'BTC' }, { api_key: 'k-123' })).toEqual({
      'X-Api-Key': 'k-123',
      'X-Symbol': 'BTC',
    });
  });

  it('rejects a secret placed in the address, not a header', () => {
    const bad = { ...secretRecipe, fetch: { url: 'https://x/y?k={secret:api_key}' } };
    expect(recipeSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a header that references an undeclared secret', () => {
    const bad = { ...secretRecipe, secrets: [], fetch: { url: 'https://x/y', headers: { A: '{secret:nope}' } } };
    expect(recipeSchema.safeParse(bad).success).toBe(false);
  });

  it('names the host a secret will be sent to', () => {
    expect(recipeFetchHost(parse(secretRecipe))).toBe('api.example.com');
  });
});

describe('config normalisation', () => {
  it('applies defaults and drops unknown keys', () => {
    const recipe = parse({
      name: 'C',
      contract: 1,
      config: [
        { key: 'a', label: 'A', type: 'string', default: 'da' },
        { key: 'b', label: 'B', type: 'string' },
      ],
      fetch: { url: 'https://x/{a}/{b}' },
      panel: { kind: 'text', text: 'ok' },
    });
    expect(normaliseConfig(recipe, { b: 'bee', junk: 'x' })).toEqual({ a: 'da', b: 'bee' });
  });
});
