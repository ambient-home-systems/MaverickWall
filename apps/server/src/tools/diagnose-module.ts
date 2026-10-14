import { openAndMigrate } from '../db/bootstrap.js';
import { createKeyring, loadOrCreateMasterKey } from '../secrets/keyring.js';
import { createFetcher } from '../net/fetcher.js';
import { readExternalModules } from '../api/external-modules.js';
import { diagnoseModule } from '../modules/external/diagnose.js';

/**
 * Read a module now and say what came back (plan item M7.10).
 *
 *   node dist/tools/diagnose-module.js [module-id]
 *
 * With no id it diagnoses every installed module. `diagnose-source` is this
 * for a calendar, and the reason is the same: a module's card says one
 * sentence a household can act on, and an author needs which request, which
 * source, and where the panel was refused. Nothing is written back, and no
 * address is printed beyond its host.
 */

const dataDir = process.env['DATA_DIR'] ?? '/data';
const { db, dataDir: resolved } = openAndMigrate(dataDir);
console.log(`Using ${resolved}`);
console.log('');

const wanted = process.argv[2];
const modules = readExternalModules(db).filter((module) => wanted === undefined || module.id === wanted);
if (modules.length === 0) {
  console.error(wanted !== undefined ? `No module with id ${wanted}.` : 'No modules installed.');
  process.exit(1);
}

const master = loadOrCreateMasterKey(dataDir);
if (master.unusableKeyWarning) {
  // A regenerated key opens no secret, and a recipe behind an API key would
  // then report its feed refusing it, for a reason nobody was told.
  console.error(`Warning: ${master.unusableKeyWarning}`);
  console.error('');
}
const keyring = createKeyring(master.key);
const fetcher = createFetcher();

for (const module of modules) {
  console.log(`── ${module.name} (${module.id}) ${'─'.repeat(Math.max(0, 40 - module.name.length))}`);
  for (const line of await diagnoseModule(db, fetcher, keyring, module, Date.now())) console.log(line);
  console.log('');
}
