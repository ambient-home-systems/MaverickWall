/**
 * OFFLINE TYPECHECK SHIM — NOT SHIPPED, NOT AUTHORITATIVE.
 * Enough of Hono to typecheck the routes without an install.
 */
declare module 'hono' {
  export interface Context {
    req: {
      header(name: string): string | undefined;
      query(name: string): string | undefined;
      path: string;
      url: string;
    };
    json(value: unknown, status?: number, headers?: Record<string, string>): Response;
    text(value: string, status?: number, headers?: Record<string, string>): Response;
    html(value: string, status?: number): Response;
    body(value: null, status: number, headers?: Record<string, string>): Response;
    redirect(location: string, status?: number): Response;
    header(name: string, value: string): void;
    set(key: string, value: unknown): void;
    get(key: string): unknown;
  }
  export type Next = () => Promise<void>;
  export type Handler = (c: Context, next: Next) => Response | Promise<Response | void> | void;
  export class Hono {
    get(path: string, ...handlers: Handler[]): Hono;
    post(path: string, ...handlers: Handler[]): Hono;
    use(path: string, ...handlers: Handler[]): Hono;
    notFound(handler: Handler): Hono;
    onError(handler: (error: Error, c: Context) => Response): Hono;
    readonly fetch: (request: Request) => Response | Promise<Response>;
  }
}

declare module '@hono/node-server' {
  import type { Hono } from 'hono';
  export function serve(options: {
    fetch: Hono['fetch'];
    port: number;
    hostname?: string;
  }): { close(callback?: () => void): void };
}

declare class Response {
  constructor(body?: unknown, init?: { status?: number; headers?: Record<string, string> });
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}
declare class Request {
  constructor(input: string, init?: { method?: string; headers?: Record<string, string> });
}
