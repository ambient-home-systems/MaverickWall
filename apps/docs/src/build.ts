import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import {
  adminWords,
  checkCompanion,
  checkCompanionMentions,
  checkEnvironment,
  checkRetired,
  checkScreenNames,
  checkTools,
  navLabels,
  type Problem,
} from './checks.js';
import { layout, STYLE } from './layout.js';
import { renderMarkdown, rewriteMarkdownLinks, type Heading } from './markdown.js';
import { isUnpublishedByRule, PAGES, REPOSITORY_URL, SECTIONS, SITE_URL, UNPUBLISHED, type Page } from './pages.js';

/**
 * The docs site, built (plan item M9.1).
 *
 * Pure apart from reading the repository: it hands back every file the site
 * serves and every problem it found, and the caller decides whether to write
 * them. The command refuses to write a site with a problem in it, so what is
 * published is always a site that passed.
 */

export interface SiteFile {
  readonly path: string;
  readonly content: string | Buffer;
}

export interface BuiltSite {
  readonly files: readonly SiteFile[];
  readonly problems: readonly Problem[];
}

/** Where a destination written in a page points. */
type Target =
  | { readonly kind: 'external' }
  | { readonly kind: 'page'; readonly slug: string; readonly anchor: string | undefined }
  | { readonly kind: 'repository'; readonly path: string; readonly directory: boolean; readonly anchor: string | undefined }
  | { readonly kind: 'missing'; readonly path: string };

function splitAnchor(href: string): { path: string; anchor: string | undefined } {
  const hash = href.indexOf('#');
  return hash === -1 ? { path: href, anchor: undefined } : { path: href.slice(0, hash), anchor: href.slice(hash + 1) };
}

/** The repository path a relative destination in `source` names, or `undefined` if it climbs out. */
function repositoryPath(source: string, path: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    decoded = path;
  }
  const joined = posix.normalize(posix.join(posix.dirname(source), decoded));
  if (joined === '..' || joined.startsWith('../') || posix.isAbsolute(joined)) return undefined;
  return joined.replace(/\/$/, '') || '.';
}

function classify(root: string, source: string, href: string, bySource: ReadonlyMap<string, Page>): Target {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return { kind: 'external' };
  const { path, anchor } = splitAnchor(href);
  if (path === '') {
    const page = bySource.get(source);
    return page === undefined ? { kind: 'missing', path: source } : { kind: 'page', slug: page.slug, anchor };
  }
  const repoPath = repositoryPath(source, path);
  if (repoPath === undefined) return { kind: 'missing', path };
  const page = bySource.get(repoPath);
  if (page !== undefined) return { kind: 'page', slug: page.slug, anchor };
  const onDisk = join(root, repoPath);
  if (!existsSync(onDisk)) return { kind: 'missing', path: repoPath };
  return { kind: 'repository', path: repoPath, directory: statSync(onDisk).isDirectory(), anchor };
}

function repositoryUrl(path: string, directory: boolean, anchor: string | undefined): string {
  return `${REPOSITORY_URL}/${directory ? 'tree' : 'blob'}/main/${path}${anchor === undefined ? '' : `#${anchor}`}`;
}

/** An image's name on the site: its repository path, flattened. */
function imageName(path: string): string {
  return `images/${path.replace(/\//g, '--')}`;
}

/** Every Markdown file directly under `docs/`, which is what the coverage check reads. */
function docsFiles(root: string): string[] {
  return readdirSync(join(root, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`)
    .sort();
}

export function checkCoverage(root: string): Problem[] {
  const published = new Set(PAGES.map((page) => page.source));
  const problems: Problem[] = [];
  for (const file of docsFiles(root)) {
    if (!published.has(file) && UNPUBLISHED[file] === undefined && !isUnpublishedByRule(file)) {
      problems.push(`${file} is neither published (apps/docs/src/pages.ts) nor listed in UNPUBLISHED with a reason.`);
    }
  }
  for (const file of Object.keys(UNPUBLISHED)) {
    if (!existsSync(join(root, file))) problems.push(`apps/docs/src/pages.ts: UNPUBLISHED names ${file}, which does not exist.`);
  }
  for (const page of PAGES) {
    if (!existsSync(join(root, page.source))) problems.push(`apps/docs/src/pages.ts: ${page.slug} is built from ${page.source}, which does not exist.`);
  }
  const slugs = PAGES.map((page) => page.slug);
  for (const slug of new Set(slugs)) {
    if (slugs.filter((other) => other === slug).length > 1) problems.push(`apps/docs/src/pages.ts: two pages are called ${slug}.`);
  }
  return problems;
}

export function buildSite(root: string): BuiltSite {
  const problems: Problem[] = [...checkCoverage(root)];
  const files: SiteFile[] = [];
  const bySource = new Map(PAGES.filter((page) => existsSync(join(root, page.source))).map((page) => [page.source, page]));
  const words = adminWords(root);
  const labels = navLabels(root);

  interface Rendered {
    readonly page: Page;
    readonly markdown: string;
    readonly title: string;
    readonly html: string;
    readonly headings: readonly Heading[];
    readonly links: readonly { readonly href: string; readonly target: Target }[];
  }
  const rendered: Rendered[] = [];
  const images = new Map<string, string>();

  for (const page of bySource.values()) {
    const markdown = readFileSync(join(root, page.source), 'utf8');
    const links: { href: string; target: Target }[] = [];
    const result = renderMarkdown(markdown, (href, kind) => {
      const target = classify(root, page.source, href, bySource);
      links.push({ href, target });
      switch (target.kind) {
        case 'external':
          return href;
        case 'missing':
          return href;
        case 'page':
          return `${target.slug === page.slug && splitAnchor(href).path === '' ? '' : `${target.slug}.html`}${
            target.anchor === undefined ? '' : `#${target.anchor}`
          }`;
        case 'repository':
          if (kind === 'image' && !target.directory) {
            images.set(target.path, imageName(target.path));
            return imageName(target.path);
          }
          return repositoryUrl(target.path, target.directory, target.anchor);
      }
    });
    if (result.title === undefined) problems.push(`${page.source}: has no top-level heading to be its title.`);
    if (page.history !== true) {
      problems.push(...checkScreenNames(page.source, result.strong, words, labels));
      problems.push(...checkRetired(page.source, markdown));
    }
    if (page.slug === 'environment') problems.push(...checkEnvironment(root, page.source, markdown));
    if (page.slug === 'command-line') problems.push(...checkTools(root, page.source, markdown));
    if (page.slug === 'phone-and-automations') problems.push(...checkCompanion(root, page.source, markdown));
    if (page.history !== true) problems.push(...checkCompanionMentions(root, page.source, markdown));
    rendered.push({ page, markdown, title: result.title ?? page.label, html: result.html, headings: result.headings, links });
  }

  // Links are checked once every page is rendered, so an anchor on a later page is known.
  const anchors = new Map(rendered.map((one) => [one.page.slug, new Set(one.headings.map((heading) => heading.id))]));
  for (const one of rendered) {
    for (const { href, target } of one.links) {
      if (target.kind === 'missing') problems.push(`${one.page.source}: links to ${href}, which is not there.`);
      if (target.kind === 'page' && target.anchor !== undefined && anchors.get(target.slug)?.has(target.anchor) !== true) {
        problems.push(`${one.page.source}: links to ${href}, and that page has no heading #${target.anchor}.`);
      }
    }
  }

  const ordered = rendered.slice().sort((a, b) => PAGES.indexOf(a.page) - PAGES.indexOf(b.page));
  ordered.forEach((one, index) => {
    files.push({
      path: `${one.page.slug}.html`,
      content: layout({
        page: one.page,
        title: one.title,
        content: one.html,
        headings: one.headings,
        previous: ordered[index - 1]?.page,
        next: ordered[index + 1]?.page,
      }),
    });
    files.push({ path: `${one.page.slug}.md`, content: absoluteMarkdown(root, one.page, one.markdown, bySource) });
  });

  for (const [path, name] of images) files.push({ path: name, content: readFileSync(join(root, path)) });
  files.push({ path: 'style.css', content: STYLE });
  files.push({ path: 'favicon.svg', content: readFileSync(join(root, 'docs/brand/marks/lit-cell-small.svg')) });
  files.push({ path: 'fonts/roboto.woff2', content: readFileSync(join(root, 'apps/server/assets/fonts/roboto.woff2')) });
  files.push({ path: 'fonts/LICENSES.md', content: readFileSync(join(root, 'apps/server/assets/fonts/LICENSES.md')) });
  files.push({ path: 'llms.txt', content: llmsIndex() });
  files.push({
    path: 'llms-full.txt',
    content: llmsFull(
      root,
      ordered.filter((one) => one.page.history !== true).map((one) => ({ page: one.page, markdown: one.markdown })),
      bySource,
    ),
  });

  return { files, problems };
}

/** A page's Markdown with every relative destination made absolute. */
function absoluteMarkdown(root: string, page: Page, markdown: string, bySource: ReadonlyMap<string, Page>): string {
  return rewriteMarkdownLinks(markdown, (href) => {
    const target = classify(root, page.source, href, bySource);
    switch (target.kind) {
      case 'external':
      case 'missing':
        return href;
      case 'page':
        return `${SITE_URL}${target.slug}.md${target.anchor === undefined ? '' : `#${target.anchor}`}`;
      case 'repository':
        return repositoryUrl(target.path, target.directory, target.anchor);
    }
  });
}

/** `llms.txt`, as llmstxt.org describes it: a title, a summary, and the pages by section. */
export function llmsIndex(): string {
  const line = (page: Page): string => `- [${page.label}](${SITE_URL}${page.slug}.md): ${page.summary}`;
  const sections = SECTIONS.map((section) => ({ ...section, pages: section.pages.filter((page) => page.history !== true) }))
    .filter((section) => section.pages.length > 0)
    .map((section) => `## ${section.title}\n\n${section.pages.map(line).join('\n')}`);
  const optional = PAGES.filter((page) => page.history === true);
  if (optional.length > 0) sections.push(`## Optional\n\n${optional.map(line).join('\n')}`);
  return `# Maverick Wall

> A self-hosted family calendar for a wall display. One household runs one container on their own hardware; tablets, televisions and e-paper panels point at it and run unattended for months.

These pages are the Markdown in ${REPOSITORY_URL}, published, and checked against the code on every change. Every page is also served as Markdown at the same name with \`.md\`, and all of them together are ${SITE_URL}llms-full.txt.

Facts a model should not get wrong:

- There is no cloud version. Each household runs its own container (Docker, or the Home Assistant add-on).
- A wall is given handles and resolved values, never a Home Assistant entity id, an address or a token.
- Modules are data, never code: a recipe is declarative, and a service module answers JSON over HTTP.

${sections.join('\n\n')}
`;
}

function llmsFull(root: string, pages: readonly { page: Page; markdown: string }[], bySource: ReadonlyMap<string, Page>): string {
  return pages
    .map(({ page, markdown }) => `<!-- ${SITE_URL}${page.slug}.html -->\n\n${absoluteMarkdown(root, page, markdown, bySource).trim()}\n`)
    .join('\n---\n\n');
}

/** The repository root, from this file's place in `apps/docs/dist`. */
export function repositoryRoot(from: string): string {
  return join(dirname(from), '..', '..', '..');
}
