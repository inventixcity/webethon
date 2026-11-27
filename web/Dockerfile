# syntax=docker/dockerfile:1
#
# Production image for the invigil Next.js web app (next.config.ts: output "standalone").
# Multi-stage: deps -> build -> runner. The runner has the Node runtime, the standalone server,
# .next/static and public/. No source, no devDependencies, no .env* files.
#
# Build for the local Docker engine (single arch):
#   docker build -t invigil-web:local .
#
# Build and push both targets (replace <owner> and <tag>; the image is published to GHCR):
#   docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/<owner>/invigil-web:<tag> --push .
# A multi-platform --push needs a container builder. If buildx reports a driver error, create one first:
#   docker buildx create --use --name multiarch
# Building arm64 on an amd64 host needs QEMU binfmt registered in the Docker engine.
#
# Runtime environment contract. NONE of these are baked into the image. Pass them with `docker run -e`
# or in the pod spec. Never put their values in a build arg or an ENV line.
#   API_ORIGIN         REQUIRED. Base URL of the API, reached from this container, with no trailing slash.
#                      In the cluster that is the `api` Service: http://api:8080
#   PROXY_SECRET       REQUIRED in production. Must equal the API's PROXY_SECRET (the api-secrets Secret).
#                      The proxy uses it to sign the visitor IP header.
#   TRUSTED_IP_HEADER  OPTIONAL. Set to `x-real-ip` or `cf-connecting-ip`, and ONLY when the ingress in
#                      front of this container strips the client's copy of that header and rewrites it.
#                      Unset means no visitor IP is forwarded (the safe default).
#   APP_ORIGIN         Public origin of the web app, e.g. https://app.example.com. The web source does not read
#                      it today (the API does), so it has no effect on this image.
#
# Build args (NOT secrets; their values are compiled into the client bundle, so changing one needs a rebuild):
#   NEXT_PUBLIC_API_ENABLED  default "true" (same as .env.local). "true" routes /api/v1 through the proxy
#                            to API_ORIGIN. "false" turns the proxy off.
#
# Runtime: port 3000, uid/gid 10001 (non-root). The app writes only to /app/.next/cache (image cache).
# If the pod runs with readOnlyRootFilesystem, mount an emptyDir at /app/.next/cache.

# ---------------------------------------------------------------------------
# base: pinned Node major on Alpine (musl). lockfile has musl binaries for sharp, lightningcss,
# @tailwindcss/oxide, and @next/swc. The engines field needs node >=22.
# ---------------------------------------------------------------------------
FROM node:26-alpine AS base
ENV NEXT_TELEMETRY_DISABLED=1

# ---------------------------------------------------------------------------
# deps: install exactly what pnpm-lock.yaml says (dev dependencies included, because `next build`
# needs TypeScript and Tailwind). The image has no pnpm; corepack is pinned and then activates the
# exact pnpm version from package.json "packageManager". Node 26 does not bundle corepack.
# ---------------------------------------------------------------------------
FROM base AS deps
WORKDIR /app
RUN npm install -g corepack@0.36.0 \
 && corepack enable
COPY package.json pnpm-lock.yaml ./
RUN corepack prepare "$(node -p "require('./package.json').packageManager")" --activate
RUN --mount=type=cache,id=invigil-web-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

# ---------------------------------------------------------------------------
# build: copy the source and run the production build. Build args here are public values only.
# API_ORIGIN is never set here. The (app) and (admin) layouts call connection() first, so `next build` never
# reaches the API helpers.
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
ARG NEXT_PUBLIC_API_ENABLED=true
ENV NEXT_PUBLIC_API_ENABLED=${NEXT_PUBLIC_API_ENABLED}
COPY . .
# pnpm also runs this as the `prebuild` hook. The explicit call keeps the image independent of pnpm's
# pre-script setting. It writes public/vendor/maplibre-gl-worker-*.mjs, and the build fails if that step fails.
RUN node scripts/copy-maplibre-worker.mjs \
 && pnpm build

# ---------------------------------------------------------------------------
# runner: only what `node server.js` needs. Standalone output brings its own traced node_modules.
# ---------------------------------------------------------------------------
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -S -g 10001 app \
 && adduser -S -D -H -u 10001 -G app -s /sbin/nologin app

COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
RUN mkdir -p /app/.next/cache \
 && chown 10001:10001 /app/.next/cache

USER 10001:10001
EXPOSE 3000

# busybox wget ships with Alpine. It follows redirects, and it exits non-zero on a connection failure or an
# HTTP error status (4xx/5xx), which marks the container unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1

CMD ["node", "server.js"]
