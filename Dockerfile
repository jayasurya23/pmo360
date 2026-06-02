# syntax=docker/dockerfile:1
# =============================================================================
# PMO 360 — single-container production image.
#
# Builds the React SPA, then bakes it into the FastAPI image so ONE container
# serves both the UI (at /) and the API (at /api) from a single origin. That
# keeps auth simple (one URL, one cert, one redirect URI) and is the image the
# Container Apps deploy + GitHub Actions workflow ship.
#
# (The separate backend/Dockerfile + frontend/Dockerfile + docker-compose.yml
# remain for the 2-container / VM path — see docs/DEPLOYMENT.md.)
#
# Build locally:
#   docker build -t pmo360 \
#     --build-arg VITE_AZURE_TENANT_ID=... \
#     --build-arg VITE_AZURE_CLIENT_ID=... \
#     --build-arg VITE_AZURE_REDIRECT_URI=https://<your-host> .
# =============================================================================

# ---- Stage 1: build the SPA ----
FROM node:20-slim AS frontend
WORKDIR /app/frontend

# Install deps first (layer-cached unless package*.json changes).
COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./

# Vite inlines these at build time — they're PUBLIC values (tenant/client id
# are not secrets), so passing them as build args is fine. Default API base
# is /api since the SPA is served same-origin as the backend.
ARG VITE_API_BASE=/api
ARG VITE_AZURE_TENANT_ID=
ARG VITE_AZURE_CLIENT_ID=
ARG VITE_AZURE_REDIRECT_URI=
ENV VITE_API_BASE=$VITE_API_BASE \
    VITE_AZURE_TENANT_ID=$VITE_AZURE_TENANT_ID \
    VITE_AZURE_CLIENT_ID=$VITE_AZURE_CLIENT_ID \
    VITE_AZURE_REDIRECT_URI=$VITE_AZURE_REDIRECT_URI

RUN npm run build

# Drop the Castillo / PMO 360 logos into the SPA's assets dir so the single
# /assets mount in the backend serves both the JS/CSS bundles AND the logos
# (the SPA references /assets/logo/*.png). backend/assets contains logo/.
COPY backend/assets/ ./dist/assets/


# ---- Stage 2: python runtime ----
FROM python:3.11-slim AS runtime

# System deps: libpq for psycopg2, fonts for ReportLab PDF text, curl for the
# healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      libpq-dev \
      curl \
      fonts-dejavu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./

# Built SPA → /app/static (the default PMO360_STATIC_DIR the app looks for).
COPY --from=frontend /app/frontend/dist ./static

# Strip any CR from the entrypoint (in case it was committed with CRLF on a
# Windows checkout) so the shell can run it, and ensure the data dir exists.
RUN sed -i 's/\r$//' entrypoint.sh && mkdir -p /app/data/outputs

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8000 \
    PMO360_STATIC_DIR=/app/static \
    LOCAL_DEV_MODE=false

EXPOSE 8000

# Give prestart (migrations) room before the first healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1

# entrypoint.sh runs prestart (migrations) then launches uvicorn.
CMD ["sh", "./entrypoint.sh"]
