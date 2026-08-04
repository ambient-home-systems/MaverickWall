# syntax=docker/dockerfile:1.7
#
# Maverick Wall.
#
# One process, one volume, no sidecars. SQLite lives in /data with the
# encryption key beside it; there is no database service to run and nothing to
# configure before the first-run wizard.
#
# Built for amd64 and arm64 from the same file, because the machines this ends
# up on are a Synology, a Raspberry Pi, a mini PC and an Apple Silicon Mac, and
# only one of those is x86.

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
#
# The build stage runs on the *target* architecture rather than cross-compiling.
# better-sqlite3 is a native module: its binding is compiled here and copied
# into the runtime stage, so it has to be built for the platform that will
# actually load it. Buildx does this per-platform under the hood.
FROM node:22-bookworm-slim AS build

# Toolchain for better-sqlite3's binding, and nothing else. It never reaches
# the runtime image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /src

# Manifests first, so a change to source code does not re-resolve the whole
# dependency tree. The lockfile is copied with them or the install is not
# reproducible.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/calendar/package.json packages/calendar/
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/display/package.json apps/display/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .

# `pnpm test` builds first and then runs; the image build only wants the build.
RUN pnpm -r build

# Prune to what actually runs. `--prod` drops typescript, vitest and the rest;
# `deploy` flattens the server package to the root of /out and brings its own
# self-contained node_modules, so the whole directory copies between stages.
#
# The migrations come with the package. The display bundle does not — it is a
# different workspace package — so it is copied beside it and named by
# DISPLAY_DIR below.
RUN pnpm --filter @maverick-wall/server deploy --prod /out \
 && cp -r apps/display/dist /out/display \
 # `deploy` copies the whole package, sources and test harness included. None
 # of it is read at runtime and all of it ends up in a layer somebody pulls.
 && rm -rf /out/src /out/test /out/tsconfig*.json /out/vitest.config.ts /out/drizzle.config.ts

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# tini reaps zombies and forwards signals, so `docker stop` reaches the
# shutdown handler rather than being killed ten seconds later.
#
# Nothing else is installed. The healthcheck below uses node, which is already
# here — an earlier version reached for wget, which this base does not have,
# and the container ran perfectly while reporting itself unhealthy for ever.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# Absolute, always. A relative DATA_DIR resolves against the working directory,
# which is how one installation silently became two.
ENV DATA_DIR=/data
ENV PORT=8080
# A wall's working set is a few hundred events. Capping the heap means a memory
# leak shows up as a restart on a 1GB Pi rather than as the OOM killer taking
# something else out.
ENV NODE_OPTIONS="--max-old-space-size=256"
# Named explicitly, because `pnpm deploy` flattens the package and the relative
# fallback in static.ts is a fact about the repository layout rather than this
# one. Without it every asset 404s and the wall draws "the bundle is missing".
ENV DISPLAY_DIR=/app/display

WORKDIR /app
COPY --from=build /out /app

COPY --chmod=0755 docker/entrypoint.sh /entrypoint.sh

# /data is created here and given to `node` (uid 1000 in the base image), which
# is what makes a *named* volume work with no configuration at all: Docker
# initialises a new volume from the image's directory and carries its ownership
# across. Without this the volume arrives owned by root.
RUN mkdir -p /data && chown node:node /data

# There is deliberately no `USER` line, and that is not a regression.
#
# The application runs as uid 1000 — the entrypoint drops to it with `setpriv`
# and never comes back, so the process that opens the database, serves the port
# and parses somebody else's calendar feed has exactly the privileges it had
# before. What changed is that the few lines *before* it still have root.
#
# `USER node` here meant the container could not adopt a volume that arrived
# owned by somebody else, and that is not a corner case:
#
#   - The Home Assistant supervisor creates the add-on's /data itself, owned by
#     root, with no option anywhere to change it. The add-on could be installed
#     and could never start. This is the case that found it.
#   - A bind-mounted host folder keeps the host's ownership. The README steers
#     people to a named volume for exactly this reason, and they bind-mount
#     anyway.
#
# Neither is fixable from inside an image that has already given up root, and
# both are one `chown` away for one that has not. Rule nine says a failure
# degrades to reduced function with a message, never a refusal to start — an
# image that cannot write its own volume is a refusal to start.
#
# The entrypoint tests writability *as uid 1000* rather than as root, which is
# the part that has to be right: root can always write, so asking as root
# answers a different question and answers it yes.

VOLUME ["/data"]
EXPOSE 8080

# Unauthenticated on purpose, and it reveals nothing about a household. A
# monitoring check that needs a credential is one nobody sets up.
#
# Probed with node rather than wget or curl: neither is in this base, and
# adding a package to a container purely to make an HTTP request is a thing to
# keep patched in exchange for nothing. `fetch` is global from Node 18.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
# Flattened by `pnpm deploy`: the server package is the root of /app.
CMD ["node", "/app/dist/main.js"]

# Filled in by the release workflow. Kept last so they never bust the cache.
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Maverick Wall" \
      org.opencontainers.image.description="A self-hosted family calendar for a wall display." \
      org.opencontainers.image.source="https://github.com/ambient-home-systems/MaverickWall" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
