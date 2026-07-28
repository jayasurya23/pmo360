"""/api/clients — list, create, rename, delete clients."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from auth import require_db_user, require_admin
from core.deps import get_db
from db.models import Client
from db.repository import list_clients
from schemas.common import ClientOut, ClientCreate, ClientUpdate

router = APIRouter(prefix="/api/clients", tags=["clients"])


@router.get("", response_model=list[ClientOut])
def get_clients(db: Session = Depends(get_db), _user=Depends(require_db_user)):
    return list_clients(db)


@router.post("", response_model=ClientOut, status_code=201)
def create_client(payload: ClientCreate, db: Session = Depends(get_db), _user=Depends(require_db_user)):
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
def delete_client(client_id: int, db: Session = Depends(get_db), _user=Depends(require_admin)):
    """Admin-only. Deleting a client cascades through `Client.projects`
    (all, delete-orphan) into every portfolio beneath it and everything they
    own — meetings, agendas, proposals, change orders, action items. It is the
    single most destructive call in the API, so it is gated to ADMIN_EMAILS
    rather than any signed-in PM."""
    client = db.get(Client, client_id)
    if not client:
        raise HTTPException(404, "Client not found")
    db.delete(client)
    return None
