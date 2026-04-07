# Multi-stage build for the GRVT Grid bot.
#
# Stage 1: build the bot TypeScript + compile better-sqlite3 / sqlite3 native
# bindings against a glibc base. We need build-essential + python because
# sqlite3 still ships some platforms without prebuilt binaries.
#
# Stage 2: slim runtime image. Copies dist + node_modules from stage 1, drops
# everything else. Runs as non-root grvtbot user with a fixed UID so the
# bind-mounted data dir on the host has predictable ownership.

# ── Stage 1: builder ──────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Install only the bot package's deps. Copying package.json + lockfile first
# means npm install gets cached on every rebuild that doesn't change deps.
COPY package.json package-lock.json ./
COPY packages/bot/package.json packages/bot/
COPY packages/bot/tsconfig.json packages/bot/

RUN npm ci --workspace=@grvt-grid/bot --include-workspace-root

# Now copy the source and build
COPY packages/bot/src packages/bot/src
COPY packages/bot/tests packages/bot/tests
RUN npm run build --workspace=@grvt-grid/bot

# ── Stage 2: runtime ──────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Non-root user with a fixed UID so bind-mounted data/ has predictable owner
RUN groupadd -g 10000 grvtbot && \
    useradd -u 10000 -g grvtbot -m -s /usr/sbin/nologin grvtbot

WORKDIR /app

# Copy compiled output + production node_modules from builder
COPY --from=builder --chown=grvtbot:grvtbot /build/packages/bot/dist ./dist
COPY --from=builder --chown=grvtbot:grvtbot /build/node_modules ./node_modules
COPY --from=builder --chown=grvtbot:grvtbot /build/packages/bot/node_modules ./packages-node_modules
COPY --chown=grvtbot:grvtbot packages/bot/package.json ./package.json

# The dashboard SPA bundle. The host can mount /app/dashboard-dist to
# override with a freshly-built version, or use the baked-in default.
COPY --chown=grvtbot:grvtbot packages/dashboard/dist ./dashboard-dist

# Data dir is a bind-mount target for the SQLite db + WAL files
RUN mkdir -p /app/data && chown grvtbot:grvtbot /app/data
VOLUME /app/data

USER grvtbot
EXPOSE 3848

# Healthcheck talks to the legacy /api/health (no auth required)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fs http://127.0.0.1:3848/api/health || exit 1

# Tini handles PID 1 + signal forwarding (SIGTERM → node → graceful shutdown
# preserves GRVT open orders, exactly like the systemd unit on the VPS).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/dashboard/server.js"]
