import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { createExternalModule, createRecipeModule, readExternalModules } from '../src/api/external-modules.js';
import { diagnoseModule } from '../src/modules/external/diagnose.js';

/**
 * `diagnose-module` (plan item M7.10): a module read the way the poll reads
 * it, against a real loopback server and the real fetcher, saying which
 * request, which source and which part of the panel — and naming addresses by
 * their host alone.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', 'migrations');
const AT = Date.parse('2026-10-14T08:00:00Z');

const servers: Server[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function serve(routes: Record<string, { type: string; body: string } | number>): Promise<{ host: string; asked: string[] }> {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    asked.push(`${request.url ?? ''} ${request.headers['x-key'] ?? ''}`);
    const route = routes[request.url ?? ''];
    if (route === undefined || typeof route === 'number') {
      response.statusCode = typeof route === 'number' ? route : 404;
      response.end();
      return;
    }
    response.setHeader('content-type', route.type);
    response.end(route.body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { host: `127.0.0.1:${address.port}`, asked };
}

function database(): ReturnType<typeof openDatabase>['db'] {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-diagnose-module-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  return db;
}

describe('diagnose-module', () => {
  it('reads a recipe as the poll would, names hosts only, and says where the panel was refused', async () => {
    const { host, asked } = await serve({
      '/v1/private-path/pairs?stop=4321': {
        type: 'application/json',
        body: JSON.stringify({ pairs: [{ name: 'A label well over the sixty characters a row’s label may have', value: '1' }] }),
      },
      '/news-feed': { type: 'application/rss+xml', body: '<rss><channel><title>News</title></channel></rss>' },
    });
    const db = database();
    const keyring = createKeyring(randomBytes(32));
    const recipe = {
      name: 'Pairs',
      contract: 1,
      config: [{ key: 'stop', label: 'Stop' }],
      secrets: [{ key: 'key', label: 'Key' }],
      fetch: { url: `http://${host}/v1/private-path/pairs?stop={stop}`, allowLan: true, headers: { 'x-key': '{secret:key}' } },
      sources: { news: { url: `http://${host}/news-feed`, format: 'feed' } },
      panel: { kind: 'readings', title: '{@news.title}', items: { for: 'pairs', label: '{name}', value: '{value}' } },
    };
    createRecipeModule(db, {
      id: 'pairs',
      name: 'Pairs',
      url: recipe.fetch.url,
      recipe,
      config: { stop: '4321' },
      secretsEnvelope: keyring.encrypt(JSON.stringify({ key: 's3cret-value' }), 'recipe-secret'),
    });
    const module = readExternalModules(db)[0];
    if (module === undefined) throw new Error('no module');
    const lines = await diagnoseModule(db, createFetcher(), keyring, module, AT);
    const text = lines.join('\n');

    expect(lines).toContain('  kind:        recipe');
    expect(lines).toContain('  last read:   never');
    expect(lines).toContain('  settings:    stop');
    expect(lines).toContain('  secrets:     1 of 1 stored');
    expect(text).toMatch(new RegExp(`  fetch: +${host.replace(/\./g, '\\.')} answered \\d+ bytes of application/json`));
    expect(text).toMatch(new RegExp(`  @news: +${host.replace(/\./g, '\\.')} answered`));
    expect(lines).toContain('  builds:      nothing — The recipe produced something the wall cannot draw.');
    expect(lines.some((line) => /^ {4}panel\.items\.0\.label: /.test(line))).toBe(true);

    // The request went as the poll's would, the secret in its header.
    expect(asked).toContain('/v1/private-path/pairs?stop=4321 s3cret-value');
    // And the report names neither the path nor a setting's value nor the secret.
    expect(text).not.toContain('private-path');
    expect(text).not.toContain('4321');
    expect(text).not.toContain('s3cret');
    expect(text).not.toContain('sixty characters');

    // It writes nothing back: the card says what the poll last said.
    expect(readExternalModules(db)[0]?.lastPolledAt).toBe(0);
    expect(readExternalModules(db)[0]?.lastError).toBeNull();
  });

  it('says which request did not answer, and builds nothing from half its data', async () => {
    const { host } = await serve({
      '/main': { type: 'application/json', body: '{"pairs": []}' },
      '/gone': 404,
    });
    const db = database();
    const recipe = {
      name: 'Half',
      contract: 1,
      fetch: { url: `http://${host}/main`, allowLan: true },
      sources: { other: { url: `http://${host}/gone` } },
      panel: { kind: 'text', text: '{@other.words}' },
    };
    createRecipeModule(db, { id: 'half', name: 'Half', url: recipe.fetch.url, recipe, config: {} });
    const module = readExternalModules(db)[0];
    if (module === undefined) throw new Error('no module');
    const lines = await diagnoseModule(db, createFetcher(), createKeyring(randomBytes(32)), module, AT);
    expect(lines.some((line) => line.startsWith(`  @other:      ${host} did not answer: http-error 404`))).toBe(true);
    expect(lines).toContain(
      '  The panel was not built: a request did not answer, and the wall keeps its last good panel.',
    );
    expect(lines.some((line) => line.startsWith('  builds:'))).toBe(false);
  });

  it('builds a recipe that works, with its signals', async () => {
    const { host } = await serve({
      '/ok': { type: 'application/json', body: JSON.stringify({ pairs: [{ name: 'Gate', value: 'Shut' }], alarm: 'on' }) },
    });
    const db = database();
    const recipe = {
      name: 'Gate',
      contract: 1,
      fetch: { url: `http://${host}/ok`, allowLan: true },
      panel: { kind: 'readings', title: 'Gate', items: { for: 'pairs', label: '{name}', value: '{value}' } },
      signals: [{ when: 'alarm', key: 'alarm', title: 'Alarm' }],
    };
    createRecipeModule(db, { id: 'gate', name: 'Gate', url: recipe.fetch.url, recipe, config: {} });
    const module = readExternalModules(db)[0];
    if (module === undefined) throw new Error('no module');
    const lines = await diagnoseModule(db, createFetcher(), createKeyring(randomBytes(32)), module, AT);
    expect(lines).toContain('  builds:      readings, 1 row');
    expect(lines).toContain('  signals:     1 raised');
    expect(lines).toContain('    {"key":"alarm","title":"Alarm"}');
    // Built, and still nothing written back: the card says what the poll said.
    expect(readExternalModules(db)[0]?.lastPolledAt).toBe(0);
    expect(readExternalModules(db)[0]?.panel).toBeNull();
  });

  it('reads a service module’s /panel and /signals, and says where the panel is wrong', async () => {
    const { host } = await serve({
      '/svc/panel': { type: 'application/json', body: JSON.stringify({ kind: 'readings', items: [{ label: 'x' }] }) },
    });
    const db = database();
    createExternalModule(db, { id: 'svc', name: 'Service', url: `http://${host}/svc` });
    const module = readExternalModules(db)[0];
    if (module === undefined) throw new Error('no module');
    const lines = await diagnoseModule(db, createFetcher(), createKeyring(randomBytes(32)), module, AT);
    expect(lines).toContain('  kind:        service');
    expect(lines).toContain('  /panel:      answered, and the wall cannot use it');
    expect(lines.some((line) => /^ {4}panel\.items\.0\.value: /.test(line))).toBe(true);
    expect(lines).toContain('  /signals:    not offered (404), which is fine');
  });

  it('runs as the command, reading DATA_DIR', async () => {
    const { host } = await serve({ '/ok': { type: 'application/json', body: '{"pairs": []}' } });
    const dataDir = mkdtempSync(join(tmpdir(), 'mw-diagnose-module-cli-'));
    roots.push(dataDir);
    const { db } = openDatabase({ dataDir });
    runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
    const recipe = {
      name: 'Empty',
      contract: 1,
      fetch: { url: `http://${host}/ok`, allowLan: true },
      panel: { kind: 'readings', title: 'Empty', items: { for: 'pairs', label: '{name}', value: '{value}', empty: 'Nothing' } },
    };
    createRecipeModule(db, { id: 'empty', name: 'Empty', url: recipe.fetch.url, recipe, config: {} });
    db.close();
    const tool = join(HERE, '..', 'dist', 'tools', 'diagnose-module.js');
    // Asynchronously: the server answering it lives in this process.
    const run = async (id: string): Promise<{ code: number; stdout: string; stderr: string }> => {
      try {
        const { stdout, stderr } = await promisify(execFile)(process.execPath, [tool, id], {
          env: { ...process.env, DATA_DIR: dataDir },
        });
        return { code: 0, stdout, stderr };
      } catch (error) {
        const failed = error as { code: number; stdout: string; stderr: string };
        return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
      }
    };
    const result = await run('empty');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('── Empty (empty)');
    expect(result.stdout).toContain('  builds:      text');
    const missing = await run('nope');
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('No module with id nope.');
  });
});
