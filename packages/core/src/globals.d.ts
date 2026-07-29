/**
 * The runtime surface core depends on beyond plain ECMAScript.
 *
 * Rule one says core imports no vendor SDK, framework, or runtime API beyond
 * the standard library. `URL` is a WHATWG interface rather than an ECMAScript
 * one, so it is not in `lib: ES2022` — but it is present in every Node release
 * we support and in every browser, and hand-rolling a URL parser to avoid it
 * would be a security decision made for a bookkeeping reason.
 *
 * Declaring it here rather than pulling in `lib: DOM` keeps the dependency
 * explicit and auditable: this file is the complete list.
 */
declare class URL {
  constructor(url: string, base?: string);
  hash: string;
  host: string;
  hostname: string;
  href: string;
  readonly origin: string;
  password: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
  username: string;
  toString(): string;
}
