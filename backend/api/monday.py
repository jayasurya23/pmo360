"""/api/monday — link PMO 360 projects to monday.com, and read RFIs.

Monday keeps ONE flat "Portfolio" board. We keep Client -> Portfolio ->
Project. Those do not line up cleanly and never will: measured against the live
boards, 17 of 39 Monday projects match one of ours by name, 3 match more than
one, and 19 match nothing at all. So the mapping is a stored decision a person
makes, not a join a query can compute — auto-matching seeds it, the screen
corrects it.

The mapping is deliberately generic infrastructure. RFIs are the first
consumer; as the team migrates from Smartsheets, KPI reads will join through
the same monday_item_id rather than introducing a second, competing link.

Nothing here writes to monday.com.
"""
from __future__ import annotations

import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from core.deps import get_db
from auth import require_db_user
from db.models import Client, PortfolioProject, Project
from integrations import monday

router = APIRouter(prefix="/api/monday", tags=["monday"])


# ---------------------------------------------------------------- schemas
class MondayStatusOut(BaseModel):
    configured: bool
    #: Present only when a live call failed, so the UI can say WHY it is empty
    #: rather than implying monday.com has no projects.
    error: Optional[str] = None
    project_count: int = 0
    mapped_count: int = 0


class MappingTargetOut(BaseModel):
    """One PMO 360 row a Monday project could be (or is) attached to."""
    kind: str                      # "portfolio" | "project"
    id: int
    name: str
    client_name: Optional[str] = None
    portfolio_name: Optional[str] = None   # set for kind="project"


class MondayProjectOut(BaseModel):
    monday_item_id: int
    name: str
    project_code: Optional[str] = None
    client_name: Optional[str] = None
    project_site: Optional[str] = None
    contract_status: Optional[str] = None
    #: What this Monday project is linked to today. Several, because one Monday
    #: project can legitimately cover two of ours ("Highland South (1 & 2)").
    linked: list[MappingTargetOut] = []
    #: Name matches we would propose. Empty when nothing matches; more than one
    #: when the name is ambiguous, and then we never auto-apply.
    suggestions: list[MappingTargetOut] = []


class SetMappingIn(BaseModel):
    monday_item_id: int
    project_code: Optional[str] = None
    kind: str                      # "portfolio" | "project"
    id: int


class ClearMappingIn(BaseModel):
    kind: str
    id: int


class AutoMapResult(BaseModel):
    applied: list[str] = []
    skipped_ambiguous: list[str] = []
    skipped_no_match: list[str] = []
    skipped_already_linked: list[str] = []


# ---------------------------------------------------------------- helpers
def _key(name: Optional[str]) -> str:
    """Compare names ignoring case, spacing and punctuation.

    Deliberately loose: 'Highland South (1 & 2)' and 'Highland South 1' should
    not collide, but 'Beloit II' and 'beloit ii' must. Anything cleverer (fuzzy
    distance) starts guessing, and a wrong mapping silently files RFIs under
    another client's project — worse than no match at all.
    """
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def _targets(db: Session) -> list[tuple[str, object, str, Optional[str], Optional[str]]]:
    """Every mappable row, as (kind, orm_row, name, client_name, portfolio_name)."""
    clients = {c.id: c.name for c in db.query(Client).all()}
    portfolios = db.query(Project).all()
    pf_by_id = {p.id: p for p in portfolios}
    out: list = []
    for p in portfolios:
        out.append(("portfolio", p, p.name, clients.get(p.client_id), None))
    for sp in db.query(PortfolioProject).all():
        parent = pf_by_id.get(sp.portfolio_id)
        out.append((
            "project", sp, sp.name,
            clients.get(parent.client_id) if parent else None,
            parent.name if parent else None,
        ))
    return out


def _as_target(kind, row, client_name, portfolio_name) -> MappingTargetOut:
    return MappingTargetOut(
        kind=kind, id=row.id, name=row.name,
        client_name=client_name, portfolio_name=portfolio_name,
    )


def _row_for(db: Session, kind: str, row_id: int):
    if kind == "portfolio":
        row = db.get(Project, row_id)
    elif kind == "project":
        row = db.get(PortfolioProject, row_id)
    else:
        raise HTTPException(400, "kind must be 'portfolio' or 'project'.")
    if row is None:
        raise HTTPException(404, "That portfolio or project no longer exists.")
    return row


# ---------------------------------------------------------------- endpoints
@router.get("/status", response_model=MondayStatusOut)
def monday_status(db: Session = Depends(get_db), _user=Depends(require_db_user)):
    """Whether the integration can talk to monday.com, and how far mapping has got.

    Never raises: this drives a Settings panel that has to render an
    explanation when the token is missing or the API is down.
    """
    mapped = (
        db.query(Project).filter(Project.monday_item_id.isnot(None)).count()
        + db.query(PortfolioProject)
        .filter(PortfolioProject.monday_item_id.isnot(None)).count()
    )
    if not monday.is_configured():
        return MondayStatusOut(configured=False, mapped_count=mapped)
    try:
        return MondayStatusOut(
            configured=True, project_count=len(monday.list_projects()),
            mapped_count=mapped,
        )
    except Exception as exc:
        return MondayStatusOut(
            configured=True, mapped_count=mapped, error=str(exc)[:300],
        )


@router.get("/projects", response_model=list[MondayProjectOut])
def list_monday_projects(db: Session = Depends(get_db), _user=Depends(require_db_user)):
    """Monday's projects, each with its current link and any name suggestions."""
    if not monday.is_configured():
        raise HTTPException(
            503,
            "monday.com is not connected. Add a MONDAY_API_TOKEN to enable RFIs.",
        )
    try:
        projects = monday.list_projects()
    except Exception as exc:
        raise HTTPException(502, f"Could not reach monday.com: {exc}") from exc

    targets = _targets(db)
    by_name: dict[str, list] = {}
    linked_by_item: dict[int, list] = {}
    for kind, row, name, client_name, portfolio_name in targets:
        by_name.setdefault(_key(name), []).append((kind, row, client_name, portfolio_name))
        if row.monday_item_id:
            linked_by_item.setdefault(int(row.monday_item_id), []).append(
                (kind, row, client_name, portfolio_name)
            )

    out: list[MondayProjectOut] = []
    for p in projects:
        item_id = p["monday_item_id"]
        linked = [_as_target(k, r, c, pf) for k, r, c, pf in linked_by_item.get(item_id, [])]
        # Suggestions are only useful while nothing is linked yet.
        sugg = []
        if not linked:
            sugg = [
                _as_target(k, r, c, pf)
                for k, r, c, pf in by_name.get(_key(p["name"]), [])
            ]
        out.append(MondayProjectOut(
            **{k: p[k] for k in
               ("monday_item_id", "name", "project_code", "client_name",
                "project_site", "contract_status")},
            linked=linked, suggestions=sugg,
        ))
    return out


@router.post("/mapping", response_model=MondayProjectOut)
def set_mapping(
    payload: SetMappingIn,
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
):
    """Attach one PMO 360 row to a Monday project.

    Additive, not exclusive: linking a second row to the same Monday project is
    legitimate ("Highland South (1 & 2)" covers two of our sub-projects), so
    nothing here clears the other side.
    """
    row = _row_for(db, payload.kind, payload.id)
    row.monday_item_id = payload.monday_item_id
    row.monday_project_code = payload.project_code
    db.flush()
    return _refresh_one(db, payload.monday_item_id)


@router.delete("/mapping", status_code=204)
def clear_mapping(
    kind: str,
    id: int,
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
):
    row = _row_for(db, kind, id)
    row.monday_item_id = None
    row.monday_project_code = None
    db.flush()
    return None


def _refresh_one(db: Session, monday_item_id: int) -> MondayProjectOut:
    """Re-read one Monday project's links for the write response, so the UI does
    not have to refetch the whole board after every click."""
    linked = []
    for kind, row, name, client_name, portfolio_name in _targets(db):
        if row.monday_item_id and int(row.monday_item_id) == int(monday_item_id):
            linked.append(_as_target(kind, row, client_name, portfolio_name))
    return MondayProjectOut(monday_item_id=monday_item_id, name="", linked=linked)


@router.post("/automap", response_model=AutoMapResult)
def automap(db: Session = Depends(get_db), _user=Depends(require_db_user)):
    """Apply every UNAMBIGUOUS name match, and report what it would not touch.

    Only exact single matches are applied. An ambiguous name is left alone
    rather than resolved by a tie-break: 'Nesler' matches both a portfolio and a
    sub-project under 'All Portfolios', and picking one silently would file a
    client's RFIs against the wrong record while looking successful.

    Already-linked rows are never overwritten — a person's decision outranks a
    name match, and re-running this must be safe.
    """
    if not monday.is_configured():
        raise HTTPException(
            503, "monday.com is not connected. Add a MONDAY_API_TOKEN first.",
        )
    try:
        projects = monday.list_projects()
    except Exception as exc:
        raise HTTPException(502, f"Could not reach monday.com: {exc}") from exc

    targets = _targets(db)
    by_name: dict[str, list] = {}
    already = set()
    for kind, row, name, client_name, portfolio_name in targets:
        by_name.setdefault(_key(name), []).append((kind, row))
        if row.monday_item_id:
            already.add(int(row.monday_item_id))

    res = AutoMapResult()
    for p in projects:
        label = f"{p.get('project_code') or '—'} {p['name']}"
        if p["monday_item_id"] in already:
            res.skipped_already_linked.append(label)
            continue
        cands = by_name.get(_key(p["name"]), [])
        if len(cands) == 1:
            kind, row = cands[0]
            row.monday_item_id = p["monday_item_id"]
            row.monday_project_code = p.get("project_code")
            res.applied.append(f"{label}  ->  {kind} '{row.name}'")
        elif len(cands) > 1:
            res.skipped_ambiguous.append(
                f"{label}  ({len(cands)} possible matches)"
            )
        else:
            res.skipped_no_match.append(label)
    db.flush()
    return res
