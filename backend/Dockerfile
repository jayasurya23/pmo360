# ---- Python 3.11 slim image with PDF/Word/Excel toolchain ----
FROM python:3.11-slim AS base

# System deps: libpq for psycopg2 + a couple of fonts so ReportLab can
# render Jost-equivalent text in the PDF docs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      libpq-dev \
      curl \
      fonts-dejavu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Make sure runtime data dirs exist (mounted as volumes in compose).
RUN mkdir -p /app/data/outputs

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8000

EXPOSE 8000

# Healthcheck hits the /api/health endpoint exposed by app.py
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1

# Production server: gunicorn with uvicorn workers (4 by default; set
# UVICORN_WORKERS in the env to override).
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000} --workers ${UVICORN_WORKERS:-2} --proxy-headers --forwarded-allow-ips=*"]
