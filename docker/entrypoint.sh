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

exec "$@"
