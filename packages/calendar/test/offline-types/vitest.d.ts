/**
 * OFFLINE TYPECHECK SHIM — NOT SHIPPED, NOT AUTHORITATIVE.
 *
 * Just enough of vitest's surface to typecheck the suite where node_modules
 * cannot be installed. `expect` is deliberately loose: the value of checking
 * tests offline is catching wrong imports, renamed exports and bad property
 * paths in the code under test, not policing matcher arities.
 */
declare module 'vitest' {
  interface Matchers {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toMatchObject(expected: unknown): void;
    toMatchSnapshot(): void;
    toContain(expected: unknown): void;
    toHaveLength(expected: number): void;
    toBeTruthy(): void;
    toBeUndefined(): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toThrow(expected?: unknown): void;
    not: Matchers;
    (...args: unknown[]): void;
  }

  interface ExpectFn {
    (actual: unknown, message?: string): Matchers;
    arrayContaining(expected: readonly unknown[]): unknown;
    objectContaining(expected: object): unknown;
    any(constructor: unknown): unknown;
  }

  export const expect: ExpectFn;

  interface EachFn {
    <T>(cases: readonly T[]): (name: string, fn: (item: T) => void | Promise<void>) => void;
  }

  interface TestFn {
    (name: string, fn: () => void | Promise<void>): void;
    each: EachFn;
    skip: TestFn;
    only: TestFn;
    skipIf(condition: boolean): TestFn;
    runIf(condition: boolean): TestFn;
  }

  export const it: TestFn;
  export const test: TestFn;
  export const describe: TestFn;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
}

declare module 'vitest/config' {
  export function defineConfig(config: unknown): unknown;
}
