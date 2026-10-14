import { escapeHtml, type Heading } from './markdown.js';
import { REPOSITORY_URL, SECTIONS, type Page } from './pages.js';

/**
 * The page around the content, and its stylesheet.
 *
 * The site follows the product's own rule three: every file it draws is
 * served beside it — one stylesheet, the admin's own Roboto, the mark — and
 * nothing is fetched from anywhere else, so the docs read the same on a
 * network that blocks a CDN. There is no script at all. The colours are the
 * admin's own two schemes (`apps/server/src/http/design-tokens.ts`), whose
 * pairs are already measured against each other, so the docs and the screens
 * they describe look like one product.
 */

export interface LayoutInput {
  readonly page: Page;
  readonly title: string;
  readonly content: string;
  readonly headings: readonly Heading[];
  readonly previous: Page | undefined;
  readonly next: Page | undefined;
}

function navList(current: Page): string {
  return SECTIONS.map(
    (section) =>
      `<p class="nav-head">${escapeHtml(section.title)}</p><ul>${section.pages
        .map(
          (page) =>
            `<li><a href="${page.slug}.html"${page.slug === current.slug ? ' aria-current="page"' : ''}>${escapeHtml(page.label)}</a></li>`,
        )
        .join('')}</ul>`,
  ).join('');
}

/** A table of contents, for a page long enough to want one. */
function contents(headings: readonly Heading[]): string {
  const twos = headings.filter((heading) => heading.depth === 2);
  if (twos.length < 4) return '';
  // A long record (the release notes) lists its newest entries, not all of them.
  const shown = twos.slice(0, 16);
  return `<nav class="toc" aria-label="On this page"><p class="nav-head">On this page</p><ul>${shown
    .map((heading) => `<li><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></li>`)
    .join('')}</ul></nav>`;
}

/** The content with the contents placed straight after its title. */
function withContents(content: string, headings: readonly Heading[]): string {
  const toc = contents(headings);
  if (toc === '') return content;
  const end = content.indexOf('</h1>');
  return end === -1 ? toc + content : content.slice(0, end + 5) + toc + content.slice(end + 5);
}

export function layout(input: LayoutInput): string {
  const { page, title, previous, next } = input;
  const nav = navList(page);
  const pager = [
    previous === undefined
      ? '<span></span>'
      : `<a class="prev" href="${previous.slug}.html"><span>Previous</span>${escapeHtml(previous.label)}</a>`,
    next === undefined ? '<span></span>' : `<a class="next" href="${next.slug}.html"><span>Next</span>${escapeHtml(next.label)}</a>`,
  ].join('');
  const fullTitle = page.slug === 'index' ? 'Maverick Wall docs' : `${title} · Maverick Wall docs`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(fullTitle)}</title>
<meta name="description" content="${escapeHtml(page.summary)}">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="style.css">
<link rel="alternate" type="text/markdown" href="${page.slug}.md">
</head>
<body>
<a class="skip" href="#content">Skip to the page</a>
<header class="bar">
<a class="brand" href="index.html"><img src="favicon.svg" alt="" width="28" height="28"><span>Maverick Wall</span><span class="brand-docs">docs</span></a>
<a class="bar-link" href="${REPOSITORY_URL}" rel="noopener noreferrer">GitHub</a>
</header>
<details class="nav-compact"><summary>Pages</summary><nav aria-label="Pages">${nav}</nav></details>
<div class="frame">
<nav class="nav" aria-label="Pages">${nav}</nav>
<main id="content" tabindex="-1">
<article>
${withContents(input.content, input.headings)}
</article>
<p class="edit"><a href="${REPOSITORY_URL}/blob/main/${page.source}" rel="noopener noreferrer">Edit this page on GitHub</a></p>
<nav class="pager" aria-label="Previous and next">${pager}</nav>
</main>
</div>
<footer class="foot"><p>Maverick Wall is free software under the AGPL-3.0. These pages are built from the Markdown in <a href="${REPOSITORY_URL}/tree/main/docs" rel="noopener noreferrer">the repository</a>, and checked against its code on every change. For language models: <a href="llms.txt">llms.txt</a>.</p></footer>
</body>
</html>
`;
}

export const STYLE = `@font-face{font-family:'Roboto';src:url(fonts/roboto.woff2) format('woff2');font-weight:100 900;font-display:swap}
:root{color-scheme:light dark;--bg:#F7F6F4;--surface:#FFFFFF;--ink:#1A1C1F;--muted:#62676D;--line:#E2DFDA;--line-strong:#CBC7C1;--accent:#8C5C0C;--accent-soft:#EFE8DD;--accent-soft-ink:#6B4608;--code:#F1EFEC;--measure:46rem;--font:'Roboto',system-ui,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#14161A;--surface:#1A1D22;--ink:#E9EBEE;--muted:#8E97A3;--line:#2E333A;--line-strong:#3D444D;--accent:#E8A33D;--accent-soft:#3B3226;--accent-soft-ink:#F3C079;--code:#22262C}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:400 1.0625rem/1.6 var(--font);font-variant-numeric:tabular-nums}
a{color:var(--accent);text-underline-offset:.18em}
a:hover{text-decoration-thickness:2px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:2px}
.skip{position:absolute;left:1rem;top:-3rem;background:var(--surface);padding:.5rem .75rem;border:1px solid var(--line-strong);border-radius:6px;z-index:2}
.skip:focus{top:.75rem}
.bar{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.75rem 1.25rem;border-bottom:1px solid var(--line);background:var(--surface);position:sticky;top:0;z-index:1}
.brand{display:flex;align-items:center;gap:.6rem;color:var(--ink);text-decoration:none;font-weight:650;letter-spacing:-.01em}
.brand-docs{color:var(--muted);font-weight:400}
.bar-link{color:var(--muted);text-decoration:none}
.bar-link:hover{color:var(--ink)}
.frame{display:grid;grid-template-columns:15rem minmax(0,1fr);gap:3rem;max-width:72rem;margin:0 auto;padding:2rem 1.25rem 3rem}
.nav{position:sticky;top:5rem;align-self:start;max-height:calc(100vh - 6rem);overflow:auto;font-size:.9375rem}
.nav ul,.toc ul{list-style:none;margin:0 0 1.25rem;padding:0}
.nav li a{display:block;padding:.3rem .6rem;border-left:2px solid transparent;color:var(--ink);text-decoration:none}
.nav li a:hover{border-left-color:var(--line-strong)}
.nav li a[aria-current="page"]{border-left-color:var(--accent);color:var(--accent);font-weight:600}
.nav-head{margin:0 0 .35rem;padding-left:.6rem;color:var(--muted);font-size:.75rem;font-weight:650;letter-spacing:.06em;text-transform:uppercase}
.nav-compact{display:none;margin:0;border-bottom:1px solid var(--line);background:var(--surface)}
.nav-compact summary{padding:.75rem 1.25rem;cursor:pointer;font-weight:600}
.nav-compact nav{padding:0 1.25rem 1rem}
.nav-compact .nav-head{padding-left:0}
.nav-compact li a{display:block;padding:.45rem 0;color:var(--ink);text-decoration:none}
.nav-compact li a[aria-current="page"]{color:var(--accent);font-weight:600}
main{min-width:0;outline:none}
article{max-width:var(--measure)}
h1,h2,h3,h4{line-height:1.25;letter-spacing:-.015em;font-weight:650;position:relative}
h1{font-size:2.25rem;margin:0 0 1.25rem;letter-spacing:-.025em}
h2{font-size:1.5rem;margin:2.75rem 0 .75rem;padding-top:1.25rem;border-top:1px solid var(--line)}
h3{font-size:1.1875rem;margin:2rem 0 .5rem}
h4{font-size:1rem;margin:1.5rem 0 .5rem}
.anchor{position:absolute;left:-1.1em;padding-right:.3em;color:var(--muted);text-decoration:none;opacity:0}
h1:hover .anchor,h2:hover .anchor,h3:hover .anchor,h4:hover .anchor,.anchor:focus{opacity:1}
p,ul,ol,blockquote,pre,.table{margin:0 0 1rem}
li+li{margin-top:.25rem}
blockquote{margin-left:0;margin-right:0;padding:.75rem 1rem;border:1px solid var(--line);background:var(--accent-soft);color:var(--accent-soft-ink);border-radius:6px}
blockquote p:last-child{margin-bottom:0}
code{font-family:var(--mono);font-size:.875em;background:var(--code);padding:.1em .35em;border-radius:4px;overflow-wrap:anywhere}
pre{background:var(--code);padding:1rem;border-radius:6px;overflow:auto;line-height:1.5}
pre code{background:none;padding:0;font-size:.875rem;overflow-wrap:normal}
td code,th code{overflow-wrap:normal;word-break:normal}
td:first-child code{white-space:nowrap}
.table{overflow-x:auto;border:1px solid var(--line);border-radius:6px}
table{border-collapse:collapse;width:100%;font-size:.9375rem}
th,td{text-align:left;vertical-align:top;padding:.55rem .75rem;border-bottom:1px solid var(--line)}
tr:last-child td{border-bottom:0}
th{background:var(--surface);font-weight:650}
img{max-width:100%;height:auto;border-radius:6px}
.external-image{display:inline-block;padding:.35rem .75rem;border:1px solid var(--line-strong);border-radius:6px;font-weight:600}
hr{border:0;border-top:1px solid var(--line);margin:2rem 0}
.toc{margin:0 0 2rem;padding:1rem 1.25rem;border:1px solid var(--line);border-radius:6px;background:var(--surface);font-size:.9375rem}
.toc .nav-head{padding-left:0}
.toc ul{margin:0;columns:2;column-gap:2rem}
.toc li{break-inside:avoid}
.edit{margin:3rem 0 1rem;font-size:.9375rem}
.pager{display:grid;grid-template-columns:1fr 1fr;gap:1rem;max-width:var(--measure)}
.pager a{display:block;padding:.85rem 1rem;border:1px solid var(--line);border-radius:6px;text-decoration:none;color:var(--ink);background:var(--surface)}
.pager a:hover{border-color:var(--line-strong)}
.pager span{display:block;color:var(--muted);font-size:.8125rem}
.pager .next{text-align:right}
.foot{border-top:1px solid var(--line);padding:1.5rem 1.25rem;color:var(--muted);font-size:.875rem}
.foot p{max-width:72rem;margin:0 auto}
@media (max-width:640px){.table{border:0;overflow:visible}.table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.table table,.table tbody,.table tr,.table td{display:block}.table tr{border:1px solid var(--line);border-radius:6px;margin-bottom:.75rem;padding:.25rem 0}.table td{border:0;padding:.35rem .75rem}.table td::before{content:attr(data-label);display:block;color:var(--muted);font-size:.75rem;font-weight:650;letter-spacing:.04em;text-transform:uppercase}.table td[data-label=""]::before{content:none}td:first-child code{white-space:normal}}
@media (max-width:900px){.frame{grid-template-columns:minmax(0,1fr);padding-top:1.5rem}.nav{display:none}.nav-compact{display:block}h1{font-size:1.875rem}.toc ul{columns:1}.anchor{display:none}}
`;
