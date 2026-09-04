import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipped } from './compress.js';

/**
 * Serving the display bundle.
 *
 * Deliberately not a directory server. Files are read by exact name from one
 * directory, the name is checked against a pattern that cannot express a
 * traversal, and anything else is a 404. A wall display needs about six files;
 * the general case is all risk and no benefit.
 *
 * The path is resolved from this module rather than the working directory.
 * `pnpm --filter` runs from the package directory and a container runs from
 * `/`, and the last time something here depended on the working directory it
 * silently split one installation into two databases.
 */

/** No slashes, no dots leading anywhere. A traversal cannot be spelled. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function contentTypeFor(name: string): string {
  const dot = name.lastIndexOf('.');
  const extension = dot < 0 ? '' : name.slice(dot);
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

export interface StaticFile {
  readonly body: Buffer;
  readonly contentType: string;
  /** Content-derived, so a rebuild changes it and a byte-identical file does not. */
  readonly etag: string;
  /**
   * The same bytes, gzipped — or absent, for a file not worth compressing.
   *
   * Computed here rather than at the route, because this is the one place that
   * already knows when a file has actually changed: the cache below is keyed on
   * mtime and size, so a wall that reloads every day pays for this once per
   * *build* rather than once per request. `display.css` and `render.js` are
   * 269 KB between them and 83 KB gzipped, and every screen in the house asks
   * for exactly the same bytes.
   */
  readonly gzip: Buffer | undefined;
}

/** Same construction as `manifestEtag`: a short, quoted content hash. */
export function contentEtag(body: Buffer): string {
  return `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
}

export interface StaticFiles {
  readonly directory: string;
  /** Undefined for a name that is not there, or not a name we will serve. */
  read(name: string): StaticFile | undefined;
  /** Whether the bundle looks built at all, for the boot report. */
  present(): boolean;
}

/** Where the display bundle lands relative to the compiled server. */
/**
 * Where the wall's bundle is.
 *
 * `DISPLAY_DIR` first, because the relative fallback below is a fact about the
 * *repository* layout and the image does not have that layout: `pnpm deploy`
 * flattens the server package to the root, so `../../../display/dist` resolves
 * outside the application directory entirely. Every asset 404s, the shell is
 * not found either, and the wall shows "the bundle is missing" — on the one
 * screen the whole product exists to draw.
 *
 * The fallback stays for `node apps/server/dist/main.js` from a checkout,
 * which is how this is run in development and in the docs.
 */
export function defaultDisplayDir(): string {
  const configured = globalThis.process?.env?.['DISPLAY_DIR'];
  if (configured !== undefined && configured !== '') return configured;
  // apps/server/dist/http/static.js → apps/display/dist
  return new URL('../../../display/dist', import.meta.url).pathname;
}

/**
 * Where the self-hosted admin fonts are.
 *
 * `FONTS_DIR` first, for the image: `pnpm deploy` flattens the server package,
 * so the repo-relative fallback below resolves nowhere in the container — the
 * same trap `defaultDisplayDir` guards against, so the Dockerfile sets it. The
 * fallback is `apps/server/assets/fonts`, for a checkout run in development.
 * Rule three: nothing here is fetched — the woff2 ships in the image and is
 * served same-origin from this directory.
 */
export function defaultFontsDir(): string {
  const configured = globalThis.process?.env?.['FONTS_DIR'];
  if (configured !== undefined && configured !== '') return configured;
  // apps/server/dist/http/static.js → apps/server/assets/fonts
  return new URL('../../assets/fonts', import.meta.url).pathname;
}

export function createStaticFiles(directory: string): StaticFiles {
  // Keyed on name, invalidated by mtime and size rather than time: the point
  // of Cache-Control: no-cache is that a rebuild must be visible on the very
  // next request with no restart, so this may never serve a body or an ETag
  // older than what is on disk right now — it only skips redoing the hash
  // when the file provably has not changed since the last read.
  const cache = new Map<string, { readonly mtimeMs: number; readonly size: number; readonly file: StaticFile }>();

  return {
    directory,

    read(name: string): StaticFile | undefined {
      if (!SAFE_NAME.test(name)) return undefined;
      const path = join(directory, name);
      try {
        const stat = statSync(path);
        const cached = cache.get(name);
        if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          return cached.file;
        }
        const body = readFileSync(path);
        const contentType = contentTypeFor(name);
        const file = {
          body,
          contentType,
          etag: contentEtag(body),
          gzip: gzipped(body, contentType),
        };
        cache.set(name, { mtimeMs: stat.mtimeMs, size: stat.size, file });
        return file;
      } catch {
        return undefined;
      }
    },

    present(): boolean {
      try {
        return statSync(join(directory, 'index.html')).isFile();
      } catch {
        return false;
      }
    },
  };
}
