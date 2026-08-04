"""/api/dashboard — home page rollup (overdue actions, follow-ups, agendas).

Endpoints:
  - GET /api/dashboard           → cross-portfolio "everyone's stuff" view
  - GET /api/dashboard/mine      → only the signed-in user's stuff. Same shape
                                    so the frontend can render one component
                                    in two contexts.
  - GET /api/dashboard/my-work   → the signed-in person's own plate, counted:
                                    action metrics, where the backlog is
                                    concentrated, and the CO / agenda / draft
                                    queue. Backs the Dashboard's all-clients
                                    state, which otherwise renders nothing.
  - GET /api/dashboard/briefing  → AI-written personalized "since you were
                                    last here..." card for the top of Home.
  - GET /api/dashboard/risks     → open risks aggregated from the most-recent
                                    agenda of every portfolio the user can
                                    see. Sorted by likelihood (Critical → Low)
                                    then by portfolio name.
"""
import logging
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from core.deps import get_db
from auth import require_db_user
from auth.permissions import CO_APPROVAL, has_permission
from db.models import (
    ActionItem, Agenda, ChangeOrder, Client, Meeting, Note, Project,
)
from db.repository import (
    all_open_actions_across_portfolios, all_notes_with_follow_up,
    all_upcoming_agendas, list_my_project_ids,
)
from llm.providers import get_provider
from schemas.common import (
    DashboardResponse, DashboardActionOut, DashboardNoteOut, DashboardAgendaOut,
    BriefingResponse, DashboardRisksResponse, DashboardRiskOut,
    MyWorkActionCounts, MyWorkOut, MyWorkPortfolioRow, MyWorkQueueItem,
    MyWorkWaitingOnMe,
)


logger = logging.getLogger(__name__)


router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


def _project_label(project):
    if project is None:
        return None, None
    client_name = project.client.name if project.client else None
    return project.name, client_name


# ============================================================
# "Is this action mine?" — ONE rule, every personal view
# ============================================================
# Why this is not a one-liner on owner_user_id: every person-picker in the app
# asked an endpoint capped at 200 for 500 users, so the request 422'd, the
# caller swallowed it, and the User-backed source was always empty. Owners were
# therefore recorded as free-text NAME STRINGS for most of this app's life. That
# was fixed and a prod backfill covered some rows, not all — so a count that
# trusts owner_user_id alone reads LOW, and a PM believing they have less work
# than they do is worse than showing nothing.
#
# Three rungs, strongest first. The basis is returned rather than a bare bool so
# a caller can report how much of a number rests on the weakest rung; callers
# that only need membership test `is not None`.
ACTION_MINE_OWNER_ID = "owner_user_id"    # canonical: set by the typeahead picker
ACTION_MINE_OWNER_NAME = "owner_name"     # legacy free text + external owners
ACTION_MINE_CREATED_BY = "created_by"     # last resort: I raised it, nobody named


def _name_targets(actor) -> list[str]:
    """Lowercased substring candidates to test against ``ActionItem.owner`` —
    full name, first name, last name. So an owner string of just 'Roashaael'
    still matches 'Roashaael Mary John'."""
    name = (actor.name or "").strip().lower() if actor is not None else ""
    if not name:
        return []
    parts = name.split()
    out = [name]
    if parts:
        out.append(parts[0])
        if len(parts) > 1:
            out.append(parts[-1])
    return list(dict.fromkeys(out))  # dedupe, preserve strongest-first order


def _action_mine_basis(action, actor, targets: list[str]) -> Optional[str]:
    """Which rung (if any) makes this action the actor's. None = not theirs.

    Extracted so /mine and /my-work cannot drift: two copies of this rule show
    up as a dashboard and a list disagreeing about the same person's workload,
    and neither number looks wrong on its own.
    """
    if actor is None:
        return None
    if action.owner_user_id is not None and action.owner_user_id == actor.id:
        return ACTION_MINE_OWNER_ID
    owner_lower = (action.owner or "").strip().lower()
    if owner_lower and targets and any(t in owner_lower for t in targets):
        return ACTION_MINE_OWNER_NAME
    # AUTHORSHIP IS A LAST RESORT, not a third way of owning something.
    #
    # core/services.py stamps created_by_id on every action it saves out of a
    # meeting, so whoever typed the minutes is author of all of them. Treating
    # that as ownership made the note-taker "own" the entire meeting: on real
    # data a PM who owned nothing read 30 open / 30 overdue, and /my-work said
    # 27 overdue where /briefing — which has always used only the two rungs
    # above — said 2. Castillo captures every meeting, so this fired on the
    # primary user on day one.
    #
    # It still has to fire, or an action you raised for yourself and never
    # assigned would belong to nobody. So: only when the row carries no other
    # ownership signal at all. `.strip()` matters — a whitespace-only owner is
    # not somebody else's name.
    if (
        action.created_by_id is not None
        and action.created_by_id == actor.id
        and action.owner_user_id is None
        and not owner_lower
    ):
        return ACTION_MINE_CREATED_BY
    return None


@router.get("", response_model=DashboardResponse)
def get_dashboard(db: Session = Depends(get_db), _user=Depends(require_db_user)):
    actions = []
    for a in all_open_actions_across_portfolios(db):
        proj_name, client_name = _project_label(getattr(a, "originating_meeting", None) and a.originating_meeting.project)
        actions.append(DashboardActionOut(
            id=a.id, project_id=a.project_id, text=a.text, owner=a.owner,
            due_date=a.due_date, status=a.status,
            project_name=proj_name, client_name=client_name,
        ))

    notes = []
    for n in all_notes_with_follow_up(db):
        proj_name, client_name = _project_label(n.project)
        notes.append(DashboardNoteOut(
            id=n.id, project_id=n.project_id, topic=n.topic,
            action_needed=n.action_needed, follow_up_date=n.follow_up_date,
            priority=n.priority,
            project_name=proj_name, client_name=client_name,
        ))

    agendas = []
    for a in all_upcoming_agendas(db, date.today()):
        proj_name, client_name = _project_label(a.project)
        agendas.append(DashboardAgendaOut(
            id=a.id, project_id=a.project_id, upcoming_date=a.upcoming_date,
            title=a.title,
            project_name=proj_name, client_name=client_name,
        ))

    return DashboardResponse(
        open_actions=actions,
        follow_up_notes=notes,
        upcoming_agendas=agendas,
    )


# ============================================================
# Personalized: just the signed-in user's stuff
# ============================================================
@router.get("/mine", response_model=DashboardResponse)
def get_my_dashboard(
    db: Session = Depends(get_db),
    actor = Depends(require_db_user),
):
    """Subset of the dashboard filtered to things the signed-in user owns
    or created. Three buckets:
      - Open actions that are theirs by `_action_mine_basis` (owner link,
        then owner-name substring, then authorship).
      - Follow-up notes they authored.
      - Agendas they authored that are still upcoming.
    """
    targets = _name_targets(actor)

    # ---- Open actions ----
    actions = []
    for a in all_open_actions_across_portfolios(db):
        if _action_mine_basis(a, actor, targets) is None:
            continue
        proj_name, client_name = _project_label(
            getattr(a, "originating_meeting", None) and a.originating_meeting.project
        )
        actions.append(DashboardActionOut(
            id=a.id, project_id=a.project_id, text=a.text, owner=a.owner,
            due_date=a.due_date, status=a.status,
            project_name=proj_name, client_name=client_name,
        ))

    # ---- Follow-up notes I created ----
    notes = []
    for n in all_notes_with_follow_up(db):
        if n.created_by_id != actor.id:
            continue
        proj_name, client_name = _project_label(n.project)
        notes.append(DashboardNoteOut(
            id=n.id, project_id=n.project_id, topic=n.topic,
            action_needed=n.action_needed, follow_up_date=n.follow_up_date,
            priority=n.priority,
            project_name=proj_name, client_name=client_name,
        ))

    # ---- Upcoming agendas I authored ----
    agendas = []
    for a in all_upcoming_agendas(db, date.today()):
        if a.created_by_id != actor.id:
            continue
        proj_name, client_name = _project_label(a.project)
        agendas.append(DashboardAgendaOut(
            id=a.id, project_id=a.project_id, upcoming_date=a.upcoming_date,
            title=a.title,
            project_name=proj_name, client_name=client_name,
        ))

    return DashboardResponse(
        open_actions=actions,
        follow_up_notes=notes,
        upcoming_agendas=agendas,
    )


# ============================================================
# My work — the personal cross-portfolio plate
# ============================================================
# A rolling 7 days rather than "to the end of this calendar week": a
# week-ending window answers a different question every day it is read — it is
# near-empty by Thursday and jumps on Monday morning — and a number whose
# meaning depends on the day of the week is one people stop trusting. Seven
# days always answers "what lands on me next".
_DUE_WINDOW_DAYS = 7
# Two weeks of close-outs. This PMO runs on a weekly meeting cadence and PMs
# close actions in a batch at the meeting, so a 7-day window reads zero for
# anyone who looks the day before their next one.
_CLOSED_WINDOW_DAYS = 14


def _today_local() -> tuple[date, str]:
    """The calendar date the people using this app are actually living in.

    The server runs UTC in a container, so ``date.today()`` rolls over at 8pm
    Eastern — a Florida PM checking after dinner would see tomorrow's date and
    watch an action that is due today get filed as due tomorrow, or one due
    yesterday stay un-overdue for an extra evening. We anchor to the company
    timezone (config.DEFAULT_TIMEZONE, the same value /api/settings hands the
    SPA) instead.

    Consequence, stated plainly: this is ONE company-wide timezone, not a
    per-user preference. A PM working from California sees Eastern day
    boundaries, which is right for a single-office US-East company and wrong
    the day that stops being true. The chosen zone ships in the response so
    the UI can say which day the numbers mean rather than implying the
    reader's own.
    """
    from datetime import datetime, timezone

    from config import DEFAULT_TIMEZONE

    try:
        from zoneinfo import ZoneInfo

        tz = ZoneInfo(DEFAULT_TIMEZONE)
    except Exception:  # noqa: BLE001 — missing tzdata must not 500 a dashboard
        return datetime.now(timezone.utc).date(), "UTC"
    return datetime.now(timezone.utc).astimezone(tz).date(), DEFAULT_TIMEZONE


def _co_label(co) -> str:
    base = f"CO-{co.co_number}"
    title = (co.title or "").strip()
    return f"{base} — {title}" if title else base


@router.get("/my-work", response_model=MyWorkOut)
def get_my_work(
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
) -> MyWorkOut:
    """Everything on the signed-in person's plate, across every client and
    portfolio. Backs the Dashboard's all-clients state.

    Not the same page as /api/lead/overview: that one is the ORG, this one is
    the PERSON. And not portfolio-scoped — ``auth/permissions.py::
    is_portfolio_member`` is deliberately disabled, so "mine" here means action
    OWNERSHIP, never ProjectMember.

    THE DEFINITIONS, since a metric nobody can restate is a metric nobody
    trusts. All dates compare against ``_today_local()``:

      * open           — status open or pending, the app-wide meaning.
      * overdue        — open AND due_date STRICTLY before today. Due today is
                         due, not late. Matches PortfolioMetricsOut and
                         /api/lead so the same action can't be overdue on one
                         screen and not on another.
      * due_this_week  — open AND today <= due_date <= today + 6. Starts at
                         today, so it never double-counts an overdue item.
      * no_due_date    — open with no due_date at all. NOT overdue (nothing
                         says it is late) but reported, because otherwise a
                         pile of undated work is invisible on a page whose
                         whole job is to show what is on you.
      * closed_recently— status COMPLETED inside the close window. Cancelled is
                         counted separately: dropped work was not done, and
                         folding it in flatters throughput.

    Caveat worth knowing before anyone reads closed_recently as productivity:
    re-saving a meeting from Review deletes and re-inserts its action rows
    (core/services.py::update_parsed_meeting), which resets the very
    timestamps we date the close by. A bulk re-save can therefore make old
    close-outs look like this week's.

    COST: seven queries, and seven regardless of how much work the user has —
    the older dashboard routes resolve each action's label through
    ``originating_meeting.project.client``, which is three lazy loads per row.
    ActionItem carries project_id directly, so two bulk reads answer every
    label here. The two action queries are deliberately NOT narrowed to the
    user in SQL: the owner-name rung is a Python substring test, and pushing it
    down as LOWER()/LIKE would let SQL and Python disagree on some strings. The
    disagreement would show up as a count that reads LOW, which is the exact
    failure this endpoint exists to avoid.
    """
    from datetime import datetime, timedelta

    today, tz_name = _today_local()
    due_window_end = today + timedelta(days=_DUE_WINDOW_DAYS - 1)
    # A duration, not a calendar boundary, so it stays in UTC to line up with
    # the naive utcnow() timestamps the ORM writes.
    closed_cutoff = datetime.utcnow() - timedelta(days=_CLOSED_WINDOW_DAYS)
    targets = _name_targets(actor)

    # ---- Portfolio labels, resolved once (queries 1 + 2) ----
    labels: dict[int, tuple[str, Optional[str]]] = {}
    client_names = {c.id: c.name for c in db.query(Client).all()}
    for p in db.query(Project).all():
        labels[p.id] = (p.name, client_names.get(p.client_id))

    # ---- Open actions (query 3) ----
    counts = MyWorkActionCounts(
        due_window_days=_DUE_WINDOW_DAYS,
        closed_window_days=_CLOSED_WINDOW_DAYS,
    )
    open_by_project: dict[int, int] = {}
    overdue_by_project: dict[int, int] = {}
    for a in (
        db.query(ActionItem)
        .filter(ActionItem.status.in_(("open", "pending")))
        .all()
    ):
        basis = _action_mine_basis(a, actor, targets)
        if basis is None:
            continue
        counts.open += 1
        if basis == ACTION_MINE_CREATED_BY:
            counts.open_authored_only += 1
        open_by_project[a.project_id] = open_by_project.get(a.project_id, 0) + 1
        if a.due_date is None:
            counts.no_due_date += 1
        elif a.due_date < today:
            counts.overdue += 1
            overdue_by_project[a.project_id] = (
                overdue_by_project.get(a.project_id, 0) + 1
            )
        elif a.due_date <= due_window_end:
            counts.due_this_week += 1

    # ---- Recently closed (query 4) ----
    # COALESCE mirrors the burndown's rule in api/projects.py: last_status_change
    # is only stamped by the Actions PATCH route, so rows closed by any other
    # path fall back to updated_at then created_at. A row with none of the three
    # has no knowable close time and is correctly left out of "recently".
    closed_at = func.coalesce(
        ActionItem.last_status_change, ActionItem.updated_at, ActionItem.created_at,
    )
    for a in (
        db.query(ActionItem)
        .filter(ActionItem.status.in_(("completed", "cancelled")))
        .filter(closed_at >= closed_cutoff)
        .all()
    ):
        if _action_mine_basis(a, actor, targets) is None:
            continue
        if a.status == "completed":
            counts.closed_recently += 1
        else:
            counts.cancelled_recently += 1

    # ---- Where the backlog is concentrated ----
    by_portfolio = []
    for project_id, open_count in open_by_project.items():
        name, client_name = labels.get(project_id, (None, None))
        if name is None:
            continue  # action pointing at a deleted portfolio; nothing to link to
        by_portfolio.append(MyWorkPortfolioRow(
            project_id=project_id,
            project_name=name,
            client_name=client_name,
            open=open_count,
            overdue=overdue_by_project.get(project_id, 0),
        ))
    by_portfolio.sort(key=lambda r: (
        -r.overdue, -r.open, (r.client_name or "").lower(), r.project_name.lower(),
    ))

    waiting = _waiting_on_me(db, actor, labels, today)

    return MyWorkOut(
        as_of=today,
        timezone=tz_name,
        actions=counts,
        by_portfolio=by_portfolio,
        waiting_on_me=waiting,
    )


def _waiting_on_me(db: Session, actor, labels, today: date) -> MyWorkWaitingOnMe:
    """The non-action half of the queue: change orders, agendas, drafts.

    Each rule is "could this person actually act on it right now", not "is it
    unfinished somewhere" — a queue full of things you are not allowed to touch
    is a queue people learn to ignore.
    """
    block = MyWorkWaitingOnMe()

    # ---- Change orders (query 5) ----
    # Both CO rungs need the CO Approval permission — approving and marking-sent
    # are both gated on it (api/change_orders.py) — so someone without it has no
    # CO work waiting and we skip the query entirely rather than filter it away.
    if has_permission(actor, CO_APPROVAL):
        for co in (
            db.query(ChangeOrder)
            .filter(or_(
                ChangeOrder.status == "pending",
                and_(ChangeOrder.status == "approved",
                     ChangeOrder.sent_at.is_(None)),
            ))
            .order_by(ChangeOrder.created_at.desc())
            .all()
        ):
            project_name, client_name = labels.get(co.project_id, (None, None))
            amount = float(co.total_amount or 0.0)
            item = MyWorkQueueItem(
                kind="co_approval" if co.status == "pending" else "co_send",
                id=co.id,
                project_id=co.project_id,
                project_name=project_name,
                client_name=client_name,
                label=_co_label(co),
                amount=amount,
                event_date=co.request_date,
                updated_at=co.updated_at,
            )
            if co.status == "pending":
                # Separation of duties (auth/permissions.py::
                # assert_change_order_approvable): the creator of record cannot
                # approve their own CO, so it is not waiting on them — listing it
                # would send them at a button the server refuses.
                #
                # That rule has one escape hatch we deliberately do not mirror:
                # it relents when literally nobody else could approve, so a sole
                # admin in a one-person org CAN self-approve and will not see the
                # CO here. Reproducing it costs a per-CO query and only matters
                # in an org shape this one is not.
                if co.created_by_id is not None and co.created_by_id == actor.id:
                    continue
                item.detail = (
                    f"Raised by {co.requested_by}" if co.requested_by else None
                )
                block.co_approvals.append(item)
                block.co_approval_amount += amount
            else:
                # Approved and never delivered. Anyone holding CO Approval could
                # technically send it, but only the people attached to this one
                # OWE it — otherwise every approver inherits the whole company's
                # unsent pile on a page that is supposed to be personal.
                if actor.id not in (
                    co.created_by_id, co.approved_by_user_id, co.requested_by_user_id,
                ):
                    continue
                item.detail = "Approved, not yet sent to the client"
                block.co_to_send.append(item)
                block.co_to_send_amount += amount

    # ---- Agendas I authored that are still ahead of me (query 6) ----
    # "Not yet sent" is approximated by "still upcoming": Agenda has no sent_at
    # and no send route — SendAgendaDialog emails it client-side through Graph
    # and records nothing — so the server genuinely cannot know. Once an agenda's
    # meeting date has passed it is spent either way, which makes the upcoming
    # ones the honest actionable set. Label it as upcoming in the UI, not "unsent".
    for ag in (
        db.query(Agenda)
        .filter(Agenda.created_by_id == actor.id)
        .filter(Agenda.upcoming_date >= today)
        .order_by(Agenda.upcoming_date.asc())
        .all()
    ):
        project_name, client_name = labels.get(ag.project_id, (None, None))
        block.agendas.append(MyWorkQueueItem(
            kind="agenda",
            id=ag.id,
            project_id=ag.project_id,
            project_name=project_name,
            client_name=client_name,
            label=(ag.title or "").strip() or f"Agenda — {project_name or 'portfolio'}",
            detail="Upcoming, not sent from PMO 360",
            event_date=ag.upcoming_date,
            updated_at=ag.updated_at,
        ))

    # ---- Meeting drafts I authored (query 7) ----
    # NULL stage counts as draft: `stage` is a Python-side default, so any row
    # written outside the ORM's default path has no stage and is unfinished in
    # exactly the same way.
    for m in (
        db.query(Meeting)
        .filter(Meeting.created_by_id == actor.id)
        .filter(or_(Meeting.stage == "draft", Meeting.stage.is_(None)))
        .order_by(Meeting.meeting_date.desc())
        .all()
    ):
        project_name, client_name = labels.get(m.project_id, (None, None))
        block.meeting_drafts.append(MyWorkQueueItem(
            kind="meeting_draft",
            id=m.id,
            project_id=m.project_id,
            project_name=project_name,
            client_name=client_name,
            label=(m.title or "").strip() or f"Meeting — {m.meeting_date:%b %d, %Y}",
            detail="Draft — not finalized",
            event_date=m.meeting_date,
            updated_at=m.updated_at,
        ))

    block.total = (
        len(block.co_approvals) + len(block.co_to_send)
        + len(block.agendas) + len(block.meeting_drafts)
    )
    return block


# ============================================================
# AI Home briefing — "since you were last here..."
# ============================================================
def _fallback_briefing(first_name: str, facts: dict) -> str:
    """Deterministic prose used when the LLM call fails — never let the
    endpoint return a 502 just because OpenAI is having a moment."""
    if not any(facts.get(k, 0) for k in (
        "new_actions", "overdue_actions", "new_meetings_touched",
        "new_agendas_touched", "new_follow_up_notes",
    )):
        return "All clear — nothing requires your attention since you were last here."
    greet = "You're back" if not first_name else f"Welcome back, {first_name}"
    days = facts.get("days_since_last_seen")
    when = f" {days} days later" if days and days > 0 else ""
    bits = []
    if facts.get("overdue_actions", 0):
        bits.append(f"{facts['overdue_actions']} overdue action(s) need your attention")
    if facts.get("new_actions", 0):
        bits.append(f"{facts['new_actions']} new action(s) landed on your plate")
    if facts.get("new_meetings_touched", 0):
        bits.append(f"{facts['new_meetings_touched']} meeting(s) were touched")
    if facts.get("new_follow_up_notes", 0):
        bits.append(f"{facts['new_follow_up_notes']} follow-up note(s) are coming due")
    if facts.get("new_agendas_touched", 0):
        bits.append(f"{facts['new_agendas_touched']} agenda(s) saw activity")
    tail = (" Since then, " + "; ".join(bits) + ".") if bits else ""
    return f"{greet}{when}.{tail}"


@router.get("/briefing", response_model=BriefingResponse)
def get_home_briefing(
    db: Session = Depends(get_db),
    actor = Depends(require_db_user),
):
    """Personalized "since you were last here..." briefing for the Home page.

    Workflow:
      1. Read ``actor.previous_last_seen_at`` as the cutoff. The auth
         dependency already bumped ``last_seen_at`` to now() and parked the
         old value in ``previous_last_seen_at``, so we get a stable "what's
         changed since the user actually left" cutoff.
      2. Count five buckets against that cutoff: new actions assigned to me,
         overdue actions assigned to me (status-based, not time-of-creation),
         meetings touched, agendas touched, follow-up notes coming due.
      3. Hand the numeric facts to the LLM, which writes 2-3 sentences of
         prose. On LLM failure, fall back to a deterministic template so the
         endpoint never 502s.
    """
    # First-ever sign-in for this user has no previous_last_seen_at — fall
    # back to last_seen_at minus 7 days so the first card has something to
    # surface (PMs typically come back to their own backlog, not a fresh
    # account). After the second visit we'll have a real cutoff.
    cutoff = actor.previous_last_seen_at or (
        (actor.last_seen_at or datetime.utcnow()) - timedelta(days=7)
    )

    today = date.today()
    targets = _name_targets(actor)

    # ---- New actions assigned to me ----
    new_actions = 0
    if targets:
        for a in (
            db.query(ActionItem)
            .filter(ActionItem.created_at >= cutoff)
            .all()
        ):
            if a.owner_user_id == actor.id:
                new_actions += 1
                continue
            owner = (a.owner or "").lower()
            if any(t in owner for t in targets):
                new_actions += 1

    # ---- Overdue actions assigned to me (open/pending + due_date < today) ----
    overdue_actions = 0
    if targets:
        for a in (
            db.query(ActionItem)
            .filter(ActionItem.status.in_(("open", "pending")))
            .filter(ActionItem.due_date.isnot(None))
            .filter(ActionItem.due_date < today)
            .all()
        ):
            if a.owner_user_id == actor.id:
                overdue_actions += 1
                continue
            owner = (a.owner or "").lower()
            if any(t in owner for t in targets):
                overdue_actions += 1

    # ---- New meetings touched (any project) ----
    new_meetings_touched = (
        db.query(Meeting)
        .filter(or_(Meeting.created_at >= cutoff, Meeting.updated_at >= cutoff))
        .count()
    )

    # ---- New agendas touched ----
    new_agendas_touched = (
        db.query(Agenda)
        .filter(or_(Agenda.created_at >= cutoff, Agenda.updated_at >= cutoff))
        .count()
    )

    # ---- Follow-up notes coming due ("past, today, +7d" assigned to me).
    # We assume "assigned to me" = "I created it" (Note has no owner column).
    window_end = today + timedelta(days=7)
    new_follow_up_notes = (
        db.query(Note)
        .filter(Note.created_by_id == actor.id)
        .filter(Note.status == "open")
        .filter(Note.follow_up_date.isnot(None))
        .filter(Note.follow_up_date <= window_end)
        .count()
    )

    # ---- Days since last seen (for the prose) ----
    days_since = None
    if actor.previous_last_seen_at:
        days_since = (datetime.utcnow() - actor.previous_last_seen_at).days
        if days_since < 0:
            days_since = 0

    facts = {
        "new_actions": new_actions,
        "overdue_actions": overdue_actions,
        "new_meetings_touched": new_meetings_touched,
        "new_agendas_touched": new_agendas_touched,
        "new_follow_up_notes": new_follow_up_notes,
        "days_since_last_seen": days_since,
    }

    # ---- LLM prose (with fallback) ----
    first_name = ((actor.name or "").strip().split() or [""])[0]
    try:
        prose = get_provider().briefing_for_user(actor.name or "", facts)
    except Exception as exc:  # noqa: BLE001 — endpoint MUST NOT 502 on this
        logger.warning("briefing_for_user failed, using fallback: %s", exc)
        prose = _fallback_briefing(first_name, facts)

    if not prose:
        prose = _fallback_briefing(first_name, facts)

    return BriefingResponse(
        last_seen_at=actor.previous_last_seen_at,
        new_actions_assigned_to_me=new_actions,
        overdue_actions_assigned_to_me=overdue_actions,
        new_meetings_touched=new_meetings_touched,
        new_agendas_touched=new_agendas_touched,
        new_follow_up_notes=new_follow_up_notes,
        briefing=prose,
    )


# ============================================================
# Open risks rollup — Home card
# ============================================================
# Likelihood -> sort weight. Critical first, blank/unknown last.
_LIKELIHOOD_WEIGHT = {
    "critical": 0,
    "high": 1,
    "medium": 2,
    "low": 3,
}


@router.get("/risks", response_model=DashboardRisksResponse)
def get_open_risks(
    scope: str = "all",
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    """Open risks aggregated from the most-recent agenda of every portfolio
    the signed-in user can see.

    Scope semantics mirror the Mine/All toggle on Home:
      - ``scope="mine"`` AND non-admin → only portfolios the user is a
        member of.
      - ``scope="all"`` OR admin → every portfolio.

    Risks come from ``Agenda.risks_json`` — a JSON list of
    ``{description, impact, likelihood, mitigation, owner}`` objects.
    There's no dedicated Risk table because PMs treat risks as agenda
    line items, not first-class entities. This rollup walks the latest
    agenda per portfolio and flattens the JSON; it's O(portfolios), so
    fast enough even at 100+ portfolios.

    Sorted by likelihood (Critical → Low → blank), then by client/portfolio
    name so risks for the same project cluster together.
    """
    # ---- Scope ----
    if actor.is_admin or scope == "all":
        project_ids: set[int] | None = None  # no filter
    else:
        project_ids = set(list_my_project_ids(db, actor.id))
        if not project_ids:
            return DashboardRisksResponse(risks=[])

    # ---- Pick the most-recent agenda per project ----
    # We use `upcoming_date DESC, updated_at DESC` as the "most recent"
    # ordering — matches the per-portfolio dashboard's behaviour.
    q = db.query(Agenda).order_by(Agenda.upcoming_date.desc(), Agenda.updated_at.desc())
    if project_ids is not None:
        q = q.filter(Agenda.project_id.in_(project_ids))
    latest_per_project: dict[int, Agenda] = {}
    for ag in q.all():
        if ag.project_id in latest_per_project:
            continue
        latest_per_project[ag.project_id] = ag

    # Project lookup for client name + display
    if latest_per_project:
        projects = {
            p.id: p
            for p in db.query(Project)
            .filter(Project.id.in_(latest_per_project.keys()))
            .all()
        }
    else:
        projects = {}

    # ---- Flatten ----
    rows: list[DashboardRiskOut] = []
    for project_id, agenda in latest_per_project.items():
        project = projects.get(project_id)
        if project is None:
            continue
        client_name = project.client.name if project.client else None
        risks = agenda.risks_json or []
        if not isinstance(risks, list):
            continue
        for r in risks:
            if not isinstance(r, dict):
                continue
            description = (r.get("description") or "").strip()
            # Drop blank rows — the inline editor leaves an empty trailing
            # row when PMs delete entries.
            if not description:
                continue
            rows.append(DashboardRiskOut(
                project_id=project_id,
                project_name=project.name,
                client_name=client_name,
                agenda_id=agenda.id,
                upcoming_date=agenda.upcoming_date,
                description=description,
                impact=(r.get("impact") or "").strip() or None,
                likelihood=(r.get("likelihood") or "").strip() or None,
                mitigation=(r.get("mitigation") or "").strip() or None,
                owner=(r.get("owner") or "").strip() or None,
            ))

    # ---- Sort ----
    rows.sort(key=lambda r: (
        _LIKELIHOOD_WEIGHT.get((r.likelihood or "").lower(), 99),
        (r.client_name or "").lower(),
        r.project_name.lower(),
    ))

    return DashboardRisksResponse(risks=rows)
