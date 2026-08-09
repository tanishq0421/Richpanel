# ════════════════════════════════════════════════════════════════════════════
# Richpanel backend — FastAPI / SQLAlchemy 2.0 / psycopg3 / Alembic
#
# Multi-stage build:
#   builder  — resolves and installs the locked dependency set with uv
#   runtime  — carries ONLY the resulting virtualenv + application source
#
# uv itself, its cache, and the dev dependency group never reach the final
# image. Base images are digest-free but version-pinned (never `latest`) so a
# rebuild is reproducible while security patches stay one tag bump away.
# ════════════════════════════════════════════════════════════════════════════

ARG PYTHON_IMAGE=python:3.14-slim-bookworm
ARG UV_VERSION=0.9.5


# ─────────────────────────── Stage 0: uv binary source ──────────────────────
# Pull uv from its official image rather than curl|sh — version-pinned,
# verifiable, and it leaves no installer tooling behind.
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uvbin


# ─────────────────────────────── Stage 1: builder ───────────────────────────
FROM ${PYTHON_IMAGE} AS builder

COPY --from=uvbin /uv /usr/local/bin/uv

ENV UV_LINK_MODE=copy \
    # Never let uv fetch its own interpreter: the venv must be built against
    # the SAME python that the runtime stage ships, or the copied venv breaks.
    UV_PYTHON_DOWNLOADS=never \
    UV_COMPILE_BYTECODE=1 \
    # Build the venv outside the project dir so it can be copied verbatim.
    UV_PROJECT_ENVIRONMENT=/opt/venv

WORKDIR /build

# Only the dependency manifests — so this layer is cached across source edits.
COPY pyproject.toml uv.lock ./

# --frozen  : fail rather than silently re-resolving; uv.lock is the contract.
# --no-dev  : pytest/httpx/pytest-cov stay out of the runtime image.
# The project itself is not a package (no [build-system] in pyproject.toml), so
# uv installs dependencies only — matching how the code is run: `python -m`
# from the project root with the root on sys.path.
#
# Deliberately no `RUN --mount=type=cache`: that is a BuildKit-only feature and
# this Dockerfile is kept buildable by the legacy builder too. The COPY of just
# the manifests above already makes this the cache-invalidation boundary, which
# is where nearly all the rebuild savings come from. If you standardise on
# BuildKit (`brew install docker-buildx`), adding
# `--mount=type=cache,target=/root/.cache/uv` here is a safe upgrade.
RUN uv sync --frozen --no-dev


# ─────────────────────────────── Stage 2: runtime ───────────────────────────
FROM ${PYTHON_IMAGE} AS runtime

ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    # No __pycache__ written at runtime — the app dir is root-owned and the
    # process runs unprivileged, so writes there would fail anyway.
    PYTHONDONTWRITEBYTECODE=1 \
    # `app` and `scripts` are imported as top-level packages from /app.
    PYTHONPATH=/app \
    TZ=Asia/Kolkata

# Unprivileged runtime user. Fixed uid/gid keeps bind-mount ownership stable.
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app

# The virtualenv, root-owned and read-only to the app user.
COPY --from=builder --chown=root:root /opt/venv /opt/venv

WORKDIR /app

# Application source. Build context is trimmed by backend/.dockerignore, which
# excludes .venv, __pycache__, tests and caches.
COPY --chown=root:root . /app

# Entrypoint runs migrations then execs uvicorn. chmod here rather than relying
# on the host filesystem's exec bit surviving the checkout.
RUN chmod 0755 /app/docker-entrypoint.sh

USER app

EXPOSE 8000

# Hits the real /health route (defined in app/main.py) through the HTTP stack,
# using the stdlib so the image needs no curl/wget.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
    CMD ["python", "-c", "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)"]

ENTRYPOINT ["/app/docker-entrypoint.sh"]
