"""Audit every API route for an authentication dependency.

Auth in this app is enforced **per endpoint** — there is no middleware and no
router-level `dependencies=`. That makes it easy to add a router and silently
ship it wide open: `AUTH_REQUIRED=true` does nothing for an endpoint that
declares no auth dependency at all. That is exactly how seven routers
(clients, roster, schedules, parse, documents, search, settings) ended up
publicly reachable in production.

This script walks the real FastAPI app and classifies every `/api` route by the
dependencies it actually resolves — TRANSITIVELY, via FastAPI's own dependency
tree, not the endpoint's direct signature. A route whose only auth is a wrapper
(``require_user_console`` -> ``require_db_user``, or the ``require_permission``
gate) is protected, and a reader that stops at the first level reports it as a
hole. A hole-finder that cries wolf gets ignored, and then a real hole gets
ignored with it. It classifies every `/api` route:

    STRICT  — require_db_user / require_admin / require_user /
              get_db_user_any_status
              401s without a valid token regardless of environment.
              get_db_user_any_status authenticates exactly as strictly as the
              others; it only declines to enforce `is_active`, so a deactivated
              user can still read the one route that tells them they have been
              deactivated. Authentication is what this audit measures.
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

STRICT_DEPS = {
    "require_db_user", "require_admin", "require_user",
    # Authenticates exactly as strictly (401 without a valid token); it only
    # skips the is_active check, so a deactivated user can read the one route
    # that tells them so. See auth/dependencies.py.
    "get_db_user_any_status",
}
ENV_DEPS = {"get_current_db_user", "get_current_user"}


def _dependency_names(route) -> set[str]:
    """Every dependency callable this route resolves, at any depth.

    FastAPI has already built the whole graph on `route.dependant` — including
    router- and app-level `dependencies=`, which never appear in the endpoint's
    signature at all — so we read that rather than re-deriving it. Walking it is
    what makes this audit indifferent to how many wrapper dependencies someone
    stacks in front of `require_db_user`: the guarantee is what actually runs on
    the request, not what the handler happens to name.
    """
    dependant = getattr(route, "dependant", None)
    if dependant is None:
        return _signature_dependency_names(getattr(route, "endpoint", None))
    names: set[str] = set()
    seen: set[int] = set()
    stack = list(getattr(dependant, "dependencies", ()))
    while stack:
        dep = stack.pop()
        if id(dep) in seen:
            continue
        seen.add(id(dep))
        call = getattr(dep, "call", None)
        if call is not None:
            names.add(getattr(call, "__name__", ""))
        stack.extend(getattr(dep, "dependencies", ()))
    return names


def _signature_dependency_names(endpoint, _seen: set | None = None) -> set[str]:
    """Fallback for a route FastAPI hasn't built a dependant for: recurse the
    signatures ourselves so the answer still can't miss an indirection."""
    if endpoint is None:
        return set()
    seen = _seen if _seen is not None else set()
    if id(endpoint) in seen:
        return set()
    seen.add(id(endpoint))
    try:
        params = inspect.signature(endpoint).parameters
    except (TypeError, ValueError):
        return set()
    names: set[str] = set()
    for p in params.values():
        call = getattr(p.default, "dependency", None)
        if call is None:
            continue
        names.add(getattr(call, "__name__", ""))
        names |= _signature_dependency_names(call, seen)
    return names


def _classify(route) -> str:
    names = _dependency_names(route)
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
        rows.append((path, ",".join(methods), _classify(route)))

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
