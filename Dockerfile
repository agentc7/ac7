# Multi-stage build: compile inside a builder, ship a slim runtime image.
#
# The image runs `ac7 serve` against a config at /data/ac7.json. State
# (config, encryption key, SQLite db, self-signed certs) is meant to
# live on a mounted volume — see docker-compose.yml for the wiring.
#
# Build:   docker build -t ac7 .
# Run:     docker run -it --rm -p 8717:8717 -v ac7-data:/data ac7
#          (first run drops you into the interactive setup wizard)

# ─── Stage 1: build ────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /src

RUN corepack enable

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json tsconfig.json biome.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile
RUN pnpm build

# Reduce node_modules to production deps only for the runtime image.
RUN pnpm --filter @agentc7/ac7 deploy --prod /out

# ─── Stage 2: runtime ──────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Non-root user. /data is the operator-owned state volume.
RUN useradd -r -u 10001 -m -d /home/ac7 ac7 && \
    mkdir -p /data && chown -R ac7:ac7 /data /app /home/ac7

COPY --from=builder --chown=ac7:ac7 /out /app
COPY --from=builder --chown=ac7:ac7 /src/apps/server/dist /app/apps/server/dist
COPY --from=builder --chown=ac7:ac7 /src/apps/server/public /app/apps/server/public
COPY --from=builder --chown=ac7:ac7 /src/packages /app/packages

USER ac7
WORKDIR /data

ENV NODE_ENV=production
ENV AC7_CONFIG_PATH=/data/ac7.json
ENV AC7_HOST=0.0.0.0
ENV AC7_PORT=8717

EXPOSE 8717 7443
VOLUME ["/data"]

# `ac7 serve` triggers the first-run wizard if /data/ac7.json is absent.
# Pass `-it` and run interactively for that path; subsequent boots are
# non-interactive.
ENTRYPOINT ["node", "/app/node_modules/@agentc7/cli/dist/index.js"]
CMD ["serve"]
