import type { Context, Hono } from 'hono';

import {
  MAX_NEWS_FEEDS,
  addNewsFeed,
  newsFeedBody,
  newsFeedHost,
  readNewsFeeds,
  removeNewsFeed,
  type NewsFeedRow,
} from '../modules/news/index.js';
import { parse } from '../validation.js';
import { confirmDestroyPage, errorBlock, escapeHtml, icon, networkAccessLabel, page, switchRow, textField } from './html.js';
import { card, destructive, emptyState, tag } from './components.js';
import { readSaved, savedRedirect } from './saved.js';
import { navModules, type AdminDeps } from './admin.js';
import { selfHref } from './self.js';

/**
 * News feeds, in the admin (plan item M5.5).
 *
 * The only place a feed's address is typed. It is read before it is stored, so
 * the strip says "Feed added" only of a feed that read and a refusal comes back
 * on the add page with what was typed and why. Then it is sealed and only its
 * host is shown again: a private feed's address is its credential, as a
 * calendar's is. Each card says when the feed last read and, if the last try
 * failed, why — while the wall goes on showing the headlines it had.
 */
export function registerNewsRoutes(app: Hono, deps: AdminDeps): void {
  const now = deps.now ?? ((): number => Date.now());

  app.get('/admin/news', (c: Context) => c.html(newsPage(c)));
  app.get('/admin/news/new', (c: Context) => c.html(newFeedPage(c)));

  app.post('/admin/news', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = parse(newsFeedBody, body);
    if (!shaped.ok) return c.html(newFeedPage(c, shaped.message, body), 400);
    if (readNewsFeeds(deps.db).length >= MAX_NEWS_FEEDS) {
      return c.html(newFeedPage(c, `There are already ${MAX_NEWS_FEEDS} feeds. Remove one to add another.`, body), 400);
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(shaped.value.url);
    } catch {
      return c.html(newFeedPage(c, 'That is not an address. Paste the whole thing, starting https://.', body), 400);
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      return c.html(newFeedPage(c, 'A feed is read from an http or https address.', body), 400);
    }
    const added = await addNewsFeed(
      { db: deps.db, keyring: deps.keyring, fetcher: deps.fetcher, now: now() },
      {
        url: shaped.value.url,
        name: shaped.value.name,
        allowLan: shaped.value.allow_lan === true,
        allowHttp: shaped.value.allow_http === true,
      },
    );
    if (!added.ok) {
      // An address that needs a switch is told which, in the form's own words.
      const reason =
        added.switches === undefined
          ? added.reason
          : `That address needs ${added.switches.map((option) => `“${networkAccessLabel(option)}”`).join(' and ')} ` +
            'turned on below to be read.';
      return c.html(newFeedPage(c, reason, body), 400);
    }
    return savedRedirect(c, '/admin/news', 'news-feed-added');
  });

  app.get('/admin/news/:id/remove', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const feed = readNewsFeeds(deps.db).find((row) => row.id === id);
    if (feed === undefined) return c.redirect('/admin/news', 302);
    return c.html(
      confirmDestroyPage({
        self: selfHref(c),
        modules: navModules(deps.db),
        title: 'Remove feed',
        nav: 'news',
        heading: `Remove “${feed.name}”?`,
        intro: 'Its address and its headlines are forgotten, and every wall stops showing them.',
        destroyAction: `admin/news/${encodeURIComponent(id)}/remove`,
        destroyLabel: 'Remove it',
        cancelAction: 'admin/news',
      }),
    );
  });

  app.post('/admin/news/:id/remove', (c: Context) => {
    // A token is a claim: a feed removed in another tab changed nothing.
    if (!removeNewsFeed(deps.db, c.req.param('id') ?? '')) return c.redirect('/admin/news', 302);
    return savedRedirect(c, '/admin/news', 'news-feed-removed');
  });

  function when(at: number): string {
    return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
  }

  function feedCard(feed: NewsFeedRow): string {
    // The host only — never the path, which for a private feed is its key.
    const host = newsFeedHost(deps.db, deps.keyring, feed.id);
    const state =
      feed.lastError !== null
        ? `${tag('Not read last time', 'warn')} <p class="hint">${escapeHtml(feed.lastError)} ` +
          `The wall keeps showing the ${feed.itemCount} headline${feed.itemCount === 1 ? '' : 's'} it had.</p>`
        : tag(`${feed.itemCount} headline${feed.itemCount === 1 ? '' : 's'}`, 'ok');
    return card(
      `<div class="card-head"><div class="card-head-main">` +
        `<h2>${escapeHtml(feed.name)}</h2>` +
        `<p class="host">${escapeHtml(host ?? 'An address that could not be read')}` +
        (feed.lastSuccessAt === null ? '' : ` · read ${escapeHtml(when(feed.lastSuccessAt))} UTC`) +
        `</p>` +
        state +
        `</div>` +
        `<details class="ovf" data-overflow>` +
        `<summary class="ovf-btn" role="button" aria-haspopup="menu" ` +
        `aria-label="More actions for ${escapeHtml(feed.name)}" title="More">${icon('more')}</summary>` +
        `<div class="ovf-menu" role="menu">` +
        destructive('Remove', { thing: feed.name, confirmAction: `admin/news/${encodeURIComponent(feed.id)}/remove` }) +
        `</div></details></div>`,
    );
  }

  function newsPage(c: Context): string {
    const feeds = readNewsFeeds(deps.db);
    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'News — Maverick Wall',
      nav: 'news',
      heading: 'News',
      saved: readSaved(c),
      action: { label: 'Add a feed', href: 'admin/news/new' },
      intro:
        'Headlines from news sites and blogs, read from their RSS or Atom feeds every half hour. ' +
        'A News widget shows them as a list or one at a time, with a code to scan to read the story on a ' +
        'phone. Nothing on a wall is a link.',
      body:
        feeds.length === 0
          ? emptyState('No feeds yet.', { label: 'Add a feed', href: 'admin/news/new' })
          : feeds.map(feedCard).join(''),
    });
  }

  /**
   * Adding a feed, on a page of its own (P2.1). A refused form comes back
   * with what was typed — the address included, since it has not been stored.
   */
  function newFeedPage(c: Context, error?: string, values?: Record<string, unknown>): string {
    const typed = (key: string): string => (typeof values?.[key] === 'string' ? (values[key] as string) : '');
    const ticked = (key: string): boolean => typeof values?.[key] === 'string' && values[key] !== '';
    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Add a feed — Maverick Wall',
      nav: 'news',
      heading: 'Add a feed',
      back: { label: 'News', href: 'admin/news' },
      body:
        (error === undefined ? '' : errorBlock(error)) +
        `<form method="post" action="admin/news">` +
        textField({
          label: 'Feed address',
          name: 'url',
          required: true,
          placeholder: 'https://',
          value: typed('url'),
          attrs: 'autocomplete="off" spellcheck="false"',
        }) +
        `<p class="hint">Look on the site for a link marked RSS, Atom or Feed. It is read before it is added, ` +
        `then kept sealed: only its site’s name is shown again.</p>` +
        textField({
          label: 'Name (optional)',
          name: 'name',
          placeholder: 'The feed’s own name',
          value: typed('name'),
          attrs: 'maxlength="40"',
        }) +
        switchRow({
          label: networkAccessLabel('allowPrivateNetwork'),
          name: 'allow_lan',
          checked: ticked('allow_lan'),
          hint: 'For a feed served on your own network — this machine included.',
        }) +
        switchRow({
          label: networkAccessLabel('allowHttp'),
          name: 'allow_http',
          checked: ticked('allow_http'),
          hint: 'The address travels unencrypted. Only for a feed on your own network.',
        }) +
        `<button type="submit">Add feed</button></form>`,
    });
  }
}
