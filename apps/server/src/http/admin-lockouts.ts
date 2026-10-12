import type { Context, Hono } from 'hono';

import {
  ADDRESS_LOCKS,
  NO_ADDRESS,
  type AddressLock,
  type Lockouts,
  type SignInAttempt,
} from '../auth/lockouts.js';
import { releaseTwoStepLock, twoStepLocks } from '../api/accounts.js';
import { readHousehold } from '../api/queries.js';
import type { SqliteDatabase } from '../db/open.js';
import { parse, z } from '../validation.js';
import { navModules } from './admin.js';
import { dataTable, emptyState, listRow, section, tag } from './components.js';
import { errorBlock, escapeHtml, page } from './html.js';
import { readSaved, savedRedirect } from './saved.js';
import { selfHref } from './self.js';

/**
 * The Lockouts screen (plan item M8.3): who has been trying to sign in, which
 * addresses have been told to wait, and a way to let one back in.
 *
 * It is a reading of the limits the app already keeps (`auth/lockouts.ts`) and
 * of the two-step plugin's own account lock, and it adds none of its own. What
 * it shows is addresses, steps and outcomes — never an email typed, a code or
 * a token — because a screen that lists who tried to sign in is the first
 * thing an attacker with an admin's password would read, and the second thing
 * a household screenshots into a forum post asking what it means.
 *
 * Releasing is a write, so a view-only account sees the screen and cannot use
 * its buttons, by the one gate every other write goes through.
 */

export interface LockoutRouteDeps {
  readonly db: SqliteDatabase;
  readonly now: () => number;
  readonly lockouts: Lockouts;
}

const releaseBody = z.object({
  kind: z.enum([...ADDRESS_LOCKS, 'two-step'], { error: () => 'That is not something that can be locked.' }),
  key: z
    .string({ error: () => 'Say what to release.' })
    .min(1, { error: () => 'Say what to release.' })
    .max(255, { error: () => 'That is not something that can be locked.' }),
});

/** Every lock held now, in the order the screen draws them. */
export interface HeldLock {
  readonly kind: AddressLock | 'two-step';
  /** The address, or for two-step codes the account's id. */
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly until: number;
}

/** An address as the screen says it. A request the socket could not place has none. */
export function addressWords(address: string | undefined): string {
  return address === undefined || address === '' || address === NO_ADDRESS || address === 'no-trusted-ip'
    ? 'an address that could not be read'
    : address;
}

/** "under a minute", "4 minutes": how long is left, rounded up. */
export function leftWords(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (ms < 60_000) return 'under a minute';
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

const ADDRESS_LOCK_WORDS: Record<AddressLock, { readonly title: string; readonly detail: (address: string) => string }> = {
  'sign-in': {
    title: 'Signing in',
    detail: (address) => `Too many tries at the sign-in page from ${address}. It is refused until this runs out.`,
  },
  pairing: {
    title: 'Pairing a wall',
    detail: (address) => `Too many pairing codes typed on a wall at ${address}.`,
  },
  'wall-start': {
    title: 'A wall asking to pair',
    detail: (address) => `Too many walls at ${address} asked for a pairing code.`,
  },
  'phone-token': {
    title: 'The phone token',
    detail: (address) =>
      `Too many wrong tokens from ${address}. A phone or automation there is refused, even with the right token, until this runs out.`,
  },
};

export function heldLocks(db: SqliteDatabase, lockouts: Lockouts, at: number): readonly HeldLock[] {
  const out: HeldLock[] = [];
  const byAddress: readonly [AddressLock, readonly { readonly key: string; readonly until: number }[]][] = [
    ['sign-in', lockouts.signIn.held(at).map((held) => ({ key: held.address, until: held.until }))],
    ['pairing', lockouts.pairing.held(at)],
    ['wall-start', lockouts.wallStart.held(at)],
    ['phone-token', lockouts.phoneToken.held(at)],
  ];
  for (const [kind, held] of byAddress) {
    for (const lock of held) {
      out.push({
        kind,
        key: lock.key,
        title: ADDRESS_LOCK_WORDS[kind].title,
        detail: ADDRESS_LOCK_WORDS[kind].detail(addressWords(lock.key)),
        until: lock.until,
      });
    }
  }
  for (const account of twoStepLocks(db, at)) {
    out.push({
      kind: 'two-step',
      key: account.id,
      title: `Two-step codes for ${account.name}`,
      detail: `Ten wrong codes in a row. ${account.name} cannot finish signing in, from any address, until this runs out.`,
      until: account.until,
    });
  }
  return out.sort((a, b) => a.until - b.until);
}

/** Lift one lock. True when there was one to lift. */
export function releaseLock(
  db: SqliteDatabase,
  lockouts: Lockouts,
  kind: AddressLock | 'two-step',
  key: string,
  at: number,
): boolean {
  switch (kind) {
    case 'sign-in':
      return lockouts.signIn.release(key);
    case 'pairing':
      return lockouts.pairing.release(key);
    case 'wall-start':
      return lockouts.wallStart.release(key);
    case 'phone-token':
      return lockouts.phoneToken.release(key);
    case 'two-step':
      return releaseTwoStepLock(db, key, at);
  }
}

const STEP_WORDS: Record<SignInAttempt['step'], string> = {
  password: 'Password',
  code: 'Code from the app',
  recovery: 'Recovery code',
};

const OUTCOME_TAG: Record<SignInAttempt['outcome'], string> = {
  'signed-in': tag('Signed in', 'ok'),
  'code-asked': tag('Asked for a code', 'neutral'),
  refused: tag('Refused', 'warn'),
  'too-many': tag('Told to wait', 'danger'),
};

export function registerLockoutRoutes(app: Hono, deps: LockoutRouteDeps): void {
  /** "Mon 12 Oct, 14:32:07", in the household's own zone. */
  const when = (at: number): string =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: readHousehold(deps.db).timezone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(at));

  const lockoutsPage = (c: Context, error?: string): string => {
    const at = deps.now();
    const held = heldLocks(deps.db, deps.lockouts, at);
    const locked =
      held.length === 0
        ? emptyState('Nothing is locked. Every address may try again.')
        : held
            .map((lock) =>
              listRow(
                '',
                { title: lock.title, detail: `${lock.detail} ${leftWords(lock.until - at)} left.` },
                `<form method="post" action="admin/lockouts/release">` +
                  `<input type="hidden" name="kind" value="${escapeHtml(lock.kind)}">` +
                  `<input type="hidden" name="key" value="${escapeHtml(lock.key)}">` +
                  `<button class="secondary" type="submit">Release</button></form>`,
              ),
            )
            .join('');

    const attempts = deps.lockouts.log.recent(at);
    const recent =
      attempts.length === 0
        ? emptyState('No sign-in attempts since Maverick Wall last started.')
        : dataTable(
            [{ label: 'When' }, { label: 'From' }, { label: 'Step' }, { label: 'Result' }],
            attempts.map((attempt) => [
              escapeHtml(when(attempt.at)),
              escapeHtml(addressWords(attempt.address)),
              escapeHtml(STEP_WORDS[attempt.step]),
              OUTCOME_TAG[attempt.outcome],
            ]),
          );

    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      saved: readSaved(c),
      title: 'Lockouts',
      nav: 'system',
      back: { label: 'System', href: 'admin/system' },
      heading: 'Lockouts',
      intro:
        'An address that keeps getting a password, a code or a token wrong is told to wait, so nobody can ' +
        'sit and guess. Here is who has tried lately, and anything waiting now.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        section(
          'Locked now',
          'Each runs out by itself. Release one to let it try again straight away — only if you know who it is.',
          locked,
        ) +
        section(
          'Recent sign-in attempts',
          'The last hundred in the past day, newest first. Only where each came from and what happened: never ' +
            'the email address typed. Kept in memory, so restarting Maverick Wall clears the list.',
          recent,
        ),
    });
  };

  app.get('/admin/lockouts', (c: Context) => c.html(lockoutsPage(c)));

  app.post('/admin/lockouts/release', async (c: Context) => {
    const shaped = parse(releaseBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(lockoutsPage(c, shaped.message), 400);
    const released = releaseLock(deps.db, deps.lockouts, shaped.value.kind, shaped.value.key, deps.now());
    return savedRedirect(c, '/admin/lockouts', released ? 'lockout-released' : 'lockout-already-free');
  });
}
