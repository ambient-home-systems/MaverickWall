import type { Context, Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { FETCH_LIMITS } from '@maverick-wall/core';
import { errorBlock, escapeHtml, page } from './html.js';
import { ago } from './admin.js';
import type { AdminDeps } from './admin.js';
import {
  createExternalModule,
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
import { CATALOG, catalogEntry, type CatalogEntry } from './catalog.js';
import { parse, text, z } from '../validation.js';

/**
 * Add-ons — third-party modules (docs/rfc-001-module-framework.md).
 *
 * A module is its own HTTP service the household registers by URL. This screen
 * adds it, shows whether it is answering, and lets it be switched off or
 * removed. The polling, validation and rendering are elsewhere; this is only the
 * household's corner of it. Read-only towards the module in the sense that
 * matters: nothing here executes what a module returns.
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

  app.get('/admin/modules', (c: Context) => {
    // `?install=<id>` deep-links from the catalogue and fills the add form in —
    // a query parameter, not a script, the same "prefill" the rule templates use.
    const prefill = catalogEntry(c.req.query('install') ?? '');
    return c.html(modulesPage(undefined, prefill));
  });

  app.get('/admin/modules/browse', (c: Context) => c.html(browsePage()));

  app.post('/admin/modules', async (c: Context) => {
    const shaped = parse(addBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(modulesPage(shaped.message), 400);

    let url: URL;
    try {
      url = new URL(shaped.value.url.trim());
    } catch {
      return c.html(modulesPage('That does not look like a web address.'), 400);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return c.html(modulesPage('A module address has to start with http:// or https://.'), 400);
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
    if (!shaped.ok) return c.html(modulesPage(shaped.message), 400);

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
      `<article class="card">` +
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
    const opt = (value: AlertsAction, label: string): string =>
      `<option value="${value}"${module.alertsAction === value ? ' selected' : ''}>${label}</option>`;
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
      `<form method="post" action="${action}/alerts" ` +
      `style="display:flex;align-items:center;gap:10px;flex:1;margin:0">` +
      `<label for="alerts-${module.id}" style="margin:0">Alerts</label>` +
      `<select id="alerts-${module.id}" name="action">` +
      opt('none', 'Off') +
      opt('banner', 'Show a banner') +
      opt('takeover', 'Take over the wall') +
      `</select>` +
      `<button class="secondary" type="submit">Save</button></form></div>` +
      `<p class="hint" style="margin-top:6px">${escapeHtml(status)} A module can raise ` +
      `a banner or cover the wall, but never wake a screen that has gone dark for ` +
      `the night, and you can always clear it from the wall.</p>`
    );
  }

  function modulesPage(error?: string, prefill?: CatalogEntry): string {
    const modules = readExternalModules(deps.db);
    // When the add form was reached from the catalogue, pre-fill its fields and
    // show the entry's install guidance above them.
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
      title: 'Add-ons — Maverick Wall',
      nav: 'modules',
      heading: 'Add-ons',
      action: { label: 'Browse the catalogue', href: 'admin/modules/browse' },
      intro:
        'Third-party modules put an extra panel on the wall. A module is its own ' +
        'small service on your network; Maverick Wall reads it and draws it, and ' +
        'never runs anything it sends.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        (modules.length === 0 ? '' : modules.map(card).join('')) +
        `<h2 class="add" id="add">Add a module</h2>` +
        prefillHint +
        `<form method="post" action="admin/modules">` +
        `<label for="url">Module address</label>` +
        `<input id="url" name="url" type="text" required value="${escapeHtml(urlValue)}" ` +
        `placeholder="http://192.168.1.10:9000"${prefill === undefined ? '' : ' autofocus'}>` +
        `<p class="hint">The address of the module’s own service. Maverick Wall ` +
        `reads its <span class="code">/panel</span> on a few-minute cycle and ` +
        `draws what it returns — a small set of shapes, never a web page.</p>` +
        `<label for="name">Call it (optional)</label>` +
        `<input id="name" name="name" type="text" maxlength="60" value="${escapeHtml(nameValue)}" ` +
        `placeholder="Leave empty to use the module’s own name">` +
        `<button type="submit">Add module</button></form>` +
        `<p class="hint">Only add a module you trust and run yourself. It never ` +
        `receives your calendars or your Home Assistant token; it only supplies ` +
        `values for the wall to show.</p>`,
    });
  }

  /** One catalogue card: glyph, name, author, description, and an Install link. */
  function catalogCard(entry: CatalogEntry): string {
    return (
      `<article class="card">` +
      `<div style="display:flex;align-items:flex-start;gap:12px">` +
      `<div style="font-size:26px;line-height:1">${escapeHtml(entry.icon)}</div>` +
      `<div style="flex:1;min-width:0">` +
      `<div class="rname" style="font-size:16px">${escapeHtml(entry.name)}</div>` +
      `<div class="host">by ${escapeHtml(entry.author)}</div>` +
      `<p style="margin:8px 0 0">${escapeHtml(entry.description)}</p></div></div>` +
      `<div class="row" style="margin-top:14px;padding-top:14px;` +
      `border-top:1px solid var(--ruleSoft)">` +
      `<a class="btn" href="admin/modules?install=${encodeURIComponent(entry.id)}#add">Install</a>` +
      (entry.install.source === undefined
        ? ''
        : `<a class="link" style="margin-left:auto;align-self:center" ` +
          `href="${escapeHtml(entry.install.source)}" rel="noreferrer noopener">Source</a>`) +
      `</div></article>`
    );
  }

  function browsePage(): string {
    return page({
      title: 'Browse modules — Maverick Wall',
      nav: 'modules',
      heading: 'Browse the catalogue',
      action: { label: 'Back to Add-ons', href: 'admin/modules' },
      intro:
        'Modules people have built and shared. Choosing one shows you how to run ' +
        'it and fills the address in for you — nothing is installed until you add ' +
        'it yourself. A module only ever supplies values for the wall to show.',
      body:
        CATALOG.modules.map(catalogCard).join('') +
        `<p class="hint">This list ships with Maverick Wall. A community-updated ` +
        `catalogue, fetched only if you ask, is on the way. To add one of your own, ` +
        `open a pull request against <span class="code">apps/server/src/http/catalog.ts</span>.</p>`,
    });
  }
}
