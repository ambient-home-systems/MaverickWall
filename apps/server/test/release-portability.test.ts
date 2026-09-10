/**
 * The release runs on the tools a developer actually has.
 *
 * `changelog-shape.test.ts` executes the changelog rename *out of the workflow
 * file*, which is the right design and is what caught this: the step reached
 * for `grep -oP`, `sed -i` with no backup suffix, a `0,/re/` address and a `\n`
 * in a replacement — four GNU extensions, none of which exists in the BSD sed
 * and grep a macOS machine ships. So the whole suite was red on a Mac, and had
 * been for as long as anybody had one: 1,992 of 1,993 passing, with the odd one
 * out being the release path.
 *
 * That is worse than an inconvenience. A suite red for an environmental reason
 * teaches people to read red as noise — this repository's own history has a
 * flake that "was right" and a ratchet left red under a note saying it held.
 * And a release nobody can rehearse locally is a release whose first execution
 * is the one that ships to households.
 *
 * Two questions here, and they are different:
 *
 *  - **Do the replacements work?** Executed against a fixture with whatever
 *    `sed` this machine has, which on CI is GNU and on a Mac is BSD. That is
 *    the only way to know, and it is why the values are asserted rather than
 *    the commands merely being run.
 *  - **Will the next one be caught?** A scan for the four constructs that bit,
 *    over every `run:` in the workflows. Fixing five lines fixes five lines;
 *    the scan is what makes it a rule.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

interface Workflow {
  jobs: Record<string, { steps?: { name?: string; run?: string }[] }>;
}

/** Every `run:` script in a workflow, with the job and step it came from. */
function scripts(file: string): { where: string; run: string }[] {
  const parsed = parseYaml(read(file)) as Workflow;
  const out: { where: string; run: string }[] = [];
  for (const [job, body] of Object.entries(parsed.jobs ?? {})) {
    for (const step of body.steps ?? []) {
      if (typeof step.run === 'string') {
        out.push({ where: `${file} › ${job} › ${step.name ?? '(unnamed step)'}`, run: step.run });
      }
    }
  }
  return out;
}

/**
 * The GNU-only spellings that were actually in this repository, each with the
 * portable form to reach for instead.
 *
 * Deliberately short. A list of everything GNU adds would be a list nobody
 * maintains; these four are the ones that shipped, and each names its cure so
 * a failure is a fix rather than a puzzle.
 */
const GNU_ONLY: { readonly pattern: RegExp; readonly what: string; readonly instead: string }[] = [
  {
    pattern: /\bgrep\s+(-\w*P|--perl-regexp)/,
    what: 'grep -P (PCRE) — BSD grep has no -P at all',
    instead: "sed -n 's/…/\\1/p', or python3 for anything with structure",
  },
  {
    pattern: /\\K/,
    what: '\\K — a PCRE reset, so GNU grep only',
    instead: 'a capture group with sed -n and \\1',
  },
  {
    pattern: /\bsed\s+(-\w*i|--in-place)(\s|$)/,
    what: 'sed -i with no backup suffix — BSD sed requires one, GNU sed refuses one',
    instead: 'sed … file > file.tmp && mv file.tmp file',
  },
  {
    pattern: /\bsed\b[^\n]*['"]0,\//,
    what: 'a 0,/re/ address — a GNU extension; BSD sed addresses start at 1',
    instead: 'python3 with re.subn(…, count=1), which also says how many it hit',
  },
];

describe('the release runs on BSD tools as well as GNU ones', () => {
  it('reaches for no GNU-only construct in any workflow step', () => {
    const found: string[] = [];
    for (const file of ['.github/workflows/release.yml', '.github/workflows/ci.yml']) {
      for (const { where, run } of scripts(file)) {
        for (const line of run.split('\n')) {
          // Comments describe the trap; they are not the trap.
          if (line.trim().startsWith('#')) continue;
          for (const gnu of GNU_ONLY) {
            if (gnu.pattern.test(line)) {
              found.push(`${where}\n    ${line.trim()}\n    ${gnu.what}\n    use: ${gnu.instead}`);
            }
          }
        }
      }
    }
    expect(found.join('\n\n'), 'a workflow step cannot run on a Mac').toBe('');
  });

  /*
   * Non-vacuity for the scan above, which is the assertion most likely to rot
   * into one that matches nothing: a workflow renamed, a step key changed, a
   * YAML shape moved, and it passes for ever while looking diligent.
   */
  it('is reading real workflow steps, so a move fails loudly', () => {
    const all = [
      ...scripts('.github/workflows/release.yml'),
      ...scripts('.github/workflows/ci.yml'),
    ];
    expect(all.length, 'no `run:` steps found — the scan above is measuring nothing').toBeGreaterThan(
      8,
    );
    expect(
      all.some(({ run }) => run.includes('addon/maverick-wall/CHANGELOG.md')),
      'no step touches the changelog, so the release path is not in what was scanned',
    ).toBe(true);
    // And the patterns can still match something, or they are dead regexes.
    expect(GNU_ONLY.filter((g) => g.pattern.test("grep -oP '^x\\K'")).length).toBeGreaterThan(0);
    expect(GNU_ONLY.some((g) => g.pattern.test('sed -i "s/a/b/" f'))).toBe(true);
  });

  /**
   * The version commands, executed with this machine's own tools.
   *
   * Out of the workflow rather than retyped, for the reason `changelog-shape`
   * gives: a copy here would pass while the shipped one failed. The changelog
   * rename is exercised there; these are the other three, which nothing ran.
   */
  it('reads and raises the advertised version, by running what ships', () => {
    const workflow = parseYaml(read('.github/workflows/release.yml')) as Workflow;
    const advertise = (workflow.jobs['advertise']?.steps ?? [])
      .map((step) => step.run ?? '')
      .find((run) => run.includes('addon/maverick-wall/config.yaml'));
    expect(advertise, 'no step in `advertise` touches config.yaml').toBeDefined();

    const lines = (advertise ?? '').split('\n').map((line) => line.trim());
    const readVersion = lines.filter(
      (line) => line.startsWith('current=') && line.includes('config.yaml'),
    );
    const raise = lines.filter((line) => line.startsWith('sed -E') && line.includes('config.yaml'));
    const newest = lines.filter(
      (line) => line.startsWith('newest=') && line.includes('CHANGELOG.md'),
    );
    expect(readVersion, 'expected one command reading the advertised version').toHaveLength(1);
    expect(raise, 'expected one command raising it').toHaveLength(1);
    expect(newest, 'expected one command reading the newest changelog heading').toHaveLength(1);

    const root = mkdtempSync(join(tmpdir(), 'mw-portability-'));
    try {
      mkdirSync(join(root, 'addon', 'maverick-wall'), { recursive: true });
      writeFileSync(
        join(root, 'addon/maverick-wall/config.yaml'),
        ['name: Maverick Wall', 'version: "0.61.0"', 'arch:', '  - aarch64', ''].join('\n'),
      );
      writeFileSync(
        join(root, 'addon/maverick-wall/CHANGELOG.md'),
        ['# Changelog', '', '## 9.9.9', '', 'Notes.', '', '## 1.2.3', '', 'Older.', ''].join('\n'),
      );

      /*
       * The raise is two lines joined by a `&&` continuation in YAML, so the
       * whole script is fed to one shell rather than the matched line alone —
       * echoing the values back is how each one is read without assuming where
       * a command ends.
       */
      const out = execFileSync(
        'bash',
        [
          '-c',
          `set -euo pipefail\nVERSION=9.9.9\n${readVersion[0]}\necho "read:$current"\n` +
            `${(advertise ?? '')
              .split('\n')
              .filter((line) => line.trim().startsWith('sed -E') || line.trim().startsWith('&& mv'))
              .join('\n')}\n` +
            `${newest[0]}\necho "newest:$newest"\n`,
        ],
        { cwd: root, encoding: 'utf8', env: { ...process.env } },
      );

      expect(out, 'the advertised version was not read back').toContain('read:0.61.0');
      expect(out, 'the newest changelog heading was not read back').toContain('newest:9.9.9');
      expect(
        readFileSync(join(root, 'addon/maverick-wall/config.yaml'), 'utf8'),
        'the version was not raised in config.yaml',
      ).toContain('version: "9.9.9"');
      // And nothing else in the file moved.
      expect(readFileSync(join(root, 'addon/maverick-wall/config.yaml'), 'utf8')).toContain(
        '  - aarch64',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
