import { contentEtag, type StaticFile } from './static.js';
import { escapeHtml } from './escape.js';

/**
 * The wall's page, told which release it is (plan item M1.5).
 *
 * A wall reloads itself after the server is updated, and to know it has been it
 * compares two versions: the server's, which every `/d/manifest` answer carries
 * as `x-app-version`, and **its own code's** — which is this. Stamped into the
 * HTML as it is served rather than baked into the bundle at build time, so it
 * is the version of the release that served *this page*: a page a service
 * worker handed back from its cache carries the version it was cached at, which
 * is exactly the version of the code running in it. That is the case a
 * baseline taken from the first poll gets wrong — it would read the new
 * server's version as the old page's own, and never reload.
 *
 * The ETag is the stamped bytes' own, so a new release is a new page to every
 * cache in the way, and nothing else changes it.
 */
export const VERSION_META = 'mw-version';

export function versionedShell(file: StaticFile, version: string): StaticFile {
  const html = file.body.toString('utf8');
  const meta = `<meta name="${VERSION_META}" content="${escapeHtml(version)}" />`;
  // After the opening <head>, so it is in the document whatever else the head
  // holds; a shell with no <head> at all gets it first, which a parser still
  // puts in the head.
  const stamped = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (open) => `${open}\n    ${meta}`)
    : `${meta}\n${html}`;
  const body = Buffer.from(stamped, 'utf8');
  return { ...file, body, etag: contentEtag(body), gzip: undefined };
}
