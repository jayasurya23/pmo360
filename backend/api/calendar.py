"""/api/calendar — match Outlook calendar events to PMO portfolios.

Three endpoints:
  - POST /api/calendar/match  → bulk match a list of events (from /me/calendarview)
  - POST /api/calendar/link   → persist a manual override link
  - DELETE /api/calendar/link/{graph_event_id} → remove a manual link

Matching priority (first hit wins):
  0. CalendarEventLink row — explicit PM override, never second-guessed.
  1. Attendee email matches a project's roster email set
     (ProjectAttendee.email ∪ MeetingAttendee.email).
  2. Event subject (case-insensitive) contains a project or client name.
     Sorted longest-name-first so "TestCo Renewables Site A" beats "TestCo"
     when both appear in the subject.

Scoping: signed-in user must be admin OR a member of the matched portfolio.
Anyone else gets back ``project_id: null``. We never reveal portfolios the
PM can't access via these endpoints.

The browser fetches Outlook events directly from Microsoft Graph
(see frontend/src/lib/graph.ts::listUpcomingEvents). We don't proxy that
through here — the user already has a delegated Graph token and proxying
would add a hop + need on-behalf-of consent. What we DO host server-side
is the matching step, because the per-portfolio email index is data we
don't want to dump to every browser session.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from auth import require_db_user
from core.deps import get_db
from db.models import (
    CalendarEventLink, Meeting, MeetingAttendee, Project, ProjectAttendee,
)
from db.repository import list_my_project_ids

logger = logging.getLogger(__name__)


router = APIRouter(prefix="/api/calendar", tags=["calendar"])


# ============================================================
# Schemas
# ============================================================
class CalendarEventIn(BaseModel):
    """One Outlook event as the frontend pulled it from Graph.

    ``key`` is the occurrence's own Graph event id — echoed back so the
    frontend can map our response onto the right row.

    ``series_key`` is what a manual portfolio LINK is keyed on: the
    recurring series' master id for occurrences of a recurring meeting, or
    the event's own id for one-offs. Linking one occurrence of a weekly
    meeting therefore matches every occurrence (they all share the master
    id). Falls back to ``key`` when omitted (older clients)."""
    key: str
    series_key: Optional[str] = None
    subject: str = ""
    attendee_emails: list[str] = Field(default_factory=list)

    @property
    def link_key(self) -> str:
        return self.series_key or self.key


class CalendarMatchRequest(BaseModel):
    events: list[CalendarEventIn]


class CalendarMatchOut(BaseModel):
    """One match result per event. ``project_id`` is None when nothing
    matched OR when the matched portfolio falls outside the user's scope
    (non-admin, not a member). ``match_reason`` exposes WHY we matched so
    the UI can show a confidence pill ("by attendee", "by subject",
    "manual link")."""
    key: str
    project_id: Optional[int] = None
    project_name: Optional[str] = None
    client_name: Optional[str] = None
    match_reason: Optional[str] = None
    # True when the matched portfolio came from a persisted
    # CalendarEventLink — the UI shows a different pill + a "Remove link"
    # action instead of "Confirm link".
    is_manual: bool = False


class CalendarMatchResponse(BaseModel):
    matches: list[CalendarMatchOut]


class CalendarLinkRequest(BaseModel):
    """POST body for /api/calendar/link. ``graph_event_id`` is the Outlook
    event's stable Graph id; ``project_id`` is the portfolio to bind it to
    (must be one the user can access)."""
    graph_event_id: str
    project_id: int


class CalendarLinkOut(BaseModel):
    graph_event_id: str
    project_id: int
    project_name: Optional[str] = None
    client_name: Optional[str] = None
    linked_at: datetime


# ============================================================
# Internal helpers
# ============================================================
def _accessible_project_ids(db: Session, actor) -> set[int]:
    """Set of project ids the user can see — admins get everything,
    non-admins get just their memberships. Mirrors the same scope
    enforcement the rest of the dashboard uses."""
    if actor.is_admin:
        return {row[0] for row in db.query(Project.id).all()}
    return set(list_my_project_ids(db, actor.id))


def _build_email_index(
    db: Session, project_ids: set[int],
) -> dict[str, int]:
    """``{ email_lowercased: project_id }`` for the given projects, deduped.

    Sources:
      - ProjectAttendee (persistent per-project roster)
      - MeetingAttendee (per-meeting snapshot — picks up ad-hoc attendees
        who never made it into the roster)
    First-seen wins per email so we don't bounce the user between portfolios
    when the same person attends both.
    """
    if not project_ids:
        return {}
    index: dict[str, int] = {}

    for pa in (
        db.query(ProjectAttendee)
        .filter(ProjectAttendee.project_id.in_(project_ids))
        .filter(ProjectAttendee.email.isnot(None))
        .all()
    ):
        email = (pa.email or "").strip().lower()
        if email and email not in index:
            index[email] = pa.project_id

    rows = (
        db.query(MeetingAttendee.email, Meeting.project_id)
        .join(Meeting, MeetingAttendee.meeting_id == Meeting.id)
        .filter(MeetingAttendee.email.isnot(None))
        .filter(Meeting.project_id.in_(project_ids))
        .all()
    )
    for email, project_id in rows:
        clean = (email or "").strip().lower()
        if not clean or clean in index:
            continue
        index[clean] = project_id

    return index


def _project_lookup(
    db: Session, project_ids: set[int],
) -> dict[int, tuple[str, Optional[str]]]:
    """``{project_id: (project_name, client_name)}`` for response enrichment."""
    out: dict[int, tuple[str, Optional[str]]] = {}
    if not project_ids:
        return out
    for p in (
        db.query(Project).filter(Project.id.in_(project_ids)).all()
    ):
        out[p.id] = (p.name, (p.client.name if p.client else None))
    return out


def _name_substring_list(
    db: Session, project_ids: set[int],
) -> list[tuple[int, str, Optional[str]]]:
    """``[(project_id, project_name_lower, client_name_lower_or_None)]`` for
    the subject-substring fallback. Sorted longest-project-name-first so
    a more specific name beats a generic one when both appear in the
    subject ("Snapdragon and Two Blues weekly" → matches "Snapdragon and
    Two Blues" before "Snapdragon")."""
    rows: list[tuple[int, str, Optional[str]]] = []
    if not project_ids:
        return rows
    for p in db.query(Project).filter(Project.id.in_(project_ids)).all():
        client_name = (p.client.name.lower() if p.client else None)
        rows.append((p.id, (p.name or "").lower(), client_name))
    rows.sort(key=lambda r: len(r[1]), reverse=True)
    return rows


# ============================================================
# Match endpoint
# ============================================================
@router.post("/match", response_model=CalendarMatchResponse)
def match_calendar_events(
    payload: CalendarMatchRequest,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
) -> CalendarMatchResponse:
    """Match a batch of Outlook events to PMO portfolios. See module
    docstring for the priority order."""
    allowed_ids = _accessible_project_ids(db, actor)
    email_index = _build_email_index(db, allowed_ids)
    name_index = _name_substring_list(db, allowed_ids)
    project_map = _project_lookup(db, allowed_ids)

    # Bulk-load all manual links for the LINK keys in this request. A link
    # key is the recurring series master id (so one link covers every
    # occurrence) or the event id for one-offs.
    link_keys = [ev.link_key for ev in payload.events if ev.link_key]
    link_map: dict[str, int] = {}
    if link_keys:
        for link in (
            db.query(CalendarEventLink)
            .filter(CalendarEventLink.graph_event_id.in_(link_keys))
            .all()
        ):
            # Only honour links that point at portfolios the user can see.
            if link.project_id in allowed_ids:
                link_map[link.graph_event_id] = link.project_id

    results: list[CalendarMatchOut] = []
    for ev in payload.events:
        matched_id: Optional[int] = None
        reason: Optional[str] = None
        is_manual = False

        # Priority 0: persistent manual link (keyed on the series/link key,
        # so every occurrence of a linked recurring meeting matches).
        if ev.link_key in link_map:
            matched_id = link_map[ev.link_key]
            reason = "manual"
            is_manual = True

        # Priority 1: attendee email
        if matched_id is None:
            for raw in ev.attendee_emails:
                clean = (raw or "").strip().lower()
                if not clean:
                    continue
                hit = email_index.get(clean)
                if hit is not None:
                    matched_id = hit
                    reason = "email"
                    break

        # Priority 2: subject substring
        if matched_id is None and ev.subject:
            subject_lower = ev.subject.lower()
            for pid, pname, cname in name_index:
                if pname and pname in subject_lower:
                    matched_id = pid
                    reason = "subject"
                    break
                if cname and cname in subject_lower:
                    matched_id = pid
                    reason = "subject"
                    break

        pname, cname = (None, None)
        if matched_id is not None:
            pname, cname = project_map.get(matched_id, (None, None))

        results.append(CalendarMatchOut(
            key=ev.key,
            project_id=matched_id,
            project_name=pname,
            client_name=cname,
            match_reason=reason,
            is_manual=is_manual,
        ))

    return CalendarMatchResponse(matches=results)


# ============================================================
# Link / unlink endpoints
# ============================================================
@router.post("/link", response_model=CalendarLinkOut)
def upsert_calendar_link(
    payload: CalendarLinkRequest,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
) -> CalendarLinkOut:
    """Bind (or rebind) a Graph event id to a PMO portfolio. Idempotent —
    a second call with the same ``graph_event_id`` updates the existing row
    rather than failing on the UNIQUE constraint.

    Authorisation: the actor must be able to access the target portfolio
    (admin OR a member). Returns 403 otherwise — we don't want users
    silently retargeting events to portfolios they can't see.
    """
    if not payload.graph_event_id.strip():
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "graph_event_id must not be empty",
        )

    project = db.get(Project, payload.project_id)
    if project is None:
        raise HTTPException(404, "Portfolio not found")

    allowed_ids = _accessible_project_ids(db, actor)
    if payload.project_id not in allowed_ids:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "You don't have access to that portfolio.",
        )

    row = (
        db.query(CalendarEventLink)
        .filter_by(graph_event_id=payload.graph_event_id)
        .first()
    )
    now = datetime.utcnow()
    if row is None:
        row = CalendarEventLink(
            graph_event_id=payload.graph_event_id,
            project_id=payload.project_id,
            linked_by_id=actor.id,
            linked_at=now,
            updated_at=now,
        )
        db.add(row)
    else:
        row.project_id = payload.project_id
        row.linked_by_id = actor.id
        row.updated_at = now
    db.flush()

    client_name = project.client.name if project.client else None
    return CalendarLinkOut(
        graph_event_id=row.graph_event_id,
        project_id=row.project_id,
        project_name=project.name,
        client_name=client_name,
        linked_at=row.linked_at or now,
    )


@router.delete("/link/{graph_event_id:path}", status_code=204)
def delete_calendar_link(
    graph_event_id: str,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    """Remove a manual link. Idempotent — deleting a non-existent link is
    a 204 (so the UI can fire-and-forget without checking existence).

    Authorisation: only the actor who created the link, OR an admin, can
    remove it. Other PMs can re-link via POST /link (which updates in
    place) but not silently nuke another PM's binding.
    """
    row = (
        db.query(CalendarEventLink)
        .filter_by(graph_event_id=graph_event_id)
        .first()
    )
    if row is None:
        return None
    if not actor.is_admin and row.linked_by_id != actor.id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only the PM who linked this event (or an admin) can unlink it.",
        )
    db.delete(row)
    return None
