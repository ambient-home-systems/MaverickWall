/**
 * What Glass costs a tick, against Soft (plan item M4.3, the Glass decision
 * gate). Opt-in: `MW_MEASURE_GLASS=1`.
 *
 * MQ1 says Q4 flips only if, at 6x CPU throttling, a tick's main-thread time
 * on Glass is within a fifth of Soft's and Glass adds no long task over 50ms
 * — and every shipped picture keeps 4.5:1 under its opacity, which
 * `browser-wallpaper-glass.test.ts` already holds on every run.
 *
 * Measured on S22's wall: the shipped Classic seed at 1920x1080 on Dusk, whose
 * 2880px file is the largest, a real fifteen-second tick at a time, traced, and
 * the main thread's tasks summed across each tick from just before the redraw
 * to after its paint. Soft and Glass are measured in alternating rounds so a
 * machine that drifts drifts on both.
 *
 * **Two ways of measuring this were tried and are wrong, and the reasons are
 * worth keeping.** Playwright's installed clock fires the tick inside a
 * DevTools command, where most of the draw's script is not attributed to the
 * page (1.4ms of script against 17ms on a real tick). And `Performance`'s
 * `TaskDuration` is thread time, which CPU throttling does not stretch — it
 * read the same at 6x as at 1x. A trace's task durations are wall time on the
 * main thread, which is what throttling slows and what a household waits on.
 *
 * **The main thread is not where a backdrop blur costs.** The blur is the
 * compositor's, which on a real tablet is the GPU and in headless Chromium is
 * its GPU process doing it in software. So each process's CPU time is read
 * too (`SystemInfo.getProcessInfo`) and printed beside the verdict. MQ1 is
 * written about the main thread and is what is asserted; the GPU figure is what
 * the decision should be read against as well.
 *
 * Opt-in because a figure taken on whatever machine runs the suite is a
 * figure about that machine, and a gate that a busy CI runner can fail is a
 * gate somebody learns to rerun. The number this decision was taken on is
 * written in CLAUDE.md with the machine it came from.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { CDPSession, Page } from 'playwright-core';
import { TEARDOWN, browser, install, loadWallSettled, shutDownBrowser, type Installation } from './browser-harness.js';

const SLOW = 1_800_000;
const TICKS = 10;
const ROUNDS = 2;
const THROTTLE = 6;

const installations: Installation[] = [];
afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

interface Round {
  readonly ticks: number[];
  readonly longTasks: number[][];
  readonly cpu: Record<string, number>;
}

async function processCpu(): Promise<Record<string, number>> {
  const session = await (await browser()).newBrowserCDPSession();
  try {
    const info = (await session.send('SystemInfo.getProcessInfo')) as { processInfo: { type: string; cpuTime: number }[] };
    const out: Record<string, number> = {};
    for (const one of info.processInfo) out[one.type] = (out[one.type] ?? 0) + one.cpuTime;
    return out;
  } finally {
    await session.detach();
  }
}

interface TraceEvent {
  readonly name: string;
  readonly ph: string;
  readonly dur?: number;
  readonly tid: number;
  readonly pid: number;
  readonly args?: { readonly name?: string };
}

/** One tick on the real clock, traced: the main thread's tasks from just before the redraw to after its paint. */
async function tracedTick(page: Page, cdp: CDPSession): Promise<{ ms: number; long: number[] }> {
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>('#wall .canvas');
    if (canvas !== null) canvas.dataset['seen'] = '1';
  });
  const events: TraceEvent[] = [];
  const collect = (chunk: { value: TraceEvent[] }): void => {
    events.push(...chunk.value);
  };
  // One listener per tick, removed after it; the session types only name its own events.
  const session = cdp as unknown as { on(event: string, fn: (chunk: { value: TraceEvent[] }) => void): void; off(event: string, fn: (chunk: { value: TraceEvent[] }) => void): void };
  session.on('Tracing.dataCollected', collect);
  const complete = new Promise<void>((resolve) => cdp.once('Tracing.tracingComplete', () => resolve()));
  // The disabled-by-default timeline category is what carries the thread names
  // that say which thread is the main one; without it nothing is attributed.
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,toplevel,disabled-by-default-devtools.timeline',
    transferMode: 'ReportEvents',
  });
  // The wall's own fifteen-second tick, on the real clock: a fake one runs the
  // draw inside a DevTools command, where most of its script goes uncounted.
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#wall .canvas')?.dataset['seen'] === undefined, undefined, {
    timeout: 40_000,
    polling: 200,
  });
  // Let the browser lay out and paint what the tick built.
  await page.waitForTimeout(1_500);
  await cdp.send('Tracing.end');
  await complete;
  session.off('Tracing.dataCollected', collect);
  const main = events.find((one) => one.name === 'thread_name' && one.args?.name === 'CrRendererMain');
  const tasks = events.filter((one) => one.ph === 'X' && one.name === 'RunTask' && main !== undefined && one.tid === main.tid && one.pid === main.pid);
  return {
    ms: tasks.reduce((sum, one) => sum + (one.dur ?? 0), 0) / 1000,
    long: tasks.filter((one) => (one.dur ?? 0) > 50_000).map((one) => (one.dur ?? 0) / 1000),
  };
}

async function round(home: Installation, link: string, screen: string, ground: 'soft' | 'glass'): Promise<Round> {
  home.db.prepare('UPDATE screens SET widget_ground = ? WHERE id = ?').run(ground, screen);
  const opened = await loadWallSettled(link, { width: 1920, height: 1080 });
  try {
    const page: Page = opened.page;
    await page.waitForSelector(`#wall .canvas[data-ground="${ground}"] .fw.has-ground`, { timeout: 30_000 });
    const cdp = await opened.context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    // Two to warm up: the first draws after a load are not the ticks a wall lives on.
    await tracedTick(page, cdp);
    await tracedTick(page, cdp);
    const cpuBefore = await processCpu();
    const ticks: number[] = [];
    const longTasks: number[][] = [];
    for (let i = 0; i < TICKS; i++) {
      const one = await tracedTick(page, cdp);
      ticks.push(one.ms);
      longTasks.push(one.long);
    }
    const cpuAfter = await processCpu();
    const cpu: Record<string, number> = {};
    for (const type of Object.keys(cpuAfter)) cpu[type] = (cpuAfter[type] ?? 0) - (cpuBefore[type] ?? 0);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    return { ticks, longTasks, cpu };
  } finally {
    await opened.close();
  }
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

describe.runIf(process.env['MW_MEASURE_GLASS'] === '1')('what Glass costs a tick (MQ1)', () => {
  it(
    'is within a fifth of Soft on the main thread at 6x throttling, and adds no long task over 50ms',
    async () => {
      const home = await install({});
      installations.push(home);
      const link = await home.pairLink('Kitchen');
      const screen = (home.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id;
      home.db
        .prepare(
          `UPDATE screens SET layout_background = '{"type":"wallpaper","id":"dusk"}',
             layout_landscape_background = '{"type":"wallpaper","id":"dusk"}' WHERE id = ?`,
        )
        .run(screen);
      const results: Record<'soft' | 'glass', Round[]> = { soft: [], glass: [] };
      for (let i = 0; i < ROUNDS; i++) {
        results.soft.push(await round(home, link, screen, 'soft'));
        results.glass.push(await round(home, link, screen, 'glass'));
      }
      const summary = (ground: 'soft' | 'glass'): { median: number; min: number; max: number; long: number; longMax: number; cpu: Record<string, number> } => {
        const ticks = results[ground].flatMap((one) => one.ticks);
        const longs = results[ground].flatMap((one) => one.longTasks);
        const cpu: Record<string, number> = {};
        for (const one of results[ground]) for (const [type, value] of Object.entries(one.cpu)) cpu[type] = (cpu[type] ?? 0) + value;
        return {
          median: median(ticks),
          min: Math.min(...ticks),
          max: Math.max(...ticks),
          long: Math.max(...longs.map((one) => one.filter((ms) => ms > 50).length)),
          longMax: Math.max(0, ...longs.flat()),
          cpu,
        };
      };
      const soft = summary('soft');
      const glass = summary('glass');
      const cpuLine = (cpu: Record<string, number>): string =>
        Object.entries(cpu)
          .map(([type, s]) => `${type} ${(s * 1000).toFixed(0)}ms`)
          .join(', ');
      process.stdout.write(
        `[glass-cost] ${TICKS * ROUNDS} ticks each at ${THROTTLE}x, 1920x1080, Classic on Dusk\n` +
          `[glass-cost] soft: median ${soft.median.toFixed(0)}ms (${soft.min.toFixed(0)}–${soft.max.toFixed(0)}), ` +
          `long tasks over 50ms a tick ${soft.long} (longest ${soft.longMax.toFixed(0)}ms); cpu ${cpuLine(soft.cpu)}\n` +
          `[glass-cost] glass: median ${glass.median.toFixed(0)}ms (${glass.min.toFixed(0)}–${glass.max.toFixed(0)}), ` +
          `long tasks over 50ms a tick ${glass.long} (longest ${glass.longMax.toFixed(0)}ms); cpu ${cpuLine(glass.cpu)}\n` +
          `[glass-cost] glass/soft main thread ${(glass.median / soft.median).toFixed(3)}\n`,
      );
      // A measurement that caught no tasks has measured nothing, and 0 is within a fifth of 0.
      expect(soft.median, 'the trace attributed no work to the main thread').toBeGreaterThan(0);
      expect(glass.median).toBeGreaterThan(0);
      expect(glass.median).toBeLessThanOrEqual(soft.median * 1.2);
      expect(glass.long).toBeLessThanOrEqual(soft.long);
    },
    SLOW,
  );
});
