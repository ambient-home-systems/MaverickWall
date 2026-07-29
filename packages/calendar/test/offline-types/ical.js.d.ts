/**
 * OFFLINE TYPECHECK SHIM — NOT SHIPPED, NOT AUTHORITATIVE.
 *
 * Corrected to match what ical.js actually ships: a single default export
 * carrying the classes, rather than named exports. The named-import form
 * transpiles and runs fine, which is why the test suite passed for a long time
 * while `tsc` had never once been run against this package.
 *
 * This file is also the complete statement of our dependency surface: this is
 * the whole of ical.js that @maverick-wall/calendar touches.
 */
declare module 'ical.js' {
  interface TimezoneLike {
    readonly tzid: string;
  }

  class Timezone implements TimezoneLike {
    readonly tzid: string;
    static readonly utcTimezone: Timezone;
    /** ical.js's floating-time sentinel. Recurrence is iterated against it. */
    static readonly localTimezone: Timezone;
  }

  interface TimeData {
    year?: number;
    month?: number;
    day?: number;
    hour?: number;
    minute?: number;
    second?: number;
    isDate?: boolean;
  }

  class Time {
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

  class Duration {
    toSeconds(): number;
  }

  interface RecurIterator {
    /** Returns the next occurrence, or null when the rule is exhausted. */
    next(): Time | null;
  }

  class Recur {
    static fromString(value: string): Recur;
    iterator(dtstart: Time): RecurIterator;
    toString(): string;
  }

  class Property {
    readonly name: string;
    getParameter(name: string): string | string[] | undefined;
    getFirstValue(): unknown;
    getValues(): unknown[];
  }

  class Component {
    constructor(jCal: unknown, parent?: Component);
    readonly name: string;
    getFirstProperty(name: string): Property | null;
    getAllProperties(name?: string): Property[];
    getFirstPropertyValue(name: string): unknown;
    getAllSubcomponents(name?: string): Component[];
  }

  /** Throws on malformed input; every call site wraps it. */
  function parse(input: string): unknown;

  const ICAL: {
    Component: typeof Component;
    Property: typeof Property;
    Time: typeof Time;
    Timezone: typeof Timezone;
    Duration: typeof Duration;
    Recur: typeof Recur;
    parse: typeof parse;
  };

  export default ICAL;
}
