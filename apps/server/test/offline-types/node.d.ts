/**
 * OFFLINE TYPECHECK SHIM — NOT SHIPPED, NOT AUTHORITATIVE.
 * Stands in for @types/node so the suite can be typechecked without an install.
 * Once @types/node is present its definitions take precedence.
 */
declare module 'node:crypto' {
  export function randomBytes(size: number): Buffer;
  export function timingSafeEqual(a: Buffer, b: Buffer): boolean;
  export function hkdfSync(
    digest: string, ikm: Buffer, salt: Buffer, info: string, keylen: number,
  ): ArrayBuffer;
  export interface Cipher {
    setAAD(aad: Buffer): Cipher;
    update(data: string, inputEncoding: 'utf8'): Buffer;
    update(data: Buffer): Buffer;
    final(): Buffer;
    getAuthTag(): Buffer;
  }
  export interface Decipher extends Cipher {
    setAuthTag(tag: Buffer): Decipher;
  }
  export function createCipheriv(algorithm: string, key: Buffer, iv: Buffer): Cipher;
  export function createDecipheriv(algorithm: string, key: Buffer, iv: Buffer): Decipher;
}

declare module 'node:fs' {
  export function readFileSync(path: string): Buffer;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(
    path: string, data: string | Buffer, options?: { mode?: number; flag?: string },
  ): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function renameSync(from: string, to: string): void;
  export function chmodSync(path: string, mode: number): void;
  export function rmSync(path: string, options?: { force?: boolean; recursive?: boolean }): void;
  export function existsSync(path: string): boolean;
  export function statSync(path: string): { mtimeMs: number; mode: number };
  export function utimesSync(path: string, atime: Date, mtime: Date): void;
  export function readdirSync(path: string): string[];
}

declare module 'node:os' {
  export function hostname(): string;
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...segments: string[]): string;
  export function dirname(path: string): string;
}

declare namespace NodeJS {
  interface ErrnoException extends Error { code?: string }
}

declare const process: {
  pid: number;
  env: Record<string, string | undefined>;
  kill(pid: number, signal: number): void;
  hrtime: { bigint(): bigint };
};

interface Buffer extends Uint8Array {
  toString(encoding?: string): string;
  equals(other: Buffer): boolean;
  subarray(start?: number, end?: number): Buffer;
}
declare const Buffer: {
  from(data: string, encoding?: string): Buffer;
  from(data: ArrayBuffer): Buffer;
  concat(list: Buffer[]): Buffer;
  alloc(size: number): Buffer;
};

declare const console: {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare class SharedArrayBuffer { constructor(byteLength: number) }
declare const Atomics: {
  wait(typedArray: Int32Array, index: number, value: number, timeout?: number): string;
};

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

interface ImportMeta {
  url: string;
}
