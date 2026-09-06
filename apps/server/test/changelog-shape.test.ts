import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
  it('keeps an ## Unreleased section with words in it', () => {
    /*
     * `release.yml` refuses a release without this, before anything is built —
     * which is right, and is the last place you want to find out. The section
     * is scaffolding that sits here between releases by design, so the check
     * is that it *exists* and that it says something: a bare heading would be
     * renamed by `advertise` and shipped as a release note saying nothing at
     * all, which is the reason the workflow looks for words rather than for a
     * heading, and so does this.
     */
    const body = today.get('Unreleased');
    expect(
      body,
      'no `## Unreleased` section. `release.yml`\'s `prepare` refuses a release without one, ' +
        'so the next release would fail on its first job. If a release just renamed it, add a ' +
        'fresh one above the newest version.',
    ).toBeDefined();

    const words = (body ?? '')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.trim().startsWith('<!--') && !line.trim().startsWith('-->'))
      .join('')
      .trim();
    expect(words.length, 'the `## Unreleased` heading is there but empty').toBeGreaterThan(0);
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
