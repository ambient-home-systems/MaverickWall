import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite, type BuiltSite } from '../src/build.js';
import { adminWords, checkScreenNames, checkTools, environmentDocumented, toolsDocumented } from '../src/checks.js';
import { renderMarkdown, rewriteMarkdownLinks, slugger } from '../src/markdown.js';
import { PAGES, SITE_URL } from '../src/pages.js';

/**
 * The docs site (plan item M9.1): built from the real repository, and built
 * again from copies of it with one fault planted at a time — a link to
 * nowhere, a variable nobody documents, a screen that was renamed — each of
 * which must stop the build with a sentence that names it.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A copy of the repository with `docs/` and `addon/` copied, so they can be
 * changed, and everything else at the top level linked rather than copied.
 */
function repositoryWith(change: (root: string) => void): BuiltSite {
  const root = mkdtempSync(join(tmpdir(), 'mw-docs-site-'));
  roots.push(root);
  for (const name of readdirSync(ROOT)) {
    if (name === '.git' || name === 'node_modules') continue;
    if (name === 'docs' || name === 'addon') cpSync(join(ROOT, name), join(root, name), { recursive: true });
    else symlinkSync(join(ROOT, name), join(root, name));
  }
  change(root);
  return buildSite(root);
}

function edit(root: string, path: string, change: (text: string) => string): void {
  const file = join(root, path);
  const before = readFileSync(file, 'utf8');
  const after = change(before);
  if (after === before) throw new Error(`the edit to ${path} changed nothing`);
  writeFileSync(file, after);
}

const text = (site: BuiltSite, path: string): string => {
  const file = site.files.find((one) => one.path === path);
  if (file === undefined) throw new Error(`no ${path}`);
  return file.content.toString();
};

describe('the docs site, built from the repository', () => {
  const site = buildSite(ROOT);

  it('builds with no problems: every link resolves, and every page agrees with the code', () => {
    expect(site.problems).toEqual([]);
  });

  it('has an HTML page and a Markdown copy for every page, and nothing published that is not listed', () => {
    for (const page of PAGES) {
      expect(text(site, `${page.slug}.html`)).toContain('<!doctype html>');
      expect(text(site, `${page.slug}.md`).length).toBeGreaterThan(100);
    }
    const html = site.files.filter((file) => file.path.endsWith('.html')).map((file) => file.path.slice(0, -5));
    expect(html.sort()).toEqual(PAGES.map((page) => page.slug).sort());
  });

  it('fetches nothing from another origin: no script at all, and every stylesheet, image and font its own', () => {
    for (const file of site.files.filter((one) => one.path.endsWith('.html') || one.path.endsWith('.css'))) {
      const body = file.content.toString();
      expect(body, file.path).not.toMatch(/<script/i);
      for (const match of body.matchAll(/<(?:img|link|source|iframe|video|audio)\b[^>]*\b(?:src|href)="([^"]+)"/gi)) {
        expect(match[1], `${file.path}: ${match[0]}`).not.toMatch(/^(?:[a-z]+:)?\/\//i);
      }
      for (const match of body.matchAll(/url\(([^)]+)\)/g)) expect(match[1], file.path).not.toMatch(/^['"]?(?:[a-z]+:)?\/\//i);
    }
  });

  it('links between pages to files that exist and headings that are there', () => {
    const ids = new Map<string, Set<string>>();
    for (const file of site.files.filter((one) => one.path.endsWith('.html'))) {
      ids.set(file.path, new Set([...file.content.toString().matchAll(/\bid="([^"]+)"/g)].map((match) => match[1] ?? '')));
    }
    const served = new Set(site.files.map((file) => file.path));
    let checked = 0;
    for (const file of site.files.filter((one) => one.path.endsWith('.html'))) {
      for (const match of file.content.toString().matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)) {
        const href = (match[1] ?? '').replace(/&amp;/g, '&');
        if (/^[a-z]+:/i.test(href)) continue;
        const [path = '', anchor] = href.split('#');
        const target = path === '' ? file.path : path;
        expect(served.has(target), `${file.path} → ${href}`).toBe(true);
        if (anchor !== undefined && target.endsWith('.html')) expect(ids.get(target)?.has(anchor), `${file.path} → ${href}`).toBe(true);
        checked += 1;
      }
    }
    // The navigation alone is fourteen links a page; a check that read none would pass.
    expect(checked).toBeGreaterThan(PAGES.length * PAGES.length);
  });

  it('writes llms.txt with every page, and llms-full.txt with every page that is not history', () => {
    const index = text(site, 'llms.txt');
    expect(index.startsWith('# Maverick Wall\n\n> ')).toBe(true);
    for (const page of PAGES) expect(index).toContain(`(${SITE_URL}${page.slug}.md): ${page.summary}`);
    expect(index).toMatch(/## Optional\n\n- \[Release notes\]/);
    const full = text(site, 'llms-full.txt');
    for (const page of PAGES.filter((one) => one.history !== true)) expect(full).toContain(`<!-- ${SITE_URL}${page.slug}.html -->`);
    expect(full).not.toContain(`${SITE_URL}release-notes.html`);
    // Relative links are made absolute, so a model reading one page can follow them.
    expect(full).not.toMatch(/\]\((?!https?:|mailto:|#)[^)]+\)/);
  });

  it('serves a page’s Markdown with its links made absolute', () => {
    const md = text(site, 'index.md');
    expect(md).toContain(`(${SITE_URL}install.md)`);
    expect(md).toContain(`(${SITE_URL}home-assistant.md)`);
    expect(md).toContain('(https://github.com/ambient-home-systems/MaverickWall/tree/main/examples/example-module)');
  });
});

describe('a fault in the docs stops the build, and says where', () => {
  it('a link to a file that is not there', () => {
    const site = repositoryWith((root) => edit(root, 'docs/install.md', (md) => `${md}\n[gone](gone.md)\n`));
    expect(site.problems).toEqual(['docs/install.md: links to gone.md, which is not there.']);
  });

  it('a link to a heading that is not there', () => {
    const site = repositoryWith((root) => edit(root, 'docs/install.md', (md) => `${md}\n[see](backup.md#no-such-heading)\n`));
    expect(site.problems).toEqual(['docs/install.md: links to backup.md#no-such-heading, and that page has no heading #no-such-heading.']);
  });

  it('a page under docs/ that is neither published nor kept off with a reason', () => {
    const site = repositoryWith((root) => writeFileSync(join(root, 'docs/new-guide.md'), '# A new guide\n'));
    expect(site.problems).toEqual([
      'docs/new-guide.md is neither published (apps/docs/src/pages.ts) nor listed in UNPUBLISHED with a reason.',
    ]);
  });

  it('an environment variable the server reads and the page does not document', () => {
    const site = repositoryWith((root) => edit(root, 'docs/environment.md', (md) => md.replace(/^\| `MDNS_NAME` .*\n/m, '')));
    expect(site.problems).toEqual([
      'docs/environment.md: the server reads MDNS_NAME (apps/server/src/main.ts), and the page does not document it.',
    ]);
  });

  it('an environment variable the page documents and nothing reads', () => {
    const site = repositoryWith((root) =>
      edit(root, 'docs/environment.md', (md) => md.replace('| `PORT` |', '| `RETIRED_SETTING` | — | Nothing. |\n| `PORT` |')),
    );
    expect(site.problems).toEqual(['docs/environment.md: documents RETIRED_SETTING, which nothing in apps/server/src reads.']);
  });

  it('a command-line tool in the image that the page does not document', () => {
    const site = repositoryWith((root) => edit(root, 'docs/command-line.md', (md) => md.replace('## `analyse-titles`', '## Analysing titles')));
    expect(site.problems).toEqual(['docs/command-line.md: apps/server/src/tools/analyse-titles.ts is not documented.']);
  });

  it('a screen the admin no longer has', () => {
    const site = repositoryWith((root) =>
      edit(root, 'docs/first-run.md', (md) => md.replace('**Walls → Add a wall → Add a browser wall.**', '**Screens → Add.**')),
    );
    expect(site.problems).toHaveLength(1);
    expect(site.problems[0]).toMatch(/^docs\/first-run\.md: “Screens → Add” starts at “Screens”, which is not one of the admin's destinations/);
  });

  it('a name the product retired', () => {
    const site = repositoryWith((root) => edit(root, 'docs/kiosk.md', (md) => `${md}\nAn eInk panel works too.\n`));
    expect(site.problems).toEqual(['docs/kiosk.md: says “eInk”, a name the product retired — e-paper.']);
  });

  it('but not in the release notes, which name each release’s screens as they were', () => {
    const site = repositoryWith((root) =>
      edit(root, 'addon/maverick-wall/CHANGELOG.md', (md) => md.replace('## Unreleased', '## Unreleased\n\nOn **Screens → Add**, an eInk panel.\n')),
    );
    expect(site.problems).toEqual([]);
  });
});

describe('the parts', () => {
  it('gives a heading GitHub’s own anchor, so a link written against the repository still lands', () => {
    const slug = slugger();
    expect(slug('Recipes — a module with no server')).toBe('recipes--a-module-with-no-server');
    expect(slug('`diagnose-source`')).toBe('diagnose-source');
    expect(slug("What's new in 0.68.0")).toBe('whats-new-in-0680');
    expect(slug('Install')).toBe('install');
    expect(slug('Install')).toBe('install-1');
  });

  it('draws a picture from another origin as its words, so nothing is fetched from elsewhere', () => {
    const out = renderMarkdown('[![Add it](https://example.com/badge.svg)](https://example.com/go)\n', (href) => href);
    expect(out.html).toContain('<a href="https://example.com/go" rel="noopener noreferrer"><span class="external-image">Add it</span></a>');
    expect(out.html).not.toContain('<img');
  });

  it('records the text of a heading and of bold, as read, and the destination of every link', () => {
    const out = renderMarkdown('# A `code` title\n\nSee **Walls → Add a wall** and [here](x.md#y "t").\n\n![p](a.png)\n', (href) => `/${href}`);
    expect(out.title).toBe('A code title');
    expect(out.headings).toEqual([{ depth: 1, text: 'A code title', id: 'a-code-title' }]);
    expect(out.strong).toEqual(['Walls → Add a wall']);
    expect(out.hrefs).toEqual(['x.md#y', 'a.png']);
    expect(out.html).toContain('<a href="/x.md#y" title="t">here</a>');
    expect(out.html).toContain('<img src="/a.png" alt="p" loading="lazy">');
  });

  it('labels each table cell with its column, for a narrow screen', () => {
    const out = renderMarkdown('| Name | What |\n|---|---|\n| `A` | one |\n', (href) => href);
    expect(out.html).toMatch(/<td data-label="Name"><code>A<\/code><\/td>\s*<td data-label="What">one<\/td>/);
  });

  it('rewrites links in Markdown and leaves code alone', () => {
    const md = 'A [link](a.md) and `[not](b.md)`.\n\n```\n[not](c.md)\n```\n\n![img](d.png "t")\n';
    expect(rewriteMarkdownLinks(md, (href) => `X/${href}`)).toBe(
      'A [link](X/a.md) and `[not](b.md)`.\n\n```\n[not](c.md)\n```\n\n![img](X/d.png "t")\n',
    );
  });

  it('reads a table of variables, several to a row, and a page of tools by their headings', () => {
    expect(environmentDocumented('| Variable |\n|---|\n| `A_B` | x |\n| `C`, `D_E` | y `F` |\n')).toEqual(['A_B', 'C', 'D_E']);
    expect(toolsDocumented('## `one`\n## Two\n## `three-four`\n### `five`\n')).toEqual(['one', 'three-four']);
  });

  it('reads the admin’s words from its strings, never its comments', () => {
    const words = adminWords(ROOT);
    // A label a household reads, and a sentence that is only ever a comment —
    // one naming a retired screen, which is exactly what must not count.
    const comment = 'Screens and Layout were two pages for one thing';
    expect(words).toContain('Approve a pairing code');
    expect(readFileSync(join(ROOT, 'apps/server/src/http/admin-walls.ts'), 'utf8')).toContain(comment);
    expect(words).not.toContain(comment);
  });

  it('holds every tool to a heading on the page and a script that runs it', () => {
    const root = mkdtempSync(join(tmpdir(), 'mw-docs-tools-'));
    roots.push(root);
    mkdirSync(join(root, 'apps/server/src/tools'), { recursive: true });
    for (const tool of ['one', 'two']) writeFileSync(join(root, `apps/server/src/tools/${tool}.ts`), '');
    writeFileSync(join(root, 'apps/server/package.json'), JSON.stringify({ scripts: { one: 'node dist/tools/one.js' } }));
    expect(checkTools(root, 'p', '## `one`\n## `two`\n## `three`\n')).toEqual([
      'apps/server/package.json: no script runs two, so `pnpm --filter @maverick-wall/server two` does nothing.',
      'p: documents three, and there is no apps/server/src/tools/three.ts.',
    ]);
  });

  it('checks a path through the admin step by step, and leaves another product’s alone', () => {
    const words = 'Add a wall\nAdd a browser wall';
    const labels = ['Walls', 'System'];
    expect(checkScreenNames('p', ['Walls → Add a wall', 'Settings → Security', 'Plain bold'], words, labels)).toEqual([]);
    expect(checkScreenNames('p', ['Walls → Pair a screen'], words, labels)).toEqual(['p: “Walls → Pair a screen” names “Pair a screen”, which no admin screen says.']);
    expect(checkScreenNames('p', ['Walls\n→ Add a wall.'], words, labels)).toEqual([]);
  });
});
