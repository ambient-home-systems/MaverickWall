#!/bin/sh
# Say what is wrong before it becomes a stack trace.
#
# Rule eleven: you can never reach the household's machine, so the container's
# first ten lines of output are the entire diagnostic channel. The two failures
# that actually happen on a first run are both about the volume, and both look
# like an unreadable Node error if nobody catches them here.
set -e

DATA_DIR="${DATA_DIR:-/data}"

if [ ! -d "$DATA_DIR" ]; then
  echo "  The data directory $DATA_DIR is not there."
  echo ""
  echo "  Mount a volume at $DATA_DIR so the calendar survives a restart:"
  echo "    docker run -v ./data:/data ..."
  exit 1
fi

# Written as root, mounted from a host directory owned by somebody else, or on
# a filesystem that does not do permissions — all end up here.
if ! touch "$DATA_DIR/.writable" 2>/dev/null; then
  echo "  $DATA_DIR is not writable by this container."
  echo ""
  echo "  It runs as uid $(id -u) so it is not root on your machine. Give that"
  echo "  user the directory:"
  echo ""
  echo "    sudo chown -R $(id -u):$(id -g) ./data"
  echo ""
  echo "  Or let Docker create the volume itself by using a named volume:"
  echo "    docker run -v maverick-wall:/data ..."
  exit 1
fi
rm -f "$DATA_DIR/.writable"

# ---------------------------------------------------------------------------
# Home Assistant add-on options
# ---------------------------------------------------------------------------
#
# The supervisor writes what somebody typed in the add-on's Configuration tab
# to /data/options.json. Nothing else in this image knows that file exists, so
# this is where it becomes an environment variable.
#
# Only `base_url`, and it earns its place: under ingress the address is
# handled for us, but the *wall displays* connect to the add-on's port
# directly, and the pairing link they are given comes from BASE_URL. Left
# unset it says `localhost`, which is exactly nowhere from a tablet on a wall.
#
# An explicit BASE_URL in the environment wins — somebody who set it meant it.
if [ -f "$DATA_DIR/options.json" ] && [ -z "${BASE_URL:-}" ]; then
  # node is already here, and parsing JSON in sh is how quoting bugs are born.
  option_base_url=$(node -e '
    try {
      const o = require(process.argv[1]);
      const v = o && o.base_url;
      if (typeof v === "string" && v.trim() !== "") process.stdout.write(v.trim());
    } catch {}
  ' "$DATA_DIR/options.json" 2>/dev/null || true)

  if [ -n "$option_base_url" ]; then
    export BASE_URL="$option_base_url"
    echo "[entrypoint] BASE_URL from add-on options: $BASE_URL"
  fi
fi

exec "$@"
