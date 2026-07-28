/**
 * OFFLINE TYPECHECK SHIM — NOT SHIPPED, NOT AUTHORITATIVE.
 * Stands in for @types/node so the test suite can be typechecked without an
 * install. Only the handful of APIs the tests actually use.
 *
 * Note that src/ deliberately imports none of this: the package targets
 * lib ES2022 with no ambient Node types, which is what enforces the
 * "standard library only" rule structurally rather than by review.
 */
declare module 'node:fs' {
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
  }
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
}

declare module 'node:path' {
  export function join(...segments: string[]): string;
  export function dirname(path: string): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

declare const process: {
  env: Record<string, string | undefined>;
  hrtime: { bigint(): bigint };
};

declare const console: {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

interface ImportMeta {
  url: string;
}
