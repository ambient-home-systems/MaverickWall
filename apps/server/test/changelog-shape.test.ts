import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/**
 * The release notes a household is actually shown, held to two things nothing
 * else was looking at.
 *
 * The supervisor reads `CHANGELOG.md` straight from this repository and prints
 * it beside the Update button, so its *shape* is a shipped artifact even
 * though no test had ever treated it as one. Three checks already circle it
 * and all three miss the middle:
 *
 *  - `addon-repository.test.ts` asserts the **newest** `## x.y.z` heading is
 *    the version `config.yaml` ships, and says in as many words that older
 *    headings are "history and not this test's business".
 *  - `version.test.ts` asserts `config.yaml` and `package.json` agree.
 *  - `release.yml`'s `prepare` refuses a release with no notes under
 *    `## Unreleased` — correctly, and *at release time*, on a runner, which is
 *    a long way from whoever caused it.
 *
 * ## The gap, which cost a real bug
 *
 * A branch was cut at `561dec7`. **Three minutes later** the release job's
 * `advertise` commit renamed `## Unreleased` to `## 0.57.0` on `main` — which
 * is exactly what it is supposed to do, last, once the image is built and
 * verified. The branch still called that section `## Unreleased` and appended
 * eight notes to it. Git merged both without a conflict, because renaming a
 * heading and appending paragraphs under it touch different lines.
 *
 * Textually clean, semantically wrong, and invisible to everything above:
 *
 *  - eight notes were filed under `## 0.57.0`, a release cut days earlier that
 *    contains none of them — so a household reading that version's notes would
 *    be told about work not in their install; and
 *  - no `## Unreleased` section survived, so the *next* release would have
 *    failed on its first job, for a reason that looks nothing like its cause.
 *
 * The newest-heading check passed throughout: `## 0.57.0` was still the newest
 * numbered heading and still matched `config.yaml`. It cannot see this by
 * design.
 *
 * ## How the second check works, and why the tag is the right reference
 *
 * A tag points at the commit that was *built*, and `advertise` renames the
 * heading and bumps the version **after** it — for a pushed tag because the
 * tag came first, and for a dispatched run because `advertise` writes the tag
 * "pointing at the commit that was built rather than at the bump that
 * followed it". Measured across `v0.57.0`, `v0.56.0` and `v0.55.0`: at every
 * one of them the newest section is still called `## Unreleased` and every
 * older section is already named.
 *
 * So one `git show` of the file at the newest tag yields both halves of the
 * comparison — what the current release's notes said when they shipped, and
 * what every earlier release's said.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CHANGELOG = 'addon/maverick-wall/CHANGELOG.md';
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

/**
 * Deliberate edits to a section that has already shipped.
 *
 * Empty, and it should stay that way. A shipped section is what households
 * were shown, so changing one changes history they have already read — a typo
 * fix is a defensible reason and "I was appending to Unreleased and the
 * heading moved under me" is not. Keyed by version, valued by why.
 */
const EDITED_AFTER_SHIPPING: Readonly<Record<string, string>> = {};

/** `{ heading: body }` for every `## …` in a changelog, bodies trimmed. */
function sections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let heading: string | undefined;
  let buffer: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      if (heading !== undefined) out.set(heading, buffer.join('\n').trim());
      heading = line.slice(3).trim();
      buffer = [];
    } else if (heading !== undefined) {
      buffer.push(line);
    }
  }
  if (heading !== undefined) out.set(heading, buffer.join('\n').trim());
  return out;
}

/** The shipped version, from the one file the supervisor compares against. */
const shipped = (parseYaml(read('addon/maverick-wall/config.yaml')) as { version: string }).version;
const today = sections(read(CHANGELOG));

describe('the changelog a household is shown', () => {
  it('keeps an ## Unreleased section to write the next notes under', () => {
    /*
     * Existence only, and the missing half is the point.
     *
     * This used to demand *words* as well, and that made it red on `main` for
     * the whole window between a release finishing and somebody writing the
     * next note — measured twice, and both times read as a broken build by
     * whoever arrived next. Two different questions had been folded into one:
     *
     *  - **is there somewhere to write notes?** — an invariant, true of `main`
     *    at every moment, which is this;
     *  - **are there notes to ship?** — a fact about one release, true only at
     *    the moment of making one, which is `release.yml`'s `prepare`. It runs
     *    before anything is built, refuses the release outright, and its own
     *    comment is the authority here: a bare scaffold "sits in the changelog
     *    between releases by design".
     *
     * Asserting the second one here asserted something the release process
     * itself makes false. It is not weakened — nothing could ship an empty
     * section before this change and nothing can now; the check that stops it
     * is the one that can still act on it.
     */
    expect(
      today.get('Unreleased'),
      'no `## Unreleased` section, so there is nowhere to write the next release\'s notes and ' +
        '`release.yml`\'s `prepare` would refuse the release. `advertise` opens a fresh one as ' +
        'it renames the old, so the usual cause is a hand-edit or a bad merge.',
    ).toBeDefined();
  });

  it('re-opens the section as the release renames it, by running what ships', () => {
    /*
     * The other half of the assertion above, and the reason it can hold.
     *
     * `advertise` used to rename `## Unreleased` to the version and stop
     * there, so the moment a release finished `main` had no such section —
     * and the check above was red until somebody wrote the next note. Both
     * halves are needed: re-opening with nothing asserting it would quietly
     * stop happening, and asserting it with nothing re-opening it is where
     * this started.
     *
     * This runs the workflow's *own* command rather than matching its text.
     * A substring check passes on a line that has been changed to something
     * that no longer works, which is the failure mode being fixed one layer
     * down: the shipped thing and the checked thing have to be the same
     * thing. If the release stops using sed here, this fails loudly rather
     * than going quietly blind — which is the outcome to want.
     */
    const workflow = parseYaml(read('.github/workflows/release.yml')) as {
      jobs: Record<string, { steps?: { run?: string }[] }>;
    };
    const script = (workflow.jobs['advertise']?.steps ?? [])
      .map((step) => step.run ?? '')
      .find((run) => run.includes('## Unreleased'));
    expect(script, 'no step in `advertise` touches `## Unreleased`').toBeDefined();

    /*
     * The command that rewrites the changelog, whatever it is written with.
     *
     * This used to select on `line.startsWith('sed -i')`, which is a fact about
     * the tool rather than about the job — and it was load-bearing in the wrong
     * direction: when the step stopped using `sed -i` (a GNU-only spelling that
     * cannot run on a Mac at all), the filter matched nothing and the whole
     * case would have gone vacuous rather than red. It selects on the *effect*
     * now: the line that names the changelog and the heading it renames.
     */
    const rename = (script ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes(CHANGELOG) && line.includes('## Unreleased'));
    // Non-vacuity: two would mean this exercised one and left the other, and
    // zero would mean the command moved and nothing below ran on anything.
    expect(rename, 'expected exactly one command over the changelog in `advertise`').toHaveLength(1);

    const root = mkdtempSync(join(tmpdir(), 'mw-advertise-'));
    try {
      mkdirSync(join(root, 'addon', 'maverick-wall'), { recursive: true });
      const before = [
        '# Changelog', '', '<!--', '  A comment the release must not treat as notes.', '-->', '',
        '## Unreleased', '', '**Something a household is told.**', '',
        '## 1.2.3', '', 'An older release.', '',
      ].join('\n');
      writeFileSync(join(root, CHANGELOG), before);

      execFileSync('bash', ['-c', rename[0] as string], {
        cwd: root,
        env: { ...process.env, VERSION: '9.9.9' },
      });
      const after = sections(readFileSync(join(root, CHANGELOG), 'utf8'));

      // The notes shipped under the version, which is the rename working.
      expect(after.get('9.9.9')).toBe('**Something a household is told.**');
      // And there is somewhere to write the next ones, which is what `main`
      // was missing for the whole window after every release.
      expect(
        after.get('Unreleased'),
        'the release renamed the section without opening a fresh one',
      ).toBeDefined();
      // Bare, deliberately: any words here are words `prepare` accepts as
      // notes, which would let the next release ship a heading saying nothing.
      expect(after.get('Unreleased'), 'the fresh section must be empty').toBe('');
      // Untouched history.
      expect(after.get('1.2.3')).toBe('An older release.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never edits a section after it has shipped', () => {
    const tag = `v${shipped}`;

    /*
     * Loud when it cannot check, never quiet. A shallow checkout has no tags,
     * and a check that silently passes because it could not look is the exact
     * failure this repository keeps writing down — so this asserts the
     * reference exists rather than skipping when it does not. CI fetches full
     * history for this job.
     */
    let atTag: string;
    try {
      atTag = git('show', `${tag}:${CHANGELOG}`);
    } catch {
      throw new Error(
        `cannot read ${CHANGELOG} at ${tag}, so nothing here was compared. This needs the ` +
          `tags and their commits: in CI, \`fetch-depth: 0\` on the checkout; locally, ` +
          `\`git fetch --tags --unshallow\`.`,
      );
    }

    const released = sections(atTag);
    const permitted = new Set(Object.keys(EDITED_AFTER_SHIPPING));

    /*
     * The current release, under the name it had when it shipped. At its own
     * tag it is still `## Unreleased`; `advertise` renames it afterwards. This
     * is the comparison the newest-heading check cannot make, and the one the
     * bug above walked straight through.
     */
    if (!permitted.has(shipped)) {
      expect(
        today.get(shipped),
        `\`## ${shipped}\` no longer says what it said when it shipped. At ${tag} those notes ` +
          `were the \`## Unreleased\` section; something has been added to or removed from them ` +
          `since. The usual cause is a branch that appended under \`## Unreleased\` while a ` +
          `release renamed that heading on main — git merges both without a conflict. Move the ` +
          `new notes to a fresh \`## Unreleased\` above.`,
      ).toBe(released.get('Unreleased'));
    }

    // Every earlier release, under the name it already had.
    const older = [...released.keys()].filter((name) => name !== 'Unreleased');
    const drifted = older
      .filter((name) => !permitted.has(name))
      .filter((name) => today.get(name) !== released.get(name))
      .map((name) => (today.has(name) ? name : `${name} (gone entirely)`));

    expect(
      drifted,
      `${drifted.length} shipped section(s) differ from what ${tag} carried: ${drifted.join(', ')}. ` +
        `Households have already read these. If an edit is deliberate, record it in ` +
        `EDITED_AFTER_SHIPPING with the reason.`,
    ).toEqual([]);

    /*
     * The non-vacuity guard. A parse that understood nothing returns an empty
     * map, every comparison above iterates nothing, and the whole file passes
     * having looked at zero sections — which is how a regex-based check goes
     * quietly blind when a file is reformatted or moved.
     */
    expect(older.length, `only ${older.length} shipped section(s) were compared`).toBeGreaterThan(50);
    expect(released.has('Unreleased'), `${tag} has no \`## Unreleased\` to compare against`).toBe(true);
  });

  it('names the shipped version, and names it once', () => {
    // `addon-repository.test.ts` asserts the newest heading matches the shipped
    // version; this is the other half of the same fact — that it is *there* and
    // that nothing has duplicated it, which a hand-edit or a bad merge can.
    const named = [...today.keys()].filter((name) => name === shipped);
    expect(named, `\`## ${shipped}\` appears ${named.length} times`).toHaveLength(1);
  });

  it('is reading the real changelog, so a move fails loudly', () => {
    // Every assertion above compares parsed sections; a file that has moved
    // parses to nothing and compares two empty maps to each other.
    expect(today.size).toBeGreaterThan(50);
    expect([...today.keys()][0]).toBe('Unreleased');
  });
});
