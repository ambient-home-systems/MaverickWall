import type { DisplayTemplate } from '../api/templates.js';
import { template as skyCalendar } from './sky-calendar.js';
import { template as skyWeek } from './sky-week.js';
import { template as familyHub } from './family-hub.js';
import { template as todayFocus } from './today-focus.js';
import { template as commandCenter } from './command-center.js';
import { template as choreBoard } from './chore-board.js';
import { template as countdown } from './countdown.js';
import { template as minimalClock } from './minimal-clock.js';
import { template as teamWeek } from './team-week.js';
import { template as meetingRoom } from './meeting-room.js';
import { template as opsDashboard } from './ops-dashboard.js';
import { template as reception } from './reception.js';

/**
 * The starting layouts a household picks from (RFC 005).
 *
 * One file per template in this directory; add yours by pull request and it
 * ships to everyone in the next release — a directory of source, not a fetched
 * document, so it bakes into the image and works on a wall with no internet, the
 * same posture as the Store. `test/templates.test.ts` validates the whole list
 * against `templateSchema`, so a malformed template fails the build.
 *
 * Order is gallery order. The two Skylight-style clones lead — they are the
 * front door for a household replacing a commercial calendar — then the rest of
 * the home layouts, then the office ones.
 */
export const TEMPLATES: readonly DisplayTemplate[] = [
  skyCalendar,
  skyWeek,
  familyHub,
  todayFocus,
  commandCenter,
  choreBoard,
  countdown,
  minimalClock,
  teamWeek,
  meetingRoom,
  opsDashboard,
  reception,
];
