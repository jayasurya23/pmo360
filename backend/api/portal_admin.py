"""/api/portal-admin — issue and revoke client portal links. INTERNAL ONLY.

This is the Castillo-side half of the client portal: the screen in Settings
where somebody with `client_mgmt` hands a client a link. The client-side half
is api/portal.py, which accepts those links and nothing else.

Gated on `client_mgmt` for the same reason client contacts are: a portal link
hangs off a CLIENT, which sits above every portfolio, so there is no portfolio
membership that could stand for "may issue this". `client_mgmt` is the one
globally-scoped permission that already means "may edit this client".

THE RAW TOKEN CROSSES THE WIRE EXACTLY ONCE, in the response to the issue
call. It is not stored, not logged, and not retrievable afterwards — the list
endpoint returns metadata only. If a link is lost, revoke it and issue a new
one; there is deliberately no "show me the link again".

The link itself is assembled by the UI from window.location.origin, not here:
the server does not reliably know the public hostname behind the container
ingress, and guessing it wrong would produce links that silently point at the
wrong environment.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from auth import require_db_user
from auth.permissions import CLIENT_MGMT, require_permission
from auth.portal import hash_token, new_raw_token
from core.deps import get_db
from db.models import Client, ClientContact, ClientPortalToken

router = APIRouter(prefix="/api/portal-admin", tags=["portal-admin"])

_MAX_EXPIRY_DAYS = 365


# ---------------------------------------------------------------- schemas
class IssueTokenIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str = Field(min_length=1, max_length=120)
    contact_id: Optional[int] = None
    #: None = never expires. Capped so a typo cannot mint a decade-long link.
    expires_in_days: Optional[int] = Field(default=90, ge=1, le=_MAX_EXPIRY_DAYS)


class TokenOut(BaseModel):
    """What the list shows. Never carries the raw token."""
    model_config = ConfigDict(extra="forbid")
    id: int
    client_id: int
    contact_id: Optional[int]
    contact_name: Optional[str]
    label: str
    created_at: datetime
    created_by: Optional[str]
    expires_at: Optional[datetime]
    revoked_at: Optional[datetime]
    last_used_at: Optional[datetime]
    is_live: bool


class IssuedTokenOut(TokenOut):
    """The issue response — the ONE place the raw token appears."""
    raw_token: str


def _to_out(row: ClientPortalToken) -> TokenOut:
    contact = row.contact
    return TokenOut(
        id=row.id,
        client_id=row.client_id,
        contact_id=row.contact_id,
        contact_name=(f"{contact.first_name} {contact.last_name}".strip() if contact else None),
        label=row.label,
        created_at=row.created_at,
        created_by=(row.created_by.name if row.created_by else None),
        expires_at=row.expires_at,
        revoked_at=row.revoked_at,
        last_used_at=row.last_used_at,
        is_live=row.is_live,
    )


# ---------------------------------------------------------------- routes
@router.get("/clients/{client_id}/tokens", response_model=list[TokenOut])
def list_tokens(
    client_id: int,
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
) -> list[TokenOut]:
    """Every link ever issued for this client, live or not. Read is open to any
    signed-in user like every other GET here; the metadata is not sensitive
    and the raw token is not in it."""
    if db.get(Client, client_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Client not found.")
    rows = (
        db.query(ClientPortalToken)
        .filter(ClientPortalToken.client_id == client_id)
        .order_by(ClientPortalToken.created_at.desc())
        .all()
    )
    return [_to_out(r) for r in rows]


@router.post(
    "/clients/{client_id}/tokens",
    response_model=IssuedTokenOut,
    status_code=status.HTTP_201_CREATED,
)
def issue_token(
    client_id: int,
    body: IssueTokenIn,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
    guard=Depends(require_permission(CLIENT_MGMT)),
) -> IssuedTokenOut:
    client = db.get(Client, client_id)
    if client is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Client not found.")

    contact = None
    if body.contact_id is not None:
        contact = db.get(ClientContact, body.contact_id)
        # A contact from a DIFFERENT client is a request to give client B's
        # person a link into client A's data. Refuse it as not-found rather
        # than explaining, for the same reason the portal 404s out-of-scope.
        if contact is None or contact.client_id != client_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Contact not found for this client.")

    raw = new_raw_token()
    row = ClientPortalToken(
        client_id=client_id,
        contact_id=contact.id if contact else None,
        label=body.label.strip(),
        token_hash=hash_token(raw),
        created_by_id=actor.id,
        expires_at=(
            datetime.utcnow() + timedelta(days=body.expires_in_days)
            if body.expires_in_days else None
        ),
    )
    db.add(row)
    db.flush()   # populate id + created_at before we serialise

    out = _to_out(row)
    return IssuedTokenOut(**out.model_dump(), raw_token=raw)


@router.delete("/tokens/{token_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_token(
    token_id: int,
    db: Session = Depends(get_db),
    _actor=Depends(require_db_user),
    guard=Depends(require_permission(CLIENT_MGMT)),
) -> None:
    """Revoke, never delete: the row stays so the audit trail can answer
    'who had access, and until when'. Revoking an already-revoked link is a
    no-op, not an error — the caller's intent is satisfied either way."""
    row = db.get(ClientPortalToken, token_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Link not found.")
    if row.revoked_at is None:
        row.revoked_at = datetime.utcnow()
