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

/**
 * Every asset a served stylesheet points at, resolved the way a browser
 * resolves it, and requested.
 *
 * `admin-origins.test.ts` proves rule three — that nothing here is fetched from
 * a *third party* — and it reads `url()` out of the inline `<style>` blocks,
 * resolving each against the document. That is the correct base for an inline
 * sheet and the wrong one for a linked file, and the gap between those two is
 * a whole class of bug it cannot see: a same-origin 404 is not a third-party
 * origin, so it passes.
 *
 * It shipped one. When the authenticated shell moved from an inline `<style>`
 * to `<link rel="stylesheet" href="assets/admin.css">`, the three `@font-face`
 * rules kept saying `url('assets/fonts/…')`. A relative URL inside a stylesheet
 * resolves against the **stylesheet's own URL**, never the document's `<base>`
 * — so from `/assets/admin.css` they became `/assets/assets/fonts/…` and 404'd
 * on every page behind the login from v0.54.0, while the wizard and sign-in,
 * which still inline the same string, kept working. `font-display:swap`
 * makes that failure silent: the admin simply rendered in the system font, and
 * the only screens a developer sees most while iterating were the two that were
 * fine.
 *
 * So this test does the resolution properly, per context, and then asks the
 * server for what it computed. It is deliberately not font-specific: any
 * `url()` in any served sheet — an icon, a mask, a background — is checked the
 * same way, so the next asset that moves fails here instead of in a kitchen.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const ORIGIN = 'http://localhost';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-asset-urls-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'o'.repeat(32), baseUrl: ORIGIN },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    // A distinct address per harness: the auth rate-limit counters are
    // module-global and outlive an instance, so a shared bucket would make one
    // test file's traffic another's 429.
    clientAddress: () => '10.9.9.7',
    setupToken,
    dataDir,
  });

  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = new Headers(init.headers);
    if (cookie !== '') headers.set('cookie', cookie);
    const response = await app.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }));
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return response;
  };
  const form = (path: string, fields: Record<string, string>): Promise<Response> =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  return { call, form, setupToken };
}

/** Every `url()` and `@import` target in a stylesheet, in source order. */
function cssReferences(css: string): string[] {
  const references: string[] = [];
  const urls = /url\(\s*(?:'([^']*)'|"([^"]*)"|([^)'"\s]+))\s*\)/gi;
  for (let m = urls.exec(css); m !== null; m = urls.exec(css)) {
    references.push((m[1] ?? m[2] ?? m[3]) as string);
  }
  const imports = /@import\s+(?:'([^']*)'|"([^"]*)")/gi;
  for (let m = imports.exec(css); m !== null; m = imports.exec(css)) {
    references.push((m[1] ?? m[2]) as string);
  }
  return references;
}

/** The `href` of every linked stylesheet. Our own generator quotes attributes. */
function linkedStylesheets(html: string): string[] {
  const hrefs: string[] = [];
  const links = /<link\b[^>]*\brel="stylesheet"[^>]*>/gi;
  for (let m = links.exec(html); m !== null; m = links.exec(html)) {
    const href = /\bhref="([^"]*)"/i.exec(m[0] as string);
    if (href !== null) hrefs.push(href[1] as string);
  }
  return hrefs;
}

/** The contents of every inline `<style>` block. */
function inlineStyles(html: string): string[] {
  const blocks: string[] = [];
  const styles = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  for (let m = styles.exec(html); m !== null; m = styles.exec(html)) {
    blocks.push(m[1] as string);
  }
  return blocks;
}

/**
 * What the pages declare as their root. Every href and every `url()` in the
 * inline sheets is relative so that this one tag decides where they land —
 * under ingress the middleware rewrites it to the per-session prefix. A page
 * that stopped emitting it would make every resolution below a guess.
 */
function documentBase(html: string): string {
  const base = /<base\s+href="([^"]*)"/i.exec(html);
  expect(base, 'the page declares a <base>').not.toBeNull();
  return new URL((base as RegExpExecArray)[1] as string, ORIGIN).toString();
}

const PAGES = ['/admin', '/admin/calendars', '/admin/walls', '/admin/system'];

describe('assets referenced from a served stylesheet', () => {
  it('resolve against the stylesheet, not the document, and every one answers', async () => {
    const h = await harness();

    // Signed out first: the wizard and sign-in inline their CSS, so they are
    // the *document*-relative context and must not regress either.
    await h.call(`/setup?token=${h.setupToken.current().token}`);
    const pages = new Map<string, string>();

    const wizard = await h.call('/setup');
    expect(wizard.status).toBe(200);
    pages.set('/setup', await wizard.text());

    await h.form('/setup/account', {
      name: 'Household',
      email: 'family@home.local',
      password: 'correct-horse-battery',
      confirm: 'correct-horse-battery',
    });
    await h.form('/setup/household', { timezone: 'Europe/London' });

    const signIn = await h.call('/admin/sign-in');
    expect(signIn.status).toBe(200);
    pages.set('/admin/sign-in', await signIn.text());

    for (const path of PAGES) {
      const response = await h.call(path);
      expect(response.status, path).toBe(200);
      pages.set(path, await response.text());
    }

    /** Every (absolute URL, why we are asking) pair the pages imply. */
    const wanted = new Map<string, string>();
    let linkedSheets = 0;
    let inlineFontUrls = 0;
    let linkedFontUrls = 0;

    for (const [path, html] of pages) {
      const base = documentBase(html);

      // Inline <style>: a relative url() here resolves against the document.
      for (const block of inlineStyles(html)) {
        for (const reference of cssReferences(block)) {
          if (reference.startsWith('data:')) continue;
          const resolved = new URL(reference, base);
          if (resolved.pathname.endsWith('.woff2')) inlineFontUrls += 1;
          wanted.set(resolved.toString(), `${path} inline <style> url(${reference})`);
        }
      }

      // <link rel=stylesheet>: the href resolves against the document, and
      // then everything inside it resolves against *that*, not against the
      // document. This is the distinction the whole test exists for.
      for (const href of linkedStylesheets(html)) {
        const sheetUrl = new URL(href, base);
        linkedSheets += 1;
        wanted.set(sheetUrl.toString(), `${path} <link rel=stylesheet href=${href}>`);

        const sheet = await h.call(`${sheetUrl.pathname}${sheetUrl.search}`);
        expect(sheet.status, `stylesheet ${sheetUrl.pathname}`).toBe(200);
        const css = await sheet.text();

        for (const reference of cssReferences(css)) {
          if (reference.startsWith('data:')) continue;
          const resolved = new URL(reference, sheetUrl);
          if (resolved.pathname.endsWith('.woff2')) linkedFontUrls += 1;
          wanted.set(resolved.toString(), `${sheetUrl.pathname} url(${reference})`);
        }
      }
    }

    // Guards against this quietly becoming a no-op. Each one describes a state
    // the product is actually in: the shell links a sheet, that sheet declares
    // faces, and the signed-out pages still inline theirs.
    expect(linkedSheets, 'the shell links a stylesheet').toBeGreaterThan(0);
    expect(linkedFontUrls, 'the linked stylesheet declares @font-face files').toBeGreaterThan(0);
    expect(inlineFontUrls, 'the inline stylesheet declares @font-face files').toBeGreaterThan(0);

    for (const [url, why] of wanted) {
      const target = new URL(url);
      expect(target.origin, `${why} is same-origin`).toBe(ORIGIN);
      const response = await h.call(`${target.pathname}${target.search}`);
      expect(response.status, `${why} -> ${target.pathname}`).toBe(200);
    }
  });
});
