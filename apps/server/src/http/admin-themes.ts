import type { Context, Hono } from 'hono';
import {
  confirmDestroyPage,
  escapeHtml,
  errorBlock,
  page,
  segControl,
  selectField,
  textField,
} from './html.js';
import { destructive, section, tag } from './components.js';
import { navModules, type AdminDeps } from './admin.js';
import {
  COLOUR_TOKENS,
  createTheme,
  deleteTheme,
  FALLBACK_THEME,
  FONTS,
  FONT_TOKENS,
  readTheme,
  readThemes,
  themeShapeSchema,
  themeTokensSchema,
  themeUsage,
  themeUsageOf,
  updateTheme,
  type ThemeRow,
  type ThemeShape,
  type ThemeTokens,
} from '../api/themes.js';
import { colour, oneOf, parse, text } from '../validation.js';
import { generateThemeTokens } from '../api/theme-generator.js';
import { readSaved, savedRedirect } from './saved.js';
import { selfHref } from './self.js';
import {
  LEGACY_THEME_ALIASES,
  themeChoices,
  themeDisplayCard,
  themeName,
  type ThemeChoice,
} from './theme-cards.js';

/**
 * Themes: the gallery, and the custom-theme builder.
 *
 * The built-in token sets live in the display bundle as code; this screen is
 * where every theme a wall can draw is seen, and where a household builds one
 * of its own. The form is server-rendered and saves with a plain POST — it
 * works with no scripting — and `assets/theme-editor.js` enhances it with a
 * live preview and contrast guidance. A custom theme is selectable on a wall's
 * own page exactly like a built-in.
 */

/**
 * A new theme starts from a known-legible dark palette.
 *
 * Deliberately not described as any shipped theme's: it is close to none of
 * the five, and naming it after one is how a screen comes to name a theme that
 * no longer exists (RFC 015 §2.1).
 */
const DEFAULT_TOKENS: ThemeTokens = {
  '--bg': '#0B0E11',
  '--panel': '#151A21',
  '--rule': '#242D38',
  '--ink': '#E9EEF4',
  '--muted': '#7E8C9C',
  '--faint': '#4A5563',
  '--accent': '#E8A33D',
  '--s-day': '#E8A33D',
  '--s-night': '#4C7FD1',
  '--s-break': '#35916A',
  '--s-straight': '#6B7684',
  '--radius': '0.2rem',
};

/**
 * Each editable colour with the plain-language account of what it drives.
 *
 * `--faint`'s line carries one more thing, and it is the second of RFC 015
 * §2.6's four facts: it is deliberately below the contrast bar, so the
 * contrast guide beside the preview flags it on every theme ever built. Said
 * here rather than beside the guide, because the guide is where somebody reads
 * the warning and this is where they would otherwise go to "fix" it.
 */
const TOKEN_HELP: readonly { readonly key: string; readonly label: string; readonly help: string }[] = [
  { key: '--bg', label: 'Background', help: 'The wall behind everything.' },
  { key: '--panel', label: 'Panels', help: 'The surface of cards and the month grid.' },
  { key: '--rule', label: 'Lines', help: 'Hairline borders between things.' },
  { key: '--ink', label: 'Text', help: 'The main reading colour.' },
  { key: '--muted', label: 'Muted text', help: 'Secondary text — times and labels.' },
  {
    key: '--faint',
    label: 'Faint text',
    help:
      'The quietest text — past days. Deliberately below the contrast bar: it is ' +
      'meant to recede, so the guide flagging it is not a fault to fix.',
  },
  { key: '--accent', label: 'Accent', help: 'Today, and highlights across the wall.' },
  { key: '--s-day', label: 'Day shift', help: 'The colour of a day shift.' },
  { key: '--s-night', label: 'Night shift', help: 'The colour of a night shift.' },
  { key: '--s-break', label: 'Rest day', help: 'A day the rota says is off.' },
  { key: '--s-straight', label: 'Other shift', help: 'Any other shift type.' },
];

const RADII: readonly { readonly value: string; readonly label: string }[] = [
  { value: '0', label: 'Sharp' },
  { value: '0.2rem', label: 'Subtle' },
  { value: '0.4rem', label: 'Soft' },
  { value: '1.2rem', label: 'Round' },
];

/**
 * The shape control's own words, in `THEME_SHAPES`' order (RFC 014 §4.3).
 * Every value in that enum needs a label here — a theme's colours are its
 * own, but its *shape* borrows a built-in's, and the label says which rules
 * come along: Almanac's italic date, Panels' card borders, Blueprint's
 * square corners, Swiss's flat rules with no cards at all.
 */
const SHAPE_OPTIONS: readonly { readonly value: ThemeShape; readonly label: string }[] = [
  { value: 'neutral', label: 'None' },
  { value: 'panels', label: 'Panels' },
  { value: 'household', label: 'Household' },
  { value: 'blueprint', label: 'Blueprint' },
  { value: 'almanac', label: 'Almanac' },
  { value: 'swiss', label: 'Swiss' },
];

/**
 * The shadow control's two answers (decision D8, plan item P4.4).
 *
 * Soft is the derived default and is stored as an absence, so every theme a
 * household built before this existed reads as Soft — which is the shadow a
 * widget that asked for one used to cast. None is stored as the CSS value
 * itself (`themeTokensSchema`'s one literal), which is what a household with
 * an OLED screen wants: every drop shadow on the wall off in one place.
 */
const SHADOW_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'soft', label: 'Soft' },
];

const nameBody = text('A name for the theme', 60);

export function registerThemeRoutes(app: Hono, deps: AdminDeps): void {
  // ---- routes --------------------------------------------------------------

  app.get('/admin/themes', (c: Context) => c.html(themesPage(c)));

  // Adding a theme is this page (P2.1): the builder, with "Generate from a
  // colour" at its head — the second way to start one, which used to sit at
  // the foot of the Themes list beside the app bar's own action.
  app.get('/admin/themes/new', (c: Context) => c.html(builderPage(null, undefined, undefined, c)));

  app.get('/admin/themes/:id', (c: Context) => {
    const theme = readTheme(deps.db, c.req.param('id') ?? '');
    if (theme === undefined) return c.redirect('/admin/themes', 302);
    return c.html(builderPage(theme, undefined, undefined, c));
  });

  app.post('/admin/themes', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = shapeSubmission(body);
    if (!shaped.ok) return c.html(builderPage(null, body, shaped.message, c), 400);
    createTheme(deps.db, shaped.value);
    return savedRedirect(c, '/admin/themes', 'theme-created');
  });

  /**
   * Generate a full theme from one seed colour, then store it through the
   * exact create path a hand-built theme takes: the generator's output is
   * validated by the same schema (rule five — the generator is ours, but the
   * invariant is cheaper to prove than to trust), so the result is an
   * ordinary custom theme — previewable in the builder, editable afterwards,
   * resolved with tints and carried in the manifest like any other.
   */
  app.post('/admin/themes/generate', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    // A refusal comes back to the add page it was sent from, with what was
    // typed, and the error above the form that produced it.
    const refuse = (message: string): Response =>
      c.html(builderPage(null, undefined, undefined, c, { message, values: body }), 400);
    const name = parse(nameBody, body['name']);
    if (!name.ok) return refuse(name.message);
    const seed = parse(colour(), body['seed']);
    if (!seed.ok) return refuse('Pick a seed colour.');
    const mode = parse(oneOf('Dark or light', ['dark', 'light'] as const), body['mode']);
    if (!mode.ok) return refuse('Choose dark or light.');

    const tokens = themeTokensSchema.parse(generateThemeTokens(seed.value, mode.value));
    // A generated theme starts with no shape borrowed — its whole point is a
    // palette worked out from one colour, and picking a built-in's shape too
    // is a second decision the household can make afterwards, in the builder.
    const created = createTheme(deps.db, { name: name.value, tokens, shape: 'neutral' });
    // Land in the builder so the result is immediately previewable and editable.
    return savedRedirect(c, `/admin/themes/${encodeURIComponent(created.id)}`, 'theme-generated');
  });

  app.post('/admin/themes/:id', async (c: Context) => {
    const id = c.req.param('id') ?? '';
    const existing = readTheme(deps.db, id);
    if (existing === undefined) return c.redirect('/admin/themes', 302);
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = shapeSubmission(body);
    if (!shaped.ok) return c.html(builderPage(existing, body, shaped.message, c), 400);
    updateTheme(deps.db, id, shaped.value);
    return savedRedirect(c, '/admin/themes', 'theme-saved');
  });

  /**
   * Removing a theme asks first — the same GET-then-POST shape as every other
   * destructive control, in place of the one-click "Delete" the card used to
   * post directly. A theme in use never bricks a wall (`resolveTheme` falls
   * back to Panels), but naming which walls change is still the honest thing
   * to put in front of the button.
   */
  app.get('/admin/themes/:id/delete', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const theme = readTheme(deps.db, id);
    if (theme === undefined) return c.redirect('/admin/themes', 302);
    const usage = themeUsage(deps.db, id);
    const affected = usage.screens.map((wall) => `“${wall.name}”`);
    return c.html(
      confirmDestroyPage({
        self: selfHref(c),
        modules: navModules(deps.db),
        title: 'Remove theme',
        nav: 'themes',
        heading: `Remove “${theme.name}”?`,
        intro:
          affected.length === 0
            ? 'Nothing is using it right now.'
            : // A leading verb, not a bare list, so the sentence reads naturally
              // whatever the list starts with, and Intl.ListFormat supplies
              // the "and" a plain join() drops for two or more items. Every
              // wall named here is re-dressed by `deleteTheme` itself, in the
              // same transaction as the delete (RFC 015 §3.4).
              `In use by ${new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(affected)} ` +
              `— ${affected.length === 1 ? 'it switches' : 'they switch'} to ` +
              // Through `themeName`, never a literal: this sentence said
              // "Board" for releases after Board stopped existing, and a
              // literal is the only way that can happen (RFC 015 §2.1).
              `${themeName(FALLBACK_THEME)}.`,
        destroyAction: `admin/themes/${encodeURIComponent(id)}/delete`,
        destroyLabel: 'Remove it',
        cancelAction: 'admin/themes',
      }),
    );
  });

  app.post('/admin/themes/:id/delete', (c: Context) => {
    deleteTheme(deps.db, c.req.param('id') ?? '');
    return savedRedirect(c, '/admin/themes', 'theme-removed');
  });

  // ---- shaping -------------------------------------------------------------

  /** Pull the name, every colour token and the shape out of a form body, then validate. */
  function shapeSubmission(
    body: Record<string, unknown>,
  ):
    | { ok: true; value: { name: string; tokens: ThemeTokens; shape: ThemeShape } }
    | { ok: false; message: string } {
    const name = parse(nameBody, body['name']);
    if (!name.ok) return { ok: false, message: name.message };

    const raw: Record<string, unknown> = {};
    for (const token of COLOUR_TOKENS) raw[token] = body[token];
    raw['--radius'] = body['radius'];
    // Fonts are optional: an empty select is "keep the default", so only a
    // chosen stack is carried into the token set.
    for (const token of FONT_TOKENS) {
      const value = body[token];
      if (typeof value === 'string' && value !== '') raw[token] = value;
    }

    // Shadows: Soft is the derived default and is stored as an absence, so an
    // absent field (a hand-built or pre-control request) reads as Soft. Any
    // other value is refused — rule five is reject, not coerce.
    const shadows = body['shadows'];
    if (shadows !== undefined && shadows !== 'soft' && shadows !== 'none') {
      return { ok: false, message: 'Choose None or Soft for the shadows.' };
    }
    if (shadows === 'none') raw['--shadow-card'] = 'none';

    const tokens = themeTokensSchema.safeParse(raw);
    if (!tokens.success) {
      return { ok: false, message: 'Every colour needs to be a valid swatch, and the corners a preset.' };
    }

    // The control always renders one segment checked (`segControl` seeds
    // 'neutral' when nothing is stored yet), so an absent field means only a
    // hand-built or pre-phase request — read the same as 'neutral' rather
    // than refused. A field that *is* present and not one of the six values
    // is refused: rule five is reject, not coerce.
    const shapeField = body['shape'];
    const shape =
      shapeField === undefined
        ? { ok: true as const, value: 'neutral' as const }
        : parse(themeShapeSchema, shapeField);
    if (!shape.ok) return { ok: false, message: shape.message };

    return { ok: true, value: { name: name.value, tokens: tokens.data, shape: shape.value } };
  }

  // ---- pages ---------------------------------------------------------------

  /**
   * Every theme a wall can draw, in one grid.
   *
   * This screen is named after colour and, until now, was the one screen in
   * the admin where colour could not be chosen and the built-ins were named
   * nowhere — except inside an empty state that vanished the moment a
   * household made a theme of their own (RFC 015 §2.1, §2.2). So the list is
   * the five built-ins *and* whatever the household built, always, and each
   * card says which walls are wearing it.
   *
   * There is no empty state any more, and its sentence is deleted rather than
   * reworded: it named four built-in directions, three of which had not
   * existed for releases, and with the five always listed there is nothing for
   * an empty state to be about.
   *
   * A built-in card offers nothing yet. Duplicate is the obvious control and
   * it would have to *write a token set* the server does not hold — the five
   * palettes live in `apps/display/src/theme.ts` — so it waits on a
   * parity-tested transcription rather than on a button (RFC 015 §3.4).
   */
  function themesPage(c: Context, error?: string): string {
    const custom = readThemes(deps.db);

    /*
     * Which stored references count as this card.
     *
     * A built-in is worn under its own key and under every retired key that
     * folds onto it, because a household who never changed the setting still
     * stores `board` — so Panels must claim those walls rather than leaving
     * them attributed to a theme no card on this page represents.
     */
    const refsFor = (choice: ThemeChoice): readonly string[] => [
      choice.ref,
      ...Object.keys(LEGACY_THEME_ALIASES).filter(
        (retired) => LEGACY_THEME_ALIASES[retired] === choice.ref,
      ),
    ];

    const cardFor = (choice: ThemeChoice): string => {
      const usage = themeUsageOf(deps.db, refsFor(choice));
      /*
       * Who is wearing it, as words: a tag per wall, by name. Every wall names
       * its own theme (RFC 015 phase 2), so the tags across the page add up to
       * every wall in the house with nothing left to a household row.
       *
       * **And each one opens that wall** (RFC 015 phase 3). This page shows and
       * edits themes; *which* theme a wall wears is decided on the wall's own
       * page, and a tag naming a wall on a page that cannot change what it
       * wears is a dead end at exactly the moment somebody has decided. The
       * word is unchanged — a tag reads "Kitchen" either way — so nothing about
       * what this page says depends on the link.
       */
      const tags = usage.screens
        .map((wall) => tag(wall.name, 'neutral', `admin/walls/${encodeURIComponent(wall.id)}`))
        .join('');
      const id = choice.ref.startsWith('custom:') ? choice.ref.slice('custom:'.length) : '';
      const actions =
        id === ''
          ? ''
          : `<div class="tm-act">` +
            `<a class="btn btn-ghost btn-sm" href="admin/themes/${encodeURIComponent(id)}">Edit</a>` +
            destructive('Remove', {
              thing: choice.name,
              variant: 'button',
              confirmAction: `admin/themes/${encodeURIComponent(id)}/delete`,
            }) +
            `</div>`;
      return themeDisplayCard(
        choice,
        (tags === '' ? '' : `<div class="tm-use">${tags}</div>`) + actions,
      );
    };

    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Themes — Maverick Wall',
      nav: 'themes',
      heading: 'Themes',
      saved: readSaved(c),
      action: { label: 'Add a theme', href: 'admin/themes/new' },
      intro:
        'Every colour scheme a wall can draw — the ones that ship, and the ones ' +
        'you build. Each wall chooses a theme on the wall’s own page, and the ' +
        'tags below open it.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        section(
          'All themes',
          'The tags say which walls are wearing each one.',
          `<div class="themegrid">${themeChoices(custom).map(cardFor).join('')}</div>`,
        ),
    });
  }

  function builderPage(
    theme: ThemeRow | null,
    values: Record<string, unknown> | undefined,
    error: string | undefined,
    c: Context,
    /** A refused "Generate from a colour", and what was typed into it. */
    generate?: { readonly message: string; readonly values: Record<string, unknown> },
  ): string {
    const editing = theme !== null;
    const generated = (key: string, fallback: string): string => {
      const typed = generate?.values[key];
      return typeof typed === 'string' ? typed : fallback;
    };
    const mode = generated('mode', 'dark');
    /*
     * The second way to start a theme, and only on the add page: an edit
     * already has its colours. Secondary, because the builder's own Add is
     * this page's one primary — two filled buttons for "make a theme" would be
     * the two-primaries fault the list pages have just shed.
     */
    const generateSection = editing
      ? ''
      : section(
          'Generate from a colour',
          'Pick one colour — the seed — and a whole matching theme is worked out from ' +
            'it: background, panels, text and the shift colours, every pairing kept ' +
            'readable from across a room. It lands back here, so you can adjust ' +
            'anything afterwards.',
          (generate === undefined ? '' : errorBlock(generate.message)) +
            `<form method="post" action="admin/themes/generate">` +
            `<div class="row-fields">` +
            textField({ label: 'Name', name: 'name', required: true, placeholder: 'Sea glass', value: generated('name', '') }) +
            textField({ label: 'Seed colour', name: 'seed', type: 'color', value: generated('seed', '#4C7FD1') }) +
            selectField({
              label: 'Dark or light',
              name: 'mode',
              optionsHtml:
                `<option value="dark"${mode === 'light' ? '' : ' selected'}>Dark — for a wall on all evening</option>` +
                `<option value="light"${mode === 'light' ? ' selected' : ''}>Light — paper-bright</option>`,
            }) +
            `</div>` +
            `<button class="secondary" type="submit">Generate theme</button></form>`,
        );
    // Prefer a rejected submission's own values, then the stored theme, then the
    // default palette — so nothing a household typed is lost to a validation slip.
    const stored = theme?.tokens as Record<string, string> | undefined;
    const defaults = DEFAULT_TOKENS as Record<string, string>;
    const val = (key: string, fallback: string): string => {
      const submitted = values?.[key];
      if (typeof submitted === 'string' && submitted !== '') return submitted;
      return stored?.[key] ?? fallback;
    };
    const nameVal =
      typeof values?.['name'] === 'string' ? (values['name'] as string) : (theme?.name ?? '');
    const currentRadius = val('--radius', DEFAULT_TOKENS['--radius']);
    const submittedShape = values?.['shape'];
    const currentShape: ThemeShape =
      typeof submittedShape === 'string' && themeShapeSchema.safeParse(submittedShape).success
        ? (submittedShape as ThemeShape)
        : (theme?.shape ?? 'neutral');

    // A rejected submission's own answer first, then the stored theme's, then
    // Soft — the derived default a theme with no choice stored draws.
    const submittedShadows = values?.['shadows'];
    const currentShadows =
      submittedShadows === 'none' || submittedShadows === 'soft'
        ? submittedShadows
        : stored?.['--shadow-card'] === 'none'
          ? 'none'
          : 'soft';

    const colourField = (token: (typeof TOKEN_HELP)[number]): string =>
      `<div class="tf-row">` +
      `<input type="color" name="${escapeHtml(token.key)}" ` +
      `value="${escapeHtml(val(token.key, defaults[token.key] ?? '#000000'))}" ` +
      `aria-label="${escapeHtml(token.label)}">` +
      `<div><b>${escapeHtml(token.label)}</b><small>${escapeHtml(token.help)}</small></div>` +
      `</div>`;

    const fontField = (token: string, label: string, help: string): string =>
      selectField({
        label,
        name: token,
        hint: help,
        optionsHtml:
          `<option value=""${val(token, '') === '' ? ' selected' : ''}>Default</option>` +
          FONTS.map(
            (font) =>
              `<option value="${escapeHtml(font.stack)}"${val(token, '') === font.stack ? ' selected' : ''}>` +
              `${escapeHtml(font.label)}</option>`,
          ).join(''),
      });

    const action = editing ? `admin/themes/${encodeURIComponent(theme.id)}` : 'admin/themes';

    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: `${editing ? 'Edit theme' : 'Add a theme'} — Maverick Wall`,
      nav: 'themes',
      heading: editing ? 'Edit theme' : 'Add a theme',
      // The way back is the app bar's; it was a "← All themes" link in the body.
      back: { label: 'Themes', href: 'admin/themes' },
      saved: c === undefined ? undefined : readSaved(c),
      intro:
        'Pick a colour for each part of the wall. The preview updates as you go; ' +
        'save when it looks right. Corners rounds the cards and badges.',
      body:
        generateSection +
        (error === undefined ? '' : errorBlock(error)) +
        `<form method="post" action="${action}" class="theme-builder">` +
        `<div class="tb-controls">` +
        textField({
          label: 'Name',
          name: 'name',
          required: true,
          placeholder: 'Kitchen',
          value: nameVal,
          attrs: 'maxlength="60"',
        }) +

        section(
          'Colours',
          'Four more colours are worked out from these and are not on this form: the ' +
            'ink an event’s name is drawn in, the ink for the scaffolding around it — ' +
            'date numerals, weekday heads, week numbers — the ink for the quiet things ' +
            'like overflow counts and past times, and the hairline between weeks. The ' +
            'scaffolding ink is mixed from your text colour and your background, and ' +
            'the mix is pushed further until it clears 4.5:1 against that background, ' +
            'so a low-contrast pair comes back corrected rather than as you set it. ' +
            'The colours the designed widget styles use — weather, temperature, Home ' +
            'Assistant states and the skies behind a forecast — are worked out the ' +
            'same way, each pushed toward your text colour until it clears 4.5:1 on ' +
            'both your background and your panels.',
          TOKEN_HELP.filter((t) => !t.key.startsWith('--s-')).map(colourField).join(''),
        ) +

        section(
          'Shift colours',
          'These have to be told apart from across a room, not on a phone held at ' +
            'arm’s length — which is why there are four of them, and why Panels is the ' +
            'one to start from for a household with a rota: its four hues separate ' +
            'best at ten feet. Two colours that read clearly here can be one colour ' +
            'from the far end of a kitchen.',
          TOKEN_HELP.filter((t) => t.key.startsWith('--s-')).map(colourField).join(''),
        ) +

        section(
          'Corners and type',
          'A theme is colour, the corner radius, the faces and its shadow — and nothing else. How ' +
            'large the type is comes from the wall’s own size and the distance it is ' +
            'read from, under Device and time on that wall’s settings; where each ' +
            'widget sits and how big its box is comes from the layout editor. If the ' +
            'text on a wall is too small, neither answer is on this page.',
          selectField({
            label: 'Corners',
            name: 'radius',
            optionsHtml: RADII.map(
              (r) =>
                `<option value="${escapeHtml(r.value)}"${r.value === currentRadius ? ' selected' : ''}>` +
                `${escapeHtml(r.label)}</option>`,
            ).join(''),
          }) +
            fontField('--disp', 'Headings', 'The big type — the clock, dates, the month.') +
            fontField('--f-sans', 'Body', 'Event titles and the everyday text.'),
        ) +

        section(
          'Shadows',
          'The shadow a widget casts when its Style tab asks for one — never on a ' +
            'widget that did not. A shadow reads as depth on most walls, burns in ' +
            'on an OLED panel and bands on e-ink, so None switches every ' +
            'shadow on every wall wearing this theme off in one place. A wall sized ' +
            'as an e-ink panel draws none whichever you pick. Soft is worked out ' +
            'from your background: dark and heavier on a dark one, where nothing ' +
            'lighter would show, and faint in your text colour on a light one.',
          segControl({
            label: 'Shadows',
            name: 'shadows',
            options: SHADOW_OPTIONS,
            selected: currentShadows,
          }),
        ) +

        section(
          'Shape',
          'Colours are yours, but a few rules in the wall’s stylesheet are shape ' +
            'rather than colour — Almanac italicises the date and drops the month to a ' +
            'ledger look, Panels gives each widget a card, Blueprint squares every ' +
            'corner, Swiss draws flat rules with no cards at all. Borrow one, or keep ' +
            'None for the plain default this theme has always drawn.',
          segControl({
            label: 'Shape',
            name: 'shape',
            options: SHAPE_OPTIONS,
            selected: currentShape,
          }),
        ) +

        `<button type="submit">${editing ? 'Save theme' : 'Add theme'}</button>` +
        `</div>` +

        // Enhanced by assets/theme-editor.js: the shadow-DOM preview and the
        // contrast guidance. Absent scripting, the form still saves.
        `<div class="tb-preview">` +
        `<div class="kick">Preview</div>` +
        `<div id="theme-editor"><div id="theme-preview"></div><div id="theme-contrast"></div></div>` +
        `<noscript><p class="hint">The live preview needs JavaScript. Saving does not — ` +
        `pick your colours and save.</p></noscript>` +
        `</div>` +
        `</form>` +
        `<script type="module" src="assets/theme-editor.js"></script>`,
    });
  }
}
