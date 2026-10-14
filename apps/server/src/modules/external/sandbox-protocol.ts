/**
 * The messages between a script module's run and the worker that runs it (RFC
 * 017). Types only, so the worker can be started straight from its TypeScript
 * source under Node's type stripping as well as from `dist`.
 */

/** Why a run ended without an answer, as the worker saw it. */
export type WorkerFailure = 'syntax' | 'no-run' | 'error' | 'cpu' | 'memory' | 'stack' | 'output';

export interface WorkerInput {
  readonly source: string;
  /** `{config, now, timeZone}`, as JSON, parsed inside the interpreter. */
  readonly context: string;
  readonly timeZone: string;
  readonly limits: {
    readonly memoryBytes: number;
    readonly stackBytes: number;
    readonly cpuMs: number;
    readonly outputBytes: number;
    readonly requestChars: number;
  };
}

export type FromWorker =
  | { readonly type: 'fetch'; readonly id: number; readonly request: string }
  | { readonly type: 'done'; readonly output: string; readonly cpuMs: number; readonly startMs: number }
  | {
      readonly type: 'failed';
      readonly reason: WorkerFailure;
      readonly message: string;
      readonly cpuMs: number;
      readonly startMs: number;
    };

export type ToWorker =
  | { readonly type: 'fetched'; readonly id: number; readonly ok: true; readonly answer: string }
  | { readonly type: 'fetched'; readonly id: number; readonly ok: false; readonly error: string };
