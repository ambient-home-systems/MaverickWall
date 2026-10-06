import { createHash, randomBytes } from 'node:crypto';

import {
  FETCH_LIMITS,
  requiredNetworkOptions,
  type Fetcher,
  type FetchOutcome,
  type NetworkOption,
  type UrlPolicy,
} from '@maverick-wall/core';
import type { SqliteDatabase } from '../../db/open.js';
import type { Keyring } from '../../secrets/keyring.js';
import { z } from '../../validation.js';
import type { ModuleContext, PanelModule } from '../registry.js';
import { readFeed, type FeedItem } from './feed.js';

/**
 * News headlines (plan item M5.5): RSS and Atom feeds the household added on
 * the admin's News screen, read on the server and drawn by a News widget.
 *
 * **Everything that touches the network is here, and goes one way.** A feed is
 * read through the SSRF-guarded fetcher with that feed's own opt-ins (public
 * https unless the household ticked otherwise), capped at `FETCH_LIMITS.feed`
 * while streaming, and parsed by the narrow XML reader. Its address is sealed
 * (`news-feed-url`) and opened only for the length of one request; a log line
 * names the host and never the path, which for a private feed is the
 * credential. The wall is handed headlines, times, the feed's name and a link
 * — a link it draws only as a QR code, never as something to press.
 *
 * **A feed that fails keeps its last good headlines** and records why, in a
 * sentence the News screen shows, so an hour of a site being down is not an
 * empty box on the wall. A feed is read every half hour, and an unchanged one
 * costs a conditional request.
 */

export const NEWS_BLOCK = 'news';

/** Magic Frame merges up to eight; more is a wall reading the internet to itself. */
export const MAX_NEWS_FEEDS = 8;
/** How often a feed is read. News moves faster than a calendar and slower than a minute. */
export const NEWS_REFRESH_MS = 30 * 60_000;
/** The most headlines the manifest carries, across every feed. */
export const MAX_PANEL_HEADLINES = 60;

/** The shape of a feed's id, minted here: not a secret, so it travels to the wall. */
export const NEWS_FEED_ID = /^nf-[0-9a-f]{12}$/;

const checkbox = z.preprocess((value) => typeof value === 'string' && value !== '', z.boolean()).optional();

/** The add form, refused rather than coerced (rule five). */
export const newsFeedBody = z.object({
  url: z.string().trim().min(1, 'Paste the address of the feed.').max(2000, 'That address is too long.'),
  name: z.string().trim().max(40, 'Keep the name under 40 characters.').optional(),
  allow_lan: checkbox,
  allow_http: checkbox,
});

export interface NewsFeedRow {
  readonly id: string;
  readonly name: string;
  readonly allowLan: boolean;
  readonly allowHttp: boolean;
  readonly itemCount: number;
  readonly lastSuccessAt: number | null;
  readonly lastError: string | null;
  readonly createdAt: number;
}

/** Every feed, without its address, in the order the household added them. */
export function readNewsFeeds(db: SqliteDatabase): NewsFeedRow[] {
  const rows = db
    .prepare(
      `SELECT id, name, allow_lan AS allowLan, allow_http AS allowHttp, items,
              last_success_at AS lastSuccessAt, last_error AS lastError, created_at AS createdAt
         FROM news_feeds ORDER BY sort_order, created_at, id`,
    )
    .all() as {
    id: string;
    name: string;
    allowLan: number;
    allowHttp: number;
    items: string | null;
    lastSuccessAt: number | null;
    lastError: string | null;
    createdAt: number;
  }[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    allowLan: row.allowLan === 1,
    allowHttp: row.allowHttp === 1,
    itemCount: storedItems(row.items).length,
    lastSuccessAt: row.lastSuccessAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
  }));
}

/** A feed's address's host, for the News screen: the host and never the path. */
export function newsFeedHost(db: SqliteDatabase, keyring: Keyring, id: string): string | undefined {
  const row = db.prepare('SELECT url_encrypted AS url FROM news_feeds WHERE id = ?').get(id) as
    | { url: string }
    | undefined;
  if (row === undefined) return undefined;
  const opened = keyring.decrypt(row.url, 'news-feed-url');
  if (!opened.ok) return undefined;
  try {
    return new URL(opened.value).host;
  } catch {
    return undefined;
  }
}

const itemShape = z.object({
  id: z.string().max(2000),
  title: z.string().max(400),
  link: z.string().max(2000).optional(),
  publishedAt: z.number().optional(),
});

/** The cached headlines, read back defensively: a row this release cannot read is no headlines. */
function storedItems(text: string | null): FeedItem[] {
  if (text === null) return [];
  try {
    const parsed = z.array(itemShape).safeParse(JSON.parse(text));
    if (!parsed.success) return [];
    return parsed.data.map((item) => ({
      id: item.id,
      title: item.title,
      ...(item.link === undefined ? {} : { link: item.link }),
      ...(item.publishedAt === undefined ? {} : { publishedAt: item.publishedAt }),
    }));
  } catch {
    return [];
  }
}

function policyFor(row: { readonly allowLan: boolean; readonly allowHttp: boolean }): UrlPolicy {
  // "My own network" includes this machine, as a webhook's does: a feed
  // served by something beside this container is the household's network too.
  return { allowHttp: row.allowHttp, allowPrivateNetwork: row.allowLan, allowLoopback: row.allowLan };
}

/**
 * The switches on the add form an address needs and does not have, as the
 * form's two: plain http, and a local address (which includes this machine,
 * as a webhook's does). Every one at once — the fetcher answers with the
 * first thing wrong, and naming one switch a round is how a household ends up
 * submitting three times. Returned as options rather than words: only the
 * table the form is drawn from may spell a control's name
 * (`network-access-labels.test.ts`), so the add page words them.
 */
export function feedSwitchesNeeded(outcome: FetchOutcome, url: string, policy: UrlPolicy): readonly NetworkOption[] {
  if (outcome.status !== 'rejected') return [];
  const options = [...(outcome.networkOptions ?? []), ...requiredNetworkOptions(url, policy)];
  return [
    ...(options.includes('allowHttp') ? (['allowHttp'] as const) : []),
    ...(options.includes('allowPrivateNetwork') || options.includes('allowLoopback') ? (['allowPrivateNetwork'] as const) : []),
  ];
}

/**
 * Why a feed could not be read, written for somebody standing in a kitchen.
 * The fetcher's own message is for a log; this names the fix where it can.
 */
export function feedFailure(outcome: FetchOutcome, url: string, policy: UrlPolicy = {}): string {
  if (outcome.status === 'rejected') {
    if (feedSwitchesNeeded(outcome, url, policy).length > 0) {
      return 'That address is on a local network or is plain http, and this feed is not set up to reach it. Remove it and add it again with the switches it needs.';
    }
    if (outcome.code === 'dns-failed') return 'That site’s name could not be found. Check the address for a typo.';
    if (outcome.code === 'redirect-rejected' || outcome.code === 'too-many-redirects') {
      return 'That address sends readers somewhere a feed may not be read from.';
    }
    return 'That is not an address a feed can be read from. Check it starts with https://.';
  }
  if (outcome.status === 'failed') {
    if (outcome.code === 'timeout') return 'The site did not answer in time. It may be busy; it will be tried again.';
    if (outcome.code === 'too-large') return 'That feed is too large to read (over 2 MB).';
    if (outcome.code === 'http-error') {
      const status = outcome.httpStatus ?? 0;
      if (status === 404 || status === 410) return 'That address does not exist on the site any more.';
      if (status === 401 || status === 403) return 'That feed needs a sign-in, which this wall cannot do.';
      return `The site refused it (${status}). It will be tried again.`;
    }
    return 'The site could not be reached. It will be tried again.';
  }
  return 'That did not go through. Try again in a moment.';
}

type ReadResult =
  | {
      readonly ok: true;
      readonly items?: readonly FeedItem[];
      readonly title?: string;
      readonly etag?: string;
      readonly lastModified?: string;
    }
  | { readonly ok: false; readonly reason: string; readonly switches?: readonly NetworkOption[] };

async function readOnce(
  fetcher: Fetcher,
  url: string,
  row: { readonly allowLan: boolean; readonly allowHttp: boolean },
  conditional?: { readonly etag?: string; readonly lastModified?: string },
): Promise<ReadResult> {
  const outcome = await fetcher.fetch({
    url,
    policy: policyFor(row),
    maxBytes: FETCH_LIMITS.feed,
    timeoutMs: 20_000,
    ...(conditional === undefined ? {} : { conditional }),
  });
  if (outcome.status === 'not-modified') return { ok: true };
  if (outcome.status !== 'ok') {
    const switches = feedSwitchesNeeded(outcome, url, policyFor(row));
    return { ok: false, reason: feedFailure(outcome, url, policyFor(row)), ...(switches.length === 0 ? {} : { switches }) };
  }
  const read = readFeed(outcome.body);
  if (!read.ok) return { ok: false, reason: read.message };
  return {
    ok: true,
    items: read.feed.items,
    ...(read.feed.title === undefined ? {} : { title: read.feed.title }),
    ...(outcome.etag === undefined ? {} : { etag: outcome.etag }),
    ...(outcome.lastModified === undefined ? {} : { lastModified: outcome.lastModified }),
  };
}

export type AddFeedResult =
  | { readonly ok: true; readonly id: string; readonly name: string; readonly headlines: number }
  | { readonly ok: false; readonly reason: string; readonly switches?: readonly NetworkOption[] };

/**
 * Add a feed — read it first, so "Feed added" is only ever said of one that
 * read. Nothing is stored for one that does not, and the reason comes back.
 */
export async function addNewsFeed(
  context: { readonly db: SqliteDatabase; readonly keyring: Keyring; readonly fetcher: Fetcher; readonly now: number },
  input: { readonly url: string; readonly name: string | undefined; readonly allowLan: boolean; readonly allowHttp: boolean },
): Promise<AddFeedResult> {
  const count = context.db.prepare('SELECT count(*) AS n FROM news_feeds').get() as { n: number };
  if (count.n >= MAX_NEWS_FEEDS) {
    return { ok: false, reason: `There are already ${MAX_NEWS_FEEDS} feeds. Remove one to add another.` };
  }
  const read = await readOnce(context.fetcher, input.url, input);
  if (!read.ok) return read;
  const items = read.items ?? [];
  const name = (input.name ?? '').trim() || read.title || hostOf(input.url) || 'News';
  const id = `nf-${randomBytes(6).toString('hex')}`;
  const order = context.db.prepare('SELECT coalesce(max(sort_order), -1) + 1 AS n FROM news_feeds').get() as { n: number };
  context.db
    .prepare(
      `INSERT INTO news_feeds
         (id, name, url_encrypted, allow_lan, allow_http, sort_order, items, etag, last_modified,
          last_fetched_at, last_success_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      id,
      name.slice(0, 40),
      context.keyring.encrypt(input.url, 'news-feed-url'),
      input.allowLan ? 1 : 0,
      input.allowHttp ? 1 : 0,
      order.n,
      JSON.stringify(items),
      read.etag ?? null,
      read.lastModified ?? null,
      context.now,
      context.now,
      context.now,
      context.now,
    );
  return { ok: true, id, name, headlines: items.length };
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

export function removeNewsFeed(db: SqliteDatabase, id: string): boolean {
  return db.prepare('DELETE FROM news_feeds WHERE id = ?').run(id).changes > 0;
}

/**
 * Read every feed that is due, one after another. Never throws: a feed that
 * fails keeps its headlines and records its sentence, and the next is read.
 */
export async function syncNewsFeeds(context: ModuleContext, log: (line: string) => void = () => {}): Promise<void> {
  const rows = context.db
    .prepare(
      `SELECT id, url_encrypted AS url, allow_lan AS allowLan, allow_http AS allowHttp, etag,
              last_modified AS lastModified, last_fetched_at AS lastFetchedAt
         FROM news_feeds ORDER BY sort_order, created_at, id`,
    )
    .all() as {
    id: string;
    url: string;
    allowLan: number;
    allowHttp: number;
    etag: string | null;
    lastModified: string | null;
    lastFetchedAt: number | null;
  }[];
  for (const row of rows) {
    // A few minutes' slack, so a job that fires a little early still reads.
    if (row.lastFetchedAt !== null && context.now - row.lastFetchedAt < NEWS_REFRESH_MS - 3 * 60_000) continue;
    const opened = context.keyring.decrypt(row.url, 'news-feed-url');
    if (!opened.ok) {
      context.db
        .prepare('UPDATE news_feeds SET last_fetched_at = ?, last_error = ?, updated_at = ? WHERE id = ?')
        .run(context.now, 'This feed’s address could not be opened. Remove it and add it again.', context.now, row.id);
      continue;
    }
    const conditional = {
      ...(row.etag === null ? {} : { etag: row.etag }),
      ...(row.lastModified === null ? {} : { lastModified: row.lastModified }),
    };
    const read = await readOnce(
      context.fetcher,
      opened.value,
      { allowLan: row.allowLan === 1, allowHttp: row.allowHttp === 1 },
      conditional,
    );
    if (!read.ok) {
      log(`[news] ${hostOf(opened.value) ?? 'a feed'}: not read this time`);
      context.db
        .prepare('UPDATE news_feeds SET last_fetched_at = ?, last_error = ?, updated_at = ? WHERE id = ?')
        .run(context.now, read.reason, context.now, row.id);
      continue;
    }
    if (read.items === undefined) {
      // Not modified: the stored headlines are still the feed's.
      context.db
        .prepare('UPDATE news_feeds SET last_fetched_at = ?, last_success_at = ?, last_error = NULL WHERE id = ?')
        .run(context.now, context.now, row.id);
      continue;
    }
    context.db
      .prepare(
        `UPDATE news_feeds SET items = ?, etag = ?, last_modified = ?, last_fetched_at = ?,
                last_success_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(
        JSON.stringify(read.items),
        read.etag ?? null,
        read.lastModified ?? null,
        context.now,
        context.now,
        context.now,
        row.id,
      );
  }
}

export interface NewsHeadline {
  /** Stable across reads of the same item, and names no address. */
  readonly key: string;
  /** Which feed, for a widget that shows some feeds and not others. */
  readonly feed: string;
  readonly source: string;
  readonly title: string;
  readonly at?: number;
  /** An absolute http(s) address, drawn only as a QR code. */
  readonly link?: string;
}

export interface NewsPanel {
  readonly headlines: readonly NewsHeadline[];
}

/**
 * Every feed's headlines, newest first, as one list. An undated headline sorts
 * after the dated ones, in its feed's own order — a feed that dates nothing is
 * still read top to bottom.
 */
export function newsHeadlines(db: SqliteDatabase): NewsHeadline[] {
  const rows = db
    .prepare('SELECT id, name, items FROM news_feeds ORDER BY sort_order, created_at, id')
    .all() as { id: string; name: string; items: string | null }[];
  const all: (NewsHeadline & { readonly order: number })[] = [];
  let order = 0;
  for (const row of rows) {
    for (const item of storedItems(row.items)) {
      all.push({
        key: `nh-${createHash('sha256').update(`${row.id}|${item.id}`).digest('hex').slice(0, 12)}`,
        feed: row.id,
        source: row.name,
        title: item.title,
        ...(item.publishedAt === undefined ? {} : { at: item.publishedAt }),
        ...(item.link === undefined ? {} : { link: item.link }),
        order: order++,
      });
    }
  }
  all.sort((a, b) => {
    if (a.at !== undefined && b.at !== undefined) return b.at - a.at || a.order - b.order;
    if (a.at !== undefined) return -1;
    if (b.at !== undefined) return 1;
    return a.order - b.order;
  });
  return all.slice(0, MAX_PANEL_HEADLINES).map(({ order: _order, ...headline }) => headline);
}

export const newsModule: PanelModule = {
  key: NEWS_BLOCK,
  label: 'News',

  /** Some feed has headlines: a widget with none to draw is left out, and its fallback shown. */
  ready(db: SqliteDatabase): boolean {
    return newsHeadlines(db).length > 0;
  },

  contribute(context: ModuleContext): NewsPanel {
    return { headlines: newsHeadlines(context.db) };
  },

  job: {
    kind: 'news-sync',
    intervalMs: 5 * 60_000,
    async run(context: ModuleContext): Promise<void> {
      await syncNewsFeeds(context, (line) => console.log(line));
    },
  },
};
