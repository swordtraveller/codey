# syntax=docker/dockerfile:1

# Build the static Handover PWA once; the runtime image contains no source tooling.
FROM node:22-alpine AS handover-build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY handover ./handover
RUN pnpm handover:build

# Bridge has no third-party runtime dependencies. Run it as the unprivileged
# `node` user and persist its state outside the image.
FROM node:22-alpine AS bridge
WORKDIR /app
ENV NODE_ENV=production \
    BRIDGE_HOST=0.0.0.0 \
    BRIDGE_DATA_PATH=/var/lib/codey-bridge/bridge.json
COPY --chown=node:node bridge ./bridge
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "bridge/cli.mjs", "start", "--port", "8787"]

# Caddy serves Handover and terminates public HTTPS for both domains.
FROM caddy:2-alpine AS handover
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=handover-build /app/handover/dist /srv/handover