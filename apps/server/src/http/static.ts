import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
}

export interface StaticFiles {
  readonly directory: string;
  /** Undefined for a name that is not there, or not a name we will serve. */
  read(name: string): StaticFile | undefined;
  /** Whether the bundle looks built at all, for the boot report. */
  present(): boolean;
}

/** Where the display bundle lands relative to the compiled server. */
export function defaultDisplayDir(): string {
  // apps/server/dist/http/static.js → apps/display/dist
  return new URL('../../../display/dist', import.meta.url).pathname;
}

export function createStaticFiles(directory: string): StaticFiles {
  return {
    directory,

    read(name: string): StaticFile | undefined {
      if (!SAFE_NAME.test(name)) return undefined;
      try {
        // No cache. The bundle is small, the reader is one tablet on a LAN,
        // and a stale file surviving a rebuild is the kind of confusion that
        // costs an hour. Revisit when there is a hashed filename scheme.
        return { body: readFileSync(join(directory, name)), contentType: contentTypeFor(name) };
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
