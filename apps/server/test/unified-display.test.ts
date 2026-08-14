import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { issueDisplayToken } from '../src/auth/tokens.js';

/**
 * The display detail page is one page, not two tabs (Appearance + Layout were
 * merged), and the layout leads: it is the wall being built, and the theme and
 * the screen's settings customise it beneath. Both halves are drawn together and
 * the two orientation controls are told apart in the copy — a regression would
 * silently split them again or bury the layout below the settings.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let n = 0;
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function ready() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-unified-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const address = `10.11.1.${++n}`;
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 't'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => address,
    setupToken,
    dataDir,
  });

  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie !== '') headers.set('cookie', cookie);
    const res = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers, redirect: 'manual' }));
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return res;
  };
  const postForm = (path: string, fields: Record<string, string>) =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  await call(`/setup?token=${setupToken.current().token}`);
  await postForm('/setup/account', {
    name: 'H', email: `t${n}@home.local`,
    password: 'correct-horse-battery', confirm: 'correct-horse-battery',
  });
  await postForm('/setup/household', { timezone: 'Europe/London' });

  /** Pair a screen so the detail page has a real wall to render. */
  const pairScreen = (id: string, name: string): void => {
    const at = Date.now();
    const issued = issueDisplayToken();
    db.prepare(
      `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(id, name, issued.tokenHash, at, at, at);
  };

  return { db, call, pairScreen };
}

describe('the unified display page', () => {
  it('is a two-pane editor: sticky preview left, tabbed settings right, one save', async () => {
    const h = await ready();
    h.pairScreen('s1', 'Kitchen');
    const res = await h.call('/admin/displays/s1');
    expect(res.status).toBe(200);
    const html = await res.text();

    // Every settings field survived the re-layout, grouped under the three tabs.
    expect(html).toContain('name="orientation"');
    expect(html).toContain('Always landscape');
    expect(html).toContain('name="daytime_theme"');
    expect(html).toContain('data-tabpanel="look"');
    expect(html).toContain('data-tabpanel="content"');
    expect(html).toContain('data-tabpanel="device"');
    expect(html).toContain('data-tab="look"');

    // The layout editor and its chrome are both present on the same page.
    expect(html).toContain('id="layout-editor"');
    expect(html).toContain('assets/layout-editor.js');
    expect(html).toContain('assets/display-editor.js');
    expect(html).toContain('id="layout"');

    // Exactly one save action: the sticky bar's button, and the settings form
    // carries no submit button of its own (the two saves were unified).
    expect(html).toContain('data-action="save"');
    expect(html).toContain('id="savebar"');
    const settingsForm = html.slice(html.indexOf('data-settings'));
    const formOnly = settingsForm.slice(0, settingsForm.indexOf('</form>'));
    expect(formOnly).not.toContain('type="submit"');

    // The old server-side view tabs are gone.
    expect(html).not.toContain('?view=');
    expect(html).not.toContain('class="subtab');

    // The preview leads: the editor mount comes before the settings fields.
    expect(html.indexOf('id="layout-editor"')).toBeLessThan(html.indexOf('name="orientation"'));
  });

  it('tells the two orientation controls apart in the copy', async () => {
    const h = await ready();
    h.pairScreen('s2', 'Hall');
    const html = await (await h.call('/admin/displays/s2')).text();
    // The pin explains it chooses which layout the wall shows, and is not the
    // editor's edit toggle.
    expect(html).toContain('chooses which layout this wall shows');
    expect(html).toContain('not the Portrait/Landscape buttons in the layout editor');
  });

  it('draws the Default display as one page too', async () => {
    const h = await ready();
    const html = await (await h.call('/admin/displays/default')).text();
    expect(html).toContain('id="layout-editor"');
    expect(html).toContain('id="layout"');
    expect(html).not.toContain('?view=');
  });
});
