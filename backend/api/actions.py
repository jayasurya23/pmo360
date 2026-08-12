"""/api/actions — rolling action items per project."""
import csv
import io
import re
from collections import Counter, defaultdict
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from api.client_contacts import CASTILLO_ORG
from core.deps import get_db
from auth import require_db_user
from auth.permissions import MEETING_MINUTES, require_permission
from db.models import (
    ActionItem, Client, ClientContact, GlobalAttendee, Meeting, PortfolioProject,
    Project, ProjectAttendee,
)
from db.repository import (
    all_actions, open_actions, update_action_status,
    all_open_actions_across_portfolios, all_actions_across_portfolios,
    all_actions_for_client, open_actions_for_client,
)
from core.services import safe_filename_slug
from schemas.common import (
    ActionItemOut, ActionItemUpdate, ActionItemCreate,
    ActionOwnerGroupOut, ActionOwnerOut, ActionOwnersOut, split_display_name,
)


router = APIRouter(prefix="/api/actions", tags=["actions"])


def _resolve_sub_project(
    db: Session, portfolio_id: int, sub_project_id: "int | None",
) -> "PortfolioProject | None":
    """Check a sub-project is real AND belongs to THIS portfolio.

    THE SECOND HALF IS THE POINT, and the database cannot enforce it. The FK
    only says portfolio_projects.id exists; that a sub-project sits under the
    same portfolio as the action is a two-hop rule, so it lives here. Without
    it an action rolls up under one portfolio while naming a sub-project of
    another — quietly corrupting exactly the rollups the feature exists to
    produce, and doing it in a way that looks fine on every screen.

    None is a legitimate value, not a missing one: it means "the portfolio as a
    whole", which is what every action meant before sub-projects existed and
    what most will always mean.
    """
    if sub_project_id is None:
        return None
    sub = db.get(PortfolioProject, sub_project_id)
    if sub is None:
        raise HTTPException(404, "That project no longer exists.")
    if sub.portfolio_id != portfolio_id:
        # Named, because "invalid project" sends a PM hunting through a picker
        # that looks correct from where they are standing.
        raise HTTPException(
            400,
            f"“{sub.name}” belongs to a different portfolio, so this action "
            "cannot be filed against it. Move the action first, or pick a "
            "project from its own portfolio.",
        )
    return sub


def _one_with_context(db: Session, action: ActionItem) -> ActionItemOut:
    """Enrich a SINGLE action for a create/patch response.

    Deliberately not `_with_context(db, [action])[0]`: that loads every project,
    client, meeting date and sub-project in the database to decorate one row,
    which is fine for a list built once and wasteful on a write path hit on
    every edit. Targeted lookups instead.

    It matters that writes return the enriched shape at all — without the
    sub-project NAME the UI has to refetch to display the tag it just set, and
    a caller that trusts the response renders an untagged row.
    """
    o = ActionItemOut.model_validate(action)
    proj = db.get(Project, action.project_id)
    if proj is not None:
        o.project_name = proj.name
        client = db.get(Client, proj.client_id) if proj.client_id else None
        o.client_name = client.name if client else None
    if action.portfolio_project_id is not None:
        sub = db.get(PortfolioProject, action.portfolio_project_id)
        o.portfolio_project_name = sub.name if sub else None
    meeting = db.get(Meeting, action.originating_meeting_id)
    o.originating_meeting_date = meeting.meeting_date if meeting else None
    return o


def _with_context(db: Session, rows: list[ActionItem]) -> list[ActionItemOut]:
    """Attach each action's portfolio name, client name, and originating-meeting
    date so the cross-portfolio Actions view can render them. Uses one query per
    lookup table (projects / clients / meeting dates) — no per-row N+1."""
    projects = {p.id: p for p in db.query(Project).all()}
    clients = {c.id: c.name for c in db.query(Client).all()}
    meeting_dates = dict(db.query(Meeting.id, Meeting.meeting_date).all())
    # One more lookup table, same no-N+1 rule as the three above. Named rather
    # than left as a bare id so a row can render its tag without the caller
    # fetching the sub-projects of every portfolio on screen.
    sub_projects = dict(db.query(PortfolioProject.id, PortfolioProject.name).all())
    out: list[ActionItemOut] = []
    for r in rows:
        o = ActionItemOut.model_validate(r)
        proj = projects.get(r.project_id)
        if proj is not None:
            o.project_name = proj.name
            o.client_name = clients.get(proj.client_id)
        if r.portfolio_project_id is not None:
            o.portfolio_project_name = sub_projects.get(r.portfolio_project_id)
        o.originating_meeting_date = meeting_dates.get(r.originating_meeting_id)
        out.append(o)
    return out


@router.get("", response_model=list[ActionItemOut])
def list_actions(
    project_id: int | None = Query(None),
    client_id: int | None = Query(None),
    only_open: bool = Query(False),
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
):
    """List actions at one of three widths:

        project_id  -> that portfolio only
        client_id   -> every portfolio under that client
        neither     -> every action in the company

    An action hangs off a portfolio (`project_id`) and nothing finer, so those
    three are genuinely all the widths there are — there is no sub-project tier
    below this for actions.

    PRECEDENCE, when BOTH ids arrive: project_id wins, and we do not 400. Both
    ids come from the header's client + portfolio pickers, so a bookmarked or
    shared Actions URL routinely carries both; falling back to the NARROWER of
    the two shows the reader less than they asked for and never more, which is
    the only safe direction for a stale link to be wrong in.

    An unknown client_id returns an empty list, NOT a 404. A client with no
    portfolios and a client that no longer exists look identical from here, and
    neither is an error condition for a list.

    Scope is a FILTER, not a permission. This read is company-wide for any
    signed-in user (require_db_user, no per-portfolio gate) and client_id
    neither widens nor narrows that.
    """
    if project_id is not None:
        rows = open_actions(db, project_id) if only_open else all_actions(db, project_id)
    elif client_id is not None:
        rows = (
            open_actions_for_client(db, client_id)
            if only_open
            else all_actions_for_client(db, client_id)
        )
    else:
        rows = (
            all_open_actions_across_portfolios(db)
            if only_open
            else all_actions_across_portfolios(db)
        )
    return _with_context(db, rows)


@router.post("", response_model=ActionItemOut, status_code=201)
def create_action(
    payload: ActionItemCreate,
    db: Session = Depends(get_db),
    actor = Depends(require_db_user),
    guard=Depends(require_permission(MEETING_MINUTES)),
):
    # payload.project_id is the row's own portfolio — where this action will
    # live and who will see it — so it is the right thing to authorise against.
    guard.require_project(payload.project_id)
    _resolve_sub_project(db, payload.project_id, payload.portfolio_project_id)
    action = ActionItem(
        project_id=payload.project_id,
        portfolio_project_id=payload.portfolio_project_id,
        originating_meeting_id=payload.originating_meeting_id,
        text=payload.text,
        owner=payload.owner or None,
        owner_user_id=payload.owner_user_id,
        due_date=payload.due_date,
        status=payload.status or "open",
        created_by_id=actor.id,
        updated_by_id=actor.id,
    )
    db.add(action)
    db.flush()
    return _one_with_context(db, action)


@router.patch("/{action_id}", response_model=ActionItemOut)
def patch_action(
    action_id: int,
    payload: ActionItemUpdate,
    db: Session = Depends(get_db),
    actor = Depends(require_db_user),
    guard=Depends(require_permission(MEETING_MINUTES)),
):
    action = db.get(ActionItem, action_id)
    if not action:
        raise HTTPException(404, "Action not found")
    guard.require_project(action.project_id)
    # `model_fields_set` lets us distinguish "field not in the request"
    # (leave alone) from "field explicitly set to null" (clear it). That
    # distinction matters for owner_user_id — re-assigning an action from
    # a PMO PM to an external vendor needs to NULL out the user link.
    sent = payload.model_fields_set
    if "text" in sent and payload.text is not None:
        action.text = payload.text
    if "portfolio_project_id" in sent:
        # Validated against the action's CURRENT portfolio. Sending null here
        # is the supported way to put an action back on the portfolio as a
        # whole, which is why this reads model_fields_set rather than treating
        # None as "not supplied".
        _resolve_sub_project(db, action.project_id, payload.portfolio_project_id)
        action.portfolio_project_id = payload.portfolio_project_id
    if "owner" in sent:
        action.owner = payload.owner
    if "owner_user_id" in sent:
        action.owner_user_id = payload.owner_user_id
    if "due_date" in sent:
        action.due_date = payload.due_date
    if "status" in sent and payload.status is not None:
        if payload.status in ("completed", "cancelled") and payload.closing_meeting_id:
            update_action_status(db, action_id, payload.status, payload.closing_meeting_id)
        else:
            action.status = payload.status
        action.last_status_change = datetime.utcnow()
    action.updated_by_id = actor.id
    db.flush()
    return _one_with_context(db, action)


@router.delete("/{action_id}", status_code=204)
def delete_action(
    action_id: int,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
    guard=Depends(require_permission(MEETING_MINUTES)),
):
    a = db.get(ActionItem, action_id)
    if not a:
        raise HTTPException(404, "Action not found")
    guard.require_project(a.project_id)
    db.delete(a)
    return None


# ============================================================
# CSV export
# ============================================================
# `status` accepts the same status strings the page filter uses ("open",
# "pending", "completed", "cancelled") OR the synthetic "open+pending"
# shortcut the Actions page defaults to. Unrecognized values fall through
# to "all actions" rather than 400-ing — the user opening the URL by hand
# shouldn't be punished for typos.
_STATUS_FILTERS: dict[str, set[str]] = {
    "open": {"open"},
    "pending": {"pending"},
    "completed": {"completed"},
    "cancelled": {"cancelled"},
    # Two spellings of the "show me what's still on my plate" shortcut —
    # the frontend uses `open_pending` (underscore) but we accept both.
    "open+pending": {"open", "pending"},
    "open_pending": {"open", "pending"},
}


@router.get("/export.csv")
def export_actions_csv(
    project_id: int | None = Query(None),
    client_id: int | None = Query(None),
    status: str = Query("all"),
    owner: str = Query("", description="Exact match against the comma-split owner parts, case-folded"),
    owner_user_id: int | None = Query(
        None,
        description="Match the canonical owner LINK. Wins over `owner` when both arrive.",
    ),
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
):
    """Stream a CSV of action items, at the SAME three widths as ``GET
    /api/actions`` and with the same project_id-wins precedence — see that
    docstring for why both ids may legitimately arrive together.

    The export must take scope, and must take the same scope the list does. A
    CSV that quietly ignored it would hand a PM reviewing one portfolio either
    a different portfolio or every client in the company, and a plausible-looking
    file with the wrong rows in it is worse than no file: nothing downstream
    would flag it.

    For the same reason the filename NAMES the scope — "Utopian_Power_All_
    Portfolios_Actions_2026-08-11.csv" vs "Snapdragon_Actions_2026-08-11.csv" —
    so a download sitting in someone's Downloads folder a week later still says
    what it covers. Portfolio + Client columns are appended per row for the same
    reason at row level.

    Filters mirror what the Actions page renders so the export matches the
    table the PM is looking at when they click Export. Existing columns keep
    their position so PMs' pivot tables / Power BI / Excel formulas don't break.

    OWNER FILTERING TAKES TWO KEYS because the page has two. `owner` matches the
    free-text string; `owner_user_id` matches the canonical User link, which is
    what the page's "Mine" filter uses. They are NOT interchangeable: a row can
    read "D. Wraga" and be linked to Dylan, and another can read "Dylan Wraga"
    with no link at all (a stale owner never re-linked — the reason the
    owner_user_id backfill exists). Exporting by name from a screen filtered by
    link silently swaps one set of rows for another, with matching row counts
    and nothing in the file to flag it, so `owner_user_id` wins outright when
    supplied rather than being ANDed with a name that may not agree.
    """
    if project_id is not None:
        project = db.get(Project, project_id)
        if not project:
            raise HTTPException(404, "Project not found")
        rows = all_actions(db, project_id)
        scope_slug = safe_filename_slug(project.name or "project")
    elif client_id is not None:
        rows = all_actions_for_client(db, client_id)
        client = db.get(Client, client_id)
        # Deliberately NOT a 404 the way an unknown project_id is, matching
        # `list_actions`: an unknown client is an empty scope, so the download
        # still succeeds and arrives as a header row with nothing under it —
        # visibly empty beats a failed download the browser reports as a
        # network error.
        #
        # An unknown id names ITSELF rather than falling back to a bare
        # "Client_All_Portfolios": the whole point of putting the scope in the
        # filename is that the download still says what it covers a week later,
        # and a placeholder that reads like a real client name defeats that on
        # exactly the file that came back empty.
        scope_slug = (
            f"{safe_filename_slug(client.name or 'Client')}_All_Portfolios"
            if client
            else f"Unknown_Client_{client_id}_All_Portfolios"
        )
    else:
        rows = all_actions_across_portfolios(db)
        scope_slug = "All_Portfolios"

    # Portfolio + client name lookup for the trailing columns (one query each).
    projects = {p.id: p for p in db.query(Project).all()}
    clients = {c.id: c.name for c in db.query(Client).all()}

    # Status filter
    allowed = _STATUS_FILTERS.get(status.lower())
    if allowed is not None:
        rows = [r for r in rows if (r.status or "open").lower() in allowed]

    # Owner filter. The canonical link first — see the docstring for why it is
    # not ANDed with the name.
    if owner_user_id is not None:
        rows = [r for r in rows if r.owner_user_id == owner_user_id]
    # EXACT match against the comma-split parts, via the same two helpers the
    # owner directory uses, so the dropdown's count, the table and this export
    # cannot drift apart. It was a substring match against the whole owner
    # string, which meant the CSV quietly contained more rows than the table the
    # PM exported it from: "CK" also matched "Nick".
    elif owner.strip():
        needle = _owner_key(owner)
        rows = [
            r for r in rows
            if needle in {_owner_key(t) for t in _owner_tokens(r.owner)}
        ]

    # Build the CSV in-memory. We use csv.writer rather than concatenating
    # strings so commas / quotes / newlines inside owner names + action text
    # get escaped properly (RFC 4180).
    buf = io.StringIO()
    # Excel doesn't autodetect UTF-8 without a BOM; prepend one so non-ASCII
    # names (Roashaael, em-dashes from the LLM) render correctly when the
    # user double-clicks the CSV.
    buf.write("﻿")
    writer = csv.writer(buf)
    writer.writerow([
        "#", "Action", "Owner", "Due Date", "Status",
        "Raised in meeting", "Closed in meeting",
        "Created at", "Updated at",
        "Created by", "Updated by",
        # appended so existing column positions stay stable
        "Portfolio", "Client",
    ])
    for i, a in enumerate(rows, start=1):
        proj = projects.get(a.project_id)
        writer.writerow([
            i,
            (a.text or "").strip(),
            (a.owner or "").strip(),
            a.due_date.isoformat() if a.due_date else "",
            (a.status or "open").capitalize(),
            (
                a.originating_meeting.meeting_date.isoformat()
                if a.originating_meeting and a.originating_meeting.meeting_date
                else ""
            ),
            (
                a.closed_in_meeting.meeting_date.isoformat()
                if a.closed_in_meeting and a.closed_in_meeting.meeting_date
                else ""
            ),
            a.created_at.isoformat(timespec="minutes") if a.created_at else "",
            a.updated_at.isoformat(timespec="minutes") if a.updated_at else "",
            (a.created_by.name if a.created_by else "") or "",
            (a.updated_by.name if a.updated_by else "") or "",
            (proj.name if proj else "") or "",
            (clients.get(proj.client_id) if proj else "") or "",
        ])

    data = buf.getvalue().encode("utf-8")
    date_str = datetime.utcnow().strftime("%Y-%m-%d")
    filename = f"{scope_slug}_Actions_{date_str}.csv"
    return StreamingResponse(
        iter([data]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ============================================================
# Owner directory — backs the grouped owner filter
# ============================================================
# The header the unmatched worklist renders under. Named for what it asks the
# user to DO, because that section's whole reason to exist is that adding those
# people to the directory fixes them permanently.
UNMATCHED_LABEL = "Not matched to a company"

# TWO FOLDINGS, DOING TWO DIFFERENT JOBS. Keeping them apart is what lets this
# endpoint be both grouped and honest, so neither may be quietly aligned with
# the other.
_PUNCTUATION = re.compile(r"[.'’]")
_INITIALS = re.compile(r"[a-z]{1,4}")


def _owner_key(name: str) -> str:
    """The IDENTITY of one dropdown row. Folds case, and nothing else.

    That is byte-for-byte the key the Actions page already dedupes its own
    option list on, so this endpoint returns the same set of options it would
    have built for itself — only grouped, coloured and sorted.

    Anything more aggressive would be a silent merge. The page filters actions
    by the option's `name`, so collapsing "Dana  Reyes" (two spaces) into "Dana
    Reyes" would hide every row spelled the other way behind a filter claiming
    to include them, while `action_count` insisted they were there. Two
    identical-looking rows in the dropdown is the visible version of that same
    typo, and visible is the whole point of this feature.
    """
    return name.strip().casefold()


def _match_key(name: str) -> str:
    """The key used to ask the directory "which company is this?".

    Folds harder than `_owner_key` — punctuation and repeated whitespace go, so
    "D. Reyes" finds a roster row typed "D Reyes". Safe to be generous here
    because this key never decides which actions are counted or what the filter
    matches; it only picks a header. It still will not bridge "D. Reyes" and
    "Dana Reyes", which are different strings by any measure available to us.
    """
    return " ".join(_PUNCTUATION.sub("", name).split()).casefold()


def _company_key(name: str | None) -> str:
    """Fold an employer name for comparison. `organization` is free text a human
    typed, so case and stray spacing are noise — but nothing else is: "Heelstone"
    and "Heelstone Energy" stay two companies, because we cannot tell a shortened
    name from a different subsidiary."""
    return " ".join((name or "").split()).casefold()


def _initials_shape(match_key: str) -> bool:
    """Short enough and letters-only to be somebody's initials. Applied to the
    roster's `initials` column, which is initials whatever case it was typed
    in."""
    return bool(_INITIALS.fullmatch(match_key))


def _owner_is_initials(token: str) -> bool:
    """Whether an OWNER string should be allowed to match on initials at all.

    Shape is not enough on its own: "Mike", "Dana" and "Ana" are all
    initials-shaped, and a first-name-only owner that happens to collide with
    someone's initials would be filed under a company with real confidence and
    no way to notice. So the token must also be written in capitals, which is
    how initials actually appear in this data ("CK, KC") and how a given name
    does not.

    A sloppily typed "Ck" therefore stays unmatched. That is the intended
    direction: it lands in the worklist where somebody can fix it, rather than
    quietly under a header that might be wrong.
    """
    return token.isupper() and _initials_shape(_match_key(token))


def _preferred(spellings: Counter) -> str:
    """The spelling to show when the same thing was typed several ways: the
    commonest, ties broken alphabetically. Deterministic on purpose — a label
    that changes between two loads of the same data is the instability this
    endpoint exists to remove."""
    return min(spellings.items(), key=lambda kv: (-kv[1], kv[0]))[0]


def _owner_tokens(raw: str | None) -> list[str]:
    """The people one action's owner string names, deduped, first spelling wins.

    Splitting on commas is the app's existing reading — "CK, KC" is two owners —
    and the Actions page splits the same way. The cost is that a surname-first
    entry, "Reyes, Dana", becomes two owners called "Reyes" and "Dana", and
    nothing in the string distinguishes the two shapes. Detecting it (treating
    the pair as one person when the directory happens to hold "Dana Reyes")
    would produce an option the page could never match, because the page splits
    on commas too. So the split stays literal: surname-first is a data-entry fix,
    not a parser feature.
    """
    seen: dict[str, str] = {}
    for part in (raw or "").split(","):
        token = part.strip()
        if token:
            seen.setdefault(_owner_key(token), token)
    return list(seen.values())


def _name_keys(full_name: str | None) -> set[str]:
    """Every spelling of a directory person an owner string might have used —
    the stored form, plus its given-name-first reordering, so a roster row filed
    as "Reyes, Dana" is still found by an action that says "Dana Reyes".

    Widening what the DIRECTORY answers to is safe in a way that widening
    `_owner_key` is not: it can only turn an unmatched owner into a matched one,
    never merge two owners, and a name that reaches two employers is caught by
    the conflict rule below.
    """
    raw = (full_name or "").strip()
    if not raw:
        return set()
    keys = {_match_key(raw)}
    first, last = split_display_name(raw)
    if first and last:
        keys.add(_match_key(f"{first} {last}"))
    return {k for k in keys if k}


@router.get("/owners", response_model=ActionOwnersOut)
def list_action_owners(
    project_id: int | None = Query(None),
    client_id: int | None = Query(None),
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
):
    """Every distinct owner named on an action, grouped by employer.

    Open to any signed-in user, like every other GET here. Costs FIVE queries
    regardless of how much data there is — the actions, the two attendee tables,
    the client contacts and the client names — because the page a PM lives in
    loads this on every visit. There is no per-owner lookup.

    HOW A COMPANY IS DECIDED, strongest evidence first. Each rung is asked in
    turn and the first one that answers wins:

      1. ``owner_user_id`` — a User row is a Castillo Entra account, so this is
         the one signal that cannot be wrong. Read only from actions naming a
         SINGLE owner: on "CK, KC" the link belongs to one of them and the row
         cannot say which, so it proves nothing about either.
      2. GlobalAttendee / ProjectAttendee ``organization``, matched on name.
      3. ClientContact, matched on name, resolving to its Client.
      4. Attendee ``initials`` — last, because "CK" is the highest-collision
         key in this data, and only for an owner written in capitals so a
         four-letter given name cannot collide with somebody's initials. See
         `_owner_is_initials`.

    Two employers for one name STOPS the ladder at unmatched rather than
    falling through to a weaker rung: the contradiction is a fault in the
    directory, and a confident answer built on top of a known contradiction is
    the failure this endpoint is supposed to avoid. The rosters are global, not
    scoped to ``project_id`` — a person works for the same company in every
    portfolio, and scoping would let the same owner be matched on one page and
    unmatched on another.

    WHERE IT WILL BE WRONG, and it is worth knowing before trusting a header:

      * "Reyes, Dana" is read as two owners (see `_owner_tokens`).
      * "D. Reyes" and "Dana Reyes" are two owners; the initials-ish one is
        probably unmatched. Nicknames ("Dan" / "Daniel") likewise.
      * A "CK" two people share resolves to nothing, on purpose. So does a
        lower-cased "ck", which is not read as initials at all.
      * A person whose roster row carries a blank ``organization`` — pervasive
        in this data — is unmatched. Blank is absence of evidence, not conflict.

    All of those land in the unmatched worklist, which is the honest place for
    them and the one place a user can permanently fix them.

    ``project_id`` / ``client_id`` scope which ACTIONS are considered, and MUST
    be passed the same scope the table is rendering — same three widths and the
    same project_id-wins precedence as ``GET /api/actions``. A mismatch is not
    cosmetic: the dropdown would offer people the table holds no rows for, each
    carrying an `action_count` the list beside it contradicts, and picking one
    would empty the table for no visible reason. An id matching nothing yields
    no owners rather than a 404, exactly as the list endpoint behaves.
    """
    # QUERY 1 of 5. Two columns, not whole ORM objects — nothing else about an
    # action matters to this answer. The client join adds no query: it narrows
    # this one.
    query = db.query(ActionItem.owner, ActionItem.owner_user_id)
    if project_id is not None:
        query = query.filter(ActionItem.project_id == project_id)
    elif client_id is not None:
        query = query.join(Project, ActionItem.project_id == Project.id).filter(
            Project.client_id == client_id
        )

    owners: dict[str, dict] = {}
    for owner_text, owner_user_id in query.all():
        tokens = _owner_tokens(owner_text)
        for token in tokens:
            entry = owners.setdefault(
                _owner_key(token),
                {"spellings": Counter(), "count": 0, "user_ids": set()},
            )
            entry["spellings"][token] += 1
            entry["count"] += 1
            if owner_user_id is not None and len(tokens) == 1:
                entry["user_ids"].add(owner_user_id)

    if not owners:
        # Nobody owns anything in scope; the four directory queries would only
        # be answering a question no one asked.
        return ActionOwnersOut()

    # ---- One pass to build the lookup, then no more queries ----
    company_spellings: dict[str, Counter] = defaultdict(Counter)
    by_name: dict[str, set[str]] = defaultdict(set)
    by_initials: dict[str, set[str]] = defaultdict(set)
    by_contact: dict[str, set[str]] = defaultdict(set)

    def _record_attendee(full_name, initials, organization) -> None:
        company = _company_key(organization)
        if not company:
            return          # blank org is no evidence — not conflicting evidence
        company_spellings[company][(organization or "").strip()] += 1
        for key in _name_keys(full_name):
            by_name[key].add(company)
        initials_key = _match_key(initials or "")
        if _initials_shape(initials_key):
            by_initials[initials_key].add(company)

    for row in db.query(                                            # QUERY 2
        GlobalAttendee.full_name, GlobalAttendee.initials,
        GlobalAttendee.organization,
    ).all():
        _record_attendee(*row)
    for row in db.query(                                            # QUERY 3
        ProjectAttendee.full_name, ProjectAttendee.initials,
        ProjectAttendee.organization,
    ).all():
        _record_attendee(*row)

    client_names = dict(db.query(Client.id, Client.name).all())     # QUERY 4
    # `contact_client_id`, NOT `client_id`: that name is this endpoint's scope
    # PARAMETER. Rebinding it here happens to be harmless only because the
    # scoped query above has already been executed — a landmine for whoever next
    # needs the scope further down, who would silently get the last contact's
    # employer instead.
    for first, last, contact_client_id in db.query(                 # QUERY 5
        ClientContact.first_name, ClientContact.last_name,
        ClientContact.client_id,
    ).all():
        # An unplaced contact (client_id NULL) is exactly the person this
        # endpoint cannot name an employer for — the directory has not been
        # told yet either.
        company = _company_key(client_names.get(contact_client_id))
        if not company:
            continue
        company_spellings[company][client_names[contact_client_id].strip()] += 1
        for key in _name_keys(" ".join(p for p in (first, last) if p)):
            by_contact[key].add(company)

    castillo = _company_key(CASTILLO_ORG)

    def _company_of(match_key: str, *, allow_initials: bool) -> str | None:
        for index in (by_name, by_contact):
            hits = index.get(match_key)
            if not hits:
                continue
            # Two employers for one name is a fault in the DIRECTORY, and the
            # directory is where it gets fixed. Picking one would file somebody
            # under a header our own roster contradicts — and it would look
            # settled, so nobody would ever go and fix it. Falling through to a
            # weaker rung would be worse still: a confident answer built on top
            # of a known contradiction.
            return next(iter(hits)) if len(hits) == 1 else None
        if allow_initials:
            # Last, and only last. Initials are the highest-collision key in
            # this data, so a "CK" two people share resolves to nothing rather
            # than to whichever row the query happened to return first.
            hits = by_initials.get(match_key)
            if hits and len(hits) == 1:
                return next(iter(hits))
        return None

    # ---- Resolve, then sort inside each group ----
    grouped: dict[str | None, list[tuple[tuple, ActionOwnerOut]]] = defaultdict(list)
    for entry in owners.values():
        display = _preferred(entry["spellings"])
        user_ids = entry["user_ids"]
        company = castillo if user_ids else _company_of(
            _match_key(display), allow_initials=_owner_is_initials(display),
        )
        first_name, last_name = split_display_name(display)
        # First name, then surname, then the whole name. The last component is a
        # total order on its own — owner keys are unique and case-folded — so
        # the sequence cannot depend on dict or query order. A name with no
        # discernible given name falls back to the whole string, which is what
        # happens to a bare "CK": it sorts under C, alongside the Charlies.
        sort_key = (
            (first_name or display).casefold(),
            (last_name or "").casefold(),
            display.casefold(),
        )
        grouped[company].append((sort_key, ActionOwnerOut(
            name=display,
            owner_user_id=next(iter(user_ids)) if len(user_ids) == 1 else None,
            first_name=first_name,
            action_count=entry["count"],
        )))

    def _sorted(company: str | None) -> list[ActionOwnerOut]:
        return [owner for _, owner in sorted(grouped[company], key=lambda p: p[0])]

    def _label(company: str) -> str:
        # Castillo is pinned to the canonical literal rather than the roster's
        # commonest spelling: this group is the brand, and a lower-cased
        # "castillo engineering" typed into someone's roster row should not
        # become the header the whole company reads.
        if company == castillo:
            return CASTILLO_ORG
        spellings = company_spellings.get(company)
        return _preferred(spellings) if spellings else company

    labels = {c: _label(c) for c in grouped if c is not None}
    # ALPHABETICAL between Castillo and the unmatched worklist, not by size. A
    # filter dropdown is a lookup device — you open it already knowing which
    # company you want — and a count-ordered list reshuffles itself every time
    # work moves between clients, which is exactly the "order shifts between
    # loads" problem the grouping is meant to fix.
    middle = sorted(
        (c for c in grouped if c is not None and c != castillo),
        key=lambda c: (labels[c].casefold(), labels[c]),
    )

    groups: list[ActionOwnerGroupOut] = []
    if castillo in grouped:
        groups.append(ActionOwnerGroupOut(
            company=CASTILLO_ORG, is_castillo=True, owners=_sorted(castillo),
        ))
    groups.extend(
        ActionOwnerGroupOut(company=labels[c], owners=_sorted(c)) for c in middle
    )
    if None in grouped:
        groups.append(ActionOwnerGroupOut(
            company=UNMATCHED_LABEL, is_unmatched=True, owners=_sorted(None),
        ))
    return ActionOwnersOut(groups=groups)
