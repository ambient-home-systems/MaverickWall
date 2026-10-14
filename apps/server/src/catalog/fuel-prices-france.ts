import type { CatalogEntry } from '../http/catalog.js';

/**
 * The cheapest fuel in a French postcode, from the government's own instant
 * feed of every station's prices (prix-carburants, on data.economie.gouv.fr):
 * key-less. The query asks the service for one fuel's price under one name,
 * `prix`, so the panel reads the same field whichever fuel is chosen.
 */
export const entry: CatalogEntry = {
  id: 'fuel-prices-france',
  name: 'Fuel prices (France)',
  author: 'Maverick Wall',
  description:
    "The cheapest stations for one fuel in a French postcode, from the French government's price feed. " +
    'Prices are in euros a litre.',
  glyph: 'power',
  emoji: 'car',
  kind: 'recipe',
  recipe: {
    name: 'Fuel prices',
    contract: 1,
    config: [
      { key: 'cp', label: 'Postcode', type: 'string', default: '69003' },
      {
        key: 'fuel',
        label: 'Fuel',
        type: 'select',
        options: [
          { value: 'e10', label: 'SP95-E10' },
          { value: 'sp95', label: 'SP95' },
          { value: 'sp98', label: 'SP98' },
          { value: 'gazole', label: 'Gazole' },
          { value: 'e85', label: 'E85' },
          { value: 'gplc', label: 'GPLc' },
        ],
        default: 'e10',
      },
    ],
    secrets: [],
    fetch: {
      url:
        'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records' +
        '?select=adresse%2Cville%2C{fuel}_prix%20as%20prix%2C{fuel}_maj%20as%20maj' +
        '&where=cp%3D%22{cp}%22%20and%20{fuel}_prix%20is%20not%20null&order_by=prix&limit=6',
      intervalSeconds: 3600,
      allowLan: false,
      format: 'json',
    },
    panel: {
      kind: 'readings',
      title: 'Fuel',
      items: {
        for: 'results',
        label: '{adresse | truncate:40}',
        value: '{prix | number:3} €',
        empty: 'No station in this postcode lists this fuel.',
      },
    },
    signals: [],
  },
};
