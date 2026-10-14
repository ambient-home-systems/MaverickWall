import type { Context, Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { errorBlock, escapeHtml, page, textField, textareaField } from './html.js';
import { card, section, tag } from './components.js';
import { navModules, type AdminDeps } from './admin.js';
import { createScriptModule, ensureDisplayBlock } from '../api/external-modules.js';
import { normaliseConfig, withReadingValues, type RecipeConfig } from '../modules/external/recipe.js';
import {
  scriptFetch,
  scriptManifestSchema,
  scriptSha256,
  scriptSourceSchema,
  SCRIPT_LIMITS,
  type ScriptManifest,
} from '../modules/external/script.js';
import { runScript, type ScriptRun } from '../modules/external/sandbox.js';
import { householdTimezone, readingValueReader } from '../modules/external/index.js';
import { catalogEntry, type ScriptEntry } from './catalog.js';
import { invalidSetting, readSettingsForm, settingsControls, watchedReadingChoices } from './module-settings.js';
import { builtPreview } from './admin-modules.js';
import { savedRedirect } from './saved.js';
import { selfHref } from './self.js';

/**
 * Script modules in the admin (RFC 017, plan item M7.12): pasting one, running
 * it once, and installing one from the store.
 *
 * Before anything is installed or run, the household is shown what the script
 * may reach — every host, which credential goes to which host, whether it may
 * use their own network — and the sha256 of its code, in the consent shape the
 * update check uses. Pressing a button on that page is the consent, and it is
 * bound to exactly what was shown: change a host or a character of the code and
 * the page asks again.
 */

/** What a household agreed to: the manifest and the code together. */
function consentKey(manifest: ScriptManifest, source: string): string {
  return scriptSha256(`${JSON.stringify(manifest)}\n${source}`);
}

const MANIFEST_EXAMPLE = JSON.stringify(
  {
    name: 'Days until the holidays',
    contract: 1,
    hosts: ['date.nager.at'],
    config: [{ key: 'country', label: 'Country code', type: 'string', default: 'GB' }],
    intervalSeconds: 3600,
  },
  null,
  2,
);

const SOURCE_EXAMPLE = `// Counts the days to the next public holiday, which a recipe cannot work out.
export default async function run(ctx) {
  const year = ctx.local(ctx.now).year;
  const res = await ctx.fetch('https://date.nager.at/api/v3/PublicHolidays/' + year + '/' + ctx.config.country);
  if (!res.ok) throw new Error('The holiday list did not answer.');
  const next = (await res.json()).find((day) => Date.parse(day.date) > ctx.now);
  if (next === undefined) return { panel: { kind: 'text', text: 'No more holidays this year.' } };
  const days = Math.ceil((Date.parse(next.date) - ctx.now) / 86400000);
  return { panel: { kind: 'stat', title: next.localName, value: String(days), caption: days === 1 ? 'day' : 'days' } };
}
`;

/** What the household agrees to, said before anything runs. */
export function consentCard(manifest: ScriptManifest, source: string): string {
  const hosts =
    manifest.hosts.length === 0
      ? `<p>It contacts nothing: it works its panel out on this server and asks nobody.</p>`
      : `<p>It may contact ${manifest.hosts.map((host) => tag(host)).join(' ')}` +
        (manifest.allowLan
          ? ` — including addresses on your own network, and by plain http.</p>`
          : ` — and only over https, and never your own network.</p>`);
  const secrets =
    manifest.secrets.length === 0
      ? ''
      : `<p>Its credentials are sent only to their own host: ` +
        manifest.secrets
          .map((secret) => `${escapeHtml(secret.label)} to <span class="code">${escapeHtml(secret.host)}</span>`)
          .join(', ') +
        `. The code never sees them.</p>`;
  return card(
    `<h2>Before it runs</h2>` +
      hosts +
      secrets +
      `<p>Its code runs on this server in a sandbox, with no files, no other network and no way ` +
      `to read a credential, for at most ${SCRIPT_LIMITS.wallMs / 1000} seconds at a time. What it ` +
      `returns is checked before a wall sees it, and the wall only ever draws data.</p>` +
      `<p class="hint">The code’s sha256 is <span class="code" data-script-sha>${scriptSha256(source)}</span>. ` +
      `The module’s card shows it too, so you can tell one version from another.</p>`,
    manifest.allowLan ? { tone: 'warn' } : {},
  );
}

/** One line for a script module's card: what it may contact, and which code it is. */
export function scriptHostLine(manifest: unknown, source: string | null): string {
  const parsed = scriptManifestSchema.safeParse(manifest);
  const hosts = parsed.success
    ? parsed.data.hosts.length === 0
      ? 'Contacts nothing'
      : `May contact ${parsed.data.hosts.join(', ')}`
    : 'Not valid';
  return `Script · ${escapeHtml(hosts)} · sha256 <span class="code">${source === null ? '—' : scriptSha256(source)}</span>`;
}

interface ScriptForm {
  readonly name: string;
  readonly manifest: string;
  readonly source: string;
  readonly config: string;
  readonly secrets: string;
}

type ReadForm =
  | {
      readonly ok: true;
      readonly manifest: ScriptManifest;
      readonly source: string;
      readonly config: RecipeConfig;
      readonly secrets: Record<string, string>;
    }
  | { readonly ok: false; readonly error: string };

/** The pasted form, read with the same schemas the poll uses. The first thing wrong is named, with its field. */
function readForm(form: ScriptForm): ReadForm {
  let json: unknown;
  try {
    json = JSON.parse(form.manifest);
  } catch {
    return { ok: false, error: 'The manifest is not valid JSON.' };
  }
  const manifest = scriptManifestSchema.safeParse(json);
  if (!manifest.success) {
    const first = manifest.error.issues[0];
    const where = first !== undefined && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
    return { ok: false, error: `This manifest is not valid — ${where}${first?.message ?? 'not a manifest'}.` };
  }
  const source = scriptSourceSchema.safeParse(form.source);
  if (!source.success) return { ok: false, error: `The script — ${source.error.issues[0]?.message ?? 'is not valid'}.` };
  const object = (raw: string, what: string): Record<string, unknown> | string => {
    if (raw.trim() === '') return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Said below.
    }
    return `The ${what} are not a JSON object.`;
  };
  const config = object(form.config, 'settings');
  if (typeof config === 'string') return { ok: false, error: config };
  const supplied: RecipeConfig = {};
  for (const [key, value] of Object.entries(config)) if (typeof value === 'string') supplied[key] = value;
  const refused = invalidSetting(manifest.data.config, supplied);
  if (refused !== undefined) return { ok: false, error: refused };
  const secretsJson = object(form.secrets, 'secret values');
  if (typeof secretsJson === 'string') return { ok: false, error: secretsJson };
  const secrets: Record<string, string> = {};
  for (const secret of manifest.data.secrets) {
    const value = secretsJson[secret.key];
    if (typeof value === 'string' && value !== '') secrets[secret.key] = value;
  }
  return { ok: true, manifest: manifest.data, source: source.data, config: normaliseConfig(manifest.data, supplied), secrets };
}

export function registerScriptRoutes(app: Hono, deps: AdminDeps): void {
  const now = deps.now ?? ((): number => Date.now());

  const field = (body: Record<string, unknown>, name: string): string =>
    typeof body[name] === 'string' ? body[name] : '';
  const formOf = (body: Record<string, unknown>): ScriptForm => ({
    name: field(body, 'name').trim(),
    manifest: field(body, 'manifest'),
    source: field(body, 'source'),
    config: field(body, 'config'),
    secrets: field(body, 'secrets'),
  });

  function seal(secrets: Record<string, string>): string | null {
    return Object.keys(secrets).length === 0 ? null : deps.keyring.encrypt(JSON.stringify(secrets), 'recipe-secret');
  }

  function install(name: string, manifest: ScriptManifest, source: string, config: RecipeConfig, sealed: string | null): void {
    const id = randomBytes(6).toString('hex');
    const blockKey = createScriptModule(deps.db, {
      id,
      name: name || manifest.name,
      url: manifest.hosts[0] === undefined ? '' : `https://${manifest.hosts[0]}`,
      manifest,
      source,
      config,
      secretsEnvelope: sealed,
    });
    ensureDisplayBlock(deps.db, blockKey);
    deps.db.prepare(`UPDATE job_state SET next_run_at = 0 WHERE kind = 'external-modules'`).run();
  }

  app.get('/admin/modules/script', (c: Context) => c.html(scriptPage(c, {})));

  // Check, then add: the first press shows what the script may reach, and the
  // second — on that page, carrying the key of what was shown — adds it.
  app.post('/admin/modules/script', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const form = formOf(body);
    const read = readForm(form);
    if (!read.ok) return c.html(scriptPage(c, { form, error: read.error }), 400);
    const key = consentKey(read.manifest, read.source);
    if (field(body, 'consent') !== key) return c.html(scriptPage(c, { form, consent: { manifest: read.manifest, source: read.source, key } }));
    install(form.name, read.manifest, read.source, read.config, seal(read.secrets));
    return savedRedirect(c, '/admin/modules', 'module-added');
  });

  /*
   * Run it once, for real — its own hosts, its own settings and credentials —
   * and show what it built, without adding it. Only after the household has
   * seen what it may reach, for the same reason installing waits for that.
   */
  app.post('/admin/modules/script/run', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const form = formOf(body);
    const read = readForm(form);
    if (!read.ok) return c.html(scriptPage(c, { form, error: read.error }), 400);
    const key = consentKey(read.manifest, read.source);
    const consent = { manifest: read.manifest, source: read.source, key };
    if (field(body, 'consent') !== key) return c.html(scriptPage(c, { form, consent }));
    const began = Date.now();
    const run = await runScript({
      source: read.source,
      config: withReadingValues(read.manifest, read.config, readingValueReader(deps.db)),
      now: now(),
      timeZone: householdTimezone(deps.db),
      fetch: scriptFetch(deps.fetcher, read.manifest, read.secrets, () => SCRIPT_LIMITS.wallMs - (Date.now() - began)),
    });
    return c.html(scriptPage(c, { form, consent, run }), run.ok ? 200 : 400);
  });

  app.get('/admin/modules/script/install/:id', (c: Context) => {
    const entry = catalogEntry(c.req.param('id') ?? '');
    if (entry === undefined || entry.kind !== 'script') return c.redirect('/admin/modules', 302);
    return c.html(installPage(c, entry));
  });

  app.post('/admin/modules/script/install/:id', async (c: Context) => {
    const entry = catalogEntry(c.req.param('id') ?? '');
    if (entry === undefined || entry.kind !== 'script') return c.redirect('/admin/modules', 302);
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const read = readSettingsForm(entry.manifest.config, body);
    if (read.error !== undefined) return c.html(installPage(c, entry, { values: read.values, error: read.error }), 400);
    const secrets: Record<string, string> = {};
    for (const secret of entry.manifest.secrets) {
      const value = body[`sec_${secret.key}`];
      if (typeof value === 'string' && value !== '') secrets[secret.key] = value;
    }
    install(
      field(body, 'name').trim() || entry.name,
      entry.manifest,
      entry.source,
      normaliseConfig(entry.manifest, read.values),
      seal(secrets),
    );
    return savedRedirect(c, '/admin/modules', 'module-added');
  });

  function scriptPage(
    c: Context,
    state: {
      readonly form?: ScriptForm;
      readonly error?: string;
      readonly consent?: { readonly manifest: ScriptManifest; readonly source: string; readonly key: string };
      readonly run?: ScriptRun;
    },
  ): string {
    const form = state.form;
    const mono = 'spellcheck="false" style="font-family:var(--mono);font-size:13px"';
    const consent = state.consent;
    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Add a script — Maverick Wall',
      nav: 'modules',
      heading: 'Add a script',
      back: { label: 'Advanced', href: 'admin/modules/advanced' },
      intro:
        'A script is a module written in JavaScript, for what a recipe cannot work out: arithmetic, ' +
        'conditions, merging two answers. It runs on this server in a sandbox and can only return ' +
        'data for the wall to draw — the wall never runs it.',
      body:
        (state.error === undefined ? '' : errorBlock(state.error)) +
        (state.run === undefined ? '' : runResult(state.run)) +
        `<form method="post" action="admin/modules/script">` +
        textField({
          label: 'Call it (optional)',
          name: 'name',
          value: form?.name ?? '',
          placeholder: 'Leave empty to use the manifest’s own name',
          attrs: 'maxlength="60"',
        }) +
        textareaField({ label: 'Manifest', name: 'manifest', rows: 10, required: true, value: form?.manifest ?? MANIFEST_EXAMPLE, attrs: mono }) +
        `<p class="hint">Every host it may fetch from goes in <span class="code">hosts</span>; ` +
        `anything else is refused before it leaves. A credential is declared in ` +
        `<span class="code">secrets</span> with the one host it goes to, and the script names it in a ` +
        `header as <span class="code">{secret:key}</span> without ever seeing it.</p>` +
        textareaField({ label: 'Script', name: 'source', rows: 16, required: true, value: form?.source ?? SOURCE_EXAMPLE, attrs: mono }) +
        `<p class="hint">One file with an <span class="code">export default</span> function. It is given ` +
        `<span class="code">ctx.config</span>, <span class="code">ctx.now</span>, ` +
        `<span class="code">ctx.timeZone</span>, <span class="code">ctx.local(instant)</span> and ` +
        `<span class="code">ctx.fetch(url, options)</span>, and returns <span class="code">{ panel, signals }</span>.</p>` +
        textareaField({ label: 'Settings (optional JSON)', name: 'config', rows: 3, value: form?.config ?? '', placeholder: '{ "country": "GB" }', attrs: mono }) +
        textareaField({
          label: 'Secret values (optional JSON)',
          name: 'secrets',
          rows: 3,
          value: form?.secrets ?? '',
          placeholder: '{ "api_key": "…" }',
          attrs: 'spellcheck="false" autocomplete="off" style="font-family:var(--mono);font-size:13px"',
        }) +
        (consent === undefined
          ? `<button type="submit">Check it</button>`
          : consentCard(consent.manifest, consent.source) +
            `<input type="hidden" name="consent" value="${consent.key}">` +
            `<div class="row">` +
            `<button type="submit" class="btn-tonal" formaction="admin/modules/script/run">Run it once</button>` +
            `<button type="submit">Add script</button></div>`) +
        `</form>` +
        (state.run?.ok === true && state.run.panel !== undefined
          ? `<script type="module" src="assets/recipe-preview.js"></script>`
          : ''),
    });
  }

  /** What one run built, or why it stopped, with how long it took. */
  function runResult(run: ScriptRun): string {
    const timing = `<p class="hint" data-script-timing>Started in ${Math.round(run.timing.startMs)} ms, ran for ${Math.round(run.timing.cpuMs)} ms, ${Math.round(run.timing.wallMs)} ms in all.</p>`;
    if (!run.ok) {
      return section(
        'Preview',
        undefined,
        card(
          `<p><strong>${escapeHtml(run.error)}</strong></p>` +
            (run.detail === '' ? '' : `<pre class="code" data-preview-detail>${escapeHtml(run.detail)}</pre>`) +
            timing,
          { tone: 'danger' },
        ),
        'preview',
      );
    }
    return builtPreview(run.panel, run.signals?.signals ?? []) + timing;
  }

  function installPage(c: Context, entry: ScriptEntry, echo?: { readonly values: RecipeConfig; readonly error: string }): string {
    const fields = settingsControls(entry.manifest.config, echo?.values, watchedReadingChoices(deps.db), entry.manifest.hosts[0] ?? 'nobody');
    const secretFields = entry.manifest.secrets
      .map((secret) => textField({ label: secret.label, name: `sec_${secret.key}`, type: 'password', attrs: 'autocomplete="off" maxlength="280"' }))
      .join('');
    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: `Install ${entry.name} — Maverick Wall`,
      nav: 'modules',
      heading: `Install ${entry.name}`,
      back: { label: 'Store', href: 'admin/modules' },
      intro: entry.description,
      body:
        `<form method="post" action="admin/modules/script/install/${encodeURIComponent(entry.id)}">` +
        textField({ label: 'Call it (optional)', name: 'name', value: entry.name, attrs: 'maxlength="60"' }) +
        (echo === undefined ? '' : errorBlock(echo.error)) +
        (fields === '' ? '' : `<h2 class="add">Settings</h2>${fields}`) +
        (secretFields === '' ? '' : `<h2 class="add">Credentials</h2>${secretFields}`) +
        consentCard(entry.manifest, entry.source) +
        `<button type="submit" style="margin-top:16px">Install</button></form>`,
    });
  }
}
