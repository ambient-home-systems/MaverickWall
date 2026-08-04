import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/**
 * The Home Assistant add-on repository, checked against the supervisor's own
 * rules rather than against how it looks in a directory listing.
 *
 * This file exists because "is not a valid app repository" is the entire error
 * a household gets. It names no file, no path and no reason, and it is
 * identical whether the manifest is missing, misplaced, or malformed — so
 * there is nothing to debug from and no way to tell which of the three
 * happened. Everything here is a rule read out of `home-assistant/supervisor`:
 *
 *   - `store/data.py` finds the repository manifest with
 *     `find_one_filetype(path, "repository", [".yaml", ".yml", ".json"])`,
 *     where `path` is the **root of the clone**. Ours lived in `addon/` and
 *     was invisible; the add-on was unreachable for everybody.
 *   - `store/validate.py` requires `name`, and accepts `maintainer` as free
 *     text — which is why an issues URL is valid there.
 *   - `_find_app_configs` globs for `config.*` at any depth, recursively, so
 *     the add-on itself may stay in a subdirectory. That is a convenience with
 *     a trap attached, and the trap is the third test below.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const readYaml = (path: string): Record<string, unknown> =>
  parseYaml(read(path)) as Record<string, unknown>;

/** Tracked files only. An untracked stray is a local mess; a tracked one ships. */
const tracked = (): string[] =>
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

describe('the add-on repository manifest', () => {
  it('is at the root of the repository, which is the only place the supervisor looks', () => {
    expect(existsSync(join(ROOT, 'repository.yaml'))).toBe(true);

    // And nowhere else. `find_one_filetype` raises when it matches more than
    // one, so a leftover copy in `addon/` would break the repository just as
    // completely as having none — with the same unhelpful message.
    const manifests = tracked().filter((f) => /^repository\.(yaml|yml|json)$/.test(f));
    expect(manifests).toEqual(['repository.yaml']);
    expect(tracked().filter((f) => f.includes('/repository.y'))).toEqual([]);
  });

  it('carries the keys the supervisor schema requires', () => {
    const repo = readYaml('repository.yaml');
    expect(repo.name).toBe('Maverick Wall');
    expect(repo.url).toBe('https://github.com/ambient-home-systems/MaverickWall');

    // Free text in the schema, so a URL is as valid as an address here — and a
    // better answer, because an inbox is answerable by one person and invisible
    // to the next household with the same problem.
    expect(String(repo.maintainer)).toContain('/issues');
    expect(String(repo.maintainer)).not.toContain('example.invalid');
  });

  it('offers the supervisor exactly one add-on', () => {
    /*
     * `_find_app_configs` globs `**\/config.*` from the repository root, so
     * *any* `config.yaml`, `config.yml` or `config.json` committed anywhere in
     * this monorepo is read as an add-on manifest. A tool's config file added
     * in a year's time would be parsed as a broken add-on, in a repository
     * whose add-on had been working — which is a long way from the change that
     * caused it.
     *
     * The suffix list is the supervisor's; `.ts` and `.js` are not in it, so a
     * `config.ts` is safe.
     */
    const configs = tracked().filter((f) => /(^|\/)config\.(yaml|yml|json)$/.test(f));
    expect(configs).toEqual(['addon/maverick-wall/config.yaml']);
  });
});

describe('the add-on manifest', () => {
  const addon = readYaml('addon/maverick-wall/config.yaml');

  it('declares only architectures the published image actually has', () => {
    /*
     * The supervisor believes this list: it offers the add-on on a machine of
     * a declared architecture, and the install then fails at `docker pull`.
     * `armv7` was listed and never built, which is an install that breaks
     * after somebody has already added the repository and pressed the button.
     *
     * These two are the supervisor's own ARCH_ALL, and they are what
     * `release.yml` builds. Changing one without the other is the bug.
     */
    expect(addon.arch).toEqual(['aarch64', 'amd64']);

    const release = read('.github/workflows/release.yml');
    expect(release).toContain('linux/amd64');
    expect(release).toContain('linux/arm64');
    expect(release).not.toContain('linux/arm/v7');
  });

  it('pulls the version it says it is', () => {
    // The supervisor pulls `image:version`. A version with no matching tag in
    // the registry is a failed install with a registry-shaped error message.
    expect(addon.image).toBe('ghcr.io/ambient-home-systems/maverick-wall');
    expect(addon.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('maps a port as well as ingress, because wall displays cannot use ingress', () => {
    // Ingress is the settings, authenticated by Home Assistant. A screen
    // screwed to a wall has no Home Assistant session and never will, so
    // without `ports` there is a settings page and nothing to look at.
    expect(addon.ingress).toBe(true);
    expect(addon.ingress_stream).toBe(true);
    expect(addon.ports).toHaveProperty('8080/tcp');
  });
});

describe('the working tree', () => {
  it('has no file-sync collision duplicates committed', () => {
    /*
     * macOS file sync resolves a write conflict by copying the file beside
     * itself as `name 2.ext`, silently. Nine `… 2.sql` migrations appeared in
     * this repository once and were caught by the journal-parity check;
     * `NOTICE 2` and `packages/calendar/LICENSE 2` appeared the same way, were
     * caught by nothing, and were committed and pushed to a public repository.
     * Byte-identical duplicates of two licence files is the worst place for it
     * — a reader cannot tell which one is authoritative.
     *
     * Nothing else looks for these, and the whole point is that they are
     * invisible: identical content, plausible name, no diff to read.
     */
    const collisions = tracked().filter((f) => / \d+(\.[^/]+)?$/.test(f.split('/').pop() ?? ''));
    expect(collisions).toEqual([]);
  });
});
