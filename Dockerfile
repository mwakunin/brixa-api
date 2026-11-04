# syntax=docker/dockerfile:1

# Node 24: matches CI.
ARG NODE_VERSION=24-alpine

# --- deps -------------------------------------------------------------------
# Full install (dev included) purely to compile. None of it reaches the final
# image.
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# --- build ------------------------------------------------------------------
FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Mirrors the "build" script: tsc emits JS, tsc-alias rewrites the "@/*"
# paths Node cannot resolve.
RUN ./node_modules/.bin/tsc && ./node_modules/.bin/tsc-alias

# --- production dependencies ------------------------------------------------
# Resolved separately so the runtime image never contains a compiler.
FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# --- runtime ----------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Better Auth's session columns are `timestamp` without a zone, so the process
# must not drift from the database's UTC. Business dates are computed in
# Africa/Nairobi in one module (CLAUDE.md rule 26), never from this clock zone.
ENV TZ=UTC

# env.ts requires LOG_LEVEL with no default. An image has no .env to read, so
# without this the container exits before serving anything.
ENV LOG_LEVEL=info

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# .sql files are data, not compiled output. The deploy-time migrator reads
# them from this path.
COPY src/db/migrations ./src/db/migrations

USER node

EXPOSE 9999

# For `docker run` and Compose only: Cloud Run ignores HEALTHCHECK. There, the
# service needs an HTTP startup/readiness probe on /health, which answers 503
# until every database connection works; otherwise the default TCP probe
# passes as soon as the port opens, and requests meet the startup gate's 503
# until the role check succeeds (src/lib/startup-gate.ts).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9999)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations are deliberately NOT run here: with more than one instance they
# would race. Run them as a separate release step from this same image:
#
#   docker run --rm --env-file .env.production <image> node ./dist/src/db/migrate.js
CMD ["node", "./dist/src/index.js"]
