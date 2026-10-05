import type { Context, Hono } from 'hono';

import {
  MAX_WEBHOOK_TARGETS,
  createWebhookTarget,
  deleteWebhookTarget,
  readWebhookTargets,
  setWebhookPressable,
  webhookCallsHomeAssistant,
  webhookHost,
  webhookTargetBody,
  type WebhookTargetRow,
} from '../modules/webhooks/index.js';
import { readWallActions } from '../modules/homeassistant/control.js';
import { checkbox, parse, z } from '../validation.js';
import {
  confirmDestroyPage,
  errorBlock,
  escapeHtml,
  icon,
  networkAccessLabel,
  page,
  switchRow,
  textField,
} from './html.js';
import { card, dataTable, destructive, emptyState, section, tag } from './components.js';
import { readSaved, savedRedirect } from './saved.js';
import { navModules, type AdminDeps } from './admin.js';
import { selfHref } from './self.js';

/**
 * Webhook buttons, in the admin (RFC 018 §9, phase 5).
 *
 * Where a button's address is set, and the only place: never on the wall,
 * which sends a button's id and nothing else (MQ9). The address is sealed as
 * soon as it is saved and never shown again — only its host, because the path
 * of a webhook is usually its whole secret. Each button has the second of RFC
 * 018's three switches, "Can be pressed from walls", off when it is made.
 */

const pressableBody = z.object({
  pressable: checkbox().optional(),
});

/** A webhook into Home Assistant is a script by another name (RFC 018 §9). */
const HA_WEBHOOK_CAUTION =
  'This calls a Home Assistant webhook, which runs whatever automation it is attached to — ' +
  'a script by another name. Allow it only if you would let a guest in your kitchen run it.';

export function registerButtonRoutes(app: Hono, deps: AdminDeps): void {
  const now = deps.now ?? ((): number => Date.now());

  app.get('/admin/buttons', (c: Context) => c.html(buttonsPage(c)));
  app.get('/admin/buttons/new', (c: Context) => c.html(newButtonPage(c)));

  app.post('/admin/buttons', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = parse(webhookTargetBody, body);
    if (!shaped.ok) return c.html(newButtonPage(c, shaped.message, body), 400);
    if (readWebhookTargets(deps.db).length >= MAX_WEBHOOK_TARGETS) {
      return c.html(
        newButtonPage(c, `There are already ${MAX_WEBHOOK_TARGETS} buttons. Remove one before adding another.`, body),
        400,
      );
    }
    // A shape check, not a reachability check: an address is only proved by
    // pressing it, which is the household's to do from a wall.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(shaped.value.url);
    } catch {
      return c.html(newButtonPage(c, 'That is not an address. Paste the whole thing, starting https://.', body), 400);
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      return c.html(newButtonPage(c, 'A button can only call an http or https address.', body), 400);
    }
    if (parsedUrl.protocol === 'http:' && shaped.value.allow_http !== true) {
      return c.html(
        newButtonPage(c, `That address is plain http. Tick “${networkAccessLabel('allowHttp')}” if you mean it.`, body),
        400,
      );
    }
    const headerName = shaped.value.header_name ?? '';
    createWebhookTarget(
      deps.db,
      deps.keyring,
      {
        name: shaped.value.name,
        url: shaped.value.url,
        headerName: headerName === '' ? null : headerName,
        headerValue: headerName === '' ? null : (shaped.value.header_value ?? ''),
        allowLan: shaped.value.allow_lan === true,
        allowHttp: shaped.value.allow_http === true,
      },
      now(),
    );
    return savedRedirect(c, '/admin/buttons', 'button-added');
  });

  app.post('/admin/buttons/:id/pressable', async (c: Context) => {
    const id = c.req.param('id') ?? '';
    const shaped = parse(pressableBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(buttonsPage(c, shaped.message), 400);
    const on = shaped.value.pressable === true;
    // A token is a claim: a button removed in another tab changed nothing.
    if (!setWebhookPressable(deps.db, id, on, now())) return c.redirect('/admin/buttons', 302);
    return savedRedirect(c, '/admin/buttons', on ? 'button-pressable' : 'button-not-pressable');
  });

  app.get('/admin/buttons/:id/remove', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const target = readWebhookTargets(deps.db).find((row) => row.id === id);
    if (target === undefined) return c.redirect('/admin/buttons', 302);
    return c.html(
      confirmDestroyPage({
        self: selfHref(c),
        modules: navModules(deps.db),
        title: 'Remove button',
        nav: 'buttons',
        heading: `Remove “${target.name}”?`,
        intro:
          'Its address and any header are forgotten, and every wall showing it stops drawing it. ' +
          'What it calls is not touched.',
        destroyAction: `admin/buttons/${encodeURIComponent(id)}/remove`,
        destroyLabel: 'Remove it',
        cancelAction: 'admin/buttons',
      }),
    );
  });

  app.post('/admin/buttons/:id/remove', (c: Context) => {
    if (!deleteWebhookTarget(deps.db, c.req.param('id') ?? '')) return c.redirect('/admin/buttons', 302);
    return savedRedirect(c, '/admin/buttons', 'button-removed');
  });

  function buttonCard(target: WebhookTargetRow): string {
    // The host only — never the path, which is where a webhook's secret lives.
    const host = webhookHost(deps.db, deps.keyring, target.id);
    const caution = webhookCallsHomeAssistant(deps.db, deps.keyring, target.id) ? ` ${HA_WEBHOOK_CAUTION}` : '';
    return card(
      `<div class="card-head"><div class="card-head-main">` +
        `<h2>${escapeHtml(target.name)}</h2>` +
        `<p class="host">${escapeHtml(host ?? 'An address that could not be read')}` +
        `${target.headerName === null ? '' : ` · sends ${escapeHtml(target.headerName)}`}</p>` +
        (target.pressable ? tag('Can be pressed from walls', 'accent') : tag('Not pressable', 'neutral')) +
        `</div>` +
        `<details class="ovf" data-overflow>` +
        `<summary class="ovf-btn" role="button" aria-haspopup="menu" ` +
        `aria-label="More actions for ${escapeHtml(target.name)}" title="More">${icon('more')}</summary>` +
        `<div class="ovf-menu" role="menu">` +
        destructive('Remove', {
          thing: target.name,
          confirmAction: `admin/buttons/${encodeURIComponent(target.id)}/remove`,
        }) +
        `</div></details></div>` +
        `<form method="post" action="admin/buttons/${encodeURIComponent(target.id)}/pressable">` +
        switchRow({
          label: 'Can be pressed from walls',
          name: 'pressable',
          checked: target.pressable,
          hint:
            `With this on, ${target.name} can be pressed — and held — from a wall whose Touch ` +
            `controls allow operating things in the house, in a Buttons widget set to Tap to ` +
            `operate.${caution}`,
        }) +
        `<button type="submit">Save</button></form>`,
    );
  }

  function pressesSection(): string {
    const presses = readWallActions(deps.db, now()).filter((press) => press.action === 'press');
    if (presses.length === 0) return '';
    return section(
      'Recent presses from walls',
      'The last fourteen days. Kept here only — not in the logs, and not in the diagnostics export.',
      dataTable(
        [{ label: 'When' }, { label: 'Wall' }, { label: 'Button' }, { label: 'Result' }],
        presses.map((press) => [
          escapeHtml(new Date(press.at).toISOString().slice(0, 16).replace('T', ' ')),
          escapeHtml(press.wall),
          escapeHtml(press.reading),
          press.ok ? tag('Done', 'ok') : `${tag('Failed', 'danger')} ${escapeHtml(press.message ?? '')}`,
        ]),
      ),
    );
  }

  function buttonsPage(c: Context, error?: string): string {
    const targets = readWebhookTargets(deps.db);
    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Buttons — Maverick Wall',
      nav: 'buttons',
      heading: 'Buttons',
      saved: readSaved(c),
      action: { label: 'Add a button', href: 'admin/buttons/new' },
      intro:
        'A button on a wall that calls an address you set here — a Home Assistant webhook, ' +
        'a Node-RED flow, anything that answers a POST. The address is kept sealed and is ' +
        'never sent to a wall. A Buttons widget draws them.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        (targets.length === 0
          ? emptyState('No buttons yet.', { label: 'Add a button', href: 'admin/buttons/new' })
          : targets.map(buttonCard).join('')) +
        pressesSection(),
    });
  }

  /**
   * Adding a button, on a page of its own (P2.1). A refused form comes back
   * with what was typed — the address included, since it is the household's
   * own and has not been stored — except the header's secret value, which is
   * never written into a page.
   */
  function newButtonPage(c: Context, error?: string, values?: Record<string, unknown>): string {
    const typed = (key: string): string =>
      typeof values?.[key] === 'string' ? (values[key] as string) : '';
    const ticked = (key: string): boolean => typeof values?.[key] === 'string' && values[key] !== '';
    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Add a button — Maverick Wall',
      nav: 'buttons',
      heading: 'Add a button',
      back: { label: 'Buttons', href: 'admin/buttons' },
      body:
        (error === undefined ? '' : errorBlock(error)) +
        `<form method="post" action="admin/buttons">` +
        textField({ label: 'Name', name: 'name', required: true, placeholder: 'Doorbell chime', value: typed('name'), attrs: 'maxlength="40"' }) +
        textField({
          label: 'Address',
          name: 'url',
          required: true,
          placeholder: 'https://',
          value: typed('url'),
          attrs: 'autocomplete="off" spellcheck="false"',
        }) +
        `<p class="hint">Called with an empty POST, and never followed if it redirects. ` +
        `It is sealed when you save and only its host is shown again.</p>` +
        textField({ label: 'Header name (optional)', name: 'header_name', value: typed('header_name'), attrs: 'autocomplete="off"' }) +
        textField({ label: 'Header value (optional)', name: 'header_value', type: 'password', attrs: 'autocomplete="new-password"' }) +
        switchRow({
          label: networkAccessLabel('allowPrivateNetwork'),
          name: 'allow_lan',
          checked: ticked('allow_lan'),
          hint:
            'For an address on your own network, such as Home Assistant or Node-RED at home — ' +
            'this machine included.',
        }) +
        switchRow({
          label: networkAccessLabel('allowHttp'),
          name: 'allow_http',
          checked: ticked('allow_http'),
          hint: 'The address and any header travel unencrypted. Only for your own network.',
        }) +
        `<button type="submit">Add button</button></form>`,
    });
  }
}

