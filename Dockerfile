# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
ARG PRODUCTION_HOSTNAME
ENV PRODUCTION_HOSTNAME=${PRODUCTION_HOSTNAME} REQUIRE_PRODUCTION_HOSTNAME=true
RUN test -n "$PRODUCTION_HOSTNAME" || (echo 'PRODUCTION_HOSTNAME build argument is required.' >&2; exit 1)

# Native dependencies can compile if a prebuilt binary is unavailable.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci
COPY astro.config.mjs tsconfig.json server.mjs ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY drizzle ./drizzle
RUN DATABASE_PATH=:memory: npm run build \
    && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321 \
    DATABASE_PATH=/data/sqlite.db \
    UPLOAD_DIR=/data/proofs \
    DEMO_DIR=/data/demos

RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-osd \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data \
    && chown node:node /data

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The custom server and migration runner import TypeScript directly in Node 24.
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/server.mjs ./

USER node
EXPOSE 4321
CMD ["node", "server.mjs"]
