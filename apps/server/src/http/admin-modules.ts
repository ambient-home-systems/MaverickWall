import type { Context, Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { FETCH_LIMITS } from '@maverick-wall/core';
import { errorBlock, escapeHtml, page, textField, textareaField } from './html.js';
import { ago, navModules } from './admin.js';
import type { AdminDeps } from './admin.js';
import {
  createExternalModule,
  createRecipeModule,
  deleteExternalModule,
  ensureDisplayBlock,
  readExternalModules,
  removeDisplayBlock,
  setExternalModuleAlertsAction,
  setExternalModuleEnabled,
  type AlertsAction,
  type ExternalModuleRow,
} from '../api/external-modules.js';
import { deleteRule, moduleAlertRuleId, syncModuleAlertRule } from '../api/rules.js';
import { signalDataSchema } from '../modules/external/signal-data.js';
import {
  normaliseConfig,
  recipeFetchHost,
  recipeSchema,
  type RecipeConfig,
} from '../modules/external/recipe.js';
import { CATALOG, catalogEntry, previewFor, type CatalogEntry, type RecipeEntry, type ServiceEntry } from './catalog.js';
import { parse, text, z } from '../validation.js';

/**
 * The module store (docs/rfc-002-module-catalog-and-recipes.md).
 *
 * The Store screen is the household's front door: a curated, in-repo catalogue
 * of modules to browse and install, and the list of what they have installed.
 * Most entries are *recipes* — declarative, no service to host. The two power
 * tools — adding a module that runs as its own service (by URL), and writing a
 * recipe by hand — live on a separate Advanced screen, off the everyday path.
 *
 * Nothing here executes what a module returns; the wall runs no third-party
 * code.
 */

const addBody = z.object({
  url: text('The module’s address', 2048),
  name: z.string().max(60).optional(),
});

const alertsBody = z.object({
  // `takeover_and_wake` is deliberately not accepted: a module may not wake a
  // dark screen. The evaluator is told the same thing, but this is the boundary.
  action: z.enum(['none', 'banner', 'takeover']),
});

// A module runs on the household's own network, so LAN, loopback and http are
// all permitted — the same policy the poll uses. The health check reads its
// manifest and nothing more.
const POLICY = { allowHttp: true, allowPrivateNetwork: true, allowLoopback: true } as const;

export function registerModuleRoutes(app: Hono, deps: AdminDeps): void {
  const now = deps.now ?? ((): number => Date.now());

  // The Store: what you've installed, and the catalogue to install from.
  app.get('/admin/modules', (c: Context) => c.html(storePage()));

  // Old link, kept working.
  app.get('/admin/modules/browse', (c: Context) => c.redirect('/admin/modules', 302));

  // The two power tools, off the everyday path: add a service by URL, or write a
  // recipe by hand. `?install=<id>` prefills the service form from a store entry.
  app.get('/admin/modules/advanced', (c: Context) => {
    const entry = catalogEntry(c.req.query('install') ?? '');
    return c.html(advancedPage(undefined, entry?.kind === 'service' ? entry : undefined));
  });

  app.get('/admin/modules/install/:id', (c: Context) => {
    const entry = catalogEntry(c.req.param('id') ?? '');
    if (entry === undefined || entry.kind !== 'recipe') return c.redirect('/admin/modules', 302);
    return c.html(installRecipePage(entry));
  });

  app.post('/admin/modules/install/:id', async (c: Context) => {
    const entry = catalogEntry(c.req.param('id') ?? '');
    if (entry === undefined || entry.kind !== 'recipe') return c.redirect('/admin/modules', 302);

    // The household filled in the recipe's own config fields, keyed by their
    // `key`. Everything else about the recipe is fixed by the catalogue entry —
    // the household is choosing values, not authoring a recipe.
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const supplied: RecipeConfig = {};
    for (const field of entry.recipe.config) {
      const raw = body[`cfg_${field.key}`];
      if (typeof raw === 'string') supplied[field.key] = raw;
    }
    const config = normaliseConfig(entry.recipe, supplied);

    const id = randomBytes(6).toString('hex');
    const name = (typeof body['name'] === 'string' && body['name'].trim()) || entry.name;
    const blockKey = createRecipeModule(deps.db, {
      id,
      name,
      url: entry.recipe.fetch.url,
      recipe: entry.recipe,
      config,
      secretsEnvelope: encryptSecrets(entry.recipe.secrets, body, 'sec_'),
    });
    ensureDisplayBlock(deps.db, blockKey);
    deps.db.prepare(`UPDATE job_state SET next_run_at = 0 WHERE kind = 'external-modules'`).run();
    return c.redirect('/admin/modules', 302);
  });

  /**
   * Collect the secret values the household typed and seal them into one keyring
   * envelope. The plaintext never leaves this function; only the envelope is
   * stored, and only decrypted at fetch time. Null when the recipe has no
   * secrets or the household left them blank.
   */
  function encryptSecrets(
    fields: readonly { key: string }[],
    body: Record<string, unknown>,
    prefix: string,
  ): string | null {
    const values: Record<string, string> = {};
    for (const field of fields) {
      const raw = body[`${prefix}${field.key}`];
      if (typeof raw === 'string' && raw !== '') values[field.key] = raw;
    }
    if (Object.keys(values).length === 0) return null;
    return deps.keyring.encrypt(JSON.stringify(values), 'recipe-secret');
  }

  app.get('/admin/modules/recipe', (c: Context) => c.html(recipePage()));

  app.post('/admin/modules/recipe', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const manifestRaw = typeof body['manifest'] === 'string' ? body['manifest'] : '';
    const configRaw = typeof body['config'] === 'string' ? body['config'] : '';
    const secretsRaw = typeof body['secrets'] === 'string' ? body['secrets'] : '';
    const nameOverride = typeof body['name'] === 'string' ? body['name'].trim() : '';
    const back = (message: string): Response =>
      c.html(recipePage(message, manifestRaw, configRaw, secretsRaw), 400);

    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(manifestRaw);
    } catch {
      return back('That recipe is not valid JSON.');
    }
    const parsed = recipeSchema.safeParse(manifestJson);
    if (!parsed.success) {
      // Name the first thing wrong, with its field — a recipe author is standing
      // at a form, not reading a stack trace.
      const first = parsed.error.issues[0];
      const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
      const why = first?.message ?? 'not a valid recipe';
      return back(`This recipe is not valid — ${where}${why}.`);
    }
    const recipe = parsed.data;

    let configJson: unknown = {};
    if (configRaw.trim() !== '') {
      try {
        configJson = JSON.parse(configRaw);
      } catch {
        return back('The config is not valid JSON.');
      }
    }
    const supplied =
      configJson !== null && typeof configJson === 'object' ? (configJson as RecipeConfig) : {};
    const config = normaliseConfig(recipe, supplied);

    // Secrets, if the recipe declares any: a JSON object of {key: value},
    // encrypted here and stored as an envelope only.
    let secretsEnvelope: string | null = null;
    if (recipe.secrets.length > 0 && secretsRaw.trim() !== '') {
      let secretsJson: unknown;
      try {
        secretsJson = JSON.parse(secretsRaw);
      } catch {
        return back('The secrets are not valid JSON.');
      }
      const values: Record<string, string> = {};
      if (secretsJson !== null && typeof secretsJson === 'object') {
        for (const field of recipe.secrets) {
          const v = (secretsJson as Record<string, unknown>)[field.key];
          if (typeof v === 'string' && v !== '') values[field.key] = v;
        }
      }
      if (Object.keys(values).length > 0) {
        secretsEnvelope = deps.keyring.encrypt(JSON.stringify(values), 'recipe-secret');
      }
    }

    const id = randomBytes(6).toString('hex');
    const blockKey = createRecipeModule(deps.db, {
      id,
      name: nameOverride || recipe.name,
      url: recipe.fetch.url,
      recipe,
      config,
      secretsEnvelope,
    });
    ensureDisplayBlock(deps.db, blockKey);
    deps.db.prepare(`UPDATE job_state SET next_run_at = 0 WHERE kind = 'external-modules'`).run();
    return c.redirect('/admin/modules', 302);
  });

  app.post('/admin/modules', async (c: Context) => {
    const shaped = parse(addBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(advancedPage(shaped.message), 400);

    let url: URL;
    try {
      url = new URL(shaped.value.url.trim());
    } catch {
      return c.html(advancedPage('That does not look like a web address.'), 400);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return c.html(advancedPage('A module address has to start with http:// or https://.'), 400);
    }

    const id = randomBytes(6).toString('hex');
    // The module's own name if it answers, the address if it does not — a module
    // that is still starting up should still be addable.
    const name = shaped.value.name?.trim() || (await readName(url.toString())) || url.host;

    const blockKey = createExternalModule(deps.db, { id, url: url.toString(), name });
    ensureDisplayBlock(deps.db, blockKey);
    // Poll now, so its panel fills in without waiting for the interval.
    deps.db.prepare(`UPDATE job_state SET next_run_at = 0 WHERE kind = 'external-modules'`).run();
    return c.redirect('/admin/modules', 302);
  });

  app.post('/admin/modules/:id/toggle', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const module = readExternalModules(deps.db).find((m) => m.id === id);
    if (module !== undefined) {
      const enable = module.enabled === 0;
      setExternalModuleEnabled(deps.db, id, enable);
      if (enable) ensureDisplayBlock(deps.db, module.blockKey);
      else removeDisplayBlock(deps.db, module.blockKey);
    }
    return c.redirect('/admin/modules', 302);
  });

  app.post('/admin/modules/:id/alerts', async (c: Context) => {
    const id = c.req.param('id') ?? '';
    const module = readExternalModules(deps.db).find((m) => m.id === id);
    if (module === undefined) return c.redirect('/admin/modules', 302);

    const shaped = parse(alertsBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(storePage(shaped.message), 400);

    const action = shaped.value.action;
    setExternalModuleAlertsAction(deps.db, id, action);
    // Keep the one source-scoped rule in step. This is the only thing that lets
    // a module's signals reach the wall — and it can only ever match this
    // module (see syncModuleAlertRule).
    syncModuleAlertRule(deps.db, { moduleId: id, moduleName: module.name, action });
    return c.redirect('/admin/modules', 302);
  });

  app.post('/admin/modules/:id/remove', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const module = readExternalModules(deps.db).find((m) => m.id === id);
    if (module !== undefined) {
      deleteExternalModule(deps.db, id);
      removeDisplayBlock(deps.db, module.blockKey);
      // A removed module leaves no rule behind to fire on signals it will never
      // send again.
      deleteRule(deps.db, moduleAlertRuleId(id));
    }
    return c.redirect('/admin/modules', 302);
  });

  /** Read a module's manifest name at add time, forgivingly. */
  async function readName(base: string): Promise<string | null> {
    try {
      const response = await deps.fetcher.fetch({
        url: `${base.replace(/\/+$/, '')}/maverick.json`,
        policy: POLICY,
        maxBytes: FETCH_LIMITS.json,
        acceptContentTypes: ['application/json'],
        timeoutMs: 8_000,
      });
      if (response.status !== 'ok') return null;
      const parsed = z
        .object({ name: z.string().max(60) })
        .safeParse(JSON.parse(response.body));
      return parsed.success ? parsed.data.name : null;
    } catch {
      return null;
    }
  }

  function card(module: ExternalModuleRow): string {
    const at = now();
    const health =
      module.lastPolledAt === 0
        ? `<span class="tag"><span class="dot dot-idle"></span>Not checked yet</span>`
        : module.lastError !== null
          ? `<span class="tag tag-bad"><span class="dot dot-bad"></span>${escapeHtml(module.lastError)}</span>`
          : `<span class="tag tag-ok"><span class="dot dot-ok"></span>Working · updated ${escapeHtml(ago(module.lastPolledAt, at))}</span>`;
    const action = `admin/modules/${encodeURIComponent(module.id)}`;
    return (
      // The id is the anchor the sidebar's per-module nav entries link to.
      `<article class="card" id="mod-${escapeHtml(module.id)}">` +
      `<div style="display:flex;align-items:center;gap:12px">` +
      `<div style="flex:1;min-width:0"><div class="rname" style="font-size:16px">` +
      `${escapeHtml(module.name)}${module.enabled === 1 ? '' : ' (off)'}</div>` +
      `<div class="host">${escapeHtml(module.url)}</div></div>${health}</div>` +
      alertsControl(module, action) +
      `<div class="row" style="margin-top:14px;padding-top:14px;border-top:1px solid var(--ruleSoft)">` +
      `<form method="post" action="${action}/toggle">` +
      `<button class="secondary" type="submit">${module.enabled === 1 ? 'Turn off' : 'Turn on'}</button></form>` +
      `<form method="post" action="${action}/remove">` +
      `<button class="btn-danger" type="submit" style="margin-left:auto">Remove</button></form>` +
      `</div></article>`
    );
  }

  /**
   * The per-module alerts control: what this module may do to the wall.
   *
   * Off by default, and the three choices stop at "take over the wall" — a
   * third-party module is never offered "wake a dark screen", which stays with
   * genuine safety alerts. The note underneath says how many alerts the module
   * is reporting right now, so a household can tell the control is doing
   * something rather than guessing.
   */
  function alertsControl(module: ExternalModuleRow, action: string): string {
    const parsed = signalDataSchema.safeParse(module.signals);
    const count = parsed.success ? parsed.data.signals.length : 0;
    // A scriptless segmented control: three submit buttons in one form. Clicking
    // one posts that value straight away — no separate Save — and the current
    // choice carries the `.on` fill. Same values and route as the old <select>.
    const seg = (value: AlertsAction, label: string): string =>
      `<button type="submit" name="action" value="${value}"` +
      `${module.alertsAction === value ? ' class="on" aria-current="true"' : ''}>${label}</button>`;
    const status =
      module.alertsAction === 'none'
        ? 'This module cannot show alerts.'
        : count === 0
          ? 'No alerts from this module right now.'
          : count === 1
            ? '1 alert is showing on the wall.'
            : `${count} alerts are showing on the wall.`;
    return (
      `<div class="row" style="margin-top:14px;padding-top:14px;` +
      `border-top:1px solid var(--ruleSoft);align-items:center;gap:10px">` +
      `<span class="kick">Alerts</span>` +
      `<form method="post" action="${action}/alerts" class="seg" ` +
      `aria-label="What this module may do to the wall">` +
      seg('none', 'Off') +
      seg('banner', 'Banner') +
      seg('takeover', 'Take over') +
      `</form></div>` +
      `<p class="hint" style="margin-top:6px">${escapeHtml(status)} A module can raise ` +
      `a banner or cover the wall, but never wake a screen that has gone dark for ` +
      `the night, and you can always clear it from the wall.</p>`
    );
  }

  /** The Store: what you've installed, and the catalogue to install from. */
  function storePage(error?: string): string {
    const modules = readExternalModules(deps.db);
    return page({
      modules: navModules(deps.db),
      title: 'Store — Maverick Wall',
      nav: 'modules',
      heading: 'Store',
      action: { label: 'Advanced', href: 'admin/modules/advanced' },
      intro:
        'Modules add a panel to the wall — a countdown, a price, the weather, ' +
        'anything that fits. Pick one below and install it. The wall only ever ' +
        'shows what a module supplies; it never runs anything a module sends.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        (modules.length === 0 ? '' : `<h2 class="add">Installed</h2>${modules.map(card).join('')}`) +
        `<h2 class="add">Store</h2>` +
        CATALOG.modules.map(catalogCard).join('') +
        `<p class="hint" style="margin-top:18px">This store ships with Maverick Wall ` +
        `and grows by contribution — anyone can add a module with a pull request ` +
        `(see <span class="code">docs/adding-to-the-store.md</span>). To run a module ` +
        `of your own, or write a recipe by hand, use ` +
        `<a class="link" href="admin/modules/advanced">Advanced</a>.</p>`,
    });
  }

  /** Advanced: the two power tools, off the everyday path. */
  function advancedPage(error?: string, prefill?: ServiceEntry): string {
    const urlValue = prefill?.install.url ?? '';
    const nameValue = prefill?.name ?? '';
    const prefillHint =
      prefill === undefined
        ? ''
        : `<div style="margin:0 0 14px;padding:12px 14px;border:1px solid var(--ruleSoft);` +
          `border-radius:8px;background:var(--panel)"><strong>${escapeHtml(prefill.name)}</strong> — ` +
          `${escapeHtml(prefill.install.hint)}` +
          (prefill.install.source === undefined
            ? ''
            : ` <a class="link" href="${escapeHtml(prefill.install.source)}" ` +
              `rel="noreferrer noopener">Where to get it</a>`) +
          `</div>`;
    return page({
      modules: navModules(deps.db),
      title: 'Advanced — Maverick Wall',
      nav: 'modules',
      heading: 'Advanced',
      action: { label: 'Back to the Store', href: 'admin/modules' },
      intro:
        'Two power tools, off the everyday path: write a recipe by hand, or add a ' +
        'module that runs as its own service on your network.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        `<article class="card"><div class="rname" style="font-size:16px">Build a recipe</div>` +
        `<p style="margin:8px 0 0">A recipe is data, never code — it names a public web ` +
        `feed and how to draw it, and Maverick Wall does the fetching. Write one to try, ` +
        `or to contribute to the store.</p>` +
        `<div class="row" style="margin-top:14px;padding-top:14px;border-top:1px solid var(--ruleSoft)">` +
        `<a class="btn" href="admin/modules/recipe">Open the recipe builder</a></div></article>` +
        `<h2 class="add" id="add">Add a module by URL</h2>` +
        prefillHint +
        `<form method="post" action="admin/modules">` +
        textField({
          label: 'Module address',
          name: 'url',
          required: true,
          value: urlValue,
          placeholder: 'http://192.168.1.10:9000',
          hint:
            'The address of a module you run yourself as its own service. ' +
            'Maverick Wall reads its /panel on a few-minute cycle and draws what ' +
            'it returns — a small set of shapes, never a web page.',
          ...(prefill === undefined ? {} : { attrs: 'autofocus' }),
        }) +
        textField({
          label: 'Call it (optional)',
          name: 'name',
          value: nameValue,
          placeholder: 'Leave empty to use the module’s own name',
          attrs: 'maxlength="60"',
        }) +
        `<button type="submit">Add module</button></form>` +
        `<p class="hint">Only add a module you trust and run yourself. It never ` +
        `receives your calendars or your Home Assistant token; it only supplies ` +
        `values for the wall to show.</p>`,
    });
  }

  const RECIPE_EXAMPLE = JSON.stringify(
    {
      name: 'Bitcoin',
      contract: 1,
      fetch: {
        url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=gbp',
        intervalSeconds: 900,
      },
      panel: { kind: 'stat', title: 'Bitcoin', value: '{bitcoin.gbp | currency:GBP}', caption: 'GBP' },
    },
    null,
    2,
  );

  function recipePage(
    error?: string,
    manifest?: string,
    config?: string,
    secrets?: string,
  ): string {
    return page({
      modules: navModules(deps.db),
      title: 'Add a recipe — Maverick Wall',
      nav: 'modules',
      heading: 'Add a recipe',
      action: { label: 'Back to Advanced', href: 'admin/modules/advanced' },
      intro:
        'A recipe is a module with no service to host: it names a public web feed ' +
        'and how to draw it, and Maverick Wall does the fetching. A recipe is data, ' +
        'never code — it can pull fields and format them, and nothing else.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        `<form method="post" action="admin/modules/recipe">` +
        textField({
          label: 'Call it (optional)',
          name: 'name',
          placeholder: 'Leave empty to use the recipe’s own name',
          attrs: 'maxlength="60"',
        }) +
        textareaField({
          label: 'Recipe',
          name: 'manifest',
          rows: 16,
          required: true,
          value: manifest ?? RECIPE_EXAMPLE,
          attrs: 'spellcheck="false" style="font-family:var(--mono);font-size:13px"',
        }) +
        `<p class="hint">A recipe reaches the public internet over https only. To ` +
        `point one at a service on your own network, add <span class="code">` +
        `"allowLan": true</span> to its <span class="code">fetch</span>. It selects ` +
        `values with dotted paths (<span class="code">{bitcoin.gbp}</span>) and a ` +
        `fixed set of formatters (<span class="code">upper</span>, ` +
        `<span class="code">round:1</span>, <span class="code">currency:GBP</span>, ` +
        `<span class="code">date:relative</span>, <span class="code">truncate:40</span>).</p>` +
        textareaField({
          label: 'Config values (optional JSON)',
          name: 'config',
          rows: 3,
          value: config ?? '',
          placeholder: '{ "station": "12345" }',
          attrs: 'spellcheck="false" style="font-family:var(--mono);font-size:13px"',
        }) +
        `<p class="hint">If the recipe’s address has <span class="code">{placeholders}</span>, ` +
        `fill them here. A tidier form is coming; for now this is the raw way in.</p>` +
        textareaField({
          label: 'Secret values (optional JSON)',
          name: 'secrets',
          rows: 3,
          value: secrets ?? '',
          placeholder: '{ "api_key": "…" }',
          attrs: 'spellcheck="false" autocomplete="off" style="font-family:var(--mono);font-size:13px"',
        }) +
        `<p class="hint">If the recipe declares <span class="code">secrets</span> and uses ` +
        `them in a <span class="code">header</span>, put the values here. They are ` +
        `stored encrypted and never shown again — a secret may not go in the address.</p>` +
        `<button type="submit">Add recipe</button></form>`,
    });
  }

  /** One store card: glyph, name, author, description, and an Install link. */
  function catalogCard(entry: CatalogEntry): string {
    // A glyph-only "screenshot" beside the icon: the entry's authored preview,
    // or one derived from a recipe's own panel shape. First line is the
    // headline, the rest captions, like a wall stat panel. Absent for a service
    // that authored none.
    const lines = previewFor(entry);
    const preview =
      lines === undefined
        ? ''
        : `<div class="cpreview">` +
          lines
            .map((line, i) => (i === 0 ? `<b>${escapeHtml(line)}</b>` : `<i>${escapeHtml(line)}</i>`))
            .join('') +
          `</div>`;
    return (
      `<article class="card">` +
      `<div style="display:flex;align-items:flex-start;gap:12px">` +
      `<div style="font-size:26px;line-height:1">${escapeHtml(entry.icon)}</div>` +
      preview +
      `<div style="flex:1;min-width:0">` +
      `<div class="rname" style="font-size:16px">${escapeHtml(entry.name)}</div>` +
      `<div class="host">by ${escapeHtml(entry.author)}</div>` +
      `<p style="margin:8px 0 0">${escapeHtml(entry.description)}</p></div>` +
      `<span class="tag" style="align-self:flex-start">${entry.kind === 'recipe' ? 'Recipe' : 'Service'}</span>` +
      `</div>` +
      `<div class="row" style="margin-top:14px;padding-top:14px;` +
      `border-top:1px solid var(--ruleSoft)">` +
      // A recipe installs in a click and a couple of fields; a service (which you
      // run yourself) hands off to the Advanced add-by-URL form, pre-filled.
      (entry.kind === 'recipe'
        ? `<a class="btn" href="admin/modules/install/${encodeURIComponent(entry.id)}">Install</a>`
        : `<a class="btn" href="admin/modules/advanced?install=${encodeURIComponent(entry.id)}#add">Install</a>` +
          (entry.install.source === undefined
            ? ''
            : `<a class="link" style="margin-left:auto;align-self:center" ` +
              `href="${escapeHtml(entry.install.source)}" rel="noreferrer noopener">Source</a>`)) +
      `</div></article>`
    );
  }

  /**
   * Installing a recipe from the catalogue: fill in its config, not JSON.
   *
   * The recipe manifest is fixed by the entry — the household is only choosing
   * values for the fields the recipe declared (a latitude, a station id). An
   * input per `recipe.config` field, its default pre-filled. A recipe with no
   * config is just a confirm.
   */
  function installRecipePage(entry: RecipeEntry): string {
    const fields = entry.recipe.config
      .map(
        (field) =>
          textField({
            label: field.label,
            name: `cfg_${field.key}`,
            value: field.default ?? '',
            attrs: 'maxlength="280"',
          }),
      )
      .join('');
    // Secrets are password inputs, never pre-filled, and the household is told
    // exactly where the value will be sent before they type it.
    const secretFields = entry.recipe.secrets
      .map(
        (field) =>
          textField({
            label: field.label,
            name: `sec_${field.key}`,
            type: 'password',
            attrs: 'autocomplete="off" maxlength="280"',
          }),
      )
      .join('');
    const secretsBlock =
      secretFields === ''
        ? ''
        : `<h2 class="add">Credentials</h2>` +
          `<p class="hint" style="margin-top:0">These are stored encrypted and sent ` +
          `only to <span class="code">${escapeHtml(recipeFetchHost(entry.recipe))}</span>. ` +
          `They never appear on the wall or in a log.</p>${secretFields}`;
    return page({
      modules: navModules(deps.db),
      title: `Install ${entry.name} — Maverick Wall`,
      nav: 'modules',
      heading: `Install ${entry.name}`,
      action: { label: 'Back to the Store', href: 'admin/modules' },
      intro: entry.description,
      body:
        `<form method="post" action="admin/modules/install/${encodeURIComponent(entry.id)}">` +
        textField({
          label: 'Call it (optional)',
          name: 'name',
          value: entry.name,
          attrs: 'maxlength="60"',
        }) +
        (fields === ''
          ? secretFields === ''
            ? `<p class="hint">This recipe needs no settings.</p>`
            : ''
          : `<h2 class="add">Settings</h2>${fields}`) +
        secretsBlock +
        `<button type="submit" style="margin-top:16px">Add to the wall</button></form>` +
        `<p class="hint">A recipe is data, never code. It reads a web feed and shows ` +
        `a value from it — it never runs anything, and never receives anything ` +
        `about your household.</p>`,
    });
  }

}
