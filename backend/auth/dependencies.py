"""
FastAPI auth dependencies.

Two flavours:
  - `get_current_user`  — returns the User if a valid Bearer is present,
                          None otherwise. Lets a route work both signed-in
                          and signed-out (useful while we phase auth in).
  - `require_user`      — same validation, but 401s on missing/invalid.
                          Use this on routes that MUST have an identity.

Token validation rules (per Microsoft docs + RFC 7519):
  - `iss` (issuer) MUST be `https://login.microsoftonline.com/{tenant}/v2.0`
  - `aud` (audience) MUST be our client id OR `api://<client_id>` for
    custom-API tokens
  - `exp` (expiry) MUST be in the future
  - `nbf` (not-before) MUST be in the past
  - signature MUST verify against the JWKS-published key for `kid`

We extract:
  - `oid`  : the user's tenant-stable object id (DO NOT use `sub` — it's
             pairwise per app and useless for cross-app correlation)
  - `preferred_username` : usually the user's UPN / email
  - `name` : display name
"""
from __future__ import annotations

import os
import logging
from typing import Optional

import jwt
from datetime import datetime
from fastapi import Depends, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from auth.jwks import find_signing_key

logger = logging.getLogger(__name__)


# ============================================================
# Config — read from env at module import. .env is loaded in config.py
# which runs before any router is imported, so these are populated.
# ============================================================
AZURE_TENANT_ID = os.getenv("AZURE_TENANT_ID", "").strip()
AZURE_CLIENT_ID = os.getenv("AZURE_CLIENT_ID", "").strip()
AUTH_REQUIRED = os.getenv("AUTH_REQUIRED", "false").lower() == "true"


def _admin_email_set() -> set[str]:
    """Lowercased set of admin emails from the ADMIN_EMAILS env var.
    Re-read on every call so flipping the env without restart works on
    the next request (used by the User upsert path)."""
    raw = os.getenv("ADMIN_EMAILS", "")
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


# ============================================================
# Pydantic model surfaced to routers
# ============================================================
class User(BaseModel):
    """The validated identity of the request. Only safe-to-trust fields go
    here — anything that came from the token but wasn't part of the validated
    set is intentionally dropped."""
    model_config = ConfigDict(extra="forbid")

    oid: str
    """Microsoft Entra object id — tenant-stable, the right primary key
    for our user table when we add one."""
    email: str
    """User's UPN (preferred_username claim). Usually first.last@castillo…"""
    name: str
    """Display name — for the 'Welcome, Arun' line in the UI."""


# ============================================================
# Token validation
# ============================================================
def _decode_token(token: str) -> dict:
    """Validate signature + claims; return the decoded payload.

    Raises jwt exceptions on failure — the caller maps to 401.
    """
    if not AZURE_TENANT_ID or not AZURE_CLIENT_ID:
        raise RuntimeError(
            "AZURE_TENANT_ID / AZURE_CLIENT_ID not configured — auth disabled. "
            "Set both in backend/.env."
        )

    # Pull the key id out of the unverified header so we know which JWKS
    # entry to look up.
    unverified_header = jwt.get_unverified_header(token)
    kid = unverified_header.get("kid")
    if not kid:
        raise jwt.InvalidTokenError("Token header missing 'kid'")
    key = find_signing_key(AZURE_TENANT_ID, kid)
    if key is None:
        raise jwt.InvalidTokenError(
            f"No signing key matches kid={kid!r} in our cached JWKS"
        )

    # Microsoft Entra issues tokens with either of two audience values
    # depending on whether the token was minted for Graph (`Microsoft Graph`,
    # which validates per token's `aud`) or our SPA (`<client_id>` or
    # `api://<client_id>`). For the SPA token we accept both forms.
    expected_audiences = [
        AZURE_CLIENT_ID,
        f"api://{AZURE_CLIENT_ID}",
    ]
    # Microsoft Entra issues tokens in two flavours depending on the app
    # registration's `accessTokenAcceptedVersion` manifest setting:
    #   - v2.0 (preferred): iss = https://login.microsoftonline.com/<tid>/v2.0
    #   - v1.0 (legacy):    iss = https://sts.windows.net/<tid>/
    # We accept BOTH so the app reg manifest doesn't have to be flipped to
    # `accessTokenAcceptedVersion: 2` — that flip can break other downstream
    # integrations and isn't worth fighting for. The signature + audience
    # checks below still gate access, so accepting both issuers is safe.
    expected_issuers = (
        f"https://login.microsoftonline.com/{AZURE_TENANT_ID}/v2.0",
        f"https://sts.windows.net/{AZURE_TENANT_ID}/",
    )

    # pyjwt's `issuer=` arg only accepts a single string, so we validate
    # the issuer ourselves after decoding. We still pass require=["iss"]
    # so a missing-issuer token gets rejected up-front by pyjwt.
    payload = jwt.decode(
        token,
        key=key,
        algorithms=["RS256"],
        audience=expected_audiences,
        options={"require": ["exp", "iss", "aud"]},
    )
    iss = payload.get("iss")
    if iss not in expected_issuers:
        raise jwt.InvalidIssuerError(
            f"Invalid issuer {iss!r}; expected one of {expected_issuers}"
        )
    return payload


def _validate_bearer(authorization: Optional[str]) -> Optional[User]:
    """Parse + validate the `Authorization: Bearer …` header.

    Returns None if the header is absent or malformed. Raises HTTPException
    (401) if a Bearer is present but the token is invalid — that's a real
    error, the client sent us garbage.
    """
    if not authorization:
        print("[auth.dbg] no Authorization header on request", flush=True)
        return None
    parts = authorization.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        print(
            f"[auth.dbg] malformed Authorization header: {authorization[:60]!r}",
            flush=True,
        )
        return None
    token = parts[1].strip()

    try:
        payload = _decode_token(token)
    except RuntimeError as exc:
        # Misconfiguration on our side — surface a 500 not a 401.
        logger.error("Auth misconfig: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Auth not configured on this server.",
        )
    except jwt.PyJWTError as exc:
        # Peek at the unverified payload so we can log the audience +
        # issuer the SPA sent — almost every prod auth bug is one of those
        # not matching what the backend expects.
        try:
            unverified = jwt.decode(token, options={"verify_signature": False})
            print(
                f"[auth.dbg] JWT rejected: {exc} | "
                f"aud={unverified.get('aud')!r} "
                f"iss={unverified.get('iss')!r} "
                f"exp={unverified.get('exp')!r} "
                f"scp={unverified.get('scp')!r}",
                flush=True,
            )
        except Exception:
            print(
                f"[auth.dbg] JWT rejected (couldn't decode): {exc}",
                flush=True,
            )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {exc}",
            headers={"WWW-Authenticate": "Bearer"},
        )

    oid = payload.get("oid")
    if not oid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token missing required 'oid' claim",
        )
    return User(
        oid=oid,
        email=(
            payload.get("preferred_username")
            or payload.get("upn")
            or payload.get("email")
            or ""
        ),
        name=payload.get("name") or "",
    )


# ============================================================
# FastAPI dependencies
# ============================================================
def get_current_user(
    authorization: Optional[str] = Header(None),
) -> Optional[User]:
    """Best-effort identity. Returns None for anonymous OR for malformed
    Bearer tokens. Only raises 401 when ``AUTH_REQUIRED=true`` is set AND
    no usable identity could be resolved.

    Why we don't 401 on bad tokens here: a signed-in SPA with a stale
    refresh token (e.g. MSAL's silent acquire returned 400) will keep
    sending the bad Bearer until the user manually re-signs-in. If we
    401 every optional-auth route on that, the picker and dashboard
    silently break despite "anonymous would have worked fine". The
    strict ``require_user`` dependency still 401s on bad tokens — that's
    the right behaviour for routes that MUST have identity."""
    try:
        user = _validate_bearer(authorization)
    except HTTPException as exc:
        # _validate_bearer raises on a malformed Bearer; treat as
        # anonymous on optional routes.
        if exc.status_code == status.HTTP_401_UNAUTHORIZED:
            user = None
        else:
            raise
    if user is None and AUTH_REQUIRED:
        # Global enforce mode — flip via AUTH_REQUIRED=true. Lets you
        # gradually require auth without sprinkling require_user
        # everywhere first.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


def require_user(
    authorization: Optional[str] = Header(None),
) -> User:
    """Strict identity. 401s on missing or invalid token. Use on routes
    that depend on the user identity (Graph proxy, audit-logged writes,
    anything per-user-scoped)."""
    user = _validate_bearer(authorization)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


# ============================================================
# DB-backed identity: upsert the User row + return it
# ============================================================
def _upsert_user_row(db: Session, jwt_user: User):
    """Upsert the SQLAlchemy `users` row matching the JWT identity.

    First sign-in inserts a new row; subsequent calls update `email` and
    `name` (in case they changed in Entra) and bump `last_seen_at`.
    Returns the persisted row.
    """
    # Import inside the function to keep auth/ free of model dependencies
    # at module load time — keeps the import graph DAG-shaped.
    from db.models import User as UserModel
    row = db.query(UserModel).filter_by(oid=jwt_user.oid).first()
    now = datetime.utcnow()
    # Recompute admin status from the env list on every request — lets the
    # team flip ADMIN_EMAILS without a DB write or restart.
    is_admin_now = (jwt_user.email or "").lower() in _admin_email_set()
    if row is None:
        row = UserModel(
            oid=jwt_user.oid,
            email=jwt_user.email or "",
            name=jwt_user.name or "",
            is_admin=is_admin_now,
            created_at=now,
            last_seen_at=now,
            # First sign-in: nothing "previous". The briefing endpoint treats
            # NULL as "fall back to last_seen_at" so the first card still has
            # a sensible cutoff.
            previous_last_seen_at=None,
        )
        db.add(row)
        db.flush()
    else:
        # Keep email/name fresh in case the user got married, changed UPN,
        # etc. Cheap UPDATE that runs at most a few times per minute even
        # in a busy session.
        if jwt_user.email and row.email != jwt_user.email:
            row.email = jwt_user.email
        if jwt_user.name and row.name != jwt_user.name:
            row.name = jwt_user.name
        if row.is_admin != is_admin_now:
            row.is_admin = is_admin_now
        # Park the old `last_seen_at` in `previous_last_seen_at` BEFORE we
        # bump. This is the cutoff the Home briefing endpoint reads to ask
        # "what's changed since the user was last here?". Without this, the
        # briefing would always see "since now" and report zero deltas.
        row.previous_last_seen_at = row.last_seen_at
        row.last_seen_at = now
    return row


def get_current_db_user(
    authorization: Optional[str] = Header(None),
):
    """Optional identity, DB-backed. Returns the User row if signed in,
    None otherwise. 401s only when AUTH_REQUIRED is true.

    Use this on routes that want to stamp writes with attribution but
    work fine anonymously (existing behaviour).
    """
    # Lazy import to avoid circular dependency: auth → db → ... → routers → auth.
    from core.deps import get_db
    try:
        jwt_user = _validate_bearer(authorization)
    except HTTPException as exc:
        # Same soft-fail as get_current_user: optional routes shouldn't
        # 401 on a malformed/stale Bearer. The user just degrades to
        # anonymous until they re-sign-in.
        if exc.status_code == status.HTTP_401_UNAUTHORIZED:
            jwt_user = None
        else:
            raise
    if jwt_user is None:
        if AUTH_REQUIRED:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Authentication required.",
                headers={"WWW-Authenticate": "Bearer"},
            )
        return None
    # Open a short-lived session to upsert. We don't want to depend on
    # the caller's session because routers that don't need DB still
    # work correctly.
    db_gen = get_db()
    db = next(db_gen)
    try:
        row = _upsert_user_row(db, jwt_user)
        db.commit()
        # Detach so the returned object is usable across requests without
        # the closed session triggering DetachedInstanceError on access.
        db.refresh(row)
        return row
    finally:
        try:
            next(db_gen)
        except StopIteration:
            pass


def require_db_user(
    authorization: Optional[str] = Header(None),
):
    """Strict DB-backed identity. 401 on no token / invalid token; returns
    the SQLAlchemy User row otherwise. Same upsert behaviour as
    `get_current_db_user`."""
    row = get_current_db_user(authorization)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return row


def require_admin(
    authorization: Optional[str] = Header(None),
):
    """Admin-only identity. 401 without a valid token, 403 when the caller
    isn't in ADMIN_EMAILS. Returns the SQLAlchemy User row.

    `is_admin` is recomputed from the env var on every authenticated request
    (see `_upsert_user_row`), so adding/removing an admin takes effect on their
    next call — no restart, no re-login.
    """
    row = require_db_user(authorization)
    if not row.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator access required.",
        )
    return row
