# syntax=docker/dockerfile:1.7

# ---- Build stage -----------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Install dependencies first so this layer is cached across source changes.
COPY package.json package-lock.json ./
RUN npm ci

# Compile TypeScript. The image only ships the compiled output.
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Prune devDependencies so the runtime image stays small.
RUN npm prune --omit=dev

# ---- Runtime stage ---------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

# Run as a non-root user for defense in depth.
RUN addgroup -S app && adduser -S app -G app \
    && mkdir -p /app/data && chown -R app:app /app/data

# Copy the production deps and compiled output from the build stage.
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --chown=app:app package.json ./

USER app

# Fastify/Node listen on 3000 by default; REDACT_PII defaults to on.
ENV NODE_ENV=production \
    PORT=3000 \
    REDACT_PII=1

EXPOSE 3000

# Report container health via /health endpoint every 30s with 5s timeout.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

# Node handles SIGINT/SIGTERM directly (the app has graceful shutdown), and
# Docker's `--init` can be used if zombie reaping is ever needed.
#
# Persistent store for API keys lives in /app/data (used when AUTH_ENABLED=1).
# On Railway, attach a Volume to /app/data so keys survive redeploys; do not use
# a Dockerfile `VOLUME` directive (Railway does not support it).
CMD ["node", "dist/index.js"]
