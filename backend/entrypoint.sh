#!/bin/sh
# Container entrypoint — runs the migration pre-start hook, then launches
# the web server. Keeping migrations here (not in the FastAPI startup event)
# means they run exactly ONCE per deploy, before any worker spawns, so
# multiple uvicorn workers never race to migrate.
set -e

echo "[entrypoint] running prestart (migrations)…"
python prestart.py

echo "[entrypoint] starting uvicorn on :${PORT:-8000} (${UVICORN_WORKERS:-2} workers)"
exec uvicorn app:app \
  --host 0.0.0.0 \
  --port "${PORT:-8000}" \
  --workers "${UVICORN_WORKERS:-2}" \
  --proxy-headers \
  --forwarded-allow-ips='*'
