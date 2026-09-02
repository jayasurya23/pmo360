"""Client-portal identity — a second principal type, kept deliberately apart.

Internal users arrive as ``Authorization: Bearer <Entra JWT>`` and are
resolved by ``auth/dependencies.py``. Clients arrive as
``Authorization: Portal <token>`` and are resolved here. The two share a
header name and nothing else:

  * ``_validate_bearer`` rejects any scheme but ``bearer`` — a portal token
    presented to an internal route is a malformed Bearer, i.e. anonymous.
  * ``_parse_portal`` rejects any scheme but ``portal`` — an Entra JWT
    presented to a portal route is a malformed Portal token, i.e. 401.

Neither side has a code path that can be talked into honouring the other's
credential, which is the property the whole design rests on.

SCOPE IS DERIVED, NOT ASSIGNED. A principal sees exactly the portfolios whose
``Project.client_id`` matches its token's client. That data already exists and
is already correct; there is no membership table to populate and therefore no
way for an unpopulated table to lock everyone out — the failure that took
production down when ``project_members`` was first enforced.

DENY BY DEFAULT. ``scoped_portfolio`` answers 404, never 403, for a portfolio
outside the principal's client: a client must not be able to confirm that a
portfolio belonging to someone else exists.
"""
from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from core.deps import get_db
from db.models import ClientPortalToken, Project

SCHEME = "portal"
_TOKEN_BYTES = 32   # 256 bits of entropy; sha256 at rest is sufficient


# --------------------------------------------------------------------------
# Token primitives — used by issuance (api/portal_admin.py) and by auth here.
# --------------------------------------------------------------------------

def new_raw_token() -> str:
    """A fresh, URL-safe token. Shown once; never stored."""
    return secrets.token_urlsafe(_TOKEN_BYTES)


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------
# The principal
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class PortalPrincipal:
    """Who is reading, and what they are allowed to see.

    ``kind`` is "invite" (a hand-issued link) or "session" (minted by a
    password login). ``account_id``/``email`` are set only for sessions; an
    invite link has no account behind it and cannot change a password."""
    client_id: int
    client_name: str
    token_id: int
    label: str
    expires_at: Optional[datetime]
    kind: str = "invite"
    account_id: Optional[int] = None
    email: Optional[str] = None
    must_change_password: bool = False


def _parse_portal(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != SCHEME or not parts[1].strip():
        return None
    return parts[1].strip()


def _unauthorized() -> HTTPException:
    # One message for absent, malformed, unknown, revoked and expired alike.
    # Distinguishing them would tell a holder of a revoked link that it WAS
    # valid once, which is information they should not get.
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="A valid portal link is required.",
        headers={"WWW-Authenticate": "Portal"},
    )


def require_portal_client(
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> PortalPrincipal:
    """FastAPI dependency: the client behind this request, or 401."""
    raw = _parse_portal(authorization)
    if raw is None:
        raise _unauthorized()

    row = (
        db.query(ClientPortalToken)
        .filter(ClientPortalToken.token_hash == hash_token(raw))
        .one_or_none()
    )
    if row is None or not row.is_live:
        raise _unauthorized()

    # A session token is only as alive as its account. Checking here, on every
    # request, is what makes "deactivate" take effect immediately rather than
    # at the next login.
    acct = row.account
    if (row.kind or "invite") == "session" and (acct is None or not acct.is_active):
        raise _unauthorized()

    # Best-effort usage stamp. get_db commits at the request boundary, so this
    # persists without a second round-trip; if it ever fails the read still
    # succeeds — the stamp is telemetry, not a control.
    row.last_used_at = datetime.utcnow()

    return PortalPrincipal(
        client_id=row.client_id,
        client_name=row.client.name if row.client else "",
        token_id=row.id,
        label=row.label,
        expires_at=row.expires_at,
        kind=row.kind or "invite",
        account_id=acct.id if acct else None,
        email=acct.email if acct else None,
        must_change_password=bool(acct.must_change_password) if acct else False,
    )


def require_settled_portal_client(
    principal: PortalPrincipal = Depends(require_portal_client),
) -> PortalPrincipal:
    """``require_portal_client`` plus: the account is not on a temporary
    password. Every DATA route uses this one.

    A session minted from a temporary password may call /me, /logout and
    /change-password and nothing else. That has to hold on the server: the
    SPA's forced-change screen is a convenience, and anyone who intercepts a
    temporary password would otherwise read the whole portal with curl —
    without ever burning the password, so the real client never notices."""
    if principal.must_change_password:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Password change required.",
        )
    return principal


# --------------------------------------------------------------------------
# Scoping helpers — the only way portal routes reach portfolio rows.
# --------------------------------------------------------------------------

def portal_portfolios(db: Session, principal: PortalPrincipal):
    """Every portfolio this client may see. The single source of scope."""
    return (
        db.query(Project)
        .filter(Project.client_id == principal.client_id)
        .order_by(Project.name)
    )


def scoped_portfolio(db: Session, principal: PortalPrincipal, portfolio_id: int) -> Project:
    """The named portfolio, if and only if it belongs to this client.

    404 rather than 403 on a miss — see the module docstring.
    """
    row = (
        portal_portfolios(db, principal)
        .filter(Project.id == portfolio_id)
        .one_or_none()
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found.")
    return row
