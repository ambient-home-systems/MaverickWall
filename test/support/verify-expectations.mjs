// Cross-checks the hardcoded expectations in the test suite against the real
// timezone module and real calendar arithmetic. Catches hand-arithmetic errors
// that would otherwise look like engine bugs when the suite finally runs.
const tz = await import('../../src/timezone.ts');

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  if (!ok) console.log(`  FAIL ${label}\n       got  ${got}\n       want ${want}`);
};

const wc = (y, mo, d, h = 0, mi = 0, s = 0) =>
  ({ year: y, month: mo, day: d, hour: h, minute: mi, second: s });
const at = (y, mo, d, h, mi, zone) =>
  new Date(tz.zonedWallClockToUtcMs(wc(y, mo, d, h, mi), zone)).toISOString();

const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const dow = (y, mo, d) => DOW[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];

console.log('== calendar facts the fixtures assume ==');
check('2026-01-05 is Monday', dow(2026,1,5), 'Mon');
check('2026-01-30 is Friday', dow(2026,1,30), 'Fri');
check('2026-01-31 is Saturday', dow(2026,1,31), 'Sat');
check('2026-02-27 is Friday', dow(2026,2,27), 'Fri');
check('2026-02-28 is Saturday (last day of Feb, non-leap)', dow(2026,2,28), 'Sat');
check('2026-02 has 28 days', new Date(Date.UTC(2026,2,0)).getUTCDate(), 28);
check('2026-03-31 is Tuesday', dow(2026,3,31), 'Tue');
check('2026-03-08 is Sunday (US spring forward)', dow(2026,3,8), 'Sun');
check('2026-11-01 is Sunday (US fall back)', dow(2026,11,1), 'Sun');
check('2026-03-29 is Sunday (EU spring forward)', dow(2026,3,29), 'Sun');
check('2026-10-25 is Sunday (EU fall back)', dow(2026,10,25), 'Sun');
check('1997-08-05 is Tuesday (RFC 5545 WKST example)', dow(1997,8,5), 'Tue');

console.log('== DST transition dates are where the tests assume ==');
const offH = (iso, zone) => tz.offsetMsAt(Date.parse(iso), zone) / 3600000;
check('New York is UTC-5 on 2026-03-04', offH('2026-03-04T12:00:00Z','America/New_York'), -5);
check('New York is UTC-4 on 2026-03-11', offH('2026-03-11T12:00:00Z','America/New_York'), -4);
check('New York is UTC-4 on 2026-10-28', offH('2026-10-28T12:00:00Z','America/New_York'), -4);
check('New York is UTC-5 on 2026-11-04', offH('2026-11-04T12:00:00Z','America/New_York'), -5);
check('Berlin is UTC+1 on 2026-03-25', offH('2026-03-25T12:00:00Z','Europe/Berlin'), 1);
check('Berlin is UTC+2 on 2026-04-01', offH('2026-04-01T12:00:00Z','Europe/Berlin'), 2);
check('Berlin is UTC+2 on 2026-10-21', offH('2026-10-21T12:00:00Z','Europe/Berlin'), 2);
check('Berlin is UTC+1 on 2026-10-28', offH('2026-10-28T12:00:00Z','Europe/Berlin'), 1);
check('London is UTC+0 on 2026-03-25', offH('2026-03-25T12:00:00Z','Europe/London'), 0);
check('London is UTC+1 on 2026-04-01', offH('2026-04-01T12:00:00Z','Europe/London'), 1);

console.log('== recurrence.test.ts expectations ==');
const NY='America/New_York', CHI='America/Chicago';
check('R1 daily  Jan 5 09:00 NY',  at(2026,1,5,9,0,NY),  '2026-01-05T14:00:00.000Z');
check('R1 daily  Jan 7 09:00 NY',  at(2026,1,7,9,0,NY),  '2026-01-07T14:00:00.000Z');
check('R1 byday  Jan 5 11:00 NY',  at(2026,1,5,11,0,NY), '2026-01-05T16:00:00.000Z');
check('R1 byday  Feb 4 11:00 NY',  at(2026,2,4,11,0,NY), '2026-02-04T16:00:00.000Z');
check('R1 bymday Jan 15 14:00 NY', at(2026,1,15,14,0,NY),'2026-01-15T19:00:00.000Z');
check('R1 bymday Mar 15 14:00 NY', at(2026,3,15,14,0,NY),'2026-03-15T18:00:00.000Z');
check('R1 setpos Jan 30 16:00 NY', at(2026,1,30,16,0,NY),'2026-01-30T21:00:00.000Z');
check('R1 setpos Feb 27 16:00 NY', at(2026,2,27,16,0,NY),'2026-02-27T21:00:00.000Z');
check('R1 setpos Mar 31 16:00 NY', at(2026,3,31,16,0,NY),'2026-03-31T20:00:00.000Z');
check('R1 until  Jan 6 08:00 NY',  at(2026,1,6,8,0,NY),  '2026-01-06T13:00:00.000Z');
check('R1 until  Jan 27 08:00 NY', at(2026,1,27,8,0,NY), '2026-01-27T13:00:00.000Z');
check('R1 wkst   1997-08-05 09:00 NY', at(1997,8,5,9,0,NY),  '1997-08-05T13:00:00.000Z');
check('R1 wkst   1997-08-31 10:00 NY', at(1997,8,31,10,0,NY),'1997-08-31T14:00:00.000Z');
check('R2 exdate Jun 1 08:00 CHI', at(2026,6,1,8,0,CHI), '2026-06-01T13:00:00.000Z');
check('R2 exdate Jul 5 08:00 CHI', at(2026,7,5,8,0,CHI), '2026-07-05T13:00:00.000Z');
check('R2 allday Aug 10 00:00 CHI',at(2026,8,10,0,0,CHI),'2026-08-10T05:00:00.000Z');
check('R3 rdate  Jun 19 08:00 CHI',at(2026,6,19,8,0,CHI),'2026-06-19T13:00:00.000Z');
check('R3 rdate  Sep 1 12:00 CHI', at(2026,9,1,12,0,CHI),'2026-09-01T17:00:00.000Z');
check('R4 moved  Jun 2 14:00 CHI', at(2026,6,2,14,0,CHI),'2026-06-02T19:00:00.000Z');
check('R4 retro  Jun 3 09:00 CHI', at(2026,6,3,9,0,CHI), '2026-06-03T14:00:00.000Z');

console.log('== timezones.test.ts expectations ==');
check('R5 vtz summer Jun 15 09:30 CHI', at(2026,6,15,9,30,CHI),'2026-06-15T14:30:00.000Z');
check('R5 vtz winter Jan 15 09:30 CHI', at(2026,1,15,9,30,CHI),'2026-01-15T15:30:00.000Z');
check('R5 outlook   Jun 15 09:00 NY',   at(2026,6,15,9,0,NY),  '2026-06-15T13:00:00.000Z');
check('R5 outlook   Jun 15 09:00 LON',  at(2026,6,15,9,0,'Europe/London'),'2026-06-15T08:00:00.000Z');
check('R5 mozilla   Jun 15 09:00 CHI',  at(2026,6,15,9,0,CHI), '2026-06-15T14:00:00.000Z');
check('R6 float     Jun 14 08:00 CHI',  at(2026,6,14,8,0,CHI), '2026-06-14T13:00:00.000Z');
check('R6 float     Jun 14 08:00 BER',  at(2026,6,14,8,0,'Europe/Berlin'),'2026-06-14T06:00:00.000Z');
check('R7 sf        Mar 4 09:00 NY',    at(2026,3,4,9,0,NY),   '2026-03-04T14:00:00.000Z');
check('R7 sf        Mar 11 09:00 NY',   at(2026,3,11,9,0,NY),  '2026-03-11T13:00:00.000Z');
check('R7 span      Mar 8 01:00 NY',    at(2026,3,8,1,0,NY),   '2026-03-08T06:00:00.000Z');
check('R7 span end  Mar 8 04:00 NY',    at(2026,3,8,4,0,NY),   '2026-03-08T08:00:00.000Z');
check('R8 fb        Oct 28 09:00 NY',   at(2026,10,28,9,0,NY), '2026-10-28T13:00:00.000Z');
check('R8 fb        Nov 4 09:00 NY',    at(2026,11,4,9,0,NY),  '2026-11-04T14:00:00.000Z');
check('R9 eu sf     Mar 25 09:00 BER',  at(2026,3,25,9,0,'Europe/Berlin'),'2026-03-25T08:00:00.000Z');
check('R9 eu sf     Apr 1 09:00 BER',   at(2026,4,1,9,0,'Europe/Berlin'), '2026-04-01T07:00:00.000Z');
check('R9 eu fb     Oct 21 09:00 BER',  at(2026,10,21,9,0,'Europe/Berlin'),'2026-10-21T07:00:00.000Z');
check('R9 eu fb     Oct 28 09:00 BER',  at(2026,10,28,9,0,'Europe/Berlin'),'2026-10-28T08:00:00.000Z');
check('R9 uk        Mar 25 09:00 LON',  at(2026,3,25,9,0,'Europe/London'),'2026-03-25T09:00:00.000Z');
check('R9 uk        Apr 1 09:00 LON',   at(2026,4,1,9,0,'Europe/London'), '2026-04-01T08:00:00.000Z');

console.log('== allday.test.ts expectations ==');
check('R10 Mar 15 midnight CHI', at(2026,3,15,0,0,CHI), '2026-03-15T05:00:00.000Z');
check('R10 Mar 16 midnight CHI', at(2026,3,16,0,0,CHI), '2026-03-16T05:00:00.000Z');
check('R11 Feb 28 midnight CHI', at(2026,2,28,0,0,CHI), '2026-02-28T06:00:00.000Z');
check('R11 Mar 31 midnight CHI', at(2026,3,31,0,0,CHI), '2026-03-31T05:00:00.000Z');
check('R12 Mar 6 midnight CHI',  at(2026,3,6,0,0,CHI),  '2026-03-06T06:00:00.000Z');
check('R12 Mar 10 midnight CHI', at(2026,3,10,0,0,CHI), '2026-03-10T05:00:00.000Z');
const elapsed = (Date.parse('2026-03-10T05:00:00.000Z') - Date.parse('2026-03-06T06:00:00.000Z')) / 3600000;
check('R12 four-day span is 95 real hours', elapsed, 95);

console.log('== all-day anchoring in other target zones (R10) ==');
for (const zone of ['Pacific/Auckland','America/Los_Angeles','Asia/Kolkata','UTC']) {
  const startMs = tz.zonedWallClockToUtcMs(wc(2026,3,15,0,0), zone);
  const endMs = tz.zonedWallClockToUtcMs(wc(2026,3,16,0,0), zone);
  check(`R10 ${zone} start day`, tz.localDateOf(startMs, zone), '2026-03-15');
  check(`R10 ${zone} last touched day`, tz.localDateOf(endMs - 1, zone), '2026-03-15');
}


console.log('== real-feeds.test.ts expectations (FCPS, America/New_York) ==');
const NYC = 'America/New_York';
check('FCPS Sep 21 2026 midnight NY', at(2026,9,21,0,0,NYC), '2026-09-21T04:00:00.000Z');
check('FCPS Sep 23 2026 midnight NY', at(2026,9,23,0,0,NYC), '2026-09-23T04:00:00.000Z');
check('FCPS Dec 31 2026 midnight NY', at(2026,12,31,0,0,NYC), '2026-12-31T05:00:00.000Z');
check('FCPS Jan 18 2027 midnight NY', at(2027,1,18,0,0,NYC), '2027-01-18T05:00:00.000Z');
check('FCPS Mar 10 2027 midnight NY (before DST)', at(2027,3,10,0,0,NYC), '2027-03-10T05:00:00.000Z');
check('FCPS May 13 2027 midnight NY (after DST)', at(2027,5,13,0,0,NYC), '2027-05-13T04:00:00.000Z');
check('FCPS May 31 2027 midnight NY', at(2027,5,31,0,0,NYC), '2027-05-31T04:00:00.000Z');
check('US DST 2027 starts Mar 14', dow(2027,3,14), 'Sun');
check('NY is UTC-5 on 2027-03-10', offH('2027-03-10T12:00:00Z', NYC), -5);
check('NY is UTC-4 on 2027-03-15', offH('2027-03-15T12:00:00Z', NYC), -4);

console.log(`\n${pass} checks passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
