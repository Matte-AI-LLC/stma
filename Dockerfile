# Multi-stage build. Plain Dockerfile syntax (no BuildKit-only features) so
# `az acr build`, docker/build-push-action and classic `docker build` all work.

# ---------- build: full dev install + tsup bundle ----------
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
RUN npm ci

COPY . .
RUN npm run build

# ---------- prune: production-only node_modules ----------
# tsup bundles only workspace code (noExternal: @bridge/*). Runtime deps —
# hono, @hono/node-server, postgres, @electric-sql/pglite, drizzle-orm,
# @modelcontextprotocol/sdk, dotenv, zod — are resolved from node_modules
# at runtime, so the final image needs a production install.
FROM node:22-slim AS prune
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
# mkdir guarantees the per-workspace dir exists so the runtime COPY cannot fail.
RUN npm ci --omit=dev && mkdir -p packages/server/node_modules

# ---------- runtime ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

# Production dependency tree (hoisted at /app/node_modules, workspace symlinks preserved).
COPY --from=prune --chown=node:node /app/node_modules ./node_modules
COPY --from=prune --chown=node:node /app/packages/server/node_modules ./packages/server/node_modules

# Package manifests keep module resolution intact: "type": "module" in
# packages/server/package.json is required for dist/index.js to load as ESM,
# and the workspace symlinks in node_modules point at these directories.
COPY --chown=node:node package.json ./
COPY --chown=node:node packages/shared/package.json packages/shared/
COPY --chown=node:node packages/server/package.json packages/server/
COPY --chown=node:node packages/cli/package.json packages/cli/

# App bundle + drizzle migrations (dist resolves them as ../drizzle via import.meta.url).
COPY --from=build --chown=node:node /app/packages/server/dist packages/server/dist
COPY --chown=node:node packages/server/drizzle packages/server/drizzle

# Writable data dir for the embedded database (EMBEDDED_DB=1) — mount a volume here.
RUN mkdir -p /app/packages/server/.data && chown -R node:node /app/packages/server/.data

USER node
WORKDIR /app/packages/server
EXPOSE 3000

# Single line on purpose: no continuation backslashes to trip over CRLF checkouts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
