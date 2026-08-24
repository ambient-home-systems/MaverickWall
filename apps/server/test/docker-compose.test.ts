import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/**
 * `docker-compose.yml`, checked against the image it is meant to match
 * (RFC 009, 1.10).
 *
 * `wget` is not in `node:22-bookworm-slim` — the Dockerfile says so twice and
 * probes with `node` for exactly that reason. A compose healthcheck that
 * still calls `wget` gives `docker compose ps` a permanently unhealthy
 * container that is serving every request correctly, under a comment
 * claiming it matches the image it does not.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const source = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
const compose = parseYaml(source) as {
  services?: Record<string, { healthcheck?: unknown }>;
};

describe('docker-compose.yml', () => {
  it('declares no healthcheck of its own, so compose inherits the image’s', () => {
    // The image's own `HEALTHCHECK` already probes with `node`; a duplicate
    // here is the thing that drifted from it once already, into a `wget`
    // this image does not have.
    const service = compose.services?.['maverick-wall'];
    expect(service).toBeDefined();
    expect(service?.healthcheck).toBeUndefined();
  });

  it('names no binary command missing from the image', () => {
    // Structural, not a bare substring search: the explanation above is
    // allowed to name `wget` as the thing not to use; a `test:` array
    // actually invoking it is what this refuses.
    for (const service of Object.values(compose.services ?? {})) {
      const test = (service as { healthcheck?: { test?: unknown } }).healthcheck?.test;
      if (Array.isArray(test)) expect(test).not.toContain('wget');
    }
  });
});
