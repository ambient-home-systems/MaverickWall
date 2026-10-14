import type { CatalogEntry } from '../http/catalog.js';
import { entry as aurora } from './aurora-forecast.js';
import { entry as countdownExample } from './countdown-example.js';
import { entry as earthquakes } from './earthquakes.js';
import { entry as hurricanes } from './hurricanes.js';
import { entry as naturalEvents } from './natural-events.js';
import { entry as outsideTemperature } from './outside-temperature.js';
import { entry as riverLevel } from './river-level.js';
import { entry as tideTimes } from './tide-times.js';
import { entry as uvIndex } from './uv-index.js';
import { entry as volcanoAlerts } from './volcano-alerts.js';

/**
 * The store — the in-repo, curated list of modules a household can install.
 *
 * One file per module in this directory; add yours by pull request (see
 * `docs/adding-to-the-store.md`) and it ships to everyone in the next release.
 * This is deliberately a directory of source rather than a document fetched over
 * the network: the store is *part of the project*, maintained here, and it works
 * on a wall with no internet because it is baked into the image at build.
 *
 * List every module here to include it. `test/catalog.test.ts` validates the
 * whole list against the entry schema, so a malformed entry fails the build,
 * never a household's wall.
 */
export const STORE_ENTRIES: readonly CatalogEntry[] = [
  // Recipes first — the everyday case, no service to host.
  outsideTemperature,
  uvIndex,
  tideTimes,
  riverLevel,
  hurricanes,
  earthquakes,
  volcanoAlerts,
  naturalEvents,
  aurora,
  // Service modules (run their own process) after.
  countdownExample,
];
