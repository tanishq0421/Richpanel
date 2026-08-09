# ════════════════════════════════════════════════════════════════════════════
# Richpanel frontend — TEMPLATE, not yet active.
#
# There is no frontend application in this repository yet. This file is the
# production build recipe that is ready the moment one lands, and the
# `frontend` service in docker-compose.yml already points at it.
#
# ── State today ─────────────────────────────────────────────────────────────
# The `frontend` service sits behind a Compose profile, so
# `docker compose up --build` never touches this file. Building it right now
# WILL fail at the `COPY package*.json` step — there is nothing to copy. That
# is intentional: no half-scaffolded app is committed here.
#
# ── To activate (after `npm create vite@latest .` or equivalent) ─────────────
#     docker compose --profile frontend up --build
#
#   ...or make it permanent by adding one line to .env:
#     COMPOSE_PROFILES=frontend
#
# ── Assumptions to adjust for your chosen toolchain ─────────────────────────
#   * Package manager is npm with a committed package-lock.json.
#       - pnpm: swap for `corepack enable && pnpm install --frozen-lockfile`
#       - yarn: `yarn install --immutable`
#   * Build output lands in /app/dist (Vite default).
#       - Create React App / Next static export → `build` or `out`
#       - Angular → `dist/<project-name>`
#     Change the BUILD_OUTPUT_DIR arg below to match; nothing else moves.
#   * The API base URL is baked in at BUILD time, because a compiled static
#     bundle cannot read container environment variables at runtime. The value
#     comes from APP_BASE_URL in .env via docker-compose.yml build args.
# ════════════════════════════════════════════════════════════════════════════

ARG NODE_IMAGE=node:22.12-bookworm-slim
ARG NGINX_IMAGE=nginx:1.27-alpine
ARG BUILD_OUTPUT_DIR=dist


# ─────────────────────────────── Stage 1: build ─────────────────────────────
FROM ${NODE_IMAGE} AS build

WORKDIR /app

# Manifests first so `npm ci` is cached independently of source edits.
COPY package.json package-lock.json ./

# `npm ci` (not `npm install`): installs exactly the lockfile, fails if the
# lockfile and package.json disagree. Reproducible by construction.
#
# No `--mount=type=cache` here either — see the note in backend/Dockerfile: this
# repo's images stay buildable by both the legacy builder and BuildKit. Add
# `--mount=type=cache,target=/root/.npm` once BuildKit is standard for you.
RUN npm ci

COPY . .

# Injected by Compose from APP_BASE_URL. Rename to REACT_APP_API_BASE_URL /
# NEXT_PUBLIC_API_BASE_URL etc. to match your framework's convention, and
# update the matching `args:` key in docker-compose.yml.
ARG VITE_API_BASE_URL=http://localhost:8000
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

# NODE_ENV=production enables minification / dead-code elimination.
ENV NODE_ENV=production
RUN npm run build


# ────────────────────────────── Stage 2: serve ──────────────────────────────
# Only the compiled static assets cross this line: no node_modules, no Node
# runtime, no source maps toolchain. Typical final image ~50 MB.
FROM ${NGINX_IMAGE} AS runtime

ARG BUILD_OUTPUT_DIR

# SPA config: serve the file if it exists, otherwise fall back to index.html so
# client-side routes (/schedules, /reports/:id, ...) survive a hard refresh.
# Written inline so this template stays a single self-contained file.
RUN printf '%s\n' \
    'server {' \
    '    listen 80;' \
    '    server_name _;' \
    '    root /usr/share/nginx/html;' \
    '    index index.html;' \
    '' \
    '    # Hashed build assets are immutable — cache them hard.' \
    '    location /assets/ {' \
    '        expires 1y;' \
    '        add_header Cache-Control "public, immutable";' \
    '    }' \
    '' \
    '    # index.html must never be cached, or users pin to a stale bundle.' \
    '    location = /index.html {' \
    '        add_header Cache-Control "no-cache";' \
    '    }' \
    '' \
    '    location / {' \
    '        try_files $uri $uri/ /index.html;' \
    '    }' \
    '' \
    '    gzip on;' \
    '    gzip_types text/css application/javascript application/json image/svg+xml;' \
    '    gzip_min_length 1024;' \
    '}' \
    > /etc/nginx/conf.d/default.conf

COPY --from=build /app/${BUILD_OUTPUT_DIR} /usr/share/nginx/html

# nginx:alpine ships an unprivileged `nginx` user. Binding :80 as non-root works
# because the image's master process only needs the port at startup under the
# default config; if you hit a permission error, switch `listen 80` to
# `listen 8080` above and update the port mapping in docker-compose.yml.
RUN chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx \
 && touch /var/run/nginx.pid && chown nginx:nginx /var/run/nginx.pid

USER nginx

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
