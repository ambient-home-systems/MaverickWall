import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The shell and the stylesheet are not compiled, so tsc does not know about
 * them. Copying them here keeps `dist/` the one directory the server serves,
 * rather than the server needing to know the source layout.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist'), { recursive: true });
for (const file of ['index.html', 'display.css']) {
  copyFileSync(join(root, 'src', file), join(root, 'dist', file));
}
