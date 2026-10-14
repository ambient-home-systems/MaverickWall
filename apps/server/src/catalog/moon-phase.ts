import type { CatalogEntry } from '../http/catalog.js';

/**
 * A script module (RFC 017): the moon tonight, and when the next new, first
 * quarter, full and last quarter fall.
 *
 * It is a script rather than a recipe because there is nothing to fetch and
 * everything to work out: a recipe can pull a field out of an answer and format
 * it, and cannot do arithmetic. It contacts no host at all, so installing it
 * asks for nothing.
 *
 * The phases are the mean lunation counted from the new moon of 6 January 2000,
 * which `weather-icons.ts` uses for the forecast's moon too. A mean phase is
 * within about fourteen hours of the true one, so the wall says the day and not
 * the minute: a timeline draws a time the way the household's clock does, and
 * the test holds every quarter it names to the almanac within a day.
 *
 * Written without template literals so it can sit in this file as one.
 */
const SOURCE = `// The moon tonight, worked out here rather than fetched.
const SYNODIC_DAYS = 29.530588853;
const NEW_MOON = Date.UTC(2000, 0, 6, 18, 14);
const DAY = 86400000;
const QUARTERS = [
  [0, 'New moon'],
  [0.25, 'First quarter'],
  [0.5, 'Full moon'],
  [0.75, 'Last quarter'],
];
const NAMES = [
  'New moon',
  'Waxing crescent',
  'First quarter',
  'Waxing gibbous',
  'Full moon',
  'Waning gibbous',
  'Last quarter',
  'Waning crescent',
];

export default function run(ctx) {
  const lunations = (ctx.now - NEW_MOON) / DAY / SYNODIC_DAYS;
  const round = Math.floor(lunations);
  const through = lunations - round;
  const lit = Math.round(((1 - Math.cos(2 * Math.PI * through)) / 2) * 100);
  const name = NAMES[Math.round(through * 8) % 8];
  const items = QUARTERS.map(function (quarter) {
    const next = round + quarter[0] + (quarter[0] <= through ? 1 : 0);
    return { at: new Date(NEW_MOON + next * SYNODIC_DAYS * DAY).toISOString(), label: quarter[1] };
  }).sort(function (a, b) {
    return Date.parse(a.at) - Date.parse(b.at);
  });
  return { panel: { kind: 'timeline', title: 'Moon: ' + name.toLowerCase() + ', ' + lit + '% lit', items: items } };
}
`;

export const entry: CatalogEntry = {
  id: 'moon-phase',
  name: 'Moon phase',
  author: 'Maverick Wall',
  description:
    'Tonight’s moon, how much of it is lit, and when the next new, first ' +
    'quarter, full and last quarter fall. Worked out on your own server, so it ' +
    'needs no internet and asks nobody.',
  glyph: 'clear',
  emoji: 'moon-crescent',
  preview: ['Moon', 'Full moon · Sat'],
  kind: 'script',
  manifest: {
    name: 'Moon phase',
    contract: 1,
    hosts: [],
    config: [],
    secrets: [],
    intervalSeconds: 3600,
    allowLan: false,
  },
  source: SOURCE,
};
