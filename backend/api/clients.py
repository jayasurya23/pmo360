"""/api/clients — list, create, rename, delete clients."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from auth import require_db_user
from auth.permissions import CLIENT_MGMT, require_permission
from core.deps import get_db
from db.models import Client
from db.repository import list_clients
from schemas.common import ClientOut, ClientCreate, ClientUpdate

router = APIRouter(prefix="/api/clients", tags=["clients"])


@router.get("", response_model=list[ClientOut])
def get_clients(db: Session = Depends(get_db), _user=Depends(require_db_user)):
    """Deliberately require_db_user, NOT require_admin. Every page in the app
    resolves the client list to render the header switcher and navigation, so
    tightening this to admins would break the app for everyone else. Client
    *names* are not sensitive; the mutations below are what's gated."""
    return list_clients(db)


@router.post("", response_model=ClientOut, status_code=201)
def create_client(payload: ClientCreate, db: Session = Depends(get_db), _user=Depends(require_db_user)):
    """Any PM. Winning new work is the job — a PM who cannot register the client
    they just won is blocked on someone else for the most ordinary task there is.
    Creating is additive and reversible by an admin; only DELETE is gated, since
    that is the one that destroys everything underneath."""
    existing = db.query(Client).filter_by(name=payload.name).first()
    if existing:
        raise HTTPException(409, f"Client {payload.name!r} already exists")
    client = Client(name=payload.name, email_domain=payload.email_domain)
    db.add(client)
    db.flush()
    return client


@router.patch("/{client_id}", response_model=ClientOut)
def update_client(
    client_id: int, payload: ClientUpdate, db: Session = Depends(get_db),
    _user=Depends(require_db_user),
):
    """Any PM, same reasoning as create_client. A rename relabels everything
    beneath the client, but a wrong label is a typo someone can correct — it
    destroys nothing, and clients get renamed (acquisitions, rebrands) often
    enough that routing it through an admin would just add latency."""
    client = db.get(Client, client_id)
    if not client:
        raise HTTPException(404, "Client not found")
    if payload.name is not None:
        new_name = payload.name.strip()
        if not new_name:
            raise HTTPException(422, "Client name cannot be empty")
        clash = (
            db.query(Client)
            .filter(Client.name == new_name, Client.id != client_id)
            .first()
        )
        if clash:
            raise HTTPException(409, f"Client {new_name!r} already exists")
        client.name = new_name
    if payload.email_domain is not None:
        client.email_domain = payload.email_domain.strip() or None
    db.flush()
    return client


@router.delete("/{client_id}", status_code=204)
def delete_client(
    client_id: int,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
    guard=Depends(require_permission(CLIENT_MGMT)),
):
    """Requires the Client Management permission. Deleting a client cascades
    through `Client.projects` (all, delete-orphan) into every portfolio beneath
    it and everything they own — meetings, agendas, proposals, change orders,
    action items. It is the single most destructive call in the API, so it is
    the one client mutation that is gated; create and rename stay open to any
    PM (see above).

    Global scope, no portfolio: a client sits ABOVE every portfolio, so there is
    no single membership that could stand for "may destroy this". Admins hold
    the permission implicitly, which preserves the previous admin-only reach."""
    client = db.get(Client, client_id)
    if not client:
        raise HTTPException(404, "Client not found")
    db.delete(client)
    return None
