import type { CatalogEntry } from '../http/catalog.js';

/**
 * The next public holidays in a country, from Nager.Date: key-less, over a
 * hundred countries by their two-letter code. Only holidays kept across the
 * whole country are listed, so Scotland's St Andrew's Day is not on an English
 * wall.
 */
export const entry: CatalogEntry = {
  id: 'public-holidays',
  name: 'Public holidays',
  author: 'Maverick Wall',
  description:
    'The next public holidays kept across your whole country, from Nager.Date. ' +
    'Type the two-letter country code: GB, US, DE, FR and so on.',
  glyph: 'person',
  emoji: 'spiral-calendar',
  kind: 'recipe',
  recipe: {
    name: 'Public holidays',
    contract: 1,
    config: [{ key: 'country', label: 'Country code', type: 'string', default: 'GB' }],
    secrets: [],
    fetch: {
      url: 'https://date.nager.at/api/v3/NextPublicHolidays/{country}',
      intervalSeconds: 86400,
      allowLan: false,
      format: 'json',
    },
    panel: {
      kind: 'readings',
      title: 'Holidays',
      items: {
        for: '.',
        label: '{localName | truncate:40}',
        value: '{date | date:short} · {date | date:relative}',
        where: [{ path: 'global', equals: 'true' }],
        limit: 5,
        empty: 'Nager.Date lists no holidays for this country.',
      },
    },
    signals: [],
  },
};
