import type { Context, Hono } from 'hono';

import { currentUser } from '../auth/session.js';
import { issueCompanionToken, readCompanionToken, revokeCompanionToken } from '../api/companion.js';
import { readTodoLists, todoListTitle } from '../modules/todo/index.js';
import { confirmDestroyPage, errorBlock, escapeHtml, page, textField } from './html.js';
import { card, destructive, section } from './components.js';
import { readSaved, savedRedirect } from './saved.js';
import { navModules, type AdminDeps } from './admin.js';
import { ingressPath } from './ingress.js';
import { selfHref } from './self.js';

/**
 * Phone and automations: the companion token, in the admin (plan item M2.1).
 *
 * Make one, see it, copy it, replace it, turn it off — and what it can do,
 * said beside it, since a token is only as safe as a household's sense of what
 * somebody holding it could do. Today that is adding to the to-do lists on the
 * To-do lists screen, and nothing else. Reached from System, under whose
 * heading it sits in the navigation, rather than as a destination of its own:
 * it is set up once.
 */

const SCREEN = 'Phone and automations';

const WHAT_IT_CAN_DO =
  'Anyone holding it can add items to the to-do lists you chose under To-do lists, start ' +
  'and end timers, and send and clear messages on your walls — and nothing else: it cannot ' +
  'read your lists, tick them off, change a setting or sign in.';

const QUERY_CAUTION =
  'If your app cannot send a header, put the token on the end of the address as ' +
  '?key=… instead. The whole address, token included, can then be written down by ' +
  'anything it passes through — a proxy, a router, an app’s own history — so use ' +
  'the header wherever you can.';

export function registerCompanionAdminRoutes(app: Hono, deps: AdminDeps): void {
  const now = deps.now ?? ((): number => Date.now());

  app.get('/admin/companion', (c: Context) => c.html(companionPage(c)));

  /** Make the first token. A token that exists already is left alone: replacing one is its own, confirmed, act. */
  app.post('/admin/companion', (c: Context) => {
    const user = currentUser(c);
    if (readCompanionToken(deps.db, deps.keyring, user.id) !== undefined) {
      return c.redirect('/admin/companion', 302);
    }
    issueCompanionToken(deps.db, deps.keyring, user.id, now());
    return savedRedirect(c, '/admin/companion', 'companion-created');
  });

  app.get('/admin/companion/replace', (c: Context) => {
    if (readCompanionToken(deps.db, deps.keyring, currentUser(c).id) === undefined) {
      return c.redirect('/admin/companion', 302);
    }
    return c.html(
      confirmDestroyPage({
        self: selfHref(c),
        modules: navModules(deps.db),
        title: 'Replace the token',
        nav: 'system',
        heading: 'Replace the token?',
        intro:
          'A new token is made and the current one stops working at once. Every shortcut ' +
          'or automation using it gets a refusal until you paste the new one in.',
        destroyAction: 'admin/companion/replace',
        destroyLabel: 'Replace it',
        cancelAction: 'admin/companion',
      }),
    );
  });

  app.post('/admin/companion/replace', (c: Context) => {
    const user = currentUser(c);
    // A token is a claim: with none to replace, nothing was replaced.
    if (readCompanionToken(deps.db, deps.keyring, user.id) === undefined) {
      return c.redirect('/admin/companion', 302);
    }
    issueCompanionToken(deps.db, deps.keyring, user.id, now());
    return savedRedirect(c, '/admin/companion', 'companion-replaced');
  });

  app.get('/admin/companion/remove', (c: Context) => {
    if (readCompanionToken(deps.db, deps.keyring, currentUser(c).id) === undefined) {
      return c.redirect('/admin/companion', 302);
    }
    return c.html(
      confirmDestroyPage({
        self: selfHref(c),
        modules: navModules(deps.db),
        title: 'Turn off the token',
        nav: 'system',
        heading: 'Turn off the token?',
        intro:
          'It stops working at once, and nothing can add to your lists from a phone or an ' +
          'automation until you make a new one.',
        destroyAction: 'admin/companion/remove',
        destroyLabel: 'Turn it off',
        cancelAction: 'admin/companion',
      }),
    );
  });

  app.post('/admin/companion/remove', (c: Context) => {
    if (!revokeCompanionToken(deps.db, currentUser(c).id)) return c.redirect('/admin/companion', 302);
    return savedRedirect(c, '/admin/companion', 'companion-removed');
  });

  function when(at: number): string {
    return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
  }

  function tokenCard(c: Context): string {
    const view = readCompanionToken(deps.db, deps.keyring, currentUser(c).id);
    if (view === undefined) {
      return card(
        `<h2>No token yet</h2>` +
          `<p>${escapeHtml(WHAT_IT_CAN_DO)}</p>` +
          `<form method="post" action="admin/companion"><button type="submit">Make a token</button></form>`,
      );
    }
    const used = view.lastUsedAt === null ? 'Not used yet.' : `Last used ${when(view.lastUsedAt)}.`;
    return card(
      `<h2>Your token</h2>` +
        `<p class="hint">Made ${escapeHtml(when(view.createdAt))}. ${escapeHtml(used)}</p>` +
        `<p>${escapeHtml(WHAT_IT_CAN_DO)}</p>` +
        (view.token === undefined
          ? errorBlock(
              'This token can no longer be read.',
              'The key it was sealed with is not the one this server has — after a restore without its key, ' +
                'say. It may still work where it is already pasted; replace it to see a new one.',
            )
          : /*
             * Behind a disclosure, so the page can be open on a laptop in a
             * kitchen without the token on show. The copy button is revealed by
             * `copy-button.js` only where it can work, `geolocate-button.js`'s
             * rule; without it, the field is still there to select.
             */
            `<details class="token-show"><summary>Show the token</summary>` +
            textField({
              label: 'Companion token',
              name: 'companion_token',
              value: view.token,
              attrs: 'id="companion-token" readonly autocomplete="off" spellcheck="false"',
            }) +
            `<button type="button" class="secondary" data-copy="companion-token" hidden>Copy</button>` +
            `</details>`) +
        `<div class="row">` +
        `<form method="get" action="admin/companion/replace"><button class="secondary" type="submit">Replace…</button></form>` +
        destructive('Turn off', { thing: 'the token', confirmAction: 'admin/companion/remove', variant: 'button' }) +
        `</div>`,
    );
  }

  function usage(c: Context): string {
    // The address a phone reaches, by `pairPage`'s rule: under ingress the
    // request's own origin is the supervisor's internal one.
    const origin = (ingressPath(c) !== '' ? deps.baseUrl : new URL(c.req.url).origin).replace(/\/+$/, '');
    const lists = readTodoLists(deps.db);
    const example = lists[0] === undefined ? 'Shopping' : todoListTitle(lists[0]);
    const curl = (path: string, body: unknown): string =>
      `curl -X POST ${origin}${path} \\\n` +
      `  -H "Authorization: Bearer YOUR_TOKEN" \\\n` +
      `  -H "Content-Type: application/json" \\\n` +
      `  -d '${JSON.stringify(body)}'`;
    const code = (text: string): string => `<pre class="code">${escapeHtml(text)}</pre>`;
    return section(
      'Add to a to-do list',
      'Send a POST with the list’s name and the item. Leave “list” out when you have only one.',
      code(curl('/companion/todo/add', { list: example, item: 'Milk' })) +
        `<p class="hint">${escapeHtml(QUERY_CAUTION)}</p>` +
        (lists.length === 0
          ? `<p>No to-do lists have been added yet. <a class="link" href="admin/home-assistant/lists">Add one on To-do lists</a>.</p>`
          : `<p>The lists it can add to: ${lists.map((list) => `“${escapeHtml(todoListTitle(list))}”`).join(', ')}. ` +
            `<a class="link" href="admin/home-assistant/lists">Change them on To-do lists</a>.</p>`),
    ) +
      section(
        'Timers',
        'Start one with “minutes” or “seconds” and an optional “label”. End one by its “label”, ' +
          'by the “id” the start answered with, or send “all”: true. A Timers widget on a wall counts it down.',
        code(curl('/companion/timers', { minutes: 10, label: 'Pasta' })) +
          code(curl('/companion/timers/end', { label: 'Pasta' })),
      ) +
      section(
        'Messages',
        'Send the “text”, and for how many “minutes” to show it — an hour when left out, a day at most. ' +
          'Clear one by its “id”, or send “all”: true. A Messages widget on a wall shows it.',
        code(curl('/companion/messages', { text: 'Back at 6', minutes: 90 })) +
          code(curl('/companion/messages/clear', { all: true })),
      );
  }

  function companionPage(c: Context): string {
    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: `${SCREEN} — Maverick Wall`,
      nav: 'system',
      heading: SCREEN,
      back: { label: 'System', href: 'admin/system' },
      saved: readSaved(c),
      intro:
        'A token lets a phone shortcut or an automation add to your to-do lists, start timers and ' +
        'send messages without signing in. ' +
        'It belongs to your account, and there is one at a time.',
      body: tokenCard(c) + usage(c),
    });
  }
}
