import type { Context, Hono } from 'hono';

import { currentUser } from '../auth/session.js';
import { ROLE_LABELS, ROLES, isRole, type Role } from '../auth/roles.js';
import type { AccountWrite } from '../auth/better-auth.js';
import {
  clearTwoFactor,
  deleteAccount,
  findAccount,
  ingressAccount,
  listAccounts,
  readIngressAccountId,
  setIngressAccount,
  setRole,
  type AccountRow,
} from '../api/accounts.js';
import type { SqliteDatabase } from '../db/open.js';
import { parse, text, z } from '../validation.js';
import {
  confirmDestroyPage,
  errorBlock,
  escapeHtml,
  noticeBlock,
  page,
  segControl,
  selectField,
  textField,
} from './html.js';
import { emptyState, listRow, section, tag } from './components.js';
import { readSaved, savedRedirect } from './saved.js';
import { navModules } from './admin.js';
import { selfHref } from './self.js';
import { encodeQr, qrSvg } from './qr.js';

/**
 * Accounts and your own account (plan items M8.1 and M8.2).
 *
 * **Accounts** is the household's list: who may sign in, what each may do, and
 * which one Home Assistant's sidebar signs in as. **Your account** is the one
 * signed in: its password and its two-step sign-in. The second is the one
 * thing a view-only account may change (`viewerMay`), because it is about the
 * person and not the house.
 *
 * Password and two-step changes go through Better Auth's own routes by
 * `authApi`, because the library that checks a password is the one that should
 * check it before it changes. None of this works for a Home Assistant sidebar
 * visitor, who is signed in by Home Assistant and has no session of ours to
 * prove a password with, and the page says so rather than offering forms that
 * would only fail.
 */

export interface AccountRouteDeps {
  readonly db: SqliteDatabase;
  readonly now?: () => number;
  /** Call one of Better Auth's own routes as the person asking (`app.ts`'s `authApi`). */
  readonly authApi: (c: Context, path: string, body?: unknown) => Promise<Response>;
  readonly createAccount: (input: { name: string; email: string; password: string }) => Promise<AccountWrite>;
  readonly setPassword: (userId: string, password: string) => Promise<AccountWrite>;
}

const MIN_PASSWORD = 10;

const passwordField = (label: string): z.ZodType<string> =>
  z
    .string({ error: () => `${label} is required.` })
    .refine((value) => value.length >= MIN_PASSWORD, {
      error: () => `${label} needs at least ${MIN_PASSWORD} characters.`,
    })
    .refine((value) => value.length <= 128, { error: () => `${label} is longer than 128 characters.` });

const newAccountBody = z.object({
  name: text('Name', 80),
  email: z
    .string({ error: () => 'Email address is required.' })
    .transform((value) => value.trim())
    .pipe(z.email({ error: () => 'That is not an email address.' })),
  password: passwordField('Password'),
  role: z.enum(ROLES as [Role, ...Role[]], { error: () => 'Choose what this account may do.' }),
});

const roleBody = z.object({
  role: z.enum(ROLES as [Role, ...Role[]], { error: () => 'Choose what this account may do.' }),
});

const setPasswordBody = z.object({ password: passwordField('New password') });

const changePasswordBody = z.object({
  current: z.string({ error: () => 'Your current password is required.' }).min(1, { error: () => 'Your current password is required.' }),
  password: passwordField('New password'),
});

const passwordOnly = z.object({
  password: z.string({ error: () => 'Your password is required.' }).min(1, { error: () => 'Your password is required.' }),
});

const codeBody = z.object({
  code: z
    .string({ error: () => 'Type the six digits from your code app.' })
    .transform((value) => value.replace(/\s+/g, ''))
    .pipe(z.string().regex(/^\d{6}$/, { error: () => 'Type the six digits from your code app.' })),
});

const sidebarBody = z.object({ account: z.string().max(64).optional() });

/**
 * A two-step setup between "Turn on" and the code that confirms it, held in
 * memory under the account's id: the address the code app reads, and the
 * recovery codes shown with it. In memory and nowhere else, for
 * `caldav-pending.ts`'s reason — and so a mistyped confirmation can draw the
 * same QR code again rather than starting over. Fifteen minutes, then gone.
 */
interface HeldSetup {
  readonly uri: string;
  readonly codes: readonly string[];
  readonly expiresAt: number;
}

const SETUP_HOLD_MS = 15 * 60_000;

export function registerAccountRoutes(app: Hono, deps: AccountRouteDeps): void {
  const now = deps.now ?? ((): number => Date.now());
  const held = new Map<string, HeldSetup>();
  const takeHeld = (userId: string): HeldSetup | undefined => {
    const setup = held.get(userId);
    if (setup === undefined) return undefined;
    if (setup.expiresAt <= now()) {
      held.delete(userId);
      return undefined;
    }
    return setup;
  };

  /* ---- Accounts: the household's list ----------------------------------- */

  app.get('/admin/accounts', (c: Context) => c.html(accountsPage(c, deps.db)));

  app.get('/admin/accounts/new', (c: Context) => c.html(newAccountPage(c, deps.db)));

  app.post('/admin/accounts', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = parse(newAccountBody, body);
    if (!shaped.ok) return c.html(newAccountPage(c, deps.db, shaped.message, body), 400);
    const created = await deps.createAccount({
      name: shaped.value.name,
      email: shaped.value.email,
      password: shaped.value.password,
    });
    if (!created.ok) return c.html(newAccountPage(c, deps.db, created.message, body), 400);
    // The column defaults to admin, so the role is always written: an account
    // made here is exactly what the form said and never what the default is.
    const roled = setRole(deps.db, created.id, shaped.value.role);
    if (!roled.ok) return c.html(newAccountPage(c, deps.db, roled.message, body), 400);
    return savedRedirect(c, '/admin/accounts', 'account-added');
  });

  app.post('/admin/accounts/sidebar', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = parse(sidebarBody, body);
    if (!shaped.ok) return c.html(accountsPage(c, deps.db, shaped.message), 400);
    const id = shaped.value.account === undefined || shaped.value.account === '' ? null : shaped.value.account;
    const set = setIngressAccount(deps.db, id);
    if (!set.ok) return c.html(accountsPage(c, deps.db, set.message), 400);
    return savedRedirect(c, '/admin/accounts', 'account-sidebar');
  });

  /* ---- One account, seen by an admin ------------------------------------- */

  const otherAccount = (c: Context): AccountRow | Response => {
    const id = c.req.param('id') ?? '';
    if (id === currentUser(c).id) return c.redirect('/admin/account', 302);
    const account = findAccount(deps.db, id);
    return account ?? c.redirect('/admin/accounts', 302);
  };

  app.get('/admin/accounts/:id', (c: Context) => {
    const account = otherAccount(c);
    return account instanceof Response ? account : c.html(oneAccountPage(c, deps.db, account));
  });

  app.post('/admin/accounts/:id/role', async (c: Context) => {
    const account = otherAccount(c);
    if (account instanceof Response) return account;
    const shaped = parse(roleBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(oneAccountPage(c, deps.db, account, shaped.message), 400);
    const set = setRole(deps.db, account.id, shaped.value.role);
    if (!set.ok) return c.html(oneAccountPage(c, deps.db, account, set.message), 400);
    return savedRedirect(c, `/admin/accounts/${encodeURIComponent(account.id)}`, 'account-role');
  });

  app.post('/admin/accounts/:id/password', async (c: Context) => {
    const account = otherAccount(c);
    if (account instanceof Response) return account;
    const shaped = parse(setPasswordBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(oneAccountPage(c, deps.db, account, shaped.message), 400);
    const set = await deps.setPassword(account.id, shaped.value.password);
    if (!set.ok) return c.html(oneAccountPage(c, deps.db, account, set.message), 400);
    return savedRedirect(c, `/admin/accounts/${encodeURIComponent(account.id)}`, 'account-password-set');
  });

  app.get('/admin/accounts/:id/two-step-off', (c: Context) => {
    const account = otherAccount(c);
    if (account instanceof Response) return account;
    if (!account.twoFactorEnabled) return c.redirect(`/admin/accounts/${encodeURIComponent(account.id)}`, 302);
    return c.html(
      confirmDestroyPage({
        self: selfHref(c),
        modules: navModules(deps.db),
        title: 'Turn off two-step sign-in',
        nav: 'system',
        heading: `Turn off two-step sign-in for ${account.name}?`,
        intro:
          'For somebody who has lost both their phone and their recovery codes. Their password ' +
          'alone signs them in again until they turn two-step sign-in back on from their own account.',
        destroyAction: `admin/accounts/${encodeURIComponent(account.id)}/two-step-off`,
        destroyLabel: 'Turn it off',
        cancelAction: `admin/accounts/${encodeURIComponent(account.id)}`,
      }),
    );
  });

  app.post('/admin/accounts/:id/two-step-off', (c: Context) => {
    const account = otherAccount(c);
    if (account instanceof Response) return account;
    // A token is a claim: with nothing on, nothing was turned off.
    if (!account.twoFactorEnabled) return c.redirect(`/admin/accounts/${encodeURIComponent(account.id)}`, 302);
    const cleared = clearTwoFactor(deps.db, account.id);
    if (!cleared.ok) return c.html(oneAccountPage(c, deps.db, account, cleared.message), 400);
    return savedRedirect(c, `/admin/accounts/${encodeURIComponent(account.id)}`, 'account-two-step-cleared');
  });

  app.get('/admin/accounts/:id/remove', (c: Context) => {
    const account = otherAccount(c);
    if (account instanceof Response) return account;
    return c.html(
      confirmDestroyPage({
        self: selfHref(c),
        modules: navModules(deps.db),
        title: 'Remove an account',
        nav: 'system',
        heading: `Remove ${account.name}’s account?`,
        intro:
          `${account.email} can no longer sign in, anywhere it is signed in now is signed out, ` +
          'and its companion token stops working. The walls and everything on them stay as they are.',
        destroyAction: `admin/accounts/${encodeURIComponent(account.id)}/remove`,
        destroyLabel: 'Remove it',
        cancelAction: `admin/accounts/${encodeURIComponent(account.id)}`,
      }),
    );
  });

  app.post('/admin/accounts/:id/remove', (c: Context) => {
    const account = otherAccount(c);
    if (account instanceof Response) return account;
    const removed = deleteAccount(deps.db, account.id, currentUser(c).id);
    if (!removed.ok) return c.html(oneAccountPage(c, deps.db, account, removed.message), 400);
    return savedRedirect(c, '/admin/accounts', 'account-removed');
  });

  /* ---- Your account ------------------------------------------------------ */

  app.get('/admin/account', (c: Context) => c.html(yourAccountPage(c, deps.db)));

  app.post('/admin/account/password', async (c: Context) => {
    if (viaIngress(c)) return c.html(yourAccountPage(c, deps.db, UNDER_INGRESS), 400);
    const shaped = parse(changePasswordBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(yourAccountPage(c, deps.db, shaped.message), 400);
    const response = await deps.authApi(c, '/api/auth/change-password', {
      currentPassword: shaped.value.current,
      newPassword: shaped.value.password,
      // Every other place this account is signed in is signed out: a password
      // is changed because the old one is known to somebody, and their session
      // would otherwise outlive it. This browser is handed a new session.
      revokeOtherSessions: true,
    });
    if (response.status >= 400) {
      return c.html(yourAccountPage(c, deps.db, refusal(response.status, 'That is not your current password.')), 400);
    }
    carryCookies(c, response);
    return savedRedirect(c, '/admin/account', 'account-password-changed');
  });

  app.post('/admin/account/two-step/start', async (c: Context) => {
    if (viaIngress(c)) return c.html(yourAccountPage(c, deps.db, UNDER_INGRESS), 400);
    const shaped = parse(passwordOnly, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(yourAccountPage(c, deps.db, shaped.message), 400);
    const response = await deps.authApi(c, '/api/auth/two-factor/enable', { password: shaped.value.password });
    if (response.status >= 400) {
      return c.html(yourAccountPage(c, deps.db, refusal(response.status, 'That is not your password.')), 400);
    }
    const answer = enableAnswer.safeParse(await response.json().catch(() => undefined));
    if (!answer.success) return c.html(yourAccountPage(c, deps.db, 'Two-step sign-in could not be started.'), 500);
    const setup: HeldSetup = { uri: answer.data.totpURI, codes: answer.data.backupCodes, expiresAt: now() + SETUP_HOLD_MS };
    held.set(currentUser(c).id, setup);
    c.header('cache-control', 'no-store');
    return c.html(setupPage(c, deps.db, setup));
  });

  app.post('/admin/account/two-step/confirm', async (c: Context) => {
    if (viaIngress(c)) return c.html(yourAccountPage(c, deps.db, UNDER_INGRESS), 400);
    const user = currentUser(c);
    const setup = takeHeld(user.id);
    if (setup === undefined) {
      return c.html(yourAccountPage(c, deps.db, 'That took too long and the setup was forgotten. Start it again.'), 400);
    }
    c.header('cache-control', 'no-store');
    const shaped = parse(codeBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(setupPage(c, deps.db, setup, shaped.message), 400);
    const response = await deps.authApi(c, '/api/auth/two-factor/verify-totp', { code: shaped.value.code });
    if (response.status >= 400) {
      return c.html(setupPage(c, deps.db, setup, refusal(response.status, WRONG_CODE)), 400);
    }
    held.delete(user.id);
    // Confirming hands this browser a fresh session, as turning it on does.
    carryCookies(c, response);
    return savedRedirect(c, '/admin/account', 'account-two-step-on');
  });

  app.post('/admin/account/two-step/off', async (c: Context) => {
    if (viaIngress(c)) return c.html(yourAccountPage(c, deps.db, UNDER_INGRESS), 400);
    const shaped = parse(passwordOnly, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(yourAccountPage(c, deps.db, shaped.message), 400);
    const response = await deps.authApi(c, '/api/auth/two-factor/disable', { password: shaped.value.password });
    if (response.status >= 400) {
      return c.html(yourAccountPage(c, deps.db, refusal(response.status, 'That is not your password.')), 400);
    }
    carryCookies(c, response);
    return savedRedirect(c, '/admin/account', 'account-two-step-off');
  });

  app.post('/admin/account/two-step/codes', async (c: Context) => {
    if (viaIngress(c)) return c.html(yourAccountPage(c, deps.db, UNDER_INGRESS), 400);
    const shaped = parse(passwordOnly, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(yourAccountPage(c, deps.db, shaped.message), 400);
    const response = await deps.authApi(c, '/api/auth/two-factor/generate-backup-codes', {
      password: shaped.value.password,
    });
    if (response.status >= 400) {
      return c.html(yourAccountPage(c, deps.db, refusal(response.status, 'That is not your password.')), 400);
    }
    const answer = codesAnswer.safeParse(await response.json().catch(() => undefined));
    if (!answer.success) return c.html(yourAccountPage(c, deps.db, 'New recovery codes could not be made.'), 500);
    c.header('cache-control', 'no-store');
    return c.html(codesPage(c, deps.db, answer.data.backupCodes));
  });
}

/* ---- Better Auth's answers, read through a schema like any outside body --- */

const enableAnswer = z.object({
  totpURI: z.string().startsWith('otpauth://totp/').max(1000),
  backupCodes: z.array(z.string().max(64)).min(1).max(32),
});

const codesAnswer = z.object({ backupCodes: z.array(z.string().max(64)).min(1).max(32) });

const WRONG_CODE =
  'That code did not match. Codes change every 30 seconds — type the one showing now, and check the ' +
  'phone’s clock is set automatically.';

const UNDER_INGRESS =
  'Home Assistant signed you in here, so there is no password of ours to check. Open Maverick Wall at its own ' +
  'address and sign in there to change your password or two-step sign-in.';

function viaIngress(c: Context): boolean {
  return c.get('viaIngress') === true;
}

function refusal(status: number, otherwise: string): string {
  return status === 429 ? 'Too many attempts. Wait a minute and try again.' : otherwise;
}

/** A Better Auth answer's cookies, onto ours: a new session replaces the one it superseded. */
function carryCookies(c: Context, response: Response): void {
  for (const cookie of response.headers.getSetCookie()) c.header('set-cookie', cookie, { append: true });
}

/* ---- Pages --------------------------------------------------------------- */

function roleTag(role: Role): string {
  return tag(ROLE_LABELS[role], role === 'admin' ? 'accent' : 'neutral');
}

function accountTags(account: AccountRow, me: string, sidebar: string | undefined): string {
  return (
    roleTag(account.role) +
    (account.twoFactorEnabled ? tag('Two-step on', 'ok') : '') +
    (account.id === me ? tag('You') : '') +
    (account.id === sidebar ? tag('Home Assistant sidebar') : '')
  );
}

function accountsPage(c: Context, db: SqliteDatabase, error?: string): string {
  const me = currentUser(c).id;
  const accounts = listAccounts(db);
  const sidebar = ingressAccount(db);
  const named = readIngressAccountId(db);
  const rows = accounts
    .map((account) =>
      listRow(
        '',
        {
          title: account.name,
          detail: account.email,
          href: account.id === me ? 'admin/account' : `admin/accounts/${encodeURIComponent(account.id)}`,
        },
        accountTags(account, me, sidebar?.id),
      ),
    )
    .join('');
  const options =
    `<option value=""${named === null ? ' selected' : ''}>Nobody named — ask for a password</option>` +
    accounts
      .map(
        (account) =>
          `<option value="${escapeHtml(account.id)}"${account.id === named ? ' selected' : ''}>` +
          `${escapeHtml(account.name)} (${escapeHtml(ROLE_LABELS[account.role])})</option>`,
      )
      .join('');
  const now =
    sidebar === undefined
      ? 'Right now the sidebar asks for a password.'
      : `Right now the sidebar signs in as ${sidebar.name}.`;
  return page({
    self: selfHref(c),
    modules: navModules(db),
    saved: readSaved(c),
    title: 'Accounts',
    nav: 'system',
    back: { label: 'System', href: 'admin/system' },
    action: { label: 'Add an account', href: 'admin/accounts/new' },
    heading: 'Accounts',
    intro:
      'Everybody who can sign in here. An admin can change anything; a view-only account can look ' +
      'at everything and change nothing but its own password and two-step sign-in.',
    body:
      (error === undefined ? '' : errorBlock(error)) +
      section('Who can sign in', undefined, accounts.length === 0 ? emptyState('No accounts') : rows) +
      section(
        'Home Assistant’s sidebar',
        'Home Assistant has already checked who is signed in to it, so with one account here the sidebar ' +
          'signs straight in as that account. With several there is no telling which person opened it, so ' +
          `name one, or it asks for a password like any other browser. ${now}`,
        `<form method="post" action="admin/accounts/sidebar">` +
          selectField({ label: 'The sidebar signs in as', name: 'account', optionsHtml: options }) +
          `<div class="row"><button type="submit">Save</button></div></form>`,
      ),
  });
}

function newAccountPage(c: Context, db: SqliteDatabase, error?: string, echo: Record<string, unknown> = {}): string {
  const value = (name: string): string => (typeof echo[name] === 'string' ? (echo[name] as string) : '');
  const role = isRole(echo['role']) ? echo['role'] : 'viewer';
  return page({
    self: selfHref(c),
    modules: navModules(db),
    title: 'Add an account',
    nav: 'system',
    back: { label: 'Accounts', href: 'admin/accounts' },
    heading: 'Add an account',
    intro:
      'For somebody else in the house. Tell them the password yourself; nothing is sent to them, ' +
      'because there is no mail server here.',
    body:
      (error === undefined ? '' : errorBlock(error)) +
      `<form method="post" action="admin/accounts">` +
      textField({ label: 'Name', name: 'name', required: true, value: value('name'), attrs: 'maxlength="80"' }) +
      textField({
        label: 'Email address',
        name: 'email',
        type: 'email',
        required: true,
        value: value('email'),
        hint: 'What they sign in with.',
        attrs: 'autocomplete="off"',
      }) +
      // Never echoed: a refused form does not hand a password back into the page.
      textField({
        label: 'Password',
        name: 'password',
        type: 'password',
        required: true,
        hint: `At least ${MIN_PASSWORD} characters. They can change it once they have signed in.`,
        attrs: `minlength="${MIN_PASSWORD}" autocomplete="new-password"`,
      }) +
      segControl({
        label: 'What they may do',
        name: 'role',
        options: [
          { value: 'viewer', label: ROLE_LABELS.viewer },
          { value: 'admin', label: ROLE_LABELS.admin },
        ],
        selected: role,
        hint: 'View only looks at everything and changes nothing. Admin can change anything, accounts included.',
      }) +
      `<div class="row"><button type="submit">Add account</button></div></form>`,
  });
}

function oneAccountPage(c: Context, db: SqliteDatabase, account: AccountRow, error?: string): string {
  const id = encodeURIComponent(account.id);
  const sidebar = ingressAccount(db);
  return page({
    self: selfHref(c),
    modules: navModules(db),
    saved: readSaved(c),
    title: account.name,
    nav: 'system',
    back: { label: 'Accounts', href: 'admin/accounts' },
    heading: account.name,
    intro: account.email,
    body:
      (error === undefined ? '' : errorBlock(error)) +
      `<p>${accountTags(account, currentUser(c).id, sidebar?.id)}</p>` +
      section(
        'What they may do',
        undefined,
        `<form method="post" action="admin/accounts/${id}/role">` +
          segControl({
            label: 'Role',
            name: 'role',
            options: [
              { value: 'viewer', label: ROLE_LABELS.viewer },
              { value: 'admin', label: ROLE_LABELS.admin },
            ],
            selected: account.role,
            hint: 'Takes effect on their next page.',
          }) +
          `<div class="row"><button type="submit">Save</button></div></form>`,
      ) +
      section(
        'Password',
        'For somebody who has forgotten theirs. Setting a new one signs them out everywhere they are signed in.',
        `<form method="post" action="admin/accounts/${id}/password">` +
          textField({
            label: 'New password',
            name: 'password',
            type: 'password',
            required: true,
            attrs: `minlength="${MIN_PASSWORD}" autocomplete="new-password"`,
          }) +
          `<div class="row"><button type="submit">Set password</button></div></form>`,
      ) +
      (account.twoFactorEnabled
        ? section(
            'Two-step sign-in',
            'On. If they have lost their phone and their recovery codes, turn it off and they can sign in with their password alone.',
            `<form method="get" action="admin/accounts/${id}/two-step-off">` +
              `<button class="secondary" type="submit">Turn off two-step sign-in…</button></form>`,
          )
        : '') +
      section(
        'Remove',
        undefined,
        `<form method="get" action="admin/accounts/${id}/remove">` +
          `<button class="btn-danger" type="submit" aria-label="Remove ${escapeHtml(account.name)}’s account">Remove account…</button></form>`,
      ),
  });
}

function yourAccountPage(c: Context, db: SqliteDatabase, error?: string): string {
  const me = currentUser(c);
  const account = findAccount(db, me.id);
  const role: Role = account?.role ?? 'viewer';
  const ingress = viaIngress(c);
  const twoStep = account?.twoFactorEnabled === true;
  const passwordInput = textField({
    label: 'Your password',
    name: 'password',
    type: 'password',
    required: true,
    attrs: 'autocomplete="current-password"',
  });
  return page({
    self: selfHref(c),
    modules: navModules(db),
    saved: readSaved(c),
    title: 'Your account',
    nav: 'system',
    back: { label: 'Accounts', href: 'admin/accounts' },
    heading: 'Your account',
    intro: `${me.name} · ${me.email}`,
    body:
      (error === undefined ? '' : errorBlock(error)) +
      `<p>${roleTag(role)}${twoStep ? tag('Two-step on', 'ok') : ''}</p>` +
      (ingress ? noticeBlock(UNDER_INGRESS) : '') +
      (ingress
        ? ''
        : section(
            'Password',
            'Changing it signs you out everywhere else you are signed in.',
            `<form method="post" action="admin/account/password">` +
              textField({
                label: 'Current password',
                name: 'current',
                type: 'password',
                required: true,
                attrs: 'autocomplete="current-password"',
              }) +
              textField({
                label: 'New password',
                name: 'password',
                type: 'password',
                required: true,
                hint: `At least ${MIN_PASSWORD} characters.`,
                attrs: `minlength="${MIN_PASSWORD}" autocomplete="new-password"`,
              }) +
              `<div class="row"><button type="submit">Change password</button></div></form>`,
          ) +
          (twoStep
            ? section(
                'Two-step sign-in',
                'On. Signing in asks for the six digits from your code app after your password, or one of your ' +
                  'recovery codes if the phone is not to hand.',
                `<form method="post" action="admin/account/two-step/codes">` +
                  passwordInput +
                  `<div class="row"><button class="secondary" type="submit">Make new recovery codes</button></div></form>` +
                  `<form method="post" action="admin/account/two-step/off">` +
                  passwordInput +
                  `<div class="row"><button class="btn-danger" type="submit">Turn off two-step sign-in</button></div></form>`,
              )
            : section(
                'Two-step sign-in',
                'Off. Turned on, signing in asks for your password and then six digits from a code app on your ' +
                  'phone — Google Authenticator, 1Password, Authy or any other — so a password somebody has ' +
                  'guessed is not enough on its own. You are given recovery codes for when the phone is not to hand.',
                `<form method="post" action="admin/account/two-step/start">` +
                  passwordInput +
                  `<div class="row"><button type="submit">Turn on two-step sign-in</button></div></form>`,
              ))),
  });
}

/** The secret a code app is told, out of the address the QR carries, in groups a person can type. */
export function secretOf(uri: string): string {
  try {
    const secret = new URL(uri).searchParams.get('secret') ?? '';
    return (secret.match(/.{1,4}/g) ?? []).join(' ');
  } catch {
    return '';
  }
}

function codeList(codes: readonly string[]): string {
  return `<ol>${codes.map((code) => `<li><code>${escapeHtml(code)}</code></li>`).join('')}</ol>`;
}

function setupPage(c: Context, db: SqliteDatabase, setup: HeldSetup, error?: string): string {
  const matrix = encodeQr(setup.uri);
  return page({
    self: selfHref(c),
    modules: navModules(db),
    title: 'Turn on two-step sign-in',
    nav: 'system',
    back: { label: 'Your account', href: 'admin/account' },
    heading: 'Turn on two-step sign-in',
    body:
      (error === undefined ? '' : errorBlock(error)) +
      section(
        '1. Add it to your code app',
        'Scan this with the code app on your phone, or type the key into it by hand.',
        (matrix === undefined ? '' : `<div class="qr">${qrSvg(matrix, 220)}</div>`) +
          `<p>Key: <code>${escapeHtml(secretOf(setup.uri))}</code></p>`,
      ) +
      section(
        '2. Keep your recovery codes',
        'Each one signs you in once if your phone is not to hand. Write them down or save them somewhere ' +
          'other than this phone. They are not shown again.',
        codeList(setup.codes),
      ) +
      section(
        '3. Type the code your app shows',
        'Two-step sign-in is not on until this matches, so a code app that read the wrong thing cannot lock you out.',
        `<form method="post" action="admin/account/two-step/confirm">` +
          textField({
            label: 'Six-digit code',
            name: 'code',
            required: true,
            attrs: 'inputmode="numeric" autocomplete="one-time-code" maxlength="7"',
          }) +
          `<div class="row"><button type="submit">Turn it on</button></div></form>`,
      ),
  });
}

function codesPage(c: Context, db: SqliteDatabase, codes: readonly string[]): string {
  return page({
    self: selfHref(c),
    modules: navModules(db),
    title: 'New recovery codes',
    nav: 'system',
    back: { label: 'Your account', href: 'admin/account' },
    heading: 'New recovery codes',
    intro: 'Your old recovery codes no longer work. Each of these signs you in once. They are not shown again.',
    body: codeList(codes),
  });
}
