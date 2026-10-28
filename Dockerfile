FROM node:24.22.0-bookworm-slim AS runtime
ENV DSH_TELEMETRY_DISABLED=1 NODE_ENV=production
WORKDIR /opt/dsh
COPY deploy/runtime/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24.22.0-bookworm-slim AS plugin
WORKDIR /app
COPY package*.json ./
COPY patches ./patches
RUN npm ci
COPY tsconfig.json ./
COPY plugins ./plugins
RUN npx tsc && npm prune --omit=dev

FROM runtime
WORKDIR /app
COPY --from=plugin /app/node_modules ./node_modules
COPY --from=plugin /app/plugins ./plugins
COPY package.json ./
COPY scripts ./scripts
COPY deploy ./deploy
COPY config ./config
RUN node deploy/verify-runtime.mjs && mkdir -p /data && chown node:node /data
USER node
ENV DSH_HOME=/data/dsh PET_CONFIG=/app/config/pet.json
ENTRYPOINT ["flock", "--no-fork", "--nonblock", "/data/pet.instance.lock", "node", "/app/deploy/entrypoint.mjs"]
