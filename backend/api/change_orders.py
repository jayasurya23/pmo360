"""/api/change-orders — internal Change Order Request module.

Workflow: draft -> pending (submit) -> approved (downloadable branded PDF).
Scoped to a portfolio (project_id). Any signed-in user can approve. Line items
are fixed (cost) or hourly (rate*hours); `total_amount` is recomputed on save.
Internal notes are stored but never rendered on the client-facing PDF.
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import func
from sqlalchemy.orm import Session

from core.deps import get_db
from auth import require_db_user
from core.services import safe_filename_slug
from db.models import ChangeOrder, ChangeOrderLineItem, Project
from docgen.change_order_pdf import build_change_order_pdf
from schemas.common import (
    ChangeOrderOut, ChangeOrderIn, ChangeOrderUpdate, ChangeOrderLineItemIn,
)


router = APIRouter(prefix="/api/change-orders", tags=["change-orders"])

_VALID_STATUS = ("draft", "pending", "approved")
_VALID_RATE = ("fixed", "hourly")


def _line_total(li: ChangeOrderLineItem, rate_type: str) -> float:
    if rate_type == "hourly":
        return float(li.hourly_rate or 0) * float(li.hours or 0)
    return float(li.cost or 0)


def _recompute_total(co: ChangeOrder) -> None:
    co.total_amount = round(
        sum(_line_total(li, co.rate_type) for li in co.line_items), 2
    )


def _apply_line_items(co: ChangeOrder, items: "list[ChangeOrderLineItemIn]") -> None:
    """Replace all line items (the editor sends the full list each save)."""
    co.line_items.clear()
    for i, it in enumerate(items):
        co.line_items.append(ChangeOrderLineItem(
            order_index=i, details=it.details or "",
            cost=it.cost, role=it.role, hourly_rate=it.hourly_rate, hours=it.hours,
            internal_notes=it.internal_notes,
        ))


def _out(co: ChangeOrder, db: Session) -> ChangeOrderOut:
    o = ChangeOrderOut.model_validate(co)
    proj = db.get(Project, co.project_id)
    o.project_name = proj.name if proj else None
    return o


def _get(db: Session, co_id: int) -> ChangeOrder:
    co = db.get(ChangeOrder, co_id)
    if not co:
        raise HTTPException(404, "Change order not found")
    return co


@router.get("", response_model=list[ChangeOrderOut])
def list_change_orders(
    project_id: int = Query(...),
    status: "str | None" = Query(None),
    db: Session = Depends(get_db),
):
    q = db.query(ChangeOrder).filter(ChangeOrder.project_id == project_id)
    if status in _VALID_STATUS:
        q = q.filter(ChangeOrder.status == status)
    rows = q.order_by(ChangeOrder.co_number.desc()).all()
    return [_out(co, db) for co in rows]


@router.get("/{co_id}", response_model=ChangeOrderOut)
def get_change_order(co_id: int, db: Session = Depends(get_db)):
    return _out(_get(db, co_id), db)


@router.post("", response_model=ChangeOrderOut, status_code=201)
def create_change_order(
    payload: ChangeOrderIn,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    project = db.get(Project, payload.project_id)
    if not project:
        raise HTTPException(404, "Portfolio not found")
    next_n = (db.query(func.max(ChangeOrder.co_number))
              .filter(ChangeOrder.project_id == payload.project_id)
              .scalar() or 0) + 1
    co = ChangeOrder(
        project_id=payload.project_id,
        co_number=next_n,
        co_version=payload.co_version or "V1",
        title=payload.title,
        rate_type=payload.rate_type if payload.rate_type in _VALID_RATE else "fixed",
        status="draft",
        request_date=payload.request_date,
        requested_by=payload.requested_by,
        requested_by_user_id=payload.requested_by_user_id,
        client_name=(project.client.name if project.client else None),
        location=payload.location,
        state=payload.state,
        size_mw=payload.size_mw,
        notes=payload.notes,
        created_by_id=actor.id if actor else None,
        updated_by_id=actor.id if actor else None,
    )
    db.add(co)
    db.flush()
    _apply_line_items(co, payload.line_items)
    _recompute_total(co)
    db.flush()
    return _out(co, db)


@router.patch("/{co_id}", response_model=ChangeOrderOut)
def update_change_order(
    co_id: int,
    payload: ChangeOrderUpdate,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    co = _get(db, co_id)
    if payload.expected_version is not None and co.version != payload.expected_version:
        raise HTTPException(409, detail={
            "error": "stale_version",
            "message": "This change order was saved by someone else. Reload first.",
            "current_version": co.version,
        })
    sent = payload.model_fields_set
    for field in ("co_version", "title", "rate_type", "request_date",
                  "requested_by", "requested_by_user_id", "location", "state",
                  "size_mw", "notes"):
        if field in sent:
            setattr(co, field, getattr(payload, field))
    if co.rate_type not in _VALID_RATE:
        co.rate_type = "fixed"
    if payload.line_items is not None:
        _apply_line_items(co, payload.line_items)
    _recompute_total(co)
    co.version = (co.version or 1) + 1
    if actor:
        co.updated_by_id = actor.id
    db.flush()
    return _out(co, db)


@router.post("/{co_id}/submit", response_model=ChangeOrderOut)
def submit_change_order(co_id: int, db: Session = Depends(get_db), actor=Depends(require_db_user)):
    co = _get(db, co_id)
    co.status = "pending"
    if actor:
        co.updated_by_id = actor.id
    db.flush()
    return _out(co, db)


@router.post("/{co_id}/approve", response_model=ChangeOrderOut)
def approve_change_order(co_id: int, db: Session = Depends(get_db), actor=Depends(require_db_user)):
    co = _get(db, co_id)
    co.status = "approved"
    co.approved_by = (actor.name or actor.email) if actor else None
    co.approved_by_user_id = actor.id if actor else None
    co.approved_at = datetime.utcnow()
    if actor:
        co.updated_by_id = actor.id
    db.flush()
    return _out(co, db)


@router.post("/{co_id}/reject", response_model=ChangeOrderOut)
def reject_change_order(co_id: int, db: Session = Depends(get_db), actor=Depends(require_db_user)):
    """Send a pending CO back to draft (clears the approval stamp)."""
    co = _get(db, co_id)
    co.status = "draft"
    co.approved_by = None
    co.approved_by_user_id = None
    co.approved_at = None
    if actor:
        co.updated_by_id = actor.id
    db.flush()
    return _out(co, db)


@router.delete("/{co_id}", status_code=204)
def delete_change_order(co_id: int, db: Session = Depends(get_db), actor=Depends(require_db_user)):
    db.delete(_get(db, co_id))
    return None


@router.get("/{co_id}/pdf/file")
def serve_change_order_pdf(co_id: int, db: Session = Depends(get_db), actor=Depends(require_db_user)):
    co = _get(db, co_id)
    pdf = build_change_order_pdf(co)
    slug = safe_filename_slug(
        f"{co.client_name or 'Castillo'}-CO-{co.co_number}-{co.co_version or 'V1'}"
    )
    return Response(
        content=pdf, media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{slug}.pdf"'},
    )
