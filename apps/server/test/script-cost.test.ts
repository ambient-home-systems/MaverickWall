import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';

import { createFetcher } from '../src/net/fetcher.js';
import { runScript } from '../src/modules/external/sandbox.js';
import { scriptFetch, scriptManifestSchema, SCRIPT_LIMITS } from '../src/modules/external/script.js';

/**
 * RFC 017 §8: what a script module costs, measured rather than assumed.
 *
 * A typical run is the RFC's own: one fetch and fifty rows of arithmetic. It
 * is timed twenty times through the real sandbox and the real fetcher, and the
 * figures are printed, so a CI log carries the runner's reading beside the one
 * recorded in CLAUDE.md. What is asserted is the RFC's gate, loosely enough to
 * hold on a loaded runner: a typical run's interpreter time is a small share of
 * its 200 ms budget, and nowhere near a second.
 *
 * The RFC also asks for an arm64 Raspberry Pi 4. That has not been measured;
 * this is the reading of whatever runs the suite.
 */

const servers: Server[] = [];
afterAll(() => {
  for (const server of servers) server.close();
});

const TYPICAL = `export default async function run(ctx) {
  const res = await ctx.fetch(ctx.config.base + '/rows');
  const rows = (await res.json()).rows;
  const items = rows
    .map((row) => ({ label: row.name, total: row.values.reduce((a, b) => a + b, 0) / row.values.length }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 12)
    .map((row) => ({ label: row.label, value: row.total.toFixed(1) }));
  return { panel: { kind: 'readings', title: 'Rows', items } };
}`;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

describe('what a script module costs (RFC 017 §8)', () => {
  it('runs one fetch and fifty rows of arithmetic well inside its budget', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ name: `Row ${i}`, values: Array.from({ length: 24 }, (_, j) => (i * 7 + j * 3) % 17) }));
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ rows }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${address.port}`;
    const manifest = scriptManifestSchema.parse({ name: 'Rows', contract: 1, hosts: ['127.0.0.1'], allowLan: true });

    const start: number[] = [];
    const cpu: number[] = [];
    const wall: number[] = [];
    for (let i = 0; i < 20; i++) {
      const began = Date.now();
      const outcome = await runScript({
        source: TYPICAL,
        config: { base },
        now: Date.now(),
        timeZone: 'UTC',
        fetch: scriptFetch(createFetcher(), manifest, {}, () => SCRIPT_LIMITS.wallMs - (Date.now() - began)),
      });
      if (!outcome.ok) throw new Error(outcome.detail);
      expect(outcome.panel).toMatchObject({ kind: 'readings' });
      start.push(outcome.timing.startMs);
      cpu.push(outcome.timing.cpuMs);
      wall.push(outcome.timing.wallMs);
    }
    const require = createRequire(import.meta.url);
    const wasm = statSync(require.resolve('@jitl/quickjs-wasmfile-release-sync/wasm')).size;
    console.log(
      `[script-cost] ${process.arch}: interpreter start ${median(start).toFixed(1)} ms, ` +
        `run ${median(cpu).toFixed(1)} ms of interpreter time (max ${Math.max(...cpu).toFixed(1)}), ` +
        `${median(wall).toFixed(1)} ms in all (max ${Math.max(...wall).toFixed(1)}); WebAssembly ${Math.round(wasm / 1024)} KB`,
    );
    expect(median(cpu)).toBeLessThan(SCRIPT_LIMITS.cpuMs / 2);
    expect(Math.max(...cpu)).toBeLessThan(1000);
  }, 60_000);
});
