# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# Native deps for better-sqlite3/argon2 builds
FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

FROM base AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 gateway \
  && useradd --system --uid 10001 --gid gateway --home /app --shell /usr/sbin/nologin gateway \
  && mkdir -p /data \
  && chown -R gateway:gateway /app /data

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY liquidsoap ./liquidsoap

ENV DATA_DIR=/data \
    DATABASE_PATH=/data/gateway.sqlite \
    GATEWAY_HOST=0.0.0.0 \
    GATEWAY_PORT=8005 \
    ADMIN_HOST=0.0.0.0 \
    ADMIN_PORT=3000

EXPOSE 8005 3000
VOLUME ["/data"]

USER gateway
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
