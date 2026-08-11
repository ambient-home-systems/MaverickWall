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
  setExternalModuleEnabled,
  type ExternalModuleRow,
} from '../api/external-modules.js';
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

// A module runs on the household's own network, so LAN, loopback and http are
// all permitted — the same policy the poll uses. The health check reads its
// manifest and nothing more.
const POLICY = { allowHttp: true, allowPrivateNetwork: true, allowLoopback: true } as const;

export function registerModuleRoutes(app: Hono, deps: AdminDeps): void {
  const now = deps.now ?? ((): number => Date.now());

  app.get('/admin/modules', (c: Context) => c.html(modulesPage()));

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

  app.post('/admin/modules/:id/remove', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const module = readExternalModules(deps.db).find((m) => m.id === id);
    if (module !== undefined) {
      deleteExternalModule(deps.db, id);
      removeDisplayBlock(deps.db, module.blockKey);
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
      `<div class="row" style="margin-top:14px;padding-top:14px;border-top:1px solid var(--ruleSoft)">` +
      `<form method="post" action="${action}/toggle">` +
      `<button class="secondary" type="submit">${module.enabled === 1 ? 'Turn off' : 'Turn on'}</button></form>` +
      `<form method="post" action="${action}/remove">` +
      `<button class="btn-danger" type="submit" style="margin-left:auto">Remove</button></form>` +
      `</div></article>`
    );
  }

  function modulesPage(error?: string): string {
    const modules = readExternalModules(deps.db);
    return page({
      title: 'Add-ons — Maverick Wall',
      nav: 'modules',
      heading: 'Add-ons',
      action: { label: 'Add a module', href: 'admin/modules#add' },
      intro:
        'Third-party modules put an extra panel on the wall. A module is its own ' +
        'small service on your network; Maverick Wall reads it and draws it, and ' +
        'never runs anything it sends.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        (modules.length === 0 ? '' : modules.map(card).join('')) +
        `<h2 class="add" id="add">Add a module</h2>` +
        `<form method="post" action="admin/modules">` +
        `<label for="url">Module address</label>` +
        `<input id="url" name="url" type="text" required placeholder="http://192.168.1.10:9000">` +
        `<p class="hint">The address of the module’s own service. Maverick Wall ` +
        `reads its <span class="code">/panel</span> on a few-minute cycle and ` +
        `draws what it returns — a small set of shapes, never a web page.</p>` +
        `<label for="name">Call it (optional)</label>` +
        `<input id="name" name="name" type="text" maxlength="60" ` +
        `placeholder="Leave empty to use the module’s own name">` +
        `<button type="submit">Add module</button></form>` +
        `<p class="hint">Only add a module you trust and run yourself. It never ` +
        `receives your calendars or your Home Assistant token; it only supplies ` +
        `values for the wall to show.</p>`,
    });
  }
}
