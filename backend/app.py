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
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles

from db import init_db
from api import (
    clients, projects, meetings, actions, notes, agendas, schedules,
    roster, dashboard, parse, documents, search, me, users, templates,
    attachments, members, calendar, lead, timeline, proposals, change_orders,
    portfolio_projects, admin_users, client_contacts,
    settings as settings_router, monday as monday_router,
    monday_bridge as monday_bridge_router,
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

    # Gzip responses (the SPA's JS/CSS bundles especially — ~1.4 MB JS drops to
    # ~400 KB on the wire). Container Apps' Envoy ingress doesn't compress for
    # us, so do it here. minimum_size skips tiny payloads where it wouldn't pay.
    app.add_middleware(GZipMiddleware, minimum_size=1024)

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
    app.include_router(lead.router)
    app.include_router(monday_router.router)
    app.include_router(monday_bridge_router.router)
    app.include_router(timeline.router)
    app.include_router(proposals.router)
    app.include_router(change_orders.router)
    app.include_router(portfolio_projects.router)
    app.include_router(admin_users.router)
    app.include_router(client_contacts.router)

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

    # ---- Static / SPA serving ----
    # MUST be wired AFTER all /api routers + the health route so those win.
    _mount_static(app)

    return app


# Cache policy for the SPA shell. `no-cache` does NOT mean "don't store" — it
# means "revalidate before using", which is exactly what we want here.
SHELL_CACHE_CONTROL = "no-cache"
# Vite content-hashes every bundle (index-Cr5uj-Ow.js), so a changed file is
# always a changed URL and these can never go stale. A year + immutable means a
# returning PM re-downloads nothing.
HASHED_CACHE_CONTROL = "public, max-age=31536000, immutable"
# Self-hosted Jost is NOT content-hashed, so it can't be immutable. A week is
# long enough that nobody refetches a typeface daily, short enough to recover.
FONT_CACHE_CONTROL = "public, max-age=604800"


def _asset_cache_control(path: str) -> str:
    """Only the content-hashed files under /assets may be immutable.

    The single /assets mount serves two different kinds of file. Vite's output
    sits FLAT at the top (Actions-CriecTAH.js) and is content-hashed, so it can
    never go stale. The Dockerfile then copies backend/assets/ in on top, which
    lands in SUBDIRECTORIES — assets/logo/Castillo_logo.png, assets/co_template/
    — and those keep their filenames across edits.

    Telling a browser Castillo_logo.png is immutable for a year would make a
    rebrand unrecoverable without renaming the file, so nesting is the tell.
    """
    nested = "/" in path.strip("/\\").replace("\\", "/")
    return FONT_CACHE_CONTROL if nested else HASHED_CACHE_CONTROL


class _CachedStaticFiles(StaticFiles):
    """StaticFiles that stamps Cache-Control on every response it serves.

    Overriding ``get_response`` (rather than adding an HTTP middleware) keeps
    the blast radius on the static mounts: no extra wrapper around API calls,
    PDF streams or Graph-backed endpoints just to set a header on .js files.
    It also runs AFTER StaticFiles' own conditional-request handling, so 304s
    still work and still carry the header.

    ``cache_control`` is either a fixed string or a callable taking the
    mount-relative path, for mounts that serve a mix of hashed and named files.
    """

    def __init__(self, *args, cache_control, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._cache_control = cache_control

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        value = (
            self._cache_control(path)
            if callable(self._cache_control)
            else self._cache_control
        )
        response.headers["Cache-Control"] = value
        return response


def _mount_static(app: FastAPI) -> None:
    """Serve the built React SPA from the same origin as the API.

    Production (single-container): the Docker build copies the Vite output
    into ``PMO360_STATIC_DIR`` (default ``/app/static``) and also drops the
    Castillo/PMO360 logos into ``<static>/assets/logo`` so one ``/assets``
    mount covers both the JS/CSS bundles and the logos. We mount the static
    dirs and add a catch-all that returns ``index.html`` for any non-API,
    non-asset path so client-side routing (/actions, /review, …) works on a
    hard refresh.

    Dev (backend-only, SPA served by Vite on :5174): there's no built SPA
    dir, so we fall back to serving just the backend ``assets/`` (logos) at
    ``/assets`` — exactly the old behaviour.
    """
    backend_assets = Path(__file__).resolve().parent / "assets"

    static_dir_env = os.getenv("PMO360_STATIC_DIR", "").strip()
    candidates = []
    if static_dir_env:
        candidates.append(Path(static_dir_env))
    candidates.append(Path(__file__).resolve().parent / "static")            # /app/static in container
    candidates.append(Path(__file__).resolve().parents[1] / "frontend" / "dist")  # local dev verification

    spa_dir = next(
        (c for c in candidates if (c / "index.html").is_file()), None
    )

    if spa_dir is None:
        # Dev fallback — no built SPA present; serve backend logos only. These
        # are NOT content-hashed (logo.png keeps its name across edits), so
        # they get the font policy, not the immutable one.
        if backend_assets.exists():
            app.mount(
                "/assets",
                _CachedStaticFiles(
                    directory=str(backend_assets),
                    cache_control=FONT_CACHE_CONTROL,
                ),
                name="assets",
            )
        return

    # Production single-origin serving.
    if (spa_dir / "assets").is_dir():
        app.mount(
            "/assets",
            _CachedStaticFiles(
                directory=str(spa_dir / "assets"),
                cache_control=_asset_cache_control,
            ),
            name="spa-assets",
        )
    if (spa_dir / "fonts").is_dir():
        app.mount(
            "/fonts",
            _CachedStaticFiles(
                directory=str(spa_dir / "fonts"),
                cache_control=FONT_CACHE_CONTROL,
            ),
            name="spa-fonts",
        )

    index_file = spa_dir / "index.html"

    # Catch-all for client-side routes. Registered last so /api/*, /assets/*,
    # /fonts/* (all wired above) take precedence. Unknown /api/* paths return
    # a JSON 404 rather than the SPA shell.
    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_fallback(full_path: str):
        if full_path.startswith("api/"):
            return JSONResponse(status_code=404, content={"detail": "Not found"})
        candidate = (spa_dir / full_path)
        # Serve real files that live at the root of the build (favicon,
        # manifest, robots, etc.); everything else falls through to the SPA
        # shell for client-side routing.
        #
        # THE HEADER IS THE POINT. Without it a PM could open the site the
        # morning after a release and still get yesterday's app: no
        # Cache-Control means the browser falls back to HEURISTIC caching
        # (~10% of the file's age), serving index.html from disk without ever
        # asking us. And index.html is what NAMES the hashed bundles, so one
        # stale copy pins the whole app to the previous build — which is
        # exactly the "needs a hard refresh" report this fixes.
        headers = {"Cache-Control": SHELL_CACHE_CONTROL}
        if full_path and candidate.is_file():
            return FileResponse(str(candidate), headers=headers)
        return FileResponse(str(index_file), headers=headers)


app = create_app()
