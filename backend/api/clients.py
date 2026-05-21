"""/api/clients — list, create, delete clients."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from core.deps import get_db
from db.models import Client
from db.repository import list_clients
from schemas.common import ClientOut, ClientCreate

router = APIRouter(prefix="/api/clients", tags=["clients"])


@router.get("", response_model=list[ClientOut])
def get_clients(db: Session = Depends(get_db)):
    return list_clients(db)


@router.post("", response_model=ClientOut, status_code=201)
def create_client(payload: ClientCreate, db: Session = Depends(get_db)):
    existing = db.query(Client).filter_by(name=payload.name).first()
    if existing:
        raise HTTPException(409, f"Client {payload.name!r} already exists")
    client = Client(name=payload.name, email_domain=payload.email_domain)
    db.add(client)
    db.flush()
    return client


@router.delete("/{client_id}", status_code=204)
def delete_client(client_id: int, db: Session = Depends(get_db)):
    client = db.get(Client, client_id)
    if not client:
        raise HTTPException(404, "Client not found")
    db.delete(client)
    return None
