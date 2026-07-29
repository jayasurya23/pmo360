"""Audit every API route for an authentication dependency.

Auth in this app is enforced **per endpoint** — there is no middleware and no
router-level `dependencies=`. That makes it easy to add a router and silently
ship it wide open: `AUTH_REQUIRED=true` does nothing for an endpoint that
declares no auth dependency at all. That is exactly how seven routers
(clients, roster, schedules, parse, documents, search, settings) ended up
publicly reachable in production.

This script walks the real FastAPI app and classifies every `/api` route:

    STRICT  — require_db_user / require_admin / require_user
              401s without a valid token regardless of environment.
    ENV     — get_current_db_user / get_current_user
              Optional identity: 401s only when AUTH_REQUIRED=true. Fine for
              prod (which sets it) but it is a weaker guarantee.
    PUBLIC  — no auth dependency. Must be on the allow-list below.

Run from the backend dir:

    python -m scripts.audit_auth

Exit code 0 == every route is accounted for. Non-zero == an unlisted public
route exists; either add the dependency or, if it is deliberately public,
add it to PUBLIC_ALLOWLIST with a reason.
"""
from __future__ import annotations

import os
import sys
import inspect
from fnmatch import fnmatch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import create_app  # noqa: E402


# Routes that are public ON PURPOSE, each with the reason it is safe.
PUBLIC_ALLOWLIST: dict[str, str] = {
    "/api/health": "Liveness probe for Azure Container Apps ingress. No data.",
    "/api/public/sign/*": (
        "Client e-signature. External signers have no Entra account; the "
        "256-bit single-use token in the URL is the credential."
    ),
}

STRICT_DEPS = {"require_db_user", "require_admin", "require_user"}
ENV_DEPS = {"get_current_db_user", "get_current_user"}


def _classify(endpoint) -> str:
    try:
        params = inspect.signature(endpoint).parameters
    except (TypeError, ValueError):
        return "PUBLIC"
    names = {
        getattr(p.default, "dependency", None).__name__
        for p in params.values()
        if getattr(p.default, "dependency", None) is not None
    }
    if names & STRICT_DEPS:
        return "STRICT"
    if names & ENV_DEPS:
        return "ENV"
    return "PUBLIC"


def _allowed(path: str) -> str | None:
    for pattern, reason in PUBLIC_ALLOWLIST.items():
        if path == pattern or fnmatch(path, pattern):
            return reason
    return None


def main() -> int:
    app = create_app()
    rows = []
    for route in app.routes:
        path = getattr(route, "path", "")
        endpoint = getattr(route, "endpoint", None)
        if not path.startswith("/api") or endpoint is None:
            continue  # static mounts + the SPA catch-all are not API surface
        methods = sorted(getattr(route, "methods", set()) - {"HEAD", "OPTIONS"})
        rows.append((path, ",".join(methods), _classify(endpoint)))

    rows.sort()
    violations = [r for r in rows if r[2] == "PUBLIC" and _allowed(r[0]) is None]
    env_only = [r for r in rows if r[2] == "ENV"]
    allowed_public = [r for r in rows if r[2] == "PUBLIC" and _allowed(r[0]) is not None]

    for path, methods, kind in rows:
        marker = {"STRICT": "  ok  ", "ENV": " env  ", "PUBLIC": " PUB  "}[kind]
        if kind == "PUBLIC" and _allowed(path) is None:
            marker = " FAIL "
        print(f"{marker} {methods:<18} {path}")

    print()
    print(f"{len(rows)} API routes: "
          f"{len(rows) - len(env_only) - len(allowed_public) - len(violations)} strict, "
          f"{len(env_only)} env-gated, "
          f"{len(allowed_public)} deliberately public, "
          f"{len(violations)} unprotected")

    if env_only:
        print("\nENV-gated (401 only because AUTH_REQUIRED=true in prod):")
        for path, methods, _ in env_only:
            print(f"    {methods:<18} {path}")

    if violations:
        print("\nFAIL — these routes have no auth dependency and are not allow-listed:")
        for path, methods, _ in violations:
            print(f"    {methods:<18} {path}")
        print("\nAdd Depends(require_db_user) (or get_current_db_user), or add an "
              "entry to PUBLIC_ALLOWLIST explaining why the route is public.")
        return 1

    print("\nOK — every route is either authenticated or deliberately allow-listed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
