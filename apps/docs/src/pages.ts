/**
 * What the docs site publishes, in the order it is read (plan item M9.1).
 *
 * The site is the Markdown in the repository, rendered, and nothing else: no
 * page is written here, so a page on the site and the file a contributor edits
 * cannot say different things. What this file decides is which of those files
 * a household is shown, under which heading, and what each one is for — the
 * last of which is also the line `llms.txt` gives a model.
 *
 * Every `docs/*.md` is either published below or named in `UNPUBLISHED` with
 * the reason it is not, and the build refuses a file that is neither. A new
 * page somebody writes for a household must not quietly stay off the site, and
 * an RFC must not quietly land on it.
 */

/** Where the site is served. Every absolute link the build writes starts here. */
export const SITE_URL = 'https://ambient-home-systems.github.io/MaverickWall/';

/** The repository, for "Edit this page" and links to files that are not pages. */
export const REPOSITORY_URL = 'https://github.com/ambient-home-systems/MaverickWall';

export interface Page {
  /** The file, from the repository root. */
  readonly source: string;
  /** The page's name on the site: `<slug>.html`, and `<slug>.md` beside it. */
  readonly slug: string;
  /** What the navigation calls it. The page's own heading is its title. */
  readonly label: string;
  /** One sentence: what somebody reads it for. Shown in `llms.txt`. */
  readonly summary: string;
  /**
   * A record of what was true when it was written, which is never edited
   * afterwards: the release notes. Its links are checked; the names of screens
   * and retired words in it are not, because a release note from last year
   * rightly names last year's screens. `llms.txt` lists it as optional, and
   * `llms-full.txt` leaves it out.
   */
  readonly history?: boolean;
}

export interface Section {
  readonly title: string;
  readonly pages: readonly Page[];
}

export const SECTIONS: readonly Section[] = [
  {
    title: 'Getting started',
    pages: [
      {
        source: 'docs/README.md',
        slug: 'index',
        label: 'Overview',
        summary: 'What Maverick Wall is, and where each part of these docs is.',
      },
      {
        source: 'docs/install.md',
        slug: 'install',
        label: 'Install',
        summary: 'Running it with Docker, Docker Compose or as a Home Assistant add-on.',
      },
      {
        source: 'docs/first-run.md',
        slug: 'first-run',
        label: 'First run',
        summary: 'The setup code, the wizard, adding a calendar and pairing the first wall.',
      },
      {
        source: 'docs/walls.md',
        slug: 'walls',
        label: 'Walls and designs',
        summary: 'Layouts, backgrounds, themes, timed layouts and e-paper panels.',
      },
      {
        source: 'docs/kiosk.md',
        slug: 'kiosk',
        label: 'Kiosk devices',
        summary: 'Keeping a Google TV, a Fire tablet or a Raspberry Pi showing the wall.',
      },
    ],
  },
  {
    title: 'Home Assistant',
    pages: [
      {
        source: 'addon/maverick-wall/DOCS.md',
        slug: 'home-assistant',
        label: 'The add-on',
        summary: 'Installing the add-on, the sidebar, and what it can and cannot do in the house.',
      },
    ],
  },
  {
    title: 'Running it',
    pages: [
      {
        source: 'docs/exposing-safely.md',
        slug: 'exposing-safely',
        label: 'Exposing it safely',
        summary: 'Read before you port-forward: TLS, reverse proxies and what is reachable.',
      },
      {
        source: 'docs/backup.md',
        slug: 'backup',
        label: 'Backup and restore',
        summary: 'What to keep, how to restore it, and why the key is a separate download.',
      },
      {
        source: 'docs/environment.md',
        slug: 'environment',
        label: 'Environment variables',
        summary: 'Every environment variable the server reads, with its default.',
      },
      {
        source: 'docs/command-line.md',
        slug: 'command-line',
        label: 'Command-line tools',
        summary: 'Every command-line tool in the image, and how to run one.',
      },
      {
        source: 'docs/troubleshooting.md',
        slug: 'troubleshooting',
        label: 'Troubleshooting',
        summary: 'What a message on the wall or in the log means, and what to do about it.',
      },
    ],
  },
  {
    title: 'Modules',
    pages: [
      {
        source: 'docs/building-a-module.md',
        slug: 'building-a-module',
        label: 'Building a module',
        summary: 'Recipes and service modules: the panel shapes, settings, sources and the tools to test them.',
      },
      {
        source: 'docs/adding-to-the-store.md',
        slug: 'adding-to-the-store',
        label: 'Adding to the Store',
        summary: 'Putting a module in the built-in Store by pull request.',
      },
    ],
  },
  {
    title: 'Releases',
    pages: [
      {
        source: 'addon/maverick-wall/CHANGELOG.md',
        slug: 'release-notes',
        label: 'Release notes',
        summary: 'What changed in every release, newest first — the same notes Home Assistant shows beside Update.',
        history: true,
      },
    ],
  },
];

export const PAGES: readonly Page[] = SECTIONS.flatMap((section) => section.pages);

/**
 * Files under `docs/` deliberately kept off the site, each with its reason.
 * They stay in the repository and a published page may link to one, which
 * takes the reader to it on GitHub.
 */
export const UNPUBLISHED: Readonly<Record<string, string>> = {
  'docs/plan-2026-09-household-review.md': 'A plan: the decisions and the work, not how anything works.',
  'docs/plan-2026-09-household-review-prompts.md': 'Prompts for building a plan, not documentation.',
  'docs/plan-2026-10-magic-frame-parity.md': 'A plan: the decisions and the work, not how anything works.',
  'docs/release-checklist.md': 'For the maintainer cutting a release.',
  'docs/releasing.md': 'For the maintainer cutting a release.',
  'docs/releasing-the-app.md': 'For the maintainer releasing the Android app.',
  'docs/whats-new.md': 'A walkthrough of 0.68.0, kept as written; the release notes are the current record.',
};

/** RFCs are design history: kept, linked to, never published as pages. */
export function isUnpublishedByRule(source: string): boolean {
  return /^docs\/rfc-\d+[-\w]*\.md$/.test(source);
}
