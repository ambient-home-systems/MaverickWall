import { Marked, type Tokens } from 'marked';

/**
 * One Markdown page rendered, with what the checks need recorded on the way
 * through rather than found again afterwards with a second, looser parse.
 *
 * Headings get GitHub's own anchor ids, so a link written against the
 * repository (`#recipes--a-module-with-no-server`) still lands on the site. A
 * link's destination is the caller's to decide, because only the site knows
 * which files are pages; this records each one it was asked about so a check
 * can say which do not resolve.
 */

export interface Heading {
  readonly depth: number;
  readonly text: string;
  readonly id: string;
}

export interface RenderedMarkdown {
  readonly html: string;
  /** The page's first top-level heading, or nothing. */
  readonly title: string | undefined;
  readonly headings: readonly Heading[];
  /** Every link and image destination, as written. */
  readonly hrefs: readonly string[];
  /** The text of every `**bold**` span, as read: no markup inside. */
  readonly strong: readonly string[];
}

/** Turns a destination as written into the one the site serves. */
export type Resolve = (href: string, kind: 'link' | 'image') => string;

/**
 * GitHub's slug: lower case, every character that is not a letter, a mark, a
 * number, a connector, a space or a hyphen removed, then each space a hyphen.
 * A repeat gets `-1`, `-2` and so on, as GitHub's does.
 */
export function slugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replace(/ /g, '-');
    const count = seen.get(base);
    seen.set(base, (count ?? 0) + 1);
    return count === undefined ? base : `${base}-${count}`;
  };
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };

/** Marked's text renderer hands back what it would have escaped; this undoes the five it escapes. */
function unescape(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_all, name: string) => ENTITIES[name] ?? '');
}

export function renderMarkdown(source: string, resolve: Resolve): RenderedMarkdown {
  const headings: Heading[] = [];
  const hrefs: string[] = [];
  const strong: string[] = [];
  const slug = slugger();
  let title: string | undefined;

  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }: Tokens.Heading): string {
        const html = this.parser.parseInline(tokens);
        const text = unescape(this.parser.parseInline(tokens, this.parser.textRenderer)).trim();
        const id = slug(text);
        headings.push({ depth, text, id });
        if (depth === 1 && title === undefined) title = text;
        return `<h${depth} id="${escapeHtml(id)}"><a class="anchor" href="#${escapeHtml(id)}" aria-hidden="true" tabindex="-1">#</a>${html}</h${depth}>\n`;
      },
      link({ href, title: linkTitle, tokens }: Tokens.Link): string {
        hrefs.push(href);
        const target = resolve(href, 'link');
        const external = /^[a-z]+:/i.test(target) && !target.startsWith('mailto:');
        const titleAttr = linkTitle ? ` title="${escapeHtml(linkTitle)}"` : '';
        const rel = external ? ' rel="noopener noreferrer"' : '';
        return `<a href="${escapeHtml(target)}"${titleAttr}${rel}>${this.parser.parseInline(tokens)}</a>`;
      },
      image({ href, title: imageTitle, text }: Tokens.Image): string {
        hrefs.push(href);
        const target = resolve(href, 'image');
        // A picture from another origin is drawn as its words, so the site
        // fetches nothing from anybody else (hard rule three's reasoning, on
        // the docs): Home Assistant's "add repository" badge becomes the link
        // it sits in, in text.
        if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(target)) return `<span class="external-image">${escapeHtml(text)}</span>`;
        const titleAttr = imageTitle ? ` title="${escapeHtml(imageTitle)}"` : '';
        return `<img src="${escapeHtml(target)}" alt="${escapeHtml(text)}"${titleAttr} loading="lazy">`;
      },
      strong({ tokens }: Tokens.Strong): string {
        strong.push(unescape(this.parser.parseInline(tokens, this.parser.textRenderer)));
        return `<strong>${this.parser.parseInline(tokens)}</strong>`;
      },
      table(token: Tokens.Table): string {
        // A wide table scrolls inside its own box rather than widening the page.
        const header = token.header.map((cell) => this.tablecell(cell)).join('');
        // Each cell carries its column's name, so a narrow screen can draw a
        // row as a card of labelled lines instead of a table wider than itself.
        const names = token.header.map((cell) => unescape(this.parser.parseInline(cell.tokens, this.parser.textRenderer)));
        const rows = token.rows
          .map(
            (row) =>
              `<tr>${row
                .map((cell, index) =>
                  this.tablecell(cell).replace(/^<td/, `<td data-label="${escapeHtml(names[index] ?? '')}"`),
                )
                .join('')}</tr>`,
          )
          .join('\n');
        return `<div class="table"><table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
      },
    },
  });

  const html = marked.parse(source, { async: false });
  return { html, title, headings, hrefs, strong };
}

/**
 * Rewrites the destinations of a page's Markdown links and images, leaving
 * fenced code and inline code alone: the `.md` copies the site serves and
 * `llms-full.txt` carry absolute addresses, because a model reading one page
 * has no repository to resolve a relative one against.
 */
export function rewriteMarkdownLinks(source: string, rewrite: (href: string) => string): string {
  const lines = source.split('\n');
  let fence: string | undefined;
  return lines
    .map((line) => {
      const opener = /^\s*(`{3,}|~{3,})/.exec(line);
      if (opener !== null) {
        const mark = opener[1] ?? '';
        if (fence === undefined) fence = mark[0];
        else if (mark[0] === fence) fence = undefined;
        return line;
      }
      if (fence !== undefined) return line;
      // Split on inline code so a `](x)` inside backticks is not a link.
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, index) =>
          index % 2 === 1
            ? part
            : part.replace(/(\]\()(<[^>]*>|[^)\s]+)((?:\s+"[^"]*")?\))/g, (_all, open: string, href: string, close: string) => {
                const bare = href.startsWith('<') ? href.slice(1, -1) : href;
                return `${open}${rewrite(bare)}${close}`;
              }),
        )
        .join('');
    })
    .join('\n');
}
