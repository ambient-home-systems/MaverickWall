/**
 * OFFLINE TYPECHECK SHIM — NOT SHIPPED, NOT AUTHORITATIVE.
 *
 * Enough of drizzle-orm's SQLite builder to typecheck the schema without an
 * install. Deliberately loose: this catches typos, missing imports and bad
 * shapes, not column-type inference. Once drizzle-orm is installed its own
 * types take over and are the authority.
 */
declare module 'drizzle-orm/sqlite-core' {
  interface ColumnBuilder {
    primaryKey(options?: { autoIncrement?: boolean }): ColumnBuilder;
    notNull(): ColumnBuilder;
    unique(): ColumnBuilder;
    default(value: unknown): ColumnBuilder;
    $defaultFn(fn: () => unknown): ColumnBuilder;
    $onUpdateFn(fn: () => unknown): ColumnBuilder;
    references(ref: () => unknown, actions?: { onDelete?: string; onUpdate?: string }): ColumnBuilder;
    $type<T>(): ColumnBuilder;
  }

  export function text(
    name?: string,
    config?: { enum?: readonly string[]; mode?: 'text' | 'json'; length?: number },
  ): ColumnBuilder;

  export function integer(
    name?: string,
    config?: { mode?: 'number' | 'boolean' | 'timestamp' | 'timestamp_ms' },
  ): ColumnBuilder;

  export function real(name?: string): ColumnBuilder;
  export function blob(name?: string, config?: { mode?: 'buffer' | 'json' }): ColumnBuilder;

  interface IndexBuilder {
    on(...columns: unknown[]): IndexBuilder;
  }
  export function index(name: string): IndexBuilder;
  export function uniqueIndex(name: string): IndexBuilder;
  export function primaryKey(config: { columns: unknown[] }): unknown;
  export function check(name: string, expression: unknown): unknown;

  export function sqliteTable<T extends Record<string, ColumnBuilder>>(
    name: string,
    columns: T,
    extra?: (table: Record<keyof T, unknown>) => unknown,
  ): Record<keyof T, unknown> & { readonly _: unknown };
}

declare module 'drizzle-orm' {
  export function sql(strings: TemplateStringsArray, ...values: unknown[]): unknown;
  export namespace sql {
    function raw(value: string): unknown;
  }
  export function relations(table: unknown, fn: (helpers: unknown) => unknown): unknown;
}

declare module 'drizzle-orm/better-sqlite3' {
  export function drizzle(client: unknown, config?: { schema?: unknown }): unknown;
}

declare module 'drizzle-orm/better-sqlite3/migrator' {
  export function migrate(db: unknown, config: { migrationsFolder: string }): void;
}

declare module 'better-sqlite3' {
  // Mirrors the real shape: a constructor merged with a namespace, so the
  // imported name is not usable as a type on its own.
  namespace BetterSqlite3 {
    interface Statement {
      run(...params: unknown[]): { changes: number; lastInsertRowid: number };
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
      pluck(toggle?: boolean): Statement;
    }
    interface Database {
      pragma(source: string, options?: { simple?: boolean }): unknown;
      prepare(sql: string): Statement;
      exec(sql: string): Database;
      close(): Database;
      readonly open: boolean;
      readonly name: string;
    }
  }
  interface DatabaseConstructor {
    new (
      path: string,
      options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number },
    ): BetterSqlite3.Database;
  }
  const Database: DatabaseConstructor;
  export default Database;
}

declare module 'drizzle-kit' {
  export interface Config {
    schema: string;
    out: string;
    dialect: string;
    dbCredentials?: { url: string };
    strict?: boolean;
  }
}
