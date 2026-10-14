import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FETCH_LIMITS, type Fetcher } from '@maverick-wall/core';

import type { SqliteDatabase } from '../../db/open.js';
import { readEnabledExternalModules } from '../../api/external-modules.js';
import { moduleImageHandle, panelImageUrl } from '../../api/module-image-handle.js';
import { sniffImage } from '../../api/media.js';
import { POLICY } from './index.js';
import { recipePolicy, recipeSchema } from './recipe.js';
import { scriptManifestSchema, scriptPolicy } from './script.js';

/**
 * A module's picture, for a wall that asks by its handle (plan item M7.5).
 *
 * Only a picture a module's current panel names is served — the install's own
 * panel or one of its widgets' (M7.6) — so a guessed handle, or one for a
 * picture the module has since stopped showing, serves nothing and fetches
 * nothing. It is fetched the first time a wall asks, through the guard under
 * the module's own policy: a service module's (it is the household's own
 * container), a recipe's (public https only unless it opted into the LAN), or
 * a script's (the same, and only from a host the script declared, RFC 017).
 * Sniffed from its bytes as every picture this application serves is, so an
 * SVG or a page is refused, and kept on this box under its handle, so a module
 * whose server goes away still has its picture on the wall. A picture no panel
 * names any more is deleted on the next ask.
 */

const HANDLE = /^[a-f0-9]{64}\.jpg$/;
const CONTENT_TYPES = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as const;

type Policy = { readonly allowHttp: boolean; readonly allowPrivateNetwork: boolean; readonly allowLoopback: boolean };

/** Every picture a current panel names, by handle, with the address and the policy to fetch it under. */
function currentPictures(db: SqliteDatabase): Map<string, { url: string; policy: Policy }> {
  const out = new Map<string, { url: string; policy: Policy }>();
  for (const module of readEnabledExternalModules(db)) {
    let policy: Policy = POLICY;
    let hosts: readonly string[] | undefined;
    if (module.kind === 'recipe') {
      const parsed = recipeSchema.safeParse(module.recipe);
      if (!parsed.success) continue;
      policy = recipePolicy(parsed.data);
    } else if (module.kind === 'script') {
      const parsed = scriptManifestSchema.safeParse(module.recipe);
      if (!parsed.success) continue;
      policy = scriptPolicy(parsed.data);
      hosts = parsed.data.hosts;
    }
    const variants = db
      .prepare(`SELECT panel FROM external_module_variants WHERE module_id = ? AND panel IS NOT NULL`)
      .all(module.id) as { panel: string }[];
    const panels: unknown[] = [module.panel];
    for (const row of variants) {
      try {
        panels.push(JSON.parse(row.panel));
      } catch {
        // A variant this process did not write is no picture.
      }
    }
    for (const panel of panels) {
      const url = panelImageUrl(panel);
      // A script's picture comes from a host it declared, as its fetches do.
      if (url !== undefined && hosts !== undefined && !hosts.includes(new URL(url).hostname)) continue;
      if (url !== undefined) out.set(moduleImageHandle(module.id, url), { url, policy });
    }
  }
  return out;
}

function cacheDir(dataDir: string): string {
  return join(dataDir, 'module-images');
}

export async function modulePicture(
  context: { readonly db: SqliteDatabase; readonly fetcher: Fetcher; readonly dataDir: string },
  handle: string,
): Promise<{ bytes: Buffer; contentType: string } | undefined> {
  if (!HANDLE.test(handle)) return undefined;
  const pictures = currentPictures(context.db);
  const wanted = pictures.get(handle);
  const dir = cacheDir(context.dataDir);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) if (!pictures.has(name)) rmSync(join(dir, name), { force: true });
  }
  if (wanted === undefined) return undefined;
  const file = join(dir, handle);
  if (existsSync(file)) {
    const bytes = readFileSync(file);
    const kind = sniffImage(bytes);
    if (kind !== undefined) return { bytes, contentType: CONTENT_TYPES[kind] };
  }
  const outcome = await context.fetcher.fetch({
    url: wanted.url,
    policy: wanted.policy,
    maxBytes: FETCH_LIMITS.image,
    timeoutMs: 15_000,
    bodyEncoding: 'base64',
  });
  if (outcome.status !== 'ok') return undefined;
  const bytes = Buffer.from(outcome.body, 'base64');
  const kind = sniffImage(bytes);
  if (kind === undefined) return undefined;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, bytes);
  return { bytes, contentType: CONTENT_TYPES[kind] };
}
