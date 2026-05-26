"""/api/search — global Cmd+K palette backend.

Searches across clients, portfolios (Project), meetings, agendas, and open
action items with a case-insensitive substring match. Returns up to 20 results
prioritized by kind:

    clients   (max 5)
    portfolios (max 5)
    meetings  (max 5)
    agendas   (max 3)
    open actions (max 5)

Each result carries the precomputed ``client_slug`` and ``portfolio_slug`` so
the React frontend can build a navigation URL without doing its own lookup.
This keeps the palette responsive and avoids needing an extra clients/projects
fetch on the way to the destination page.
"""
from __future__ import annotations

import re
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session

from core.deps import get_db
from db.models import Client, Project, Meeting, Agenda, ActionItem
from schemas.common import SearchResponse, SearchResultOut


router = APIRouter(prefix="/api/search", tags=["search"])


# Slug rules must match frontend `nameToSlug` in lib/slugs.ts:
#  - lowercase
#  - spaces / underscores → "-"
#  - drop anything outside [a-z0-9-]
#  - collapse repeated "-"
#  - trim leading / trailing "-"
def _slugify(name: Optional[str]) -> str:
    if not name:
        return ""
    s = name.lower()
    s = re.sub(r"[_\s]+", "-", s)
    s = re.sub(r"[^a-z0-9-]", "", s)
    s = re.sub(r"-{2,}", "-", s)
    return s.strip("-")


def _fmt_date(d) -> str:
    """Short label like 'May 19'. %-d / %#d differ across POSIX/Windows so we
    format with leading zeros then strip them manually."""
    if not d:
        return ""
    return d.strftime("%b %d").replace(" 0", " ")


@router.get("", response_model=SearchResponse)
def search(
    q: str = Query("", description="Case-insensitive substring query"),
    db: Session = Depends(get_db),
) -> SearchResponse:
    query = (q or "").strip()
    if not query:
        return SearchResponse(results=[])

    needle = f"%{query.lower()}%"
    results: list[SearchResultOut] = []

    # ---- Clients (max 5) ----
    clients = (
        db.query(Client)
        .filter(Client.name.ilike(needle))
        .order_by(Client.name)
        .limit(5)
        .all()
    )
    for c in clients:
        results.append(SearchResultOut(
            kind="client",
            id=c.id,
            label=c.name,
            subtitle=None,
            client_id=c.id,
            client_slug=_slugify(c.name),
        ))

    # ---- Portfolios (max 5). Search portfolio name OR client name. ----
    portfolios = (
        db.query(Project)
        .join(Client, Project.client_id == Client.id)
        .filter(or_(Project.name.ilike(needle), Client.name.ilike(needle)))
        .order_by(Project.name)
        .limit(5)
        .all()
    )
    for p in portfolios:
        client_name = p.client.name if p.client else ""
        results.append(SearchResultOut(
            kind="portfolio",
            id=p.id,
            label=p.name,
            subtitle=client_name or None,
            client_id=p.client_id,
            project_id=p.id,
            client_slug=_slugify(client_name),
            portfolio_slug=_slugify(p.name),
        ))

    # ---- Meetings (max 5). Search title OR raw_notes substring. ----
    meetings = (
        db.query(Meeting)
        .filter(or_(
            Meeting.title.ilike(needle),
            Meeting.raw_notes.ilike(needle),
        ))
        .order_by(Meeting.meeting_date.desc())
        .limit(5)
        .all()
    )
    for m in meetings:
        proj = m.project
        client = proj.client if proj else None
        context = ""
        if client and proj:
            context = f"{client.name} / {proj.name}"
        date_str = _fmt_date(m.meeting_date)
        title = m.title or "(untitled meeting)"
        results.append(SearchResultOut(
            kind="meeting",
            id=m.id,
            label=f"{title} — {date_str}" if date_str else title,
            subtitle=context or None,
            client_id=client.id if client else None,
            project_id=proj.id if proj else None,
            client_slug=_slugify(client.name) if client else None,
            portfolio_slug=_slugify(proj.name) if proj else None,
        ))

    # ---- Agendas (max 3). Search title only. ----
    agendas = (
        db.query(Agenda)
        .filter(Agenda.title.ilike(needle))
        .order_by(Agenda.upcoming_date.desc())
        .limit(3)
        .all()
    )
    for a in agendas:
        proj = a.project
        client = proj.client if proj else None
        context_parts: list[str] = []
        if client and proj:
            context_parts.append(f"{client.name} / {proj.name}")
        date_str = _fmt_date(a.upcoming_date)
        if date_str:
            context_parts.append(f"upcoming {date_str}")
        title = a.title or "(untitled agenda)"
        results.append(SearchResultOut(
            kind="agenda",
            id=a.id,
            label=title,
            subtitle=" · ".join(context_parts) or None,
            client_id=client.id if client else None,
            project_id=proj.id if proj else None,
            client_slug=_slugify(client.name) if client else None,
            portfolio_slug=_slugify(proj.name) if proj else None,
        ))

    # ---- Open actions (max 5). Search text + owner. ----
    actions = (
        db.query(ActionItem)
        .filter(ActionItem.status == "open")
        .filter(or_(
            ActionItem.text.ilike(needle),
            ActionItem.owner.ilike(needle),
        ))
        .order_by(ActionItem.due_date.asc().nullslast(), ActionItem.id.desc())
        .limit(5)
        .all()
    )
    for act in actions:
        # Resolve client/portfolio via originating meeting's project.
        orig = act.originating_meeting
        proj = orig.project if orig else None
        client = proj.client if proj else None
        context_parts: list[str] = []
        if client and proj:
            context_parts.append(f"{client.name} / {proj.name}")
        context_parts.append("open")
        if act.due_date:
            context_parts.append(f"due {_fmt_date(act.due_date)}")
        text = (act.text or "").strip()
        label = text if len(text) <= 80 else text[:77] + "…"
        results.append(SearchResultOut(
            kind="action",
            id=act.id,
            label=label or "(empty action)",
            subtitle=" · ".join(context_parts) or None,
            client_id=client.id if client else None,
            project_id=proj.id if proj else None,
            client_slug=_slugify(client.name) if client else None,
            portfolio_slug=_slugify(proj.name) if proj else None,
        ))

    # Hard cap at 20 even if every bucket hits its max (5+5+5+3+5 = 23).
    return SearchResponse(results=results[:20])
