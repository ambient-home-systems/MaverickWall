/**
 * The last few hundred log lines, in memory.
 *
 * A household cannot read a container log. They can read a web page, so the
 * lines have to be somewhere the web page can reach — and rule eleven says
 * errors have to be self-diagnosable by somebody who cannot be reached.
 *
 * In memory and nowhere else. Writing them to disk would mean a log file that
 * grows without bound on an SD card, a rotation scheme to get wrong, and one
 * more file carrying whatever a future careless log line puts in it.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogLine {
  readonly at: number;
  readonly level: LogLevel;
  readonly text: string;
}

export interface LogBuffer {
  /** Newest last, which is how a log reads. */
  lines(): readonly LogLine[];
  record(level: LogLevel, text: string): void;
  /** Replace console so everything already written ends up here too. */
  capture(target?: {
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  }): void;
}

const DEFAULT_CAPACITY = 400;
/** Long enough to be useful, short enough that one line cannot fill the page. */
const MAX_LINE = 2000;

export function createLogBuffer(capacity: number = DEFAULT_CAPACITY): LogBuffer {
  const ring: LogLine[] = [];

  const record = (level: LogLevel, text: string): void => {
    ring.push({ at: Date.now(), level, text: text.slice(0, MAX_LINE) });
    if (ring.length > capacity) ring.splice(0, ring.length - capacity);
  };

  return {
    lines: () => ring,
    record,

    capture(target = console): void {
      const original = { log: target.log, warn: target.warn, error: target.error };
      const forward =
        (level: LogLevel, pass: (...args: unknown[]) => void) =>
        (...args: unknown[]): void => {
          record(level, args.map(describe).join(' '));
          // Still goes to stdout: somebody with a terminal should not lose it
          // just because somebody else can now read it in a browser.
          pass(...args);
        };
      target.log = forward('info', original.log.bind(target));
      target.warn = forward('warn', original.warn.bind(target));
      target.error = forward('error', original.error.bind(target));
    },
  };
}

function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // A circular object is not worth failing a log call over.
    return String(value);
  }
}
