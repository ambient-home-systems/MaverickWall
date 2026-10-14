import { parentPort, workerData } from 'node:worker_threads';
import { newQuickJSWASMModuleFromVariant, type QuickJSDeferredPromise, type QuickJSHandle } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import type { FromWorker, ToWorker, WorkerFailure, WorkerInput } from './sandbox-protocol.js';

/**
 * One run of one script module (RFC 017 §4.1), in a worker thread of its own.
 *
 * The script runs inside QuickJS compiled to WebAssembly, in a runtime and a
 * context made for this run and thrown away with the worker, so nothing carries
 * from one run to the next or from one module to another. The interpreter has
 * no file system, no timers, no console and no network: its only way out is
 * `ctx.fetch`, which this worker forwards to the main thread as a message, and
 * the main thread decides — host, secret, policy, count — before anything leaves.
 *
 * Three limits are the interpreter's own: memory (`setMemoryLimit`), stack
 * (`setMaxStackSize`) and CPU, counted here as interpreter time only and
 * enforced by the interrupt handler, so a script waiting on a slow host is not
 * charged for the wait. The wall time is the main thread's, which terminates
 * this worker; so are the worker's own heap limits, so a fault in the
 * interpreter itself ends this thread and never the server.
 *
 * Imports are type-only beyond the two packages, so this file runs as written
 * under Node's type stripping (the tests) and as compiled (the image).
 */

const input = workerData as WorkerInput;
const port = parentPort;
if (port === null) throw new Error('the sandbox runs only as a worker');

const started = performance.now();
let spent = 0;
let since = -1;
let over = false;

function post(message: FromWorker): void {
  port!.postMessage(message);
}

let finished = false;
function fail(reason: WorkerFailure, message: string): void {
  if (finished) return;
  finished = true;
  post({ type: 'failed', reason, message: message.slice(0, 2000), cpuMs: spent, startMs: startMs() });
}

let loaded = -1;
const startMs = (): number => (loaded < 0 ? performance.now() - started : loaded);

/*
 * The prelude: `ctx` as the script sees it, built inside the interpreter from
 * JSON and frozen, so a script cannot reach the host functions behind it, swap
 * them, or leave anything on them for a later call.
 */
const PRELUDE = `'use strict';
(function () {
  const hostFetch = globalThis.__mwFetch;
  const hostLocal = globalThis.__mwLocal;
  delete globalThis.__mwFetch;
  delete globalThis.__mwLocal;
  const freeze = (value) => {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const key of Object.keys(value)) freeze(value[key]);
    }
    return value;
  };
  const response = (answer) => {
    const out = {
      ok: answer.ok,
      status: answer.status,
      contentType: answer.contentType,
      text: async () => answer.body,
      json: async () => JSON.parse(answer.body),
    };
    if (answer.data !== undefined) out.data = answer.data;
    return freeze(out);
  };
  globalThis.__mwContext = function (data) {
    const input = JSON.parse(data);
    return freeze({
      config: input.config,
      now: input.now,
      timeZone: input.timeZone,
      fetch: async (url, options) =>
        response(JSON.parse(await hostFetch(JSON.stringify({ url: String(url), options: options === undefined ? {} : options })))),
      local: (instant) => JSON.parse(hostLocal(Number(instant))),
    });
  };
})();`;

/** A wall-clock reading in the household's zone: what a script has in place of Intl, which QuickJS lacks. */
function local(ms: number, timeZone: string): string {
  if (!Number.isFinite(ms)) return 'null';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return 'null';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')?.value ?? '');
  return JSON.stringify({
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
    second: part('second'),
    weekday,
  });
}

async function main(): Promise<void> {
  const quickjs = await newQuickJSWASMModuleFromVariant(variant);
  loaded = performance.now() - started;
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(input.limits.memoryBytes);
  runtime.setMaxStackSize(input.limits.stackBytes);
  runtime.setInterruptHandler(() => {
    if (since >= 0 && spent + (performance.now() - since) > input.limits.cpuMs) over = true;
    return over;
  });
  runtime.setModuleLoader(() => ({ error: new Error('A script module cannot import anything.') }));
  const vm = runtime.newContext();

  /** Interpreter time, counted only while the interpreter is running. */
  const timed = <T>(f: () => T): T => {
    since = performance.now();
    try {
      return f();
    } finally {
      spent += performance.now() - since;
      since = -1;
    }
  };

  /** Why a thrown value ended the run: our counters first, the interpreter's words second. */
  const failure = (handle: QuickJSHandle): void => {
    const dumped: unknown = vm.dump(handle);
    const text =
      dumped !== null && typeof dumped === 'object'
        ? `${String((dumped as { name?: unknown }).name ?? 'Error')}: ${String((dumped as { message?: unknown }).message ?? '')}`
        : String(dumped);
    if (over) fail('cpu', text);
    else if (/out of memory/i.test(text)) fail('memory', text);
    else if (/stack overflow/i.test(text)) fail('stack', text);
    else fail('error', text);
  };

  const pending = new Map<number, QuickJSDeferredPromise>();
  let nextId = 0;

  const pump = (): void => {
    const result = timed(() => runtime.executePendingJobs());
    if (result.error !== undefined) {
      failure(result.error);
      result.error.dispose();
    }
  };

  const hostFetch = vm.newFunction('__mwFetch', (arg) => {
    const request = vm.getString(arg);
    const deferred = vm.newPromise();
    if (request.length > input.limits.requestChars) {
      const error = vm.newError('That request is too large.');
      deferred.reject(error);
      error.dispose();
      return deferred.handle;
    }
    const id = nextId++;
    pending.set(id, deferred);
    post({ type: 'fetch', id, request });
    return deferred.handle;
  });
  vm.setProp(vm.global, '__mwFetch', hostFetch);
  hostFetch.dispose();
  const hostLocal = vm.newFunction('__mwLocal', (arg) => vm.newString(local(vm.getNumber(arg), input.timeZone)));
  vm.setProp(vm.global, '__mwLocal', hostLocal);
  hostLocal.dispose();

  port!.on('message', (message: ToWorker) => {
    const deferred = pending.get(message.id);
    if (deferred === undefined || finished) return;
    pending.delete(message.id);
    if (message.ok) {
      const answer = vm.newString(message.answer);
      deferred.resolve(answer);
      answer.dispose();
    } else {
      const error = vm.newError(message.error);
      deferred.reject(error);
      error.dispose();
    }
    deferred.dispose();
    pump();
  });

  const prelude = timed(() => vm.evalCode(PRELUDE, 'prelude.js'));
  if (prelude.error !== undefined) return failure(prelude.error);
  prelude.value.dispose();

  const evaluated = timed(() => vm.evalCode(input.source, 'module.js', { type: 'module' }));
  if (evaluated.error !== undefined) {
    const dumped: unknown = vm.dump(evaluated.error);
    const name = dumped !== null && typeof dumped === 'object' ? (dumped as { name?: unknown }).name : undefined;
    if (name === 'SyntaxError') return fail('syntax', `SyntaxError: ${String((dumped as { message?: unknown }).message ?? '')}`);
    return failure(evaluated.error);
  }
  const namespace = await settle(evaluated.value);
  if (namespace === undefined) return;
  const run = vm.getProp(namespace, 'default');
  if (vm.typeof(run) !== 'function') return fail('no-run', 'The script does not export a default function.');

  const make = vm.getProp(vm.global, '__mwContext');
  vm.setProp(vm.global, '__mwContext', vm.undefined);
  const contextJson = vm.newString(input.context);
  const made = timed(() => vm.callFunction(make, vm.undefined, contextJson));
  if (made.error !== undefined) return failure(made.error);

  const called = timed(() => vm.callFunction(run, vm.undefined, made.value));
  if (called.error !== undefined) return failure(called.error);
  const result = await settle(called.value);
  if (result === undefined) return;

  const stringify = vm.unwrapResult(timed(() => vm.evalCode('(value) => JSON.stringify(value)')));
  const json = timed(() => vm.callFunction(stringify, vm.undefined, result));
  if (json.error !== undefined) return failure(json.error);
  if (vm.typeof(json.value) !== 'string') return fail('output', 'The script returned nothing that can be written as JSON.');
  const output = vm.getString(json.value);
  if (Buffer.byteLength(output, 'utf8') > input.limits.outputBytes) {
    return fail('output', `The script returned more than ${Math.round(input.limits.outputBytes / 1024)} KB.`);
  }
  if (finished) return;
  finished = true;
  post({ type: 'done', output, cpuMs: spent, startMs: startMs() });

  /** A value, or what a promise for one settles to, driving the interpreter's jobs as it goes. */
  async function settle(handle: QuickJSHandle): Promise<QuickJSHandle | undefined> {
    const settled = vm.resolvePromise(handle);
    pump();
    const outcome = await settled;
    if (finished) return undefined;
    if (outcome.error !== undefined) {
      failure(outcome.error);
      return undefined;
    }
    return outcome.value;
  }
}

main().catch((error: unknown) => {
  fail('error', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
});
