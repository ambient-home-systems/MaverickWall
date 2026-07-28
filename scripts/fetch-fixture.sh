#!/bin/bash
#
# Fetch a calendar feed into the fixture corpus.
#
#   ./scripts/fetch-fixture.sh <url> <name>
#
# Example:
#   ./scripts/fetch-fixture.sh 'https://example.org/cal.ics' acme-school-district
#
# Fixtures are frozen at fetch time on purpose. Producers edit their calendars
# continuously, so a live fetch during tests would break snapshots weekly and
# turn a real regression signal into noise.
set -euo pipefail

if [ $# -lt 2 ]; then
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

URL="$1"
NAME="$2"

if [ ! -f package.json ] || ! grep -q '@maverick-wall/calendar' package.json; then
  echo "ERROR: run this from the calendar package directory."
  exit 1
fi

# webcal:// is just https:// with a scheme that tells the OS to open a calendar app.
URL="${URL/#webcal:\/\//https://}"

DEST="test/fixtures/real/${NAME}.ics"
mkdir -p test/fixtures/real

if [ -e "$DEST" ]; then
  echo "ERROR: $DEST already exists."
  echo "       Delete it first if you intend to refresh the fixture, and expect"
  echo "       a snapshot diff you will need to read."
  exit 1
fi

# A private feed URL is a bearer credential with no expiry. Never echo it in
# full: terminal scrollback gets pasted into issues and chat windows.
MASKED=$(printf '%s' "$URL" | sed -E 's#(private-|secret/|basic/)[A-Za-z0-9_-]{8,}#\1***REDACTED***#g')
IS_PRIVATE=0
if printf '%s' "$URL" | grep -qiE 'private-|/secret/|[A-Za-z0-9]{24,}'; then
  IS_PRIVATE=1
fi

echo "==> Fetching $MASKED"
if [ "$IS_PRIVATE" = "1" ]; then
  echo "    This looks like a private feed URL. It is a credential: anyone"
  echo "    holding it can read this calendar indefinitely, and it does not"
  echo "    expire. It will not be echoed in full or written anywhere."
fi
# A real User-Agent, because some providers reject blank ones, and because
# identifying ourselves is the polite thing to do.
curl -fsSL \
  --max-time 60 \
  --max-filesize 20971520 \
  -H 'User-Agent: MaverickWall-FixtureCollector/0.1 (+https://github.com/maverick-wall)' \
  -H 'Accept: text/calendar, text/plain' \
  -o "$DEST" \
  "$URL"

if [ ! -s "$DEST" ]; then
  echo "ERROR: empty response. Nothing saved."
  rm -f "$DEST"
  exit 1
fi

# A dead feed URL usually answers with an HTML error page rather than a 404.
if ! head -c 400 "$DEST" | grep -qi 'BEGIN:VCALENDAR'; then
  echo "ERROR: response does not look like iCalendar. First few lines:"
  head -c 400 "$DEST"
  echo
  echo "Saved nothing. Check the URL is the ICS feed and not the web page."
  rm -f "$DEST"
  exit 1
fi

BYTES=$(wc -c < "$DEST" | tr -d ' ')
EVENTS=$(grep -c '^BEGIN:VEVENT' "$DEST" || true)
ALLDAY=$(grep -c 'VALUE=DATE:' "$DEST" || true)
RRULES=$(grep -c '^RRULE' "$DEST" || true)
TZIDS=$(grep -o 'TZID=[^:;]*' "$DEST" | sort -u | head -5 || true)
PRODID=$(grep -m1 '^PRODID' "$DEST" | cut -c1-90 || true)

echo
echo "==> Saved $DEST"
echo "    bytes:        $BYTES"
echo "    VEVENTs:      $EVENTS"
echo "    all-day refs: $ALLDAY"
echo "    RRULEs:       $RRULES"
echo "    producer:     ${PRODID:-unknown}"
if [ -n "$TZIDS" ]; then
  echo "    TZIDs seen:"
  echo "$TZIDS" | sed 's/^/      /'
fi
if [ "$IS_PRIVATE" = "1" ]; then
  echo "==> This is a private feed. Scrub it before it goes anywhere near git:"
  echo
  echo "      npm run fixture:scrub -- $DEST"
  echo
  echo "    Content is replaced with same-length placeholders, so folding and"
  echo "    every structural property survive intact. Recurrence, timezones,"
  echo "    overrides and exceptions are exactly what we want to test; titles"
  echo "    and attendees are not."
  echo
fi

echo
echo "==> Next, two things, both required:"
echo
echo "  1. Add a config entry in test/fixtures.snapshot.test.ts so the snapshot"
echo "     uses the right household timezone. Without one the test will fail"
echo "     rather than quietly snapshot a wrong zone:"
echo
echo "       'real/${NAME}.ics': {"
echo "         targetTimezone: 'America/New_York',"
echo "         windowStart: '2026-01-01T00:00:00Z',"
echo "         windowEnd: '2028-01-01T00:00:00Z',"
echo "       },"
echo
if [ "$IS_PRIVATE" = "1" ]; then
  echo "  2. Add a provenance row to test/fixtures/README.md. For the source,"
  echo "     record the PRODUCT ONLY, never the URL:"
  echo "       | Source | Google Calendar (private iCal URL, not recorded) |"
else
  echo "  2. Add a provenance row to test/fixtures/README.md: source URL,"
  echo "     producer, retrieval date, household timezone."
fi
echo
echo "Then: npx vitest run   (a new snapshot will be written; read it)"
