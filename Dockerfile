# Multi-stage build: the React SPA is built once with Node and the resulting
# /static_react directory is copied into the Python image, which serves both
# the FastAPI backend and the static SPA on a single port (8000).
#
# Build:  docker compose build app
# Run:    docker compose up -d app

# ── Stage 1: build the React SPA ─────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /build/frontend

# Install deps first so Docker can cache this layer when only source changes.
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci

# Build-time env (consumed by Vite). Override at build time via
# `--build-arg VITE_KEYCLOAK_URL=...` etc.
ARG VITE_KEYCLOAK_URL=http://localhost:8180
ARG VITE_KEYCLOAK_REALM=inforoot
ARG VITE_KEYCLOAK_CLIENT_ID=aibot
ENV VITE_KEYCLOAK_URL=${VITE_KEYCLOAK_URL} \
    VITE_KEYCLOAK_REALM=${VITE_KEYCLOAK_REALM} \
    VITE_KEYCLOAK_CLIENT_ID=${VITE_KEYCLOAK_CLIENT_ID}

COPY frontend/ ./
# vite.config.js writes to ../static_react, so the artifacts land at /build/static_react.
RUN npm run build


# ── Stage 2: Python runtime ──────────────────────────────────────────────────
# Pin to 3.12 — 3.14 (the host default on this dev box) has wheel issues with
# psycopg2-binary, cffi and a few transitive deps. 3.12 is the latest stable
# release that all of requirements.txt installs cleanly on.
FROM python:3.12-slim AS runtime
WORKDIR /app

# System deps for psycopg2 + cryptography. gcc is needed only at build time
# but we install --no-install-recommends and keep the layer small; remove the
# build chain after pip install to shed weight.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libpq-dev gcc build-essential curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && apt-get purge -y --auto-remove gcc build-essential

# Application code. .dockerignore keeps node_modules / __pycache__ / logs /
# *.bak out so the image stays slim.
COPY . .

# Built SPA from stage 1 → into the location app.py expects.
COPY --from=frontend-builder /build/static_react /app/static_react

# Logs directory needs to exist before uvicorn writes its rotating log file.
RUN mkdir -p /app/logs

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS http://localhost:8000/api/_debug/keycloak || exit 1

CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
