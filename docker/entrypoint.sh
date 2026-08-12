#!/bin/sh
# Say what is wrong before it becomes a stack trace, and fix what can be fixed.
#
# Rule eleven: you can never reach the household's machine, so the container's
# first ten lines of output are the entire diagnostic channel. The failures
# that actually happen on a first run are all about the volume, and every one
# of them looks like an unreadable Node error if nobody catches it here.
set -e

DATA_DIR="${DATA_DIR:-/data}"

# The uid the application runs as. `node` in the base image, and the owner of
# /data as the image ships it — so a named volume needs no arrangement at all.
APP_UID=1000
APP_GID=1000

if [ ! -d "$DATA_DIR" ]; then
  echo "  The data directory $DATA_DIR is not there."
  echo ""
  echo "  Mount a volume at $DATA_DIR so the calendar survives a restart:"
  echo "    docker run -v maverick-wall:/data ..."
  exit 1
fi

# ---------------------------------------------------------------------------
# Can the application's user write to the volume?
# ---------------------------------------------------------------------------
#
# Asked *as that user*, which is the whole point. Running the test as root
# answers a different question and always answers yes — root can write to a
# directory uid 1000 cannot, so the check would pass and the application would
# then fail with EACCES on its first query.
writable_by_app() {
  if [ "$(id -u)" = "0" ]; then
    setpriv --reuid="$APP_UID" --regid="$APP_GID" --clear-groups \
      touch "$DATA_DIR/.writable" 2>/dev/null || return 1
  else
    touch "$DATA_DIR/.writable" 2>/dev/null || return 1
  fi
  rm -f "$DATA_DIR/.writable" 2>/dev/null || true
  return 0
}

# ---------------------------------------------------------------------------
# Adopt the volume if we still can
# ---------------------------------------------------------------------------
#
# This container starts as root and does not stay that way — see the Dockerfile
# for why the `USER` line went. The one thing root is for is this: a directory
# that arrives owned by somebody else is the single commonest way a first run
# fails, and it is trivially fixable from in here while nothing has opened the
# database yet.
#
# The Home Assistant add-on is the case that forced it. The supervisor creates
# the add-on's /data itself, owned by root, and there is no option anywhere
# that changes that — so an image running as uid 1000 simply could not start,
# and the message below told the household to chown a directory they cannot
# see or to pass a docker flag they never typed. Both true for `docker run`,
# both useless under the supervisor.
#
# Announced rather than silent, because it changes ownership of a directory on
# somebody's host and they should be able to find out why from the log.
if ! writable_by_app; then
  if [ "$(id -u)" = "0" ]; then
    echo "[entrypoint] $DATA_DIR is not writable by uid $APP_UID. Taking ownership of it."
    chown -R "$APP_UID:$APP_GID" "$DATA_DIR" 2>/dev/null || true
  fi
fi

# Still not writable: a read-only mount, a filesystem with no ownership to
# change, or a container told to run as a user that cannot fix it. Nothing left
# to do but say so in a way somebody can act on.
if ! writable_by_app; then
  echo "  $DATA_DIR is not writable, and this container could not fix it."
  echo ""
  if [ "$(id -u)" = "0" ]; then
    echo "  It is running as root and still could not take ownership, so the"
    echo "  mount is most likely read-only. Check for a :ro on the volume."
  else
    echo "  It was told to run as uid $(id -u), which cannot take ownership of"
    echo "  the directory. Either give that user the directory:"
    echo ""
    echo "    sudo chown -R $(id -u):$(id -g) ./data"
    echo ""
    echo "  or drop the --user flag and let the container sort it out itself."
  fi
  echo ""
  echo "  A named volume needs none of this:"
  echo "    docker run -v maverick-wall:/data ..."
  exit 1
fi

# ---------------------------------------------------------------------------
# Home Assistant add-on options
# ---------------------------------------------------------------------------
#
# The supervisor writes what somebody typed in the add-on's Configuration tab
# to /data/options.json. Nothing else in this image knows that file exists, so
# this is where it becomes an environment variable.
#
# An explicit value already in the environment always wins — somebody who set
# it meant it — so each is read only when its variable is still unset.
#
#   - base_url: under ingress the address is handled for us, but the *wall
#     displays* connect to the add-on's port directly, and the pairing link
#     they are given comes from BASE_URL. Left unset it says `localhost`, which
#     is nowhere from a tablet on a wall.
#   - ingress_trust_source: the supervisor's address, which lets the settings
#     trust a Home Assistant login instead of asking for a second one. The
#     default in the app is right on a normal install; this only overrides it.
#   - mdns: whether to announce the add-on on the LAN so a screen can find it
#     without a typed address. A boolean rather than a string, so it needs its
#     own reader: read_option returns strings only, and a `false` read through
#     it would come back empty and be indistinguishable from "not set" — an
#     option a household could turn off that did nothing.
read_option() {
  # node is already here, and parsing JSON in sh is how quoting bugs are born.
  node -e '
    try {
      const o = require(process.argv[1]);
      const v = o && o[process.argv[2]];
      if (typeof v === "string" && v.trim() !== "") process.stdout.write(v.trim());
    } catch {}
  ' "$DATA_DIR/options.json" "$1" 2>/dev/null || true
}

# The same, for a boolean. Prints "true", "false", or nothing at all when the
# key is absent — the three cases the caller has to tell apart.
read_option_bool() {
  node -e '
    try {
      const o = require(process.argv[1]);
      const v = o && o[process.argv[2]];
      if (typeof v === "boolean") process.stdout.write(String(v));
    } catch {}
  ' "$DATA_DIR/options.json" "$1" 2>/dev/null || true
}

if [ -f "$DATA_DIR/options.json" ]; then
  if [ -z "${BASE_URL:-}" ]; then
    option_base_url=$(read_option base_url)
    if [ -n "$option_base_url" ]; then
      export BASE_URL="$option_base_url"
      echo "[entrypoint] BASE_URL from add-on options: $BASE_URL"
    fi
  fi

  if [ -z "${INGRESS_TRUST_SOURCE:-}" ]; then
    option_trust=$(read_option ingress_trust_source)
    if [ -n "$option_trust" ]; then
      export INGRESS_TRUST_SOURCE="$option_trust"
      echo "[entrypoint] INGRESS_TRUST_SOURCE from add-on options: $INGRESS_TRUST_SOURCE"
    fi
  fi

  # Only `false` does anything: the application advertises unless MDNS_DISABLE
  # is set to something, so an unset or true option must leave it alone rather
  # than export an empty value.
  if [ -z "${MDNS_DISABLE:-}" ] && [ "$(read_option_bool mdns)" = "false" ]; then
    export MDNS_DISABLE=1
    echo "[entrypoint] mDNS advertising disabled by add-on options"
  fi
fi

# ---------------------------------------------------------------------------
# Drop
# ---------------------------------------------------------------------------
#
# Everything above either needed root or did not care. Nothing from here on
# gets it.
#
# `setpriv` execs directly rather than forking, so the application keeps its
# place under tini and `docker stop` still reaches the shutdown handler — `su`
# would put a shell in between and eat the signal. It is part of util-linux and
# is already in the base image, which is the point: reaching for `gosu` would
# mean a package to install and keep patched, and the HEALTHCHECK already
# taught this image what assuming a binary is present costs.
#
# --no-new-privs so nothing downstream can regain what was just given up.
if [ "$(id -u)" = "0" ]; then
  echo "[entrypoint] starting as uid $APP_UID"
  exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --init-groups \
    --inh-caps=-all --no-new-privs "$@"
fi

exec "$@"
