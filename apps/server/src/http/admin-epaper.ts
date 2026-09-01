import type { Context, Hono } from 'hono';
import { randomBytes } from 'node:crypto';

import {
  createEpaperScreen,
  panelCanvasOwner,
  readAdminScreens,
  readLayoutWidgets,
  readPeopleAdmin,
  revokeScreen,
  rotateScreenToken,
  setPanelSource,
  type AdminScreenRow,
} from '../api/queries.js';
import { readEnabledExternalModules } from '../api/external-modules.js';
import { keepWidgetsWithSomethingToSay, type Manifest, type PlacedWidgetRow } from '../api/manifest.js';
import { layoutWidgetBody } from '../api/widget-schema.js';
import { issueDisplayToken } from '../auth/tokens.js';
import { epaperOrientation, renderScreenFrame } from '../epaper/frame.js';
import { encodePng1bit } from '../epaper/png.js';
import { householdSetUp } from '../modules/index.js';
import { optionalText, parse, text, z } from '../validation.js';
import { layoutEditorMount, navModules, pairingSecret, widgetsNotDrawn, type AdminDeps } from './admin.js';
import { bytesOf } from './app.js';
import { confirmDestroyPage, errorBlock, escapeHtml, page, selectField, textField } from './html.js';
import { ingressPath } from './ingress.js';
import { readSaved, savedRedirect } from './saved.js';
import { selfHref } from './self.js';

/**
 * The eInk (e-paper) screens (RFC 006).
 *
 * Its own file rather than more of `admin.ts`, for the reason `admin-ha.ts`
 * and every `admin-*.ts` after it exists: a file nobody can hold in their head
 * is where a change goes wrong. This is a pure move — the routes, their paths,
 * their schemas and the pages they render are exactly what `admin.ts` held.
 *
 * It is a separate door from the browser walls, and that is what makes it a
 * seam rather than a slice. An e-paper panel is server-rendered and reached
 * either by a device that pulls its image or by Home Assistant pushing it to a
 * BLE tag, so nothing here is a QR to scan: it is a frame URL, two recipes,
 * and a designer that previews by *rendering* rather than by drawing a second
 * opinion of the frame in the browser.
 *
 * Three things it still shares with `admin.ts`, imported rather than copied,
 * because two copies of any of them is this project's most repeated bug:
 * `pairingSecret` (a panel is paired exactly as a wall is), `layoutEditorMount`
 * and `widgetsNotDrawn` (the designer here *is* the wall's editor, hosted on a
 * panel — a second mount is how the e-paper page silently lost its editor for
 * two releases once already).
 *
 * The Walls list's e-paper row (`epaperListCard`) deliberately stays in
 * `admin.ts`: it is a row in that list, not a page here.
 */

/**
 * E-paper panel presets, all 1-bit for now (RFC 006 phase 1). Dimensions are
 * the panel's native landscape resolution; rotation is a separate field.
 */
const EPAPER_PRESETS: Record<string, { label: string; width: number; height: number }> = {
  'seeed-7in5': { label: 'Seeed 7.5" · 800×480', width: 800, height: 480 },
  'waveshare-5in83': { label: '5.83" · 648×480', width: 648, height: 480 },
  'waveshare-4in2': { label: '4.2" · 400×300', width: 400, height: 300 },
  'waveshare-2in9': { label: '2.9" · 296×128', width: 296, height: 128 },
};

/**
 * What a panel draws: its built-in layout, its own canvas, or a wall's.
 *
 * One field rather than two, because the three answers are one decision and a
 * `<select>` is how a household makes it. `follow:` carries the wall it follows
 * — `default` for the Default display, otherwise a screen id, checked against
 * the screens that actually exist before anything is written (the regex only
 * says it is *shaped* like an id, which is not the same as it being one).
 */
const epaperSourceBody = z.object({
  source: z
    .unknown()
    .refine(
      (value) =>
        value === 'builtin' ||
        value === 'own' ||
        /^follow:(default|[A-Za-z0-9_-]{1,64})$/.test(String(value)),
      { error: () => 'Choose what this panel draws.' },
    )
    .transform((value) => String(value)),
});

const newEpaperBody = z.object({
  name: text('A name for the wall', 80),
  preset: text('A panel', 40),
  width: optionalText(6),
  height: optionalText(6),
  rotation: z
    .unknown()
    .refine((value) => ['0', '90', '180', '270'].includes(String(value)), {
      error: () => 'Rotation has to be a quarter turn.',
    })
    .transform((value) => Number(value)),
});

/**
 * The canvas the e-paper designer wants previewed — the boxes it has on screen
 * right now, which may not be saved yet. Same widget schema the save path
 * validates, so a preview can express nothing a save could not.
 */
const epaperPreviewBody = z.object({
  widgets: z.array(layoutWidgetBody).max(50),
});

/**
 * Every `/admin/epaper` route, registered in the order `admin.ts` registered
 * them — which is where it calls this, not at the top with the other modules.
 * Route order decides which pattern answers a path, so a move must not reorder.
 */
export function registerEpaperRoutes(app: Hono, deps: AdminDeps): void {
  // -------------------------------------------------------------------------
  // eInk (e-paper) displays (RFC 006)
  //
  // A separate door from the browser walls: an e-paper panel is server-rendered
  // and reached either by a device that pulls its image or by Home Assistant
  // pushing it to a BLE tag. So the page's job is not a QR to scan — it is the
  // frame URL and the two recipes that consume it.

  /**
   * The origin an e-paper device (or Home Assistant) can actually reach.
   *
   * Exactly the pairing link's problem: under ingress the request origin is the
   * supervisor's internal Docker address, which an ESPHome panel on the wall
   * cannot reach, so the URL comes from `base_url`; on the port the request
   * origin is what the household typed and is right.
   */
  const epaperOrigin = (c: Context): string => {
    const underIngress = ingressPath(c) !== '';
    return (underIngress ? deps.baseUrl : new URL(c.req.url).origin).replace(/\/+$/, '');
  };
  const frameUrlFor = (token: string, c: Context): string => `${epaperOrigin(c)}/d/epaper/${token}.png`;

  const esphomeRecipe = (url: string): string =>
    `esphome:\n` +
    `  name: kitchen-eink\n` +
    `esp32:\n` +
    `  board: esp32dev\n` +
    `wifi:\n` +
    `  ssid: !secret wifi_ssid\n` +
    `  password: !secret wifi_password\n\n` +
    `display:\n` +
    `  - platform: waveshare_epaper   # match your panel's driver\n` +
    `    model: 7.50inv2\n` +
    `    cs_pin: 5\n` +
    `    dc_pin: 17\n` +
    `    busy_pin: 4\n` +
    `    reset_pin: 16\n` +
    `    update_interval: never\n` +
    `    lambda: |-\n` +
    `      it.image(0, 0, id(wall_image));\n\n` +
    `online_image:\n` +
    `  - id: wall_image\n` +
    `    url: "${url}"\n` +
    `    format: PNG\n` +
    `    type: BINARY\n\n` +
    `deep_sleep:            # drop this block for a mains panel that carries alerts\n` +
    `  run_duration: 30s\n` +
    `  sleep_duration: 30min\n\n` +
    `interval:\n` +
    `  - interval: 25s\n` +
    `    then:\n` +
    `      - component.update: wall_image\n` +
    `      - component.update: display`;

  const haRecipe = (url: string): string =>
    `# configuration.yaml — Home Assistant fetches this URL; the wall is never called back\n` +
    `camera:\n` +
    `  - platform: generic\n` +
    `    name: eInk source\n` +
    `    still_image_url: "${url}"\n\n` +
    `# automation — runs entirely inside Home Assistant\n` +
    `triggers:\n` +
    `  - trigger: time_pattern\n` +
    `    minutes: "/15"\n` +
    `actions:\n` +
    `  - action: camera.snapshot\n` +
    `    target:\n` +
    `      entity_id: camera.eink_source\n` +
    `    data:\n` +
    `      filename: /media/eink/wall.png\n` +
    `  - action: opendisplay.upload_image\n` +
    `    data:\n` +
    `      device_id: <your OpenDisplay tag>\n` +
    `      image:\n` +
    `        media_content_id: media-source://media_source/local/eink/wall.png\n` +
    `        media_content_type: image/png\n` +
    `      fit_mode: contain\n` +
    `      dither: floyd_steinberg\n` +
    `      refresh_mode: full`;

  const codeBlock = (title: string, code: string): string =>
    `<h3 style="margin:18px 0 6px">${escapeHtml(title)}</h3>` +
    `<pre class="code">${escapeHtml(code)}</pre>`;

  /**
   * The page shown once a screen exists, carrying the token in the URL.
   *
   * The token is shown here and never stored in the clear, exactly like a
   * pairing link — so this is also where "Regenerate URL" lands. A URL that says
   * `localhost` cannot be reached from a wall panel, so we say so rather than
   * hand over a dead link.
   */
  const epaperConfigPage = (
    id: string,
    name: string,
    token: string,
    geometry: { width: number; height: number; rotation: number },
    c: Context,
  ): string => {
    const url = frameUrlFor(token, c);
    const unreachable = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'E-paper wall — Maverick Wall',
      nav: 'walls',
      heading: name,
      intro: `${geometry.width}×${geometry.height}, black & white${geometry.rotation === 0 ? '' : `, rotated ${geometry.rotation}°`}.`,
      body:
        (unreachable
          ? errorBlock(
              'This URL points at localhost, which a wall panel cannot reach.',
              'Set this add-on’s base URL (or open the admin by the address a device on your network uses), then regenerate the URL.',
            )
          : '') +
        `<p>This is the wall's image URL. It contains the wall's token, so it is ` +
        `shown <strong>once</strong> — copy it now. Regenerating makes a new one and ` +
        `retires this.</p>` +
        `<input readonly onclick="this.select()" value="${escapeHtml(url)}" ` +
        `style="width:100%;font:13px/1.4 ui-monospace,Menlo,Consolas,monospace" aria-label="Frame URL">` +
        `<p class="hint">A device pulls this image; Home Assistant can push it to a BLE tag. ` +
        `On battery, an e-paper panel is a glance — it sleeps, so it cannot show a weather ` +
        `takeover the moment it fires. A mains panel that polls can.</p>` +
        codeBlock('ESPHome — a wifi panel pulls the image', esphomeRecipe(url)) +
        codeBlock('Home Assistant — push to an OpenDisplay tag', haRecipe(url)) +
        `<div style="display:flex;gap:10px;margin-top:18px">` +
        `<a class="btn" href="admin/walls">Done</a>` +
        `<form method="get" action="admin/epaper/${encodeURIComponent(id)}/regenerate">` +
        `<button class="btn ghost" type="submit">Regenerate URL</button></form>` +
        `</div>`,
    });
  };

  /**
   * The read-only view of a screen that already exists — reached by GET, so
   * looking at a panel's recipes is never itself the thing that breaks it
   * (RFC 009, 1.8).
   *
   * The frame URL is never stored in the clear — it lives only in the
   * response that showed it, exactly like a wall's pairing link — so this
   * page cannot show the URL a household already flashed into a panel.
   * Regenerating is still one click away, but it is named for what it does
   * and asks first, rather than being the only way to see anything about the
   * screen at all.
   */
  const epaperViewPage = (
    c: Context,
    id: string,
    name: string,
    geometry: { width: number; height: number; rotation: number },
  ): string => {
    const placeholder = "<this wall's frame URL>";
    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'E-paper wall — Maverick Wall',
      nav: 'walls',
      heading: name,
      intro: `${geometry.width}×${geometry.height}, black & white${geometry.rotation === 0 ? '' : `, rotated ${geometry.rotation}°`}.`,
      body:
        `<p>The frame URL is shown only once — when this wall is added, or its ` +
        `URL is regenerated — and is never stored anywhere it could be shown again. ` +
        `If the panel or Home Assistant already has it configured, there is nothing ` +
        `to do here.</p>` +
        codeBlock('ESPHome — a wifi panel pulls the image', esphomeRecipe(placeholder)) +
        codeBlock('Home Assistant — push to an OpenDisplay tag', haRecipe(placeholder)) +
        `<div style="display:flex;gap:10px;margin-top:18px">` +
        `<a class="btn" href="admin/walls">Done</a>` +
        `<form method="get" action="admin/epaper/${encodeURIComponent(id)}/regenerate">` +
        `<button class="btn ghost" type="submit">Regenerate URL (the panel will need re-flashing)</button></form>` +
        `</div>`,
    });
  };

  /**
   * The add-an-e-paper-wall page.
   *
   * The list of e-paper walls themselves moved onto the merged `/admin/walls`
   * list (RFC 009 Phase 4, `epaperListCard`) — this page is now only the form,
   * reached from a link there. Kept at its own route rather than folded into
   * the Walls page's own markup because the size presets and rotation picker
   * are e-paper-specific and would otherwise crowd the pairing form every
   * household sees.
   */
  const epaperPage = (c: Context, error?: string): string => {
    const options = Object.entries(EPAPER_PRESETS)
      .map(([key, p]) => `<option value="${key}">${escapeHtml(p.label)}</option>`)
      .join('');

    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Add an e-paper wall — Maverick Wall',
      nav: 'walls',
      heading: 'Add an e-paper wall',
      saved: readSaved(c),
      intro:
        'Low-power e-paper panels. Maverick Wall renders the picture; a device pulls it, ' +
        'or Home Assistant pushes it to a BLE tag. Add one to get its image URL and the recipes.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        `<p><a class="link" href="admin/walls">← Back to walls</a></p>` +
        `<form method="post" action="admin/epaper" id="add">` +
        textField({
          label: 'Name',
          name: 'name',
          required: true,
          placeholder: 'Hallway tag',
          attrs: 'maxlength="80"',
        }) +
        selectField({
          label: 'Panel',
          name: 'preset',
          optionsHtml: `${options}<option value="custom">Custom size…</option>`,
          attrs: 'data-cond',
        }) +
        `<div class="grid g2" data-cond-show="custom">` +
        `<div>` +
        textField({ label: 'Width (px)', name: 'width', placeholder: '800', attrs: 'inputmode="numeric"' }) +
        `</div><div>` +
        textField({ label: 'Height (px)', name: 'height', placeholder: '480', attrs: 'inputmode="numeric"' }) +
        `</div></div>` +
        `<p class="hint">Width and height are only used for a Custom panel — with script ` +
        `off, both boxes show regardless of the panel chosen above. In the panel's ` +
        `native (landscape) resolution — rotation is separate.</p>` +
        selectField({
          label: 'Rotation',
          name: 'rotation',
          optionsHtml:
            `<option value="0">None</option><option value="90">90°</option>` +
            `<option value="180">180°</option><option value="270">270°</option>`,
        }) +
        `<p class="hint">Colour panels are coming; today every e-paper wall is rendered ` +
        `black &amp; white.</p>` +
        `<button class="btn" type="submit">Create</button>` +
        `</form>`,
    });
  };

  app.get('/admin/epaper', (c: Context) => c.html(epaperPage(c)));

  /**
   * A screen's recipes, read-only (RFC 009, 1.8).
   *
   * Reaching this by GET is the whole fix: before it existed, the only page
   * that could show anything about a screen was the one that minted — and
   * invalidated — a new token, so looking was indistinguishable from
   * breaking it.
   */
  app.get('/admin/epaper/:id', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const screen = readAdminScreens(deps.db).find(
      (candidate) => candidate.id === id && candidate.kind === 'epaper' && candidate.revokedAt === null,
    );
    if (screen === undefined) return c.html(epaperPage(c, 'That wall is no longer there.'), 404);
    return c.html(
      epaperViewPage(c, id, screen.name, {
        width: screen.panelWidth ?? 800, height: screen.panelHeight ?? 480, rotation: screen.rotation,
      }),
    );
  });

  app.post('/admin/epaper', async (c: Context) => {
    const shaped = parse(newEpaperBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(epaperPage(c, shaped.message), 400);

    let width: number;
    let height: number;
    if (shaped.value.preset === 'custom') {
      width = Number(shaped.value.width);
      height = Number(shaped.value.height);
      const sane = (n: number): boolean => Number.isInteger(n) && n >= 64 && n <= 2000;
      if (!sane(width) || !sane(height)) {
        return c.html(
          epaperPage(c, 'Give the panel a width and height in pixels, each between 64 and 2000.'),
          400,
        );
      }
    } else {
      const preset = EPAPER_PRESETS[shaped.value.preset];
      if (preset === undefined) return c.html(epaperPage(c, 'Choose a panel.'), 400);
      width = preset.width;
      height = preset.height;
    }

    const issued = issueDisplayToken();
    const id = randomBytes(6).toString('hex');
    createEpaperScreen(deps.db, id, shaped.value.name, pairingSecret(issued), {
      width,
      height,
      colour: 'bw',
      rotation: shaped.value.rotation,
    });
    return c.html(
      epaperConfigPage(id, shaped.value.name, issued.token, { width, height, rotation: shaped.value.rotation }, c),
    );
  });

  /**
   * Regenerating asks first — the old URL stops working immediately, and the
   * panel needs re-flashing with the new one. This is the GET half of the
   * GET-then-POST shape used everywhere else; it replaces the inline
   * inline confirm script the read-only recipes page used to carry, which
   * was the one bit of script in the server-rendered admin.
   */
  app.get('/admin/epaper/:id/regenerate', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const screen = readAdminScreens(deps.db).find(
      (candidate) => candidate.id === id && candidate.kind === 'epaper' && candidate.revokedAt === null,
    );
    if (screen === undefined) return c.redirect('/admin/walls', 302);
    return c.html(
      confirmDestroyPage({
        self: selfHref(c),
        modules: navModules(deps.db),
        title: 'Regenerate URL',
        nav: 'walls',
        heading: `Regenerate the URL for “${screen.name}”?`,
        intro: 'The old one stops working immediately, and the panel will need re-flashing with the new one.',
        destroyAction: `admin/epaper/${encodeURIComponent(id)}/regenerate`,
        destroyLabel: 'Regenerate it',
        cancelAction: `admin/epaper/${encodeURIComponent(id)}`,
        cancelLabel: 'Keep the current URL',
      }),
    );
  });

  app.post('/admin/epaper/:id/regenerate', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const screen = readAdminScreens(deps.db).find(
      (candidate) => candidate.id === id && candidate.kind === 'epaper' && candidate.revokedAt === null,
    );
    if (screen === undefined) return c.html(epaperPage(c, 'That wall is no longer there.'), 404);
    const issued = issueDisplayToken();
    rotateScreenToken(deps.db, id, pairingSecret(issued));
    return c.html(
      epaperConfigPage(
        id,
        screen.name,
        issued.token,
        { width: screen.panelWidth ?? 800, height: screen.panelHeight ?? 480, rotation: screen.rotation },
        c,
      ),
    );
  });

  /**
   * What this panel draws: its built-in layout, its own canvas, or a wall's.
   *
   * Following is the state direction B needed to exist. Copying a wall's canvas
   * onto a panel was always possible and gives two canvases that drift apart the
   * first time somebody moves a box; following gives *one* canvas on two media,
   * and each widget's `ink` override is how that one canvas says something
   * different in black and white.
   */
  app.post('/admin/epaper/:id/source', async (c: Context) => {
    const id = c.req.param('id') ?? '';
    const screen = findEpaper(id);
    if (screen === undefined) return c.html(epaperPage(c, 'That wall is no longer there.'), 404);
    const shaped = parse(epaperSourceBody, (await c.req.parseBody()) as Record<string, unknown>);
    // A rejected value re-renders the screen it was rejected on, saying why.
    // It used to answer a bare 302 back here carrying nothing, and the select
    // then re-drew the *stored* source — which is exactly what a successful
    // save looks like on this page, so the household was told a value they
    // never chose had been saved. `savedRedirect` is not the other half of
    // this: the strip has one tone and it is confirmation (see `saved.ts`),
    // so a refusal is a 400 with the page's own error block, like every other
    // rejected form in the admin.
    if (!shaped.ok) return c.html(epaperDesignPage(c, id, screen, shaped.message), 400);

    const choice = shaped.value.source;
    if (choice === 'builtin' || choice === 'own') {
      setPanelSource(deps.db, id, choice, null);
      return savedRedirect(c, `/admin/epaper/${encodeURIComponent(id)}/design`, 'epaper-source-saved');
    }

    // `follow:<id>` — the id has to name a wall that is actually there. The
    // schema only proved it is *shaped* like one, and a panel following a
    // screen that never existed would draw the built-in layout with no
    // explanation anywhere.
    const target = choice.slice('follow:'.length);
    if (target === 'default') {
      setPanelSource(deps.db, id, 'follow', null);
      return savedRedirect(c, `/admin/epaper/${encodeURIComponent(id)}/design`, 'epaper-source-saved');
    }
    const wall = readAdminScreens(deps.db).find(
      (candidate) => candidate.id === target && candidate.id !== id && candidate.revokedAt === null,
    );
    if (wall === undefined) {
      // The design page, not `epaperPage`: the panel is fine and the household
      // is standing on its layout screen, so answering with the add-an-e-paper-
      // wall form threw away where they were and offered them a second panel
      // for an error about the first. The 404s above are the other case and
      // still render that page — there the *panel* is gone, so there is no
      // design page left to draw.
      return c.html(epaperDesignPage(c, id, screen, 'That wall is no longer there.'), 400);
    }
    setPanelSource(deps.db, id, 'follow', wall.id);
    return savedRedirect(c, `/admin/epaper/${encodeURIComponent(id)}/design`, 'epaper-source-saved');
  });

  /**
   * Removing an eInk screen asks first — the GET half of the GET-then-POST
   * shape used everywhere else, replacing the inline confirm script
   * the list card used to carry.
   */
  app.get('/admin/epaper/:id/delete', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const screen = readAdminScreens(deps.db).find(
      (candidate) => candidate.id === id && candidate.kind === 'epaper' && candidate.revokedAt === null,
    );
    if (screen === undefined) return c.redirect('/admin/walls', 302);
    return c.html(
      confirmDestroyPage({
        self: selfHref(c),
        modules: navModules(deps.db),
        title: 'Remove e-paper wall',
        nav: 'walls',
        heading: `Remove “${screen.name}”?`,
        intro: 'Its URL stops working immediately, and any device or automation using it will fail.',
        destroyAction: `admin/epaper/${encodeURIComponent(id)}/revoke`,
        destroyLabel: 'Remove it',
        cancelAction: 'admin/walls',
      }),
    );
  });

  app.post('/admin/epaper/:id/revoke', (c: Context) => {
    revokeScreen(deps.db, c.req.param('id') ?? '');
    return savedRedirect(c, '/admin/walls', 'epaper-screen-removed');
  });

  const findEpaper = (id: string): AdminScreenRow | undefined =>
    readAdminScreens(deps.db).find((s) => s.id === id && s.kind === 'epaper' && s.revokedAt === null);

  /**
   * The canvas a panel draws: its own, a wall's, or none (the built-in layout).
   *
   * `panelCanvasOwner` is the one resolver, shared with the device endpoint, so
   * the preview on this page and the frame on the glass can never disagree
   * about whose boxes they are — which is the failure this project keeps
   * finding whenever two places answer one question.
   */
  const epaperWidgetsFor = (id: string, screen: AdminScreenRow): PlacedWidgetRow[] => {
    const owner = panelCanvasOwner({ ...screen, id });
    return owner === undefined ? [] : readLayoutWidgets(deps.db, owner, epaperOrientation(screen));
  };

  /**
   * The saved layout, drawn exactly as the panel will — the one honest preview.
   *
   * The editor's own live preview is DOM, which has colour and anti-aliasing a
   * 1-bit panel does not; this renders the real frame through the same path the
   * device fetches, so what the household arranges is what they will see. Behind
   * the session, and never cached — it changes every time the layout is saved.
   *
   * "Exactly as the panel will" includes the omission (RFC 009 Phase 2): the
   * device endpoint drops the widgets the household has nothing set up for, so
   * this drops them too. A page captioned "what the panel actually draws" that
   * draws "No weather yet" where the glass shows nothing is the two-renderers
   * disagreement in its most misleading form — the disagreement is with the
   * caption rather than between two files, and it is no less wrong.
   */
  app.get('/admin/epaper/:id/preview.png', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const screen = findEpaper(id);
    if (screen === undefined || deps.previewManifest === undefined) return c.body(null, 404);
    try {
      const widgets = keepWidgetsWithSomethingToSay(
        epaperWidgetsFor(id, screen),
        householdSetUp(deps.db),
      ).map((row) => ({
        type: row.type,
        x: row.x,
        y: row.y,
        w: row.w,
        h: row.h,
        z: row.z,
        config: row.config !== null && typeof row.config === 'object' ? (row.config as Record<string, unknown>) : {},
      }));
      const frame = renderScreenFrame(deps.previewManifest(id) as Manifest, screen, widgets);
      c.header('cache-control', 'no-store');
      return c.body(bytesOf(Buffer.from(encodePng1bit(frame.fb))), 200, { 'content-type': 'image/png' });
    } catch {
      return c.body(null, 503);
    }
  });

  /**
   * The same 1-bit frame, for a canvas that has not been saved yet.
   *
   * The designer's arrange area used to be drawn by the *wall* renderer, so an
   * arrangement for a black-and-white panel was shown in colour cards and
   * looked nothing like the thing it was for. The fix is not to teach the
   * browser a second 1-bit renderer — two renderers disagreeing is the whole
   * problem — but to let the editor post the boxes it has and get back the
   * exact frame the panel would draw, from the one renderer that draws it.
   *
   * Nothing is stored. `POST` because a canvas does not belong in a URL, and
   * `no-store` because this frame is a keystroke old.
   *
   * Renders exactly the canvas it is posted, and does not second-guess it: the
   * caller decides what to draw. The editor posts what it draws — the same
   * filtered set its own preview uses (RFC 009 Phase 2), so the arrange
   * backdrop and the ink-lane frame agree with the saved preview above and with
   * the device. Nothing is ungrabbable as a result: the draggable boxes are the
   * editor's overlay and are always the whole canvas, so a flagged widget keeps
   * its box and loses only the ink under it, which is what its flag says.
   *
   * The posted boxes are the canvas *by definition* here, whatever the row says.
   * A panel that has never been saved has `layout_mode` NULL, and reading it
   * would have drawn the built-in layout for every arrangement — a backdrop
   * that never moves while you drag, which is the very fault this endpoint
   * exists to fix. That used to need an explicit `layoutMode: 'freeform'` on
   * the way in; `renderScreenFrame` now takes the widgets as the answer, so
   * there is nothing to override. Posting an empty canvas still falls back to
   * the built-in layout exactly as a saved empty one does.
   */
  app.post('/admin/epaper/:id/preview.png', async (c: Context) => {
    const id = c.req.param('id') ?? '';
    const screen = findEpaper(id);
    if (screen === undefined || deps.previewManifest === undefined) return c.body(null, 404);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ ok: false, message: 'That was not readable as JSON.' }, 400);
    }
    const shaped = parse(epaperPreviewBody, raw);
    if (!shaped.ok) return c.json({ ok: false, message: shaped.message }, 400);
    try {
      const widgets = shaped.value.widgets.map((widget) => ({
        type: widget.type,
        x: widget.x,
        y: widget.y,
        w: widget.w,
        h: widget.h,
        z: widget.z,
        config: widget.config !== undefined ? (widget.config as Record<string, unknown>) : {},
      }));
      const frame = renderScreenFrame(deps.previewManifest(id) as Manifest, screen, widgets);
      c.header('cache-control', 'no-store');
      return c.body(bytesOf(Buffer.from(encodePng1bit(frame.fb))), 200, { 'content-type': 'image/png' });
    } catch {
      return c.body(null, 503);
    }
  });

  /**
   * Design an e-paper panel's layout — the same drag-and-drop editor a browser
   * wall uses, on this panel's own canvas, with the real 1-bit preview beside it.
   *
   * The editor writes the same `layout_widgets` and flips the screen to
   * `freeform` on save (`replaceLayout`), so nothing here has to. The canvas
   * aspect is seeded from the panel geometry so a box drawn square is square on
   * the panel; the household still sees the truth in the preview regardless.
   */
  const epaperDesignPage = (c: Context, id: string, screen: AdminScreenRow, error?: string): string => {
    const pw = screen.panelWidth ?? 800;
    const ph = screen.panelHeight ?? 480;
    const landscapeAspect = Math.max(pw, ph) / Math.min(pw, ph);
    const portraitAspect = Math.min(pw, ph) / Math.max(pw, ph);
    // The panel's own ratio, never a stored one. On a browser wall the aspect is
    // a guess about a screen nobody measured, so the household may set it; a
    // panel is 800x480 and that is the end of it. Honouring a stored 16:9 here
    // drew the boxes on a canvas the device cannot show, which is how a widget
    // ended up somewhere other than where it was dragged. Saving writes this
    // value back, so a canvas arranged before this is corrected on first save.
    const canvas = (orientation: 'portrait' | 'landscape') => ({
      aspect: orientation === 'landscape' ? landscapeAspect : portraitAspect,
      widgets: readLayoutWidgets(deps.db, id, orientation).map((w) => ({
        id: w.id,
        type: w.type,
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
        z: w.z,
        config: w.config,
      })),
      background: undefined,
    });
    const initial = {
      screen: id,
      // Tells the editor its host is a panel, so its Reset confirm says what
      // reset actually does here (back to the built-in layout, not Classic).
      kind: 'epaper',
      // The one orientation this panel will ever draw, so the editor opens on
      // the canvas the device reads rather than on the wall's portrait default.
      // The other canvas is still loaded and saved; it is simply not the one a
      // household is shown for a panel bolted to a wall in one orientation.
      orientation: epaperOrientation(screen),
      panel: { width: pw, height: ph },
      mode: 'freeform',
      portrait: canvas('portrait'),
      landscape: canvas('landscape'),
      // eInk ignores calendar-source and reading selection today (it draws them
      // whole), so those pickers start empty; the module picker is real.
      calendars: [],
      readings: [],
      modules: readEnabledExternalModules(deps.db).map((m) => ({ id: m.id, name: m.name })),
      // The Shift widget's "whose rota" is real here: a panel filters by person
      // exactly as the wall does, and draws a line each when several are on.
      people: readPeopleAdmin(deps.db).map((p) => ({ id: p.id, name: p.name })),
      // The panel omits the same widgets the wall does, so it says the same
      // thing about them.
      notDrawn: widgetsNotDrawn(deps.db),
    };

    /*
     * What this panel draws, and — when it follows a wall — where to change it.
     *
     * A following panel deliberately does *not* mount the editor. The editor
     * saves under the screen it was opened for, and `replaceLayout` flips that
     * screen to `freeform`, so arranging here would silently stop the panel
     * following the wall it was told to follow. The wall's own editor is where
     * the widgets live, and the ink lane there is where a panel says something
     * different — so this page sends the household to it rather than growing a
     * second place to arrange one canvas.
     */
    const followed = screen.layoutMode === 'follow' ? (screen.layoutFollows ?? null) : undefined;
    const walls = readAdminScreens(deps.db).filter(
      (candidate) => candidate.id !== id && candidate.revokedAt === null && candidate.kind !== 'epaper',
    );
    const followedName =
      followed === undefined
        ? ''
        : followed === null
          ? 'the Default wall'
          : (walls.find((w) => w.id === followed)?.name ?? 'a wall that is no longer there');
    const currentSource =
      screen.layoutMode === 'freeform' ? 'own' : followed === undefined ? 'builtin' : `follow:${followed ?? 'default'}`;
    const sourceOption = (value: string, label: string): string =>
      `<option value="${escapeHtml(value)}"${value === currentSource ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    const sourceForm =
      `<h2 class="add">What this panel draws</h2>` +
      `<form method="post" action="admin/epaper/${encodeURIComponent(id)}/source"><div class="row">` +
      selectField({
        label: 'Layout',
        name: 'source',
        optionsHtml:
          sourceOption('builtin', 'Its built-in layout') +
          sourceOption('own', 'Its own layout') +
          sourceOption('follow:default', "The Default wall's layout") +
          walls.map((w) => sourceOption(`follow:${w.id}`, `${w.name}'s layout`)).join(''),
        hint:
          // Escaped by `fieldWrap`, so the ampersand is written plainly here:
          // an `&amp;` in a hint reaches the page as a literal `&amp;`.
          'Following a wall draws that layout in black & white — move a box there ' +
          'and this panel moves with it. Each widget can say less on ink without changing the wall.',
      }) +
      `<button class="secondary" type="submit">Use this</button></div></form>`;

    const preview =
      `<h2 class="add">Preview</h2>` +
      `<p class="hint">What the panel actually draws, in black &amp; white. Save your ` +
      `changes and it updates within a few seconds.</p>` +
      `<img id="ep-preview" class="ep-paper" alt="eInk preview of ${escapeHtml(screen.name)}" ` +
      `src="admin/epaper/${encodeURIComponent(id)}/preview.png">` +
      `<script>(function(){var i=document.getElementById('ep-preview');if(!i)return;` +
      `setInterval(function(){i.src='admin/epaper/${encodeURIComponent(id)}/preview.png?t='+Date.now();},4000);})();</script>`;

    const arrangeHeading = `<h2 class="add">Arrange</h2>`;
    const followNote =
      followed === undefined
        ? ''
        : `<h2 class="add">Arrange</h2>` +
          `<p class="hint">This panel follows <b>${escapeHtml(followedName)}</b>. Arrange it there — ` +
          `and use the <b>On ink</b> lane beside a widget to say less on this panel without changing ` +
          `that wall.</p>` +
          `<p><a class="btn" href="admin/walls/${
            followed === null ? 'default' : encodeURIComponent(followed)
          }#layout">Open ${escapeHtml(followedName)}</a></p>`;

    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: `${screen.name} layout — Maverick Wall`,
      nav: 'walls',
      heading: `${screen.name} — layout`,
      saved: readSaved(c),
      intro: `${pw}×${ph}, black & white. Drag widgets to build the panel; the preview shows the real result. Colour, gradient and shadow options do not apply on e-paper.`,
      body:
        // Above the form it belongs to, which is the whole of the fix: a
        // rejected source used to redirect here saying nothing, and a page
        // showing the stored value with no message on it is what a *saved*
        // one looks like.
        (error === undefined ? '' : errorBlock(error)) +
        sourceForm +
        preview +
        followNote +
        (followed !== undefined ? '' : arrangeHeading + layoutEditorMount(initial) +
        // The one save bar, same chrome as the display page minus its
        // settings form — with no form the chrome saves the canvas and
        // reloads. Chrome first, so its `mwEditorState` hook is registered
        // before the editor publishes its bridge.
        `<div class="savebar" id="savebar">` +
        `<span class="msg" role="alert"></span>` +
        `<span class="savebar-flag" data-dirty-flag hidden>Unsaved changes</span>` +
        `<button type="button" class="btn-ghost" data-action="discard">Discard</button>` +
        `<button type="button" class="btn" data-action="save">Save layout</button>` +
        `</div>` +
        `<script type="module" src="assets/display-editor.js"></script>` +
        `<script type="module" src="assets/layout-editor.js"></script>`),
    });
  };

  app.get('/admin/epaper/:id/design', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const screen = findEpaper(id);
    if (screen === undefined) return c.redirect('/admin/walls', 302);
    return c.html(epaperDesignPage(c, id, screen));
  });
}
