import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';

/**
 * An error may only name a control that exists, in the words that are on it.
 *
 * Measured on a real install: submitting a loopback feed answered "Turn on
 * \"allow loopback\"", and there is no control anywhere with that label. The
 * same three switches had four names across the product — the wizard's own
 * prose, the admin's label table, `packages/core`, and the Home Assistant
 * screen — because rule one keeps `packages/core` away from that table, so it
 * wrote its own words and they drifted.
 *
 * The fix is structural rather than a find-and-replace, so the test has to be
 * structural too: **every string asserted here is read out of the page that was
 * rendered**, never typed into this file. A test comparing the error against a
 * literal passes the day somebody renames the checkbox and forgets the message,
 * which is precisely the bug. So each case submits a real address to a real
 * route, then reads the label off the rendered `<input name="allow_…">` and the
 * error off the rendered `.error`, and asks whether one contains the other.
 *
 * The negative half matters as much: any quoted phrase in an error that *looks*
 * like a control name ("allow …") must be one of the labels on that same page.
 * That is what fails when the domain goes back to inventing its own, and it is
 * the assertion that catches a fifth name nobody has thought of yet.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextAddress = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function harness() {
  const address = `10.9.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-netlabel-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'n'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => address,
    setupToken,
    dataDir,
  });

  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = new Headers(init.headers);
    if (cookie !== '') headers.set('cookie', cookie);
    const response = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return response;
  };
  const form = (path: string, fields: Record<string, string>): Promise<Response> =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  // Signed in the way a household arrives: through the wizard's first two
  // steps, which is also what leaves `/setup/calendar` reachable.
  await call(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', {
    name: 'Household', email: 'family@home.local',
    password: 'correct-horse-battery', confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });

  return { db, call, form };
}

/** Undo the escaping `escapeHtml` applied, so a comparison is of text not markup. */
function unescape(html: string): string {
  return html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * The three labels as the household reads them, off the markup that was served.
 *
 * `switchRow` draws `<label class="switch"><span …><b>LABEL</b>…<input
 * name="allow_…">`, so the label and the control it belongs to are one element
 * and cannot be paired up wrongly. Keyed on the input's `name`, which is the
 * only thing about these controls this file states for itself — and a name is
 * not a word a household ever sees, so it cannot be the thing that drifts.
 */
function renderedLabels(html: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const block of html.matchAll(/<label class="switch">([\s\S]*?)<\/label>/g)) {
    const inner = block[1] ?? '';
    const label = /<b>([\s\S]*?)<\/b>/.exec(inner)?.[1];
    const name = /<input[^>]*\sname="([^"]+)"/.exec(inner)?.[1];
    if (label !== undefined && name !== undefined) labels[name] = unescape(label);
  }
  return labels;
}

/** The error block's own words — the message and the remedy under it, together. */
function errorText(html: string): string {
  const block = /<div class="error">([\s\S]*?)<\/div>/.exec(html)?.[1];
  return block === undefined ? '' : unescape(block.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Every quoted run in a sentence that reads like the name of a control.
 *
 * Both quote styles, because the drift was across them: the domain wrote
 * `"allow loopback"` with straight quotes and the composed remedy writes
 * `“Allow this machine itself”` with curly ones. A quoted *hostname* — the
 * `bare-hostname` message says `"nas"` — is deliberately not caught, which is
 * why this looks for the word the controls all start with rather than for
 * quotes alone.
 */
function quotedControlNames(text: string): string[] {
  return [...text.matchAll(/["“]([^"“”]+)["”]/g)]
    .map((match) => match[1] ?? '')
    .filter((quoted) => /^allow\b/i.test(quoted));
}

/**
 * The switch each opt-in is set by, as `UrlPolicy` names it.
 *
 * The input names, which is the join between what `requiredNetworkOptions`
 * answers and what the form posts. Never a label.
 */
const CONTROL_FOR = {
  allowPrivateNetwork: 'allow_lan',
  allowLoopback: 'allow_loopback',
  allowHttp: 'allow_http',
} as const;

/**
 * One address per rejection code that a switch can open, plus the two that no
 * switch reaches — the cases where a remedy naming one would be a lie.
 *
 * Every one of these is refused at the URL gate, so nothing here opens a socket
 * or asks a resolver: the addresses are unreachable on purpose and the test is
 * about what is *said*, not about what answers.
 */
const CASES: readonly {
  readonly code: string;
  readonly url: string;
  readonly needs: readonly (keyof typeof CONTROL_FOR)[];
  /** Switches already ticked, so "already on is already answered" is exercised. */
  readonly ticked?: Record<string, string>;
}[] = [
  // The one that was measured, in both spellings a household types it.
  { code: 'ip-literal (loopback)', url: 'https://127.0.0.1:8443/cal.ics', needs: ['allowLoopback'] },
  { code: 'loopback-name', url: 'https://localhost/cal.ics', needs: ['allowLoopback'] },
  // Two at once: the guard refuses at the first rule, and the remedy must still
  // name both — one switch per submission is how this took three rounds.
  {
    code: 'http-not-allowed + loopback',
    url: 'http://127.0.0.1:8443/cal.ics',
    needs: ['allowLoopback', 'allowHttp'],
  },
  { code: 'bare-hostname', url: 'https://nas/cal.ics', needs: ['allowPrivateNetwork'] },
  { code: 'ip-literal (LAN)', url: 'https://192.168.1.10/cal.ics', needs: ['allowPrivateNetwork'] },
  {
    code: 'http-not-allowed (LAN already ticked)',
    url: 'http://192.168.1.10/cal.ics',
    needs: ['allowHttp'],
    ticked: { allow_lan: '1' },
  },
];

/** The two refusals no opt-in reaches. Naming a switch for either would be false. */
const NO_SWITCH_HELPS: readonly { readonly what: string; readonly url: string }[] = [
  // Refused under every policy — there is no flag that resolves a `.local`.
  { what: 'an mDNS name', url: 'https://nas.local/cal.ics' },
  // A public numeric address: local-network access opens nothing here, and the
  // shipped suggestion said to turn it on anyway.
  { what: 'a public IP literal', url: 'https://93.184.216.34/cal.ics' },
];

const SCREENS = [
  { what: 'the wizard', path: '/setup/calendar' },
  { what: 'the admin add form', path: '/admin/calendars' },
] as const;

describe('an error names the control the household is looking at', () => {
  for (const screen of SCREENS) {
    for (const entry of CASES) {
      it(`${screen.what}: ${entry.code}`, async () => {
        const h = await harness();
        const response = await h.form(screen.path, {
          name: 'Family',
          url: entry.url,
          ...(entry.ticked ?? {}),
        });
        expect(response.status).toBe(400);
        const html = await response.text();

        const labels = renderedLabels(html);
        const said = errorText(html);
        expect(said, 'nothing was said at all').not.toBe('');

        for (const option of entry.needs) {
          const control = CONTROL_FOR[option];
          const label = labels[control];
          // The control has to be on the page before an error can point at it.
          expect(label, `${screen.path} rendered no ${control} control to point at`)
            .toBeTypeOf('string');
          expect(
            said,
            `the error does not name the ${control} control, which reads ` +
              `“${label}” on this very page: “${said}”`,
          ).toContain(label);
        }

        // Every switch already ticked stays unmentioned: naming one is telling
        // a household to turn on something that is already on.
        for (const control of Object.keys(entry.ticked ?? {})) {
          const label = labels[control];
          if (label !== undefined) {
            expect(said, `the error names ${control}, which is already ticked`)
              .not.toContain(label);
          }
        }

        // And nothing that reads like a control name is anything but a label
        // rendered on this page. This is what "allow loopback" fails.
        const onThisPage = Object.values(labels);
        for (const quoted of quotedControlNames(said)) {
          expect(
            onThisPage,
            `the error quotes “${quoted}”, which is on no control on this page`,
          ).toContain(quoted);
        }
      });
    }

    for (const entry of NO_SWITCH_HELPS) {
      it(`${screen.what}: ${entry.what} is not answered with a switch`, async () => {
        const h = await harness();
        const response = await h.form(screen.path, { name: 'Family', url: entry.url });
        expect(response.status).toBe(400);
        const html = await response.text();

        const said = errorText(html);
        expect(said).not.toBe('');
        expect(
          quotedControlNames(said),
          `no opt-in opens ${entry.url}, so naming one is advice that cannot work`,
        ).toEqual([]);
        // The three historical inventions, in the words they were written in.
        for (const invented of ['allow local network', 'allow loopback', 'allow plain http']) {
          expect(said.toLowerCase(), `still says “${invented}”`).not.toContain(invented);
        }
      });
    }
  }

  it('tells a household what to do about a .local name instead', async () => {
    // Removing the false remedy must not leave the commonest self-hosted
    // mistake with nothing to act on. The true answer is a different address,
    // not a different switch.
    const h = await harness();
    const html = await (
      await h.form('/admin/calendars', { name: 'Family', url: 'https://nas.local/cal.ics' })
    ).text();
    expect(errorText(html)).toContain('numeric address');
  });
});

/**
 * The half a driven test cannot reach.
 *
 * `describe()` in the Home Assistant client answers a name that *resolves* to a
 * LAN address — which needs a resolver that says so, and there is no way to
 * arrange one here without either a stub or somebody's DNS. That branch carried
 * the product's fifth name for the same switch (`Turn on "Home Assistant is on
 * my local network"`), so the invariant is asserted on the source instead: the
 * words on these controls exist in exactly one file, and everywhere else asks
 * for them by the `UrlPolicy` flag they set.
 *
 * A text scan is a blunt instrument and it is the right one here, because the
 * failure mode is somebody typing a label into a message — which is a string
 * literal, in a file, and nothing else about it is checkable.
 */
describe('only one file in the product knows what these controls are called', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  /** Where the table lives, and the one file allowed to spell a label out. */
  const TABLE = join('apps', 'server', 'src', 'http', 'html.ts');

  /**
   * Code with its comments taken out.
   *
   * The comments in these files quote the old names at length, on purpose —
   * that history is why the rule exists. `//` is only treated as a comment when
   * it is not preceded by a colon, so `https://…` inside a string survives.
   */
  function code(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sources(full);
      return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
    });
  }

  const files = [
    ...sources(join(ROOT, 'apps', 'server', 'src')),
    ...sources(join(ROOT, 'packages', 'core', 'src')),
  ].filter((file) => !file.endsWith(TABLE));

  /**
   * The labels as they are rendered, plus every name the product used to have.
   *
   * The current labels are read off a served page rather than typed here, for
   * the same reason as everywhere else in this file: a literal goes stale the
   * day somebody renames a control, which is exactly the drift being fenced.
   */
  it('spells no control name anywhere but the table it renders from', async () => {
    const h = await harness();
    const rendered = Object.values(renderedLabels(await (await h.call('/admin/calendars')).text()));
    expect(rendered.length, 'read no labels off the page').toBe(3);

    const forbidden = [
      ...rendered,
      // The four names this product actually shipped for these three switches.
      'allow local network',
      'allow loopback',
      'This feed is on my local network',
      'This feed is on this machine',
      'Home Assistant is on my local network',
    ];

    const offences: string[] = [];
    for (const file of files) {
      const body = code(readFileSync(file, 'utf8'));
      for (const phrase of forbidden) {
        if (body.toLowerCase().includes(phrase.toLowerCase())) {
          offences.push(`${file.slice(ROOT.length + 1)} spells “${phrase}”`);
        }
      }
    }
    expect(
      offences,
      'a control name outside the table that renders it is how three switches ' +
        'came to have four names. Ask for it with networkAccessLabel().',
    ).toEqual([]);
  });
});

describe('the Home Assistant screen asks the same question by the same name', () => {
  /**
   * Its two checkboxes are plain ones, so they are read out of their own markup.
   *
   * Each reads `NAME — CONSEQUENCE`, and the two halves answer different
   * questions: the name is the shared one (it comes from the same table the
   * calendar screens render), the consequence is this screen's own, because a
   * token that controls a house is not a feed URL. So the name is what an error
   * quotes and what the parity assertion below compares.
   */
  function haLabels(html: string): Record<string, string> {
    const labels: Record<string, string> = {};
    for (const block of html.matchAll(/<label><input([^>]*)>([^<]*)<\/label>/g)) {
      const name = /\sname="([^"]+)"/.exec(block[1] ?? '')?.[1];
      if (name !== undefined) labels[name] = unescape(block[2] ?? '').trim();
    }
    return labels;
  }

  /** The half of a Home Assistant label that is the control's name. */
  function controlName(label: string | undefined): string {
    return (label ?? '').split('—')[0]?.trim() ?? '';
  }

  it('names its local-network box, in that box’s own words, when one is refused', async () => {
    const h = await harness();
    // A LAN address with the plain-http consent given, so the refusal is about
    // the network and not about encryption.
    const response = await h.form('/admin/home-assistant/connect', {
      base_url: 'http://192.168.1.10:8123',
      token: 'x'.repeat(40),
      accept_http: '1',
    });
    expect(response.status).toBe(400);
    const html = await response.text();

    const labels = haLabels(html);
    const said = errorText(html);
    expect(labels['allow_lan'], 'the screen rendered no local-network control').toBeTypeOf('string');
    const named = controlName(labels['allow_lan']);
    expect(named, 'the local-network control has no name before its consequence').not.toBe('');
    expect(
      said,
      `the refusal does not name the box that opens it, which reads ` +
        `“${named}”: “${said}”`,
    ).toContain(named);
    // And nothing quoted here is a name from somewhere else. Compared against
    // the control *names*, since that is the half a sentence quotes.
    const namesHere = Object.values(labels).map(controlName);
    for (const quoted of quotedControlNames(said)) {
      expect(namesHere, `quotes “${quoted}”, which is on no control here`).toContain(quoted);
    }
  });

  it('names its plain-http box the same way the calendar screens name theirs', async () => {
    const h = await harness();
    const response = await h.form('/admin/home-assistant/connect', {
      base_url: 'http://192.168.1.10:8123',
      token: 'x'.repeat(40),
      allow_lan: '1',
    });
    expect(response.status).toBe(400);
    const html = await response.text();

    const said = errorText(html);
    expect(said, `the plain-http consent does not name its own box: “${said}”`)
      .toContain(controlName(haLabels(html)['accept_http']));

    // The same control name as the wizard's, which is the whole point of one
    // table: read the calendar screens' own rendering rather than restating it.
    const wizard = await (await h.call('/admin/calendars')).text();
    const shared = renderedLabels(wizard)['allow_http'];
    expect(shared, 'no plain-http control on the calendars screen').toBeTypeOf('string');
    expect(
      haLabels(html)['accept_http'],
      'the two screens call the plain-http switch different things again',
    ).toContain(shared);
  });
});
