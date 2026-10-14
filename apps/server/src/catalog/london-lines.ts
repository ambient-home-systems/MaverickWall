import type { CatalogEntry } from '../http/catalog.js';

/**
 * Whether London's lines are running, from Transport for London's own unified
 * API: key-less at a household's rate. A line with a good service is drawn
 * quietly, minor delays in the active colour, anything worse in the alert one.
 */
export const entry: CatalogEntry = {
  id: 'london-lines',
  name: 'London line status',
  author: 'Maverick Wall',
  description:
    "Whether London's Underground, Overground, Elizabeth line or DLR are running, from Transport for London. " +
    'Delays are drawn in the alert colour.',
  glyph: 'problem',
  emoji: 'world-map',
  kind: 'recipe',
  recipe: {
    name: 'London line status',
    contract: 1,
    config: [
      {
        key: 'mode',
        label: 'Which lines',
        type: 'select',
        options: [
          { value: 'tube', label: 'Underground' },
          { value: 'elizabeth-line', label: 'Elizabeth line' },
          { value: 'overground', label: 'Overground' },
          { value: 'dlr', label: 'DLR' },
          { value: 'tram', label: 'Trams' },
        ],
        default: 'tube',
      },
    ],
    secrets: [],
    fetch: {
      url: 'https://api.tfl.gov.uk/Line/Mode/{mode}/Status',
      intervalSeconds: 300,
      allowLan: false,
      format: 'json',
    },
    panel: {
      kind: 'readings',
      title: 'Lines',
      items: {
        for: '.',
        label: '{name}',
        value: '{lineStatuses[0].statusSeverityDescription}',
        limit: 12,
        empty: 'Transport for London lists no lines of this kind.',
        tone: {
          from: 'lineStatuses[0].statusSeverity',
          map: { '10': 'idle', '18': 'idle', '19': 'idle', '9': 'active' },
          default: 'alert',
        },
      },
    },
    signals: [],
  },
};
