/**
 * OFFLINE TYPECHECK SHIM — NOT SHIPPED, NOT AUTHORITATIVE.
 *
 * This file exists so `tsc -p tsconfig.offline.json` can typecheck the package
 * in an environment where node_modules cannot be installed. It is excluded from
 * the build and from the published tarball. Once `ical.js` is installed its own
 * types take precedence and this file must not be on the include path.
 *
 * It is also a precise statement of our dependency surface: this is the *whole*
 * of ical.js that @maverick-wall/calendar touches. Anything not declared here
 * we do not use, which is what keeps a major-version bump auditable.
 *
 * Written against ical.js v2.x named exports. On v1.x the package used a single
 * default export instead, so imports would need adjusting.
 */
declare module 'ical.js' {
  export interface TimezoneLike {
    readonly tzid: string;
  }

  export class Timezone implements TimezoneLike {
    readonly tzid: string;
    static readonly utcTimezone: Timezone;
    /** ical.js's floating-time sentinel. We iterate recurrence against it. */
    static readonly localTimezone: Timezone;
  }

  export interface TimeData {
    year?: number;
    month?: number;
    day?: number;
    hour?: number;
    minute?: number;
    second?: number;
    isDate?: boolean;
  }

  export class Time {
    constructor(data?: TimeData, zone?: Timezone);
    year: number;
    /** 1-12, unlike the JS Date convention. */
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    isDate: boolean;
    readonly zone?: TimezoneLike;
    toJSDate(): Date;
    toString(): string;
  }

  export class Duration {
    toSeconds(): number;
  }

  export interface RecurIterator {
    /** Returns the next occurrence, or null when the rule is exhausted. */
    next(): Time | null;
  }

  export class Recur {
    static fromString(value: string): Recur;
    iterator(dtstart: Time): RecurIterator;
    toString(): string;
  }

  export class Property {
    readonly name: string;
    getParameter(name: string): string | string[] | undefined;
    getFirstValue(): unknown;
    getValues(): unknown[];
  }

  export class Component {
    constructor(jCal: unknown, parent?: Component);
    readonly name: string;
    getFirstProperty(name: string): Property | null;
    getAllProperties(name?: string): Property[];
    getFirstPropertyValue(name: string): unknown;
    getAllSubcomponents(name?: string): Component[];
  }

  /** Throws on malformed input; every call site wraps it. */
  export function parse(input: string): unknown;
}
