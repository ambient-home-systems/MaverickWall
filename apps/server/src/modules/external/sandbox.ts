import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { clean } from '../weather/alerts.js';
import { panelDataSchema, type PanelData } from './panel-data.js';
import { signalDataSchema, type SignalData } from './signal-data.js';
import { describeIssues } from './recipe.js';
import { SCRIPT_LIMITS, scriptFetchRequestSchema, type ScriptFetchAnswer, type ScriptFetchRequest } from './script.js';
import type { FromWorker, ToWorker, WorkerFailure, WorkerInput } from './sandbox-protocol.js';

/**
 * Run one script module once (RFC 017 §4), and hand back Panel Data, signals,
 * or a reason. Never throws: a script that loops, eats memory, recurses without
 * end, throws, or returns something the wall cannot draw costs its own panel
 * and nothing else (rule nine).
 *
 * Each run is a worker thread of its own (`sandbox-worker.ts`), started for
 * this run and terminated after it, so no state crosses from one run, or one
 * module, to the next. The main thread holds everything a script must not:
 * the fetcher, the secrets and the clock it is charged against. It answers the
 * worker's fetch messages through `fetch`, which `scriptFetch` builds, and it
 * ends the worker when the wall time runs out, whatever the interpreter is
 * doing.
 */

export type ScriptFailure = WorkerFailure | 'time' | 'shape' | 'crash';

export interface ScriptTiming {
  /** Starting the worker and loading the interpreter, before any script code. */
  readonly startMs: number;
  /** Interpreter time spent running the script. */
  readonly cpuMs: number;
  /** The whole run, fetches included. */
  readonly wallMs: number;
}

export type ScriptRun =
  | {
      readonly ok: true;
      readonly panel?: PanelData;
      readonly signals?: SignalData;
      readonly timing: ScriptTiming;
    }
  | {
      readonly ok: false;
      readonly reason: ScriptFailure;
      /** For somebody standing in a kitchen: what happened, and never the script's own words. */
      readonly error: string;
      /** For the module's author: the interpreter's message or the schema's, capped and stripped. */
      readonly detail: string;
      readonly timing: ScriptTiming;
    };

export interface ScriptRunInput {
  readonly source: string;
  readonly config: Readonly<Record<string, string>>;
  readonly now: number;
  readonly timeZone: string;
  readonly fetch: (request: ScriptFetchRequest) => Promise<ScriptFetchAnswer>;
  /** Tests narrow these to reach a limit quickly; nothing in the product passes them. */
  readonly limits?: Partial<Record<keyof typeof SCRIPT_LIMITS, number>>;
}

const SENTENCES: Readonly<Record<ScriptFailure, string>> = {
  syntax: 'The module’s code has a mistake in it and could not start.',
  'no-run': 'The module’s code has no default function to run.',
  error: 'The module’s code stopped with an error.',
  cpu: 'The module’s code worked for too long and was stopped.',
  memory: 'The module’s code used too much memory and was stopped.',
  stack: 'The module’s code went too deep and was stopped.',
  output: 'The module’s code returned too much, or nothing.',
  time: 'The module took longer than ten seconds and was stopped.',
  shape: 'The module returned something the wall cannot draw.',
  crash: 'The module’s code could not be run.',
};

/** What a run hands back, before either half is read by its own schema. */
const outputSchema = z
  .object({ panel: z.unknown().optional(), signals: z.unknown().optional() })
  .strict()
  .refine((output) => output.panel !== undefined || output.signals !== undefined, {
    message: 'return a panel, signals, or both',
  });

/** The worker, started from its source under the tests and from `dist` in the image. */
const WORKER = new URL(`./sandbox-worker${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url);

/** A known zone, or UTC: Intl throws on a zone it does not have, and a run must not. */
function knownZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

export function runScript(input: ScriptRunInput): Promise<ScriptRun> {
  const limits = { ...SCRIPT_LIMITS, ...input.limits };
  const started = performance.now();
  const timeZone = knownZone(input.timeZone);
  const workerInput: WorkerInput = {
    source: input.source,
    context: JSON.stringify({ config: input.config, now: input.now, timeZone }),
    timeZone,
    limits: {
      memoryBytes: limits.memoryBytes,
      stackBytes: limits.stackBytes,
      cpuMs: limits.cpuMs,
      outputBytes: limits.outputBytes,
      requestChars: 16_384,
    },
  };

  return new Promise((resolve) => {
    let worker: Worker;
    let startMs = 0;
    let cpuMs = 0;
    let settled = false;
    const timing = (): ScriptTiming => ({ startMs, cpuMs, wallMs: performance.now() - started });
    const finish = (run: ScriptRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(run);
    };
    const failed = (reason: ScriptFailure, detail: string): void =>
      finish({ ok: false, reason, error: SENTENCES[reason], detail: clean(detail, 600) ?? '', timing: timing() });

    try {
      worker = new Worker(WORKER, {
        workerData: workerInput,
        // The worker's own heap. The interpreter's memory is WebAssembly memory
        // under its own limit; these bound everything else the thread holds.
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
        stdout: true,
        stderr: true,
      });
    } catch (error) {
      resolve({
        ok: false,
        reason: 'crash',
        error: SENTENCES.crash,
        detail: error instanceof Error ? error.message : '',
        timing: { startMs: 0, cpuMs: 0, wallMs: performance.now() - started },
      });
      return;
    }
    const timer = setTimeout(() => failed('time', `stopped after ${limits.wallMs} ms`), limits.wallMs);
    const timeLeft = (): number => limits.wallMs - (performance.now() - started);

    worker.on('message', (message: FromWorker) => {
      if (settled) return;
      if (message.type === 'fetch') {
        void answer(message.id, message.request);
        return;
      }
      startMs = message.startMs;
      cpuMs = message.cpuMs;
      if (message.type === 'failed') {
        failed(message.reason, message.message);
        return;
      }
      finish(read(message.output, timing));
    });
    worker.on('error', (error) => failed('crash', error.message));
    worker.on('exit', () => failed('crash', 'the run ended without an answer'));

    async function answer(id: number, request: string): Promise<void> {
      let reply: ToWorker;
      try {
        const parsed = scriptFetchRequestSchema.safeParse(JSON.parse(request));
        if (!parsed.success) throw new Error(describeIssues(parsed.error.issues, 'fetch'));
        if (timeLeft() <= 0) throw new Error('There is no time left in this run.');
        const got = await input.fetch(parsed.data);
        reply = { type: 'fetched', id, ok: true, answer: JSON.stringify(got) };
      } catch (error) {
        reply = { type: 'fetched', id, ok: false, error: error instanceof Error ? error.message : 'The request was refused.' };
      }
      if (!settled) worker.postMessage(reply);
    }
  });
}

/** The run's output, read by the same schemas a service module's bodies are: rejected, never coerced. */
function read(output: string, timing: () => ScriptTiming): ScriptRun {
  const fail = (detail: string): ScriptRun => ({
    ok: false,
    reason: 'shape',
    error: SENTENCES.shape,
    detail: clean(detail, 600) ?? '',
    timing: timing(),
  });
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    return fail('the output is not JSON');
  }
  const shaped = outputSchema.safeParse(raw);
  if (!shaped.success) return fail(describeIssues(shaped.error.issues, ''));
  let panel: PanelData | undefined;
  if (shaped.data.panel !== undefined) {
    const parsed = panelDataSchema.safeParse(shaped.data.panel);
    if (!parsed.success) return fail(describeIssues(parsed.error.issues, 'panel'));
    panel = parsed.data;
  }
  let signals: SignalData | undefined;
  if (shaped.data.signals !== undefined) {
    const parsed = signalDataSchema.safeParse({ signals: shaped.data.signals });
    if (!parsed.success) return fail(describeIssues(parsed.error.issues, ''));
    signals = parsed.data;
  }
  return {
    ok: true,
    ...(panel !== undefined ? { panel } : {}),
    ...(signals !== undefined ? { signals } : {}),
    timing: timing(),
  };
}
