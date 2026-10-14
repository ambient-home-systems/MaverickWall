import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * The docs checked against the code (plan item M9.1).
 *
 * Each check here reads a fact out of the source — what the server reads from
 * its environment, which command-line tools exist, which words its screens
 * use — and reads the same fact out of the page that documents it. A page that
 * disagrees is a build failure, because a page about a tool nobody can run or
 * a screen that was renamed is worse than no page: it is followed.
 *
 * What these cannot see is stated rather than implied: the prose. A sentence
 * that says a thing works one way while the code does another is beyond a
 * check, which is why the site says it is built from the repository rather
 * than that it is correct.
 */

export type Problem = string;

function walk(dir: string, accept: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path, accept));
    else if (accept(path)) out.push(path);
  }
  return out.sort();
}

const isSource = (path: string): boolean => path.endsWith('.ts') && !path.endsWith('.d.ts');

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

/**
 * Every environment variable the server reads, by name. The three spellings
 * the source uses: `process.env.X`, `env?.['X']` and `env('X', …)`, the boot
 * file's own helper.
 */
export function environmentRead(root: string): Map<string, string[]> {
  const read = new Map<string, string[]>();
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /env(?:\?\.)?\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
    /\benv\(['"]([A-Z][A-Z0-9_]*)['"]/g,
  ];
  for (const file of walk(join(root, 'apps/server/src'), isSource)) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const name = match[1] ?? '';
        const files = read.get(name) ?? [];
        const at = relative(root, file);
        if (!files.includes(at)) files.push(at);
        read.set(name, files);
      }
    }
  }
  return read;
}

/** Documented, and read by something other than this code. */
export const READ_ELSEWHERE: Readonly<Record<string, string>> = {
  NODE_OPTIONS: 'read by Node itself, before any of this code runs',
};

/** The names in the first column of the page's table, in backticks. */
export function environmentDocumented(markdown: string): string[] {
  const names: string[] = [];
  for (const line of markdown.split('\n')) {
    // A row may document several that behave alike: `A`, `B` in one cell.
    const cell = /^\|([^|]*)\|/.exec(line)?.[1] ?? '';
    for (const match of cell.matchAll(/`([A-Z][A-Z0-9_]*)`/g)) if (match[1] !== undefined) names.push(match[1]);
  }
  return names;
}

export function checkEnvironment(root: string, page: string, markdown: string): Problem[] {
  const read = environmentRead(root);
  const documented = new Set(environmentDocumented(markdown));
  const problems: Problem[] = [];
  for (const [name, files] of read) {
    if (!documented.has(name)) problems.push(`${page}: the server reads ${name} (${files.join(', ')}), and the page does not document it.`);
  }
  for (const name of documented) {
    if (!read.has(name) && READ_ELSEWHERE[name] === undefined) {
      problems.push(`${page}: documents ${name}, which nothing in apps/server/src reads.`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Command-line tools
// ---------------------------------------------------------------------------

export function toolsShipped(root: string): string[] {
  return readdirSync(join(root, 'apps/server/src/tools'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => name.slice(0, -3))
    .sort();
}

/** The tools a page documents: each is a `## \`name\`` heading. */
export function toolsDocumented(markdown: string): string[] {
  const names: string[] = [];
  for (const line of markdown.split('\n')) {
    const match = /^##\s+`([a-z][a-z0-9-]*)`\s*$/.exec(line);
    if (match?.[1] !== undefined) names.push(match[1]);
  }
  return names;
}

export function checkTools(root: string, page: string, markdown: string): Problem[] {
  const shipped = toolsShipped(root);
  const documented = toolsDocumented(markdown);
  const scripts = (JSON.parse(readFileSync(join(root, 'apps/server/package.json'), 'utf8')) as { scripts?: Record<string, string> })
    .scripts ?? {};
  const problems: Problem[] = [];
  for (const tool of shipped) {
    if (!documented.includes(tool)) problems.push(`${page}: apps/server/src/tools/${tool}.ts is not documented.`);
    if (!Object.values(scripts).includes(`node dist/tools/${tool}.js`)) {
      problems.push(`apps/server/package.json: no script runs ${tool}, so \`pnpm --filter @maverick-wall/server ${tool}\` does nothing.`);
    }
  }
  for (const tool of documented) {
    if (!shipped.includes(tool)) problems.push(`${page}: documents ${tool}, and there is no apps/server/src/tools/${tool}.ts.`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The companion API
// ---------------------------------------------------------------------------

/** Every route the companion API answers, read from where it is registered. */
export function companionRoutes(root: string): string[] {
  const source = readFileSync(join(root, 'apps/server/src/http/companion.ts'), 'utf8');
  return [...source.matchAll(/app\.post\('(\/companion\/[a-z/-]+)'/g)].map((match) => match[1] ?? '').sort();
}

/** The requests a page shows: each ```http block's `POST /companion/…` line. */
export function companionDocumented(markdown: string): string[] {
  const paths = new Set<string>();
  for (const block of markdown.matchAll(/```http\n([\s\S]*?)```/g)) {
    const request = /^POST (\/companion\/[a-z/-]+)$/m.exec(block[1] ?? '');
    if (request?.[1] !== undefined) paths.add(request[1]);
  }
  return [...paths].sort();
}

/**
 * The page of recipes shows a request for every route, and no route the
 * server does not answer. A recipe is copied into a phone and forgotten, so a
 * route that is renamed or a new one nobody wrote down is found by a shortcut
 * that stops working, months later.
 */
export function checkCompanion(root: string, page: string, markdown: string): Problem[] {
  const routes = companionRoutes(root);
  const documented = companionDocumented(markdown);
  const problems: Problem[] = [];
  for (const route of routes) {
    if (!documented.includes(route)) problems.push(`${page}: POST ${route} is not shown.`);
  }
  for (const path of documented) {
    if (!routes.includes(path)) problems.push(`${page}: shows POST ${path}, which the server does not answer.`);
  }
  return problems;
}

/** Any page that names a companion address names one the server answers. */
export function checkCompanionMentions(root: string, page: string, markdown: string): Problem[] {
  const routes = companionRoutes(root);
  const problems: Problem[] = [];
  for (const match of markdown.matchAll(/\/companion\/[a-z][a-z/-]*[a-z]/g)) {
    if (!routes.includes(match[0])) problems.push(`${page}: names ${match[0]}, which the server does not answer.`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The names of screens
// ---------------------------------------------------------------------------

/**
 * The words the admin draws: every string and template literal in its source,
 * and in the editor's, which draws its own. Literals only, never comments, so
 * a name retired from the screens and left in a comment explaining why does
 * not count as still being there.
 */
export function adminWords(root: string): string {
  const files = [
    ...walk(join(root, 'apps/server/src/http'), isSource),
    ...walk(join(root, 'apps/display/src'), isSource),
  ];
  const parts: string[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) parts.push(node.text);
      else if (ts.isTemplateExpression(node)) {
        parts.push(node.head.text);
        for (const span of node.templateSpans) parts.push(span.literal.text);
      }
      node.forEachChild(visit);
    };
    visit(source);
  }
  return parts.join('\n');
}

/** The admin's top-level destinations: what a path in the docs starts from. */
export function navLabels(root: string): string[] {
  const html = readFileSync(join(root, 'apps/server/src/http/html.ts'), 'utf8');
  const labels = new Set<string>();
  for (const match of html.matchAll(/\{\s*key:\s*'[a-z-]+',\s*label:\s*'([^']+)',\s*href:\s*'admin/g)) {
    if (match[1] !== undefined) labels.add(match[1]);
  }
  return [...labels];
}

/**
 * Where a path written in bold with arrows starts somewhere other than this
 * app: another product's settings, which the docs walk a household through.
 * A path whose first step is neither one of these nor one of the admin's own
 * destinations names a screen that does not exist — usually one that did.
 */
export const OTHER_PRODUCTS: readonly string[] = [
  'Settings', // Google Calendar, Nextcloud and Home Assistant all start here.
  'Developer options', // Android's, on a kiosk tablet.
];

/** A step a screen draws inside a page rather than as a label: a section of Wall settings, say. */
export const PAGE_PARTS: readonly string[] = ['Wall settings'];

export function checkScreenNames(page: string, strong: readonly string[], words: string, labels: readonly string[]): Problem[] {
  const problems: Problem[] = [];
  for (const span of strong) {
    if (!/[→›]/.test(span)) continue;
    const path = span.replace(/\s+/g, ' ').trim().replace(/[.:]$/, '');
    const steps = path.split(/\s*[→›]\s*/).map((step) => step.replace(/[.:]$/, '').trim());
    const first = steps[0] ?? '';
    if (OTHER_PRODUCTS.includes(first)) continue;
    if (!labels.includes(first) && !PAGE_PARTS.includes(first)) {
      problems.push(`${page}: “${path}” starts at “${first}”, which is not one of the admin's destinations (${labels.join(', ')}).`);
      continue;
    }
    for (const step of steps.slice(1)) {
      if (!words.includes(step)) problems.push(`${page}: “${path}” names “${step}”, which no admin screen says.`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Retired words
// ---------------------------------------------------------------------------

/**
 * Names the product has retired, which a page must not teach. The admin's own
 * vocabulary test holds its screens to the same list.
 */
export const RETIRED: readonly { readonly word: RegExp; readonly instead: string }[] = [
  { word: /\bDefault wall\b/, instead: 'each wall has its own settings; the shared ones are on System' },
  { word: /\beInk\b/, instead: 'e-paper' },
  { word: /\bKitchen Slate\b|\bGlance\b theme/, instead: 'one of the five themes on Themes' },
  { word: /\*\*Screens\*\*/, instead: 'walls are on **Walls**' },
  { word: /\*\*Shifts\*\*/, instead: 'the rota is on **Work Schedule**' },
  { word: /\*\*Weather alerts\*\*/, instead: 'alerts are on **Weather**' },
];

export function checkRetired(page: string, markdown: string): Problem[] {
  const problems: Problem[] = [];
  const prose = markdown.replace(/```[\s\S]*?```/g, '');
  for (const { word, instead } of RETIRED) {
    const match = word.exec(prose);
    if (match !== null) problems.push(`${page}: says “${match[0]}”, a name the product retired — ${instead}.`);
  }
  return problems;
}
