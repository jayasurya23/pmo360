"""PMO 360 — FastAPI application entry point.

Boots the SQLAlchemy schema, enables CORS for the Vite dev server and the
deployed React frontend, then mounts each domain router under ``/api``.

Run for local development:

    cd backend
    uvicorn app:app --reload --port 8000
"""
from __future__ import annotations

import os
from pathlib import Path
from dotenv import load_dotenv

# Load env BEFORE importing anything that reads it at import-time.
load_dotenv(Path(__file__).resolve().parent / ".env")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from db import init_db
from api import (
    clients, projects, meetings, actions, notes, agendas, schedules,
    roster, dashboard, parse, documents, search, me, users, templates,
    attachments, members, calendar,
    settings as settings_router,
)


def create_app() -> FastAPI:
    app = FastAPI(
        title="PMO 360 API",
        version="1.0.0",
        description=(
            "FastAPI backend for the Castillo Engineering Meeting Management "
            "tool. Mirrors the data + workflow of the original Streamlit app."
        ),
    )

    # CORS — read the comma-separated CORS_ORIGINS env var, fall back to
    # localhost defaults so first-run dev "just works".
    origins_env = os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000",
    )
    origins = [o.strip() for o in origins_env.split(",") if o.strip()]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ---- Routers ----
    app.include_router(dashboard.router)
    app.include_router(clients.router)
    app.include_router(projects.router)
    app.include_router(roster.router)
    app.include_router(meetings.router)
    app.include_router(parse.router)
    app.include_router(documents.router)
    app.include_router(actions.router)
    app.include_router(notes.router)
    app.include_router(agendas.router)
    app.include_router(schedules.router)
    app.include_router(settings_router.router)
    app.include_router(search.router)
    app.include_router(me.router)
    app.include_router(users.router)
    app.include_router(templates.router)
    app.include_router(attachments.router)
    app.include_router(members.router)
    app.include_router(calendar.router)

    # ---- Logo + static assets (so the React app can pull the Castillo /
    # PMO 360 logos straight from the backend rather than duplicating them).
    assets_dir = Path(__file__).resolve().parent / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    # ---- Health check ----
    @app.get("/api/health", tags=["health"])
    def health():
        return {"status": "ok", "service": "pmo360-backend"}

    # ---- Init DB at startup ----
    @app.on_event("startup")
    def _startup():
        init_db()

    # ---- Friendly error envelope for unhandled exceptions ----
    @app.exception_handler(ValueError)
    def _value_error(_, exc):
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    return app


app = create_app()
