import type { CatalogEntry } from '../http/catalog.js';

/**
 * The flood warnings and alerts in force in England, from the Environment
 * Agency's real-time flood-monitoring API: key-less, updated every fifteen
 * minutes. A severe warning or a warning is drawn in the alert colour, an
 * alert in the active one. Warnings that are no longer in force are left out.
 */
export const entry: CatalogEntry = {
  id: 'flood-warnings',
  name: 'Flood warnings (England)',
  author: 'Maverick Wall',
  description:
    "The flood warnings and alerts in force in England, from the Environment Agency. Type your county " +
    'to see only its own, or leave it empty for all of England.',
  glyph: 'moisture',
  emoji: 'umbrella-with-rain-drops',
  kind: 'recipe',
  recipe: {
    name: 'Flood warnings',
    contract: 1,
    config: [{ key: 'county', label: 'County (optional)', type: 'string', default: '' }],
    secrets: [],
    fetch: {
      url: 'https://environment.data.gov.uk/flood-monitoring/id/floods?min-severity=3&county={county}',
      intervalSeconds: 900,
      allowLan: false,
      format: 'json',
    },
    panel: {
      kind: 'readings',
      title: 'Floods',
      items: {
        for: 'items',
        label: '{description | truncate:40}',
        value: '{severity}',
        sort: { by: 'severityLevel', order: 'asc', as: 'number' },
        limit: 6,
        empty: 'No flood warnings or alerts are in force.',
        tone: { from: 'severityLevel', map: { '1': 'alert', '2': 'alert', '3': 'active' } },
      },
    },
    signals: [],
  },
};
