import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The boot holder, driven as the real process it is.
 *
 * `main.ts` spawns exactly this file to hold the port with a "booting" page
 * while it migrates, then kills it and binds the port itself. The two things
 * that matter — it answers a clear 503 while it holds, and it frees the port
 * cleanly on SIGTERM so the real server can bind — are only true of the actual
 * child process, so this spawns it rather than importing a function.
 */

const HOLDER = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'boot-holder.js');

let child: ChildProcess | undefined;
afterEach(() => {
  if (child !== undefined && child.exitCode === null) child.kill('SIGKILL');
  child = undefined;
});

/** A free port to hand the holder, found by binding zero and reading it back. */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** Poll until the holder answers, or give up. */
async function waitReachable(port: number, timeoutMs = 4000): Promise<Response> {
  const start = Date.now();
  for (;;) {
    try {
      return await fetch(`http://127.0.0.1:${port}/`);
    } catch {
      if (Date.now() - start > timeoutMs) throw new Error('holder never came up');
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

describe('the boot holder process', () => {
  it('answers a 503 booting page while it holds the port', async () => {
    const port = await freePort();
    child = spawn(process.execPath, [HOLDER, String(port)], { stdio: 'ignore' });

    const res = await waitReachable(port);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('3');
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('booting');

    // A poll gets the machine body, not the page.
    const manifest = await fetch(`http://127.0.0.1:${port}/d/manifest`);
    expect(manifest.status).toBe(503);
    expect(manifest.headers.get('content-type')).toContain('application/json');
    expect(await manifest.json()).toMatchObject({ error: 'booting' });
  });

  it('frees the port on SIGTERM so the real server can bind it', async () => {
    const port = await freePort();
    child = spawn(process.execPath, [HOLDER, String(port)], { stdio: 'ignore' });
    await waitReachable(port);

    // The handover main.ts performs: kill, wait for the real exit.
    await new Promise<void>((resolve) => {
      child!.once('exit', () => resolve());
      child!.kill('SIGTERM');
    });

    // The port is free now: a fresh server binds it without EADDRINUSE.
    await new Promise<void>((resolve, reject) => {
      const s = createServer((_req, res) => res.end('real'));
      s.on('error', reject);
      s.listen(port, '127.0.0.1', () => s.close(() => resolve()));
    });
  });
});
