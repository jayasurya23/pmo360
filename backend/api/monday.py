"""/api/monday — read-only monday.com board links, KPIs and sync.

Endpoints:
  - GET    /api/monday/status                      → is the integration configured
  - GET    /api/monday/boards/{board_id}/validate  → check an id before pinning
  - GET    /api/monday/projects/{project_id}/links → boards pinned to a portfolio
  - POST   /api/monday/projects/{project_id}/links → pin one (admin)
  - PATCH  /api/monday/links/{link_id}             → activate/deactivate (admin)
  - DELETE /api/monday/links/{link_id}             → unpin (admin)
  - POST   /api/monday/links/{link_id}/sync        → force refresh now
  - GET    /api/monday/links/{link_id}/trend       → KPI history for charts
  - GET    /api/monday/links/{link_id}/tasks       → live drill-in, bypasses cache
  - GET    /api/monday/projects/{project_id}/kpis  → the dashboard payload

Nothing here writes to monday.com. Every write verb refers to PMO 360's own
link/cache rows.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from auth import require_admin, require_db_user
from config import monday_is_configured
from core.deps import get_db
from db.models import MondayBoardLink, Project
from integrations.monday import (
    MondayAuthError,
    MondayError,
    MondayNotConfigured,
    MondayRateLimitError,
    fetch_live_tasks,
    get_board_kpis,
    kpi_trend,
    sync_board,
    validate_board,
)
from schemas.monday import (
    BoardKpisOut,
    KpiTrendOut,
    KpiTrendPoint,
    MondayBoardLinkCreate,
    MondayBoardLinkOut,
    MondayBoardLinkUpdate,
    MondayBoardValidateOut,
    MondaySyncResultOut,
    MondayTaskOut,
    PortfolioKpisOut,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/monday", tags=["monday"])


def _handle_monday_error(exc: Exception) -> HTTPException:
    """Translate integration failures into honest HTTP statuses.

    A rate limit is 503 + Retry-After (the caller should come back), auth
    failure is 502 (our credential is wrong, not the caller's), and an
    unconfigured integration is 409 (a setup step is missing).
    """
    if isinstance(exc, MondayNotConfigured):
        return HTTPException(409, str(exc))
    if isinstance(exc, MondayRateLimitError):
        retry = getattr(exc, "retry_after_seconds", None)
        return HTTPException(
            503,
            f"monday.com rate limit reached. {exc}",
            headers={"Retry-After": str(int(retry))} if retry else None,
        )
    if isinstance(exc, MondayAuthError):
        return HTTPException(
            502, f"monday.com rejected PMO 360's credentials: {exc}"
        )
    return HTTPException(502, f"monday.com request failed: {exc}")


def _get_link(db: Session, link_id: int) -> MondayBoardLink:
    link = db.get(MondayBoardLink, link_id)
    if not link:
        raise HTTPException(404, "monday board link not found")
    return link


def _get_project(db: Session, project_id: int) -> Project:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Portfolio not found")
    return project


# ---------------------------------------------------------------- status
@router.get("/status")
def get_status(_user=Depends(require_db_user)):
    """Whether the integration is usable, without exposing the token."""
    return {
        "configured": monday_is_configured(),
        "read_only": True,
    }


@router.get("/boards/{board_id}/validate", response_model=MondayBoardValidateOut)
def validate_board_id(board_id: str, _user=Depends(require_db_user)):
    """Confirm a board id is real and readable before pinning it.

    Worth doing explicitly: Castillo's workspace has eight boards named
    "Duplicate of MVP", so a PM copying an id by eye can easily pin the wrong
    one and not notice until the KPIs look wrong.
    """
    try:
        meta = validate_board(board_id)
    except (MondayError, MondayNotConfigured) as exc:
        raise _handle_monday_error(exc) from exc

    workspace = meta.get("workspace") or {}
    return MondayBoardValidateOut(
        board_id=str(meta.get("id", board_id)),
        name=meta.get("name"),
        items_count=meta.get("items_count"),
        workspace_name=workspace.get("name") if isinstance(workspace, dict) else None,
    )


# ---------------------------------------------------------------- links
@router.get(
    "/projects/{project_id}/links", response_model=list[MondayBoardLinkOut]
)
def list_links(
    project_id: int, db: Session = Depends(get_db), _user=Depends(require_db_user)
):
    _get_project(db, project_id)
    return (
        db.query(MondayBoardLink)
        .filter_by(project_id=project_id)
        .order_by(MondayBoardLink.id)
        .all()
    )


@router.post(
    "/projects/{project_id}/links",
    response_model=MondayBoardLinkOut,
    status_code=201,
)
def create_link(
    project_id: int,
    payload: MondayBoardLinkCreate,
    db: Session = Depends(get_db),
    user=Depends(require_admin),
):
    """Pin a board to a portfolio. Admin-only — it decides where every KPI on
    this portfolio comes from."""
    _get_project(db, project_id)

    existing = (
        db.query(MondayBoardLink)
        .filter_by(project_id=project_id, board_id=payload.board_id)
        .first()
    )
    if existing:
        raise HTTPException(
            409, f"Board {payload.board_id} is already linked to this portfolio"
        )

    # Validate before persisting so a typo fails loudly here rather than as an
    # empty dashboard later.
    try:
        meta = validate_board(payload.board_id)
    except (MondayError, MondayNotConfigured) as exc:
        raise _handle_monday_error(exc) from exc

    link = MondayBoardLink(
        project_id=project_id,
        board_id=payload.board_id,
        board_name=meta.get("name"),
        kind=payload.kind,
        created_by_id=getattr(user, "id", None),
    )
    db.add(link)
    db.flush()
    return link


@router.patch("/links/{link_id}", response_model=MondayBoardLinkOut)
def update_link(
    link_id: int,
    payload: MondayBoardLinkUpdate,
    db: Session = Depends(get_db),
    _user=Depends(require_admin),
):
    link = _get_link(db, link_id)
    if payload.is_active is not None:
        link.is_active = payload.is_active
    if payload.kind is not None:
        link.kind = payload.kind
    db.flush()
    return link


@router.delete("/links/{link_id}", status_code=204)
def delete_link(
    link_id: int, db: Session = Depends(get_db), _user=Depends(require_admin)
):
    """Unpin a board. Cascades into its cached tasks and KPI history — the
    trend series for this board is destroyed and cannot be rebuilt, since
    monday retains no history of its own."""
    link = _get_link(db, link_id)
    db.delete(link)
    db.flush()
    return None


# ---------------------------------------------------------------- sync + KPIs
@router.post("/links/{link_id}/sync", response_model=MondaySyncResultOut)
def sync_link(
    link_id: int, db: Session = Depends(get_db), _user=Depends(require_db_user)
):
    """Force an immediate refresh from monday.com."""
    link = _get_link(db, link_id)
    try:
        kpis = sync_board(db, link)
    except (MondayError, MondayNotConfigured) as exc:
        raise _handle_monday_error(exc) from exc

    return MondaySyncResultOut(
        board_link_id=link.id,
        board_id=link.board_id,
        board_name=link.board_name,
        task_count=link.last_sync_task_count or 0,
        synced_at=link.last_synced_at,
        kpis=BoardKpisOut(**kpis.as_dict()),
    )


@router.get("/projects/{project_id}/kpis", response_model=PortfolioKpisOut)
def get_portfolio_kpis(
    project_id: int,
    refresh: bool = Query(
        False, description="Bypass the cache TTL and pull from monday now"
    ),
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
):
    """KPI payload for the portfolio dashboard.

    Degrades rather than fails: an unconfigured or unlinked portfolio returns
    200 with ``configured``/``linked`` false and a message, so the dashboard
    can render its native metrics alongside a setup prompt.
    """
    _get_project(db, project_id)

    if not monday_is_configured():
        return PortfolioKpisOut(
            project_id=project_id, configured=False, linked=False,
            message=(
                "monday.com is not configured. Set MONDAY_API_TOKEN on the "
                "backend to enable schedule, QC and effort KPIs."
            ),
        )

    links = (
        db.query(MondayBoardLink)
        .filter_by(project_id=project_id, is_active=True)
        .order_by(MondayBoardLink.id)
        .all()
    )
    if not links:
        return PortfolioKpisOut(
            project_id=project_id, configured=True, linked=False,
            message=(
                "No monday.com board is linked to this portfolio yet. Link one "
                "in Settings to pull schedule, QC and effort KPIs."
            ),
        )

    boards, last_synced = [], None
    for link in links:
        try:
            kpis = get_board_kpis(db, link, force_refresh=refresh)
        except (MondayError, MondayNotConfigured) as exc:
            # One bad board must not blank the whole dashboard.
            logger.warning("monday: KPIs unavailable for board %s: %s", link.board_id, exc)
            continue
        boards.append(BoardKpisOut(**kpis.as_dict()))
        if link.last_synced_at and (last_synced is None or link.last_synced_at > last_synced):
            last_synced = link.last_synced_at

    message = None
    if not boards:
        message = (
            "Linked to monday.com, but no board could be read. Check the API "
            "token's board permissions."
        )

    return PortfolioKpisOut(
        project_id=project_id, configured=True, linked=True,
        last_synced_at=last_synced, boards=boards, message=message,
    )


@router.get("/links/{link_id}/trend", response_model=KpiTrendOut)
def get_trend(
    link_id: int,
    days: int = Query(90, ge=7, le=730),
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
):
    """KPI history for trend charts.

    Only covers dates on which a sync ran — monday keeps no history of its own,
    so there is nothing to backfill from. A board linked today has one point.
    """
    link = _get_link(db, link_id)
    rows = kpi_trend(db, link, days=days)
    return KpiTrendOut(
        board_link_id=link.id,
        board_id=link.board_id,
        board_name=link.board_name,
        points=[KpiTrendPoint.model_validate(r, from_attributes=True) for r in rows],
    )


@router.get("/links/{link_id}/tasks", response_model=list[MondayTaskOut])
def get_tasks(
    link_id: int,
    live: bool = Query(True, description="Fetch from monday now instead of cache"),
    status: Optional[str] = Query(None, description="Filter by status label"),
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
):
    """Task-level drill-in — the live half of the hybrid strategy."""
    link = _get_link(db, link_id)

    try:
        if live:
            tasks = fetch_live_tasks(link)
        else:
            from integrations.monday import cached_tasks

            tasks = cached_tasks(db, link)
    except (MondayError, MondayNotConfigured) as exc:
        raise _handle_monday_error(exc) from exc

    if status:
        wanted = status.strip().lower()
        tasks = [t for t in tasks if (t.status or "").lower() == wanted]

    return [
        MondayTaskOut(
            item_id=t.item_id, name=t.name, url=t.url, group_title=t.group_title,
            status=t.status, phase=t.phase, disciplines=t.disciplines, owner=t.owner,
            start_date=t.start_date, end_date=t.end_date,
            completion_date=t.completion_date,
            schedule_variance_days=t.schedule_variance_days,
            planned_hours=t.planned_hours, actual_hours=t.actual_hours,
            qc_status=t.qc_status, qc_cycle_days=t.qc_cycle_days,
        )
        for t in tasks
    ]
