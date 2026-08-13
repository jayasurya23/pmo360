"""/api/change-orders — internal Change Order Request module.

Workflow: draft -> pending (submit) -> approved (downloadable branded PDF).
Scoped to a portfolio (project_id). Line items are fixed (cost) or hourly
(rate*hours); `total_amount` is recomputed on save. Internal notes are stored
but never rendered on the client-facing PDF.

`pmo_pct` / `admin_pct` are internal cost adders struck against the whole CO,
additively (100 + 5% + 5% = 110). They are invisible to the client: the PDF
marks them into the line amounts rather than printing a row, so `total_amount`
here means the marked-up figure the client actually pays.

Two separate permissions govern the two halves of that workflow, because a
change order is money leaving the client's pocket: `co_creation` raises and
edits one, `co_approval` decides on it. Splitting the columns only means
something if the app also refuses to let one person do both, so the approve
path additionally calls `assert_change_order_approvable` — the creator cannot
approve their own. Reject and mark-sent deliberately skip that rule: pulling
back your own request, or recording a delivery a second person already
approved, never lets you self-authorise the money.

A submitted CO can also NAME the people it wants approval from
(`co_approval_requests`, one row per person asked). Those rows are the
append-only history — the four approval columns on `change_orders` are mutable
and /reject NULLs all of them — and each carries a snapshot of the version and
the price that person was shown, which is what stops a CO being re-priced out
from under an approver between the email and the click. Naming approvers adds
no state to the change order: only ONE of them has to answer, and the status
machine stays draft | pending | approved | sent_back.
"""
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from core.deps import get_db
from auth import require_db_user
from auth.permissions import (
    CO_APPROVAL, CO_CREATION, assert_change_order_approvable, require_permission,
)
from co_pricing import distribute_markup, markup_breakdown
from core.services import safe_filename_slug
from storage.backend import get_storage
from db.models import (
    ChangeOrder, ChangeOrderApprovalRequest, ChangeOrderLineItem, PortfolioProject,
    Project, User,
)
from docgen.change_order_pdf import build_change_order_pdf
from schemas.common import (
    ChangeOrderOut, ChangeOrderIn, ChangeOrderUpdate, ChangeOrderLineItemIn,
    ChangeOrderMarkSent, ChangeOrderPricing, ChangeOrderApprove,
    ChangeOrderReject, ApprovalRequestOut, ApprovalRequestListOut,
    RequestApprovalIn, RequestApprovalOut,
)


router = APIRouter(prefix="/api/change-orders", tags=["change-orders"])

_VALID_STATUS = ("draft", "pending", "approved", "sent_back")
_VALID_RATE = ("fixed", "hourly")

# Approval-request outcomes. NOT change order statuses — asking three people to
# approve one CO is still a single approval step, and the CO's own machine stays
# exactly draft | pending | approved | sent_back.
_REQ_PENDING = "pending"
_REQ_APPROVED = "approved"
_REQ_REJECTED = "rejected"
_REQ_SUPERSEDED = "superseded"   # somebody else answered first
_REQ_CANCELLED = "cancelled"     # the PM withdrew the ask


def _num(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _line_total(li: ChangeOrderLineItem, rate_type: str) -> float:
    if rate_type == "hourly":
        allocs = li.allocations or []
        if allocs:   # multiple people at different rates -> sum(rate*hours)
            return sum(_num(a.get("rate")) * _num(a.get("hours")) for a in allocs)
        return _num(li.hourly_rate) * _num(li.hours)   # legacy single-person
    return _num(li.cost)


def _recompute_total(co: ChangeOrder) -> None:
    """Store WHAT THE CLIENT PAYS — the line items plus both adders.

    Keeping the markup in `total_amount` is what lets the Proposals
    revised-contract-value rollup and the Dashboard CO card stay correct without
    either of them learning about the adders. The pre-markup figure is always
    recoverable as the sum of the line items.

    Deliberately the SUM OF THE MARKED-UP LINES rather than a separately
    marked-up subtotal. The two can land a cent apart when a line's float
    carries repr noise and the markup falls on a half-cent tie, and when they
    disagree the figure the client signed for has to be the one on record."""
    lines = [_line_total(li, co.rate_type) for li in co.line_items]
    co.total_amount = round(
        sum(distribute_markup(lines, _num(co.pmo_pct), _num(co.admin_pct))), 2
    )


def _apply_line_items(co: ChangeOrder, items: "list[ChangeOrderLineItemIn]") -> None:
    """Replace all line items (the editor sends the full list each save)."""
    co.line_items.clear()
    for i, it in enumerate(items):
        allocs = None
        if it.allocations:
            allocs = [
                {"role": a.role, "rate": a.rate, "hours": a.hours}
                for a in it.allocations
                if (a.role or a.rate is not None or a.hours is not None)
            ] or None
        co.line_items.append(ChangeOrderLineItem(
            order_index=i, details=it.details or "",
            cost=it.cost, allocations=allocs,
            role=it.role, hourly_rate=it.hourly_rate, hours=it.hours,
            internal_notes=it.internal_notes,
        ))


def _out(co: ChangeOrder, db: Session) -> ChangeOrderOut:
    o = ChangeOrderOut.model_validate(co)
    proj = db.get(Project, co.project_id)
    # Prefer the editable snapshot; fall back to the portfolio name (legacy rows).
    o.project_name = co.project_name or (proj.name if proj else None)
    # The sub-project tag is separate from `project_name` above and must stay
    # that way: `project_name` is the label that PRINTS on the client's PDF,
    # this is internal filing. Resolved here so the list can badge and filter
    # without fetching every portfolio's sub-projects. Null when untagged and
    # when the sub-project has since been deleted — no badge for either, which
    # is the truth.
    if co.portfolio_project_id is not None:
        sub = db.get(PortfolioProject, co.portfolio_project_id)
        o.portfolio_project_name = sub.name if sub else None
    # The internal-only breakdown behind `total_amount`. Derived here rather than
    # stored so it can never drift from the line items it describes, and computed
    # by co_pricing so the dollars shown in the app are the same dollars the PDF
    # spreads across the lines.
    o.pricing = ChangeOrderPricing(**markup_breakdown(
        sum(_line_total(li, co.rate_type) for li in co.line_items),
        _num(co.pmo_pct), _num(co.admin_pct),
    ))
    return o


def _resolve_sub_project(
    db: Session, portfolio_id: int, sub_project_id: "int | None",
) -> None:
    """Check a sub-project is real AND belongs to THIS portfolio.

    The second half is the point and the database cannot enforce it: the FK
    only says the row exists, not that it sits under the same portfolio as the
    change order. Without this check a CO rolls up under one portfolio while
    naming a sub-project of another — corrupting exactly the rollups the tag
    exists to produce, and looking correct on every screen while it does.

    This one RAISES rather than silently dropping the tag, unlike the
    meeting-minutes path. A change order is a single deliberate form a PM is
    filling in, not a whole set of minutes that must never be lost over
    metadata — here, telling them is better than quietly filing it elsewhere.
    """
    if sub_project_id is None:
        return
    sub = db.get(PortfolioProject, sub_project_id)
    if sub is None:
        raise HTTPException(404, "That project no longer exists.")
    if sub.portfolio_id != portfolio_id:
        raise HTTPException(
            400,
            f"“{sub.name}” belongs to a different portfolio, so this change "
            "order cannot be filed against it. Pick a project from this "
            "portfolio.",
        )


def _get(db: Session, co_id: int) -> ChangeOrder:
    co = db.get(ChangeOrder, co_id)
    if not co:
        raise HTTPException(404, "Change order not found")
    return co


def _request_out(req: ChangeOrderApprovalRequest, co: ChangeOrder) -> ApprovalRequestOut:
    o = ApprovalRequestOut.model_validate(req)
    # Resolved at read time rather than snapshotted: the id is the history, the
    # name is only how it renders, and somebody changing their display name must
    # not be able to rewrite who asked for what.
    requester = req.requested_by_user
    o.requested_by_name = (
        (requester.name or requester.email) if requester else None
    )
    # WHO ACTUALLY ANSWERED, resolved from the server-stamped id. This is the
    # only identity on the row the caller did not supply: `requested_name` is
    # free text on a free-text ask, so a panel that renders it beside an
    # "Approved" pill is captioning an outcome with a name nobody verified.
    # Answered rows render this instead — see ApprovalRequestsPanel::RequestRow.
    responder = req.responded_by_user
    o.responded_by_name = (
        (responder.name or responder.email) if responder else None
    )
    o.stale = req.co_version_at_request != (co.version or 1)
    return o


def _pending_requests(db: Session, co_id: int) -> "list[ChangeOrderApprovalRequest]":
    """Every still-outstanding ask on this CO, oldest first."""
    return (
        db.query(ChangeOrderApprovalRequest)
        .filter(ChangeOrderApprovalRequest.change_order_id == co_id)
        .filter(ChangeOrderApprovalRequest.status == _REQ_PENDING)
        .order_by(ChangeOrderApprovalRequest.id.asc())
        .all()
    )


def _is_actors_request(req: ChangeOrderApprovalRequest, actor) -> bool:
    """Is this row the ask that was addressed to the caller?

    Two ways to match, and both are needed. The id is the strong one, but it is
    NULL whenever the person was picked out of the Entra directory before they
    had ever signed in — `users` rows are upserted on first authenticated
    request, which for an invited approver happens when they click the link,
    i.e. after the ask. Falling back to the address is what makes that first
    click land on their own request instead of on nobody's.
    """
    if actor is None:
        return False
    if req.requested_user_id is not None and req.requested_user_id == actor.id:
        return True
    email = (getattr(actor, "email", "") or "").strip().lower()
    return bool(email) and (req.requested_email or "").strip().lower() == email


def _latest_unanswered_request(
    db: Session, co_id: int, actor,
) -> "ChangeOrderApprovalRequest | None":
    """The last thing this person was ASKED about and never answered.

    Reads pending AND cancelled rows, not just pending, and that is deliberate.
    Withdrawing a request is gated on CO_CREATION — the CO's own author — so a
    guard that only looked at pending rows could be switched off by the one
    party it defends the approver against, with a single DELETE that notifies
    nobody: ask at $80k, re-price to $180k, withdraw the ask, and the approver's
    next click sails through on the strength of an email quoting the old number.
    A withdrawn ask is still the last figure that person was shown, so it still
    answers the only question `approve_change_order`'s guard (b) asks.

    Rows the person actually ANSWERED are excluded (approved / rejected), as are
    superseded ones: those belong to a closed round. Otherwise a CO that was
    sent back, edited and re-submitted would refuse its previous approver
    forever, with nothing they could do about it themselves.

    Newest first, and matched with `_is_actors_request` so the id/address
    fallback behaves identically here and in the close-out.
    """
    if actor is None:
        return None
    rows = (
        db.query(ChangeOrderApprovalRequest)
        .filter(ChangeOrderApprovalRequest.change_order_id == co_id)
        .filter(ChangeOrderApprovalRequest.status.in_(
            (_REQ_PENDING, _REQ_CANCELLED),
        ))
        .order_by(
            ChangeOrderApprovalRequest.requested_at.desc(),
            ChangeOrderApprovalRequest.id.desc(),
        )
        .all()
    )
    for req in rows:
        if _is_actors_request(req, actor):
            return req
    return None


def _close_out_requests(
    db: Session, co: ChangeOrder, actor, *, outcome: str, note: "str | None",
) -> None:
    """FIRST RESPONDER DECIDES: record the answer, retire the rest.

    A change order needs ONE of the people who were asked, so the moment anybody
    answers, every other outstanding ask stops being outstanding. They go to
    'superseded' rather than being deleted because "we asked four people and Ana
    got there first" is a different fact from "we asked Ana", and the second one
    is not true.

    Superseded rows get a `responded_at` (that is when they stopped being open)
    but never a `responded_by_user_id` — those people did not respond.

    A DECISION FROM SOMEBODY NOBODY ASKED still gets a row. Holding CO_APPROVAL
    is enough to approve or send back a change order without ever being named on
    it, and until this wrote a row those decisions lived only in the four
    columns on `change_orders` that the next /reject NULLs. That is the exact
    hole this table exists to close, and it does not stop being a hole because
    the decision arrived unasked: an approval on Tuesday and a send-back on
    Wednesday has to still say, on Thursday, who approved it and at what price.
    """
    now = datetime.utcnow()
    answered = False
    for req in _pending_requests(db, co.id):
        if _is_actors_request(req, actor):
            answered = True
            req.status = outcome
            req.response_note = note
            req.responded_by_user_id = actor.id if actor else None
        else:
            req.status = _REQ_SUPERSEDED
        req.responded_at = now
    if answered or actor is None:
        return
    # Recorded as its own ask-and-answer in one row: nobody requested it, so
    # `requested_by_id` stays NULL and the requestee IS the responder. Both
    # snapshots are taken AFTER `_bump`, so they describe the document as
    # decided rather than as it was a moment earlier.
    db.add(ChangeOrderApprovalRequest(
        change_order_id=co.id,
        requested_user_id=actor.id,
        requested_name=actor.name or actor.email,
        # NOT NULL. A user row with no address is possible in principle (the
        # column is nullable), and "" is the honest value — `_is_actors_request`
        # requires a non-empty address before it will match on one, so an empty
        # one can never be mistaken for somebody else's ask.
        requested_email=(actor.email or "").strip(),
        requested_at=now,
        co_version_at_request=co.version or 1,
        total_at_request=co.total_amount,
        status=outcome,
        responded_at=now,
        responded_by_user_id=actor.id,
        response_note=note,
    ))


def _co_pdf_filename(co: ChangeOrder) -> str:
    return safe_filename_slug(
        f"{co.client_name or 'Castillo'}-CO-{co.co_number}-{co.co_version or 'V1'}"
    ) + ".pdf"


def _archive_pdf(co: ChangeOrder) -> None:
    """Best-effort: build the branded PDF and file it under the project's
    storage folder (SharePoint in prod, local FS in dev). Records the returned
    path on the CO. Never raises — archiving must not block approval."""
    try:
        proj = co.project
        client = proj.client if proj else None
        folder = "/".join(filter(None, [
            safe_filename_slug(client.name) if client and client.name else None,
            safe_filename_slug(proj.name) if proj and proj.name else "project",
            "change-orders",
        ]))
        path = get_storage().save(f"{folder}/{_co_pdf_filename(co)}", build_change_order_pdf(co))
        co.pdf_storage_path = path
    except Exception:
        pass


@router.get("", response_model=list[ChangeOrderOut])
def list_change_orders(
    project_id: "int | None" = Query(None),
    client_id: "int | None" = Query(None),
    status: "str | None" = Query(None),
    sent: "bool | None" = Query(None),
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
):
    """List change orders. Scoped to one portfolio (project_id) for the module's
    per-portfolio tabs; with project_id omitted it aggregates across portfolios
    (optionally narrowed to a client) for the "all clients" view + Home rollup.

    `sent` splits the approved pile into delivered vs still-to-send; omitted, it
    leaves the result set untouched."""
    q = db.query(ChangeOrder)
    if project_id is not None:
        q = q.filter(ChangeOrder.project_id == project_id)
    if client_id is not None:
        q = q.join(Project, ChangeOrder.project_id == Project.id).filter(
            Project.client_id == client_id
        )
    if status in _VALID_STATUS:
        q = q.filter(ChangeOrder.status == status)
    if sent is not None:
        # sent_at, not sent_method: NULL-method rows are still genuinely sent.
        q = q.filter(ChangeOrder.sent_at.isnot(None) if sent
                     else ChangeOrder.sent_at.is_(None))
    if project_id is not None:
        # Per-portfolio: keep CO-number ordering (newest CO first).
        q = q.order_by(ChangeOrder.co_number.desc())
    else:
        # Aggregate: newest first so the cross-portfolio list reads chronologically.
        q = q.order_by(ChangeOrder.created_at.desc(), ChangeOrder.id.desc())
    return [_out(co, db) for co in q.all()]


@router.get("/{co_id}", response_model=ChangeOrderOut)
def get_change_order(
    co_id: int,
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
):
    return _out(_get(db, co_id), db)


@router.post("", response_model=ChangeOrderOut, status_code=201)
def create_change_order(
    payload: ChangeOrderIn,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
    guard=Depends(require_permission(CO_CREATION)),
):
    project = db.get(Project, payload.project_id)
    if not project:
        raise HTTPException(404, "Portfolio not found")
    guard.require_project(project.id)
    _resolve_sub_project(db, payload.project_id, payload.portfolio_project_id)
    next_n = (db.query(func.max(ChangeOrder.co_number))
              .filter(ChangeOrder.project_id == payload.project_id)
              .scalar() or 0) + 1
    co = ChangeOrder(
        project_id=payload.project_id,
        portfolio_project_id=payload.portfolio_project_id,
        co_number=next_n,
        co_version=payload.co_version or "V1",
        title=payload.title,
        rate_type=payload.rate_type if payload.rate_type in _VALID_RATE else "fixed",
        status="draft",
        request_date=payload.request_date,
        requested_by=payload.requested_by,
        requested_by_user_id=payload.requested_by_user_id,
        client_name=(project.client.name if project.client else None),
        # Editable Project label: use the supplied value, else snapshot the
        # portfolio name so existing behaviour is unchanged when left as-is.
        project_name=(payload.project_name or (project.name if project else None)),
        location=payload.location,
        state=payload.state,
        size_mw=payload.size_mw,
        signatory_name=payload.signatory_name,
        signatory_title=payload.signatory_title,
        signatory_phone=payload.signatory_phone,
        signatory_email=payload.signatory_email,
        client_signatory_name=payload.client_signatory_name,
        client_signatory_title=payload.client_signatory_title,
        client_signatory_email=payload.client_signatory_email,
        client_signatory_phone=payload.client_signatory_phone,
        # Set per change order, never defaulted from the portfolio or company.
        pmo_pct=_num(payload.pmo_pct),
        admin_pct=_num(payload.admin_pct),
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


class ChangeOrderSendCheck(BaseModel):
    """The pre-flight answer. Router-local rather than in schemas/common.py
    because it is the shape of one question this router asks about itself, and
    nothing else consumes it."""
    ok: bool
    already_sent_at: Optional[datetime] = None
    already_sent_to: Optional[str] = None
    already_sent_method: Optional[str] = None


def _bump(co: ChangeOrder) -> None:
    """Move the optimistic-lock version on a lifecycle transition.

    Only the PATCH used to touch `version`, so submit / approve / reject /
    mark-sent all left it where it was — and an editor that loaded the CO
    before any of them still held a version the server considered current.
    Reproduced: a PM opens Edit on the Pending tab, someone else approves and
    emails the CO, the PM saves, and the save is accepted with a 200. The stale
    form wins and the number on the client's copy is no longer the number on
    record.
    """
    co.version = (co.version or 1) + 1


def _assert_editable(co: ChangeOrder) -> None:
    """An approved or delivered change order is a document, not a draft.

    Nothing stopped a PATCH re-pricing a CO after it had been approved and
    emailed: the approval stamp, the send date and the archived PDF all stayed
    put while `total_amount` moved underneath them. The adders make that
    completely silent — the markup is folded into the line costs, so a
    re-priced CO still ties out perfectly and there is no arithmetic tell.
    There is no audit log either, so the only record of what the client was
    actually sent is the archived file.

    Revising a delivered CO is a new change order, which is what `co_version`
    is for.
    """
    if co.sent_at is not None:
        # Built from the parts rather than strftime("%-d"): the no-pad flag is
        # glibc-only and raises on Windows, which would turn this guard into a
        # crash on a developer machine.
        sent_on = f"{co.sent_at:%b} {co.sent_at.day}, {co.sent_at:%Y}"
        raise HTTPException(
            409,
            f"CO-{co.co_number} was already sent to the client on {sent_on} and "
            "can no longer be edited. Raise a new version instead, so the "
            "client's copy and this record cannot disagree.",
        )
    if co.status == "approved":
        raise HTTPException(
            409,
            f"CO-{co.co_number} has been approved and can no longer be edited. "
            "Send it back to the requester first if it needs changing — that "
            "clears the approval so everyone re-approves the new numbers.",
        )


@router.post("/{co_id}/send-check", response_model=ChangeOrderSendCheck)
def check_change_order_sendable(
    co_id: int,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
    guard=Depends(require_permission(CO_APPROVAL)),
):
    """Answer "may I send this, and has it gone already?" BEFORE Graph is touched.

    The send itself is client-side — the PM's own delegated Mail.Send, straight
    from the browser — so the server never sees it and cannot stop it. It can
    only refuse to authorise one, which is worth nothing unless somebody asks
    first. That is what this is for.

    It exists because of the ordering bug it replaces: the dialog fetched the
    PDF, called Graph, and only then called mark-sent, which is gated on
    CO_APPROVAL. A PM holding only CO_CREATION therefore delivered the change
    order to the client, got a permission error that read as "the send failed",
    and left `sent_at` NULL — so the CO stayed in the to-send queue and the next
    person sent it again. The client got the same priced change order twice.

    POST rather than GET on purpose: it is an authorisation question, and every
    GET in this app is deliberately ungated.
    """
    co = _get(db, co_id)
    guard.require_project(co.project_id)
    if co.status != "approved":
        raise HTTPException(
            409,
            f"CO-{co.co_number} has not been approved yet, so it must not go to "
            "the client. Get it approved first.",
        )
    return ChangeOrderSendCheck(
        ok=True,
        already_sent_at=co.sent_at,
        already_sent_to=co.sent_to,
        already_sent_method=co.sent_method,
    )


@router.post("/preview")
def preview_change_order_pdf(
    payload: ChangeOrderIn,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
    guard=Depends(require_permission(CO_CREATION)),
):
    """Render the CO as the client will receive it, from the UNSAVED form.

    Every other Preview button on this page goes through GET /{co_id}/pdf/file,
    which needs a row. The Create tab has no id until the first save, and
    saving a draft just to look at something would drop a half-finished change
    order into the In-flight rail every time someone wanted to sanity-check a
    total — so this renders from the payload and persists nothing.

    Declared above the /{co_id} POSTs so the literal path wins the match.

    Same permission as create: this composes a Castillo-branded, client-facing
    document out of caller-supplied text, which is the create flow whether or
    not a row comes out the other end.
    """
    project = db.get(Project, payload.project_id)
    if not project:
        raise HTTPException(404, "Portfolio not found")
    guard.require_project(project.id)

    # What the number WOULD be, so the preview matches the document that gets
    # issued. Read-only — nothing reserves it, so two people previewing at once
    # see the same number and neither has taken it.
    next_n = (db.query(func.max(ChangeOrder.co_number))
              .filter(ChangeOrder.project_id == payload.project_id)
              .scalar() or 0) + 1

    # Deliberately never added to the session. The line items hang off a
    # transient parent, so nothing here is reachable by cascade and no flush
    # anywhere in the request can turn a preview into a row. no_autoflush is
    # belt and braces for the two queries above.
    with db.no_autoflush:
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
            project_name=(payload.project_name or project.name),
            location=payload.location,
            state=payload.state,
            size_mw=payload.size_mw,
            signatory_name=payload.signatory_name,
            signatory_title=payload.signatory_title,
            signatory_phone=payload.signatory_phone,
            signatory_email=payload.signatory_email,
            client_signatory_name=payload.client_signatory_name,
            client_signatory_title=payload.client_signatory_title,
            client_signatory_email=payload.client_signatory_email,
            client_signatory_phone=payload.client_signatory_phone,
            pmo_pct=_num(payload.pmo_pct),
            admin_pct=_num(payload.admin_pct),
            notes=payload.notes,
        )
        _apply_line_items(co, payload.line_items)
        _recompute_total(co)
        pdf = build_change_order_pdf(co)

    # The bytes are identical to the issued document — that is the point of a
    # preview — so the FILENAME is what stops someone downloading this from the
    # viewer and emailing it straight to a client, leaving a change order that
    # was never approved and never recorded as sent.
    slug = safe_filename_slug(
        f"{co.client_name or 'Castillo'}-CO-{co.co_number}-{co.co_version}-PREVIEW"
    )
    return Response(
        content=pdf, media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{slug}.pdf"'},
    )


@router.patch("/{co_id}", response_model=ChangeOrderOut)
def update_change_order(
    co_id: int,
    payload: ChangeOrderUpdate,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
    guard=Depends(require_permission(CO_CREATION)),
):
    co = _get(db, co_id)
    _assert_editable(co)
    # Scope from the CO itself, never from the payload — the row's own portfolio
    # is where this write actually lands.
    guard.require_project(co.project_id)
    if payload.expected_version is not None and co.version != payload.expected_version:
        raise HTTPException(409, detail={
            "error": "stale_version",
            "message": "This change order was saved by someone else. Reload first.",
            "current_version": co.version,
        })
    sent = payload.model_fields_set
    for field in ("co_version", "project_name", "title", "rate_type",
                  "request_date", "requested_by", "requested_by_user_id",
                  "location", "state", "size_mw", "signatory_name",
                  "signatory_title", "signatory_phone", "signatory_email",
                  "client_signatory_name", "client_signatory_title",
                  "client_signatory_email", "client_signatory_phone",
                  "pmo_pct", "admin_pct", "notes"):
        if field in sent:
            setattr(co, field, getattr(payload, field))
    if "portfolio_project_id" in sent:
        # Validated against the CO's OWN portfolio, not the payload's — a PATCH
        # never re-homes a change order, so the portfolio here is fixed and the
        # sub-project has to belong to it. Read via model_fields_set so an
        # explicit null clears the tag while omitting the field leaves it alone.
        _resolve_sub_project(db, co.project_id, payload.portfolio_project_id)
        co.portfolio_project_id = payload.portfolio_project_id
    # The adders are NOT NULL, and a percentage field cleared on the form arrives
    # as an explicit null rather than 0 — coerce so the save can't 500.
    co.pmo_pct = _num(co.pmo_pct)
    co.admin_pct = _num(co.admin_pct)
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
def submit_change_order(
    co_id: int,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
    guard=Depends(require_permission(CO_CREATION)),
):
    co = _get(db, co_id)
    guard.require_project(co.project_id)
    if co.status not in ("draft", "sent_back"):
        raise HTTPException(
            409,
            f"CO-{co.co_number} is already {co.status} — only a draft or a "
            "sent-back change order can be submitted for approval.",
        )
    co.status = "pending"
    if actor:
        co.updated_by_id = actor.id
    _bump(co)
    db.flush()
    return _out(co, db)


@router.post("/{co_id}/request-approval", response_model=RequestApprovalOut)
def request_change_order_approval(
    co_id: int,
    payload: RequestApprovalIn,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
    guard=Depends(require_permission(CO_CREATION)),
):
    """Ask one or more named people to approve this CO.

    AUTHORING-side permission, deliberately. Choosing who reviews your request
    is part of raising it, not part of deciding on it — CO_APPROVAL would mean
    a PM could submit a change order and then not be allowed to ask anybody to
    look at it.

    Only ONE of the people asked has to answer (see `_close_out_requests`), so
    this adds no new state to the CO: its status machine stays draft | pending |
    approved | sent_back, and these rows sit beside it as the record of who was
    asked. There is no token and no public route anywhere in this flow — the
    approver signs in with Entra like everybody else and the deep link is just a
    path.

    NO `_bump(co)` HERE, and that is not an oversight. This writes nothing to
    the change order, and bumping would invalidate the very snapshot the line
    above it just took: `co_version_at_request` would trail `co.version` from
    the instant the ask was made, and guard (b) in approve would then reject
    every approver who ever clicked the link.
    """
    co = _get(db, co_id)
    guard.require_project(co.project_id)
    if co.status != "pending":
        raise HTTPException(
            409,
            f"CO-{co.co_number} is {co.status}, not awaiting approval. Submit it "
            "first — asking somebody to approve a change order that is still "
            "being written points them at a document that will have moved by "
            "the time they open it.",
        )

    # Normalise before anything else, so a payload carrying the modal's empty
    # trailing row is an empty request rather than a row with no address on it —
    # an unaddressable ask is invisible to everyone including the person it was
    # supposedly for.
    recipients: "list[tuple[str, str | None, int | None]]" = []
    seen: "set[str]" = set()
    for r in payload.recipients:
        email = (r.email or "").strip()
        name = (r.name or "").strip() or None
        user_id = r.user_id
        if user_id is not None:
            # THE ACCOUNT IS THE IDENTITY, not the label posted alongside it.
            # These rows are the approval history and the panel renders the name
            # on them, so free text carrying somebody else's user id — "Gary
            # Castillo (VP)" against an address that is not Gary's — would put a
            # name that never approved anything next to an Approved pill, and
            # drop the ask into that person's /my-work queue as well. The picker
            # only ever sends the id it read off the account, so taking both
            # fields FROM the account costs one get() and makes the mismatch
            # unrepresentable rather than merely unlikely.
            u = db.get(User, user_id)
            if u is None:
                raise HTTPException(
                    400,
                    "One of the people you picked no longer has an account. "
                    "Reload the page and pick them again.",
                )
            if not (u.email or "").strip():
                raise HTTPException(
                    400,
                    f"{u.name or 'That person'} has no email address on file. "
                    "An approval request is delivered by email, so pick "
                    "somebody with an address or type one in.",
                )
            if email and email.lower() != u.email.strip().lower():
                raise HTTPException(
                    400,
                    f"{email} does not match the account it was picked from "
                    f"({u.email}). Reload the page and pick them again.",
                )
            email = u.email.strip()
            name = u.name or email
        if not email:
            continue
        # One ask per person per call: the same address twice in one payload is
        # one request, not two, and deduping here keeps the loop below free to
        # treat every remaining entry as a genuinely distinct person.
        key = email.lower()
        if key in seen:
            continue
        seen.add(key)
        recipients.append((email, name, user_id))
    if not recipients:
        raise HTTPException(
            400,
            "Pick at least one person to request approval from.",
        )

    # Existing OUTSTANDING asks, keyed on the lowercased address — the same key
    # the approve-time match uses. Re-asking somebody already pending must not
    # leave two open rows for one person: both would have to be closed out on
    # their single answer, and the panel would show them asked twice for one ask.
    outstanding = {
        (req.requested_email or "").strip().lower(): req
        for req in _pending_requests(db, co.id)
    }
    # `payload.note` is the covering message for the email the SPA composes from
    # this response. It is deliberately not persisted — there is no column for
    # it, and the mail leaves from the PM's own mailbox, so their Sent items are
    # the copy of record.
    now = datetime.utcnow()
    fresh: "list[ChangeOrderApprovalRequest]" = []
    for email, name, user_id in recipients:
        prior = outstanding.get(email.lower())
        if prior is not None:
            # A RE-ASK CLOSES THE OLD ROW AND FILES A NEW ONE. It does NOT edit
            # the old one in place, and the difference is the whole point of the
            # table.
            #
            # Re-dating the existing snapshot was the previous behaviour, and it
            # meant one call — from anyone holding CO_CREATION, sending nothing
            # to anybody, since the mail is a separate client-side step — both
            # cleared guard (b) in `approve_change_order` AND overwrote the only
            # evidence of what the approver had originally been asked to
            # approve. Ask at $80k, re-price to $180k, "record without
            # emailing", and the approver's $80k email now approves $180k with
            # nothing anywhere recording the $80k ask. It also contradicted this
            # table's own contract (models.py: "They only ever change status").
            #
            # Superseding and inserting keeps everything the re-ask was for —
            # exactly one pending row per person, and an approver who has been
            # re-asked at the current figure can act again — while the original
            # ask survives at its original price, which is what makes the
            # history worth having.
            prior.status = _REQ_SUPERSEDED
            prior.responded_at = now
        req = ChangeOrderApprovalRequest(
            change_order_id=co.id,
            # Carry a resolved identity forward: a re-ask typed as free text
            # must not blank the account a directory pick already bound.
            requested_user_id=(
                user_id if user_id is not None
                else (prior.requested_user_id if prior else None)
            ),
            requested_name=name or (prior.requested_name if prior else None),
            requested_email=email,
            requested_by_id=actor.id if actor else None,
            requested_at=now,
            # THE SNAPSHOT. A pending CO is still PATCH-editable, so these two
            # are what "the version and the price this person was shown" means
            # once the CO has moved on.
            co_version_at_request=co.version or 1,
            total_at_request=co.total_amount,
            status=_REQ_PENDING,
        )
        db.add(req)
        fresh.append(req)
    db.flush()
    return RequestApprovalOut(
        requests=[_request_out(r, co) for r in fresh],
        approval_path=f"/change-orders/{co.id}",
    )


@router.get("/{co_id}/approval-requests", response_model=ApprovalRequestListOut)
def list_change_order_approval_requests(
    co_id: int,
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
):
    """The full ask-and-answer history for one CO, newest first.

    Ungated beyond authentication, like every other CO read: this is the record
    of who was asked and what they said, and hiding it from the people working
    the change order is how two of them end up asking the same person twice.
    """
    co = _get(db, co_id)
    rows = (
        db.query(ChangeOrderApprovalRequest)
        .filter(ChangeOrderApprovalRequest.change_order_id == co.id)
        .order_by(
            ChangeOrderApprovalRequest.requested_at.desc(),
            ChangeOrderApprovalRequest.id.desc(),
        )
        .all()
    )
    return ApprovalRequestListOut(requests=[_request_out(r, co) for r in rows])


@router.delete("/{co_id}/approval-requests/{req_id}", status_code=204)
def cancel_change_order_approval_request(
    co_id: int,
    req_id: int,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
    guard=Depends(require_permission(CO_CREATION)),
):
    """Withdraw an outstanding ask — "actually, don't bother reviewing this".

    Same authoring-side permission as making the ask. Closed out by status
    rather than deleted, for the same reason nothing else in this table is
    deleted: an ask that was made and withdrawn happened, and the row is the
    only thing that can say so.

    Withdrawing does NOT clear the staleness guard on approve, and must not:
    this route is gated on CO_CREATION, i.e. exactly the person that guard
    defends the approver against. A cancelled row still records the figure they
    were shown, and `_latest_unanswered_request` still reads it.

    No `_bump(co)`: the change order itself is untouched, and bumping would
    strand every other approver's snapshot (see request-approval).
    """
    co = _get(db, co_id)
    guard.require_project(co.project_id)
    req = db.get(ChangeOrderApprovalRequest, req_id)
    if req is None or req.change_order_id != co.id:
        raise HTTPException(404, "Approval request not found")
    if req.status != _REQ_PENDING:
        raise HTTPException(
            409,
            f"That approval request is already {req.status} and cannot be "
            "withdrawn — it is part of the record of what happened.",
        )
    req.status = _REQ_CANCELLED
    req.responded_at = datetime.utcnow()
    # WHO withdrew it. Any CO_CREATION holder may withdraw anybody's ask —
    # that is the contracted gate — so "this request was pulled" is only half a
    # record without the name attached to it, and it is the half somebody will
    # want when an approver says nobody told them. The person named here did
    # not ANSWER the request; the status is what says what happened to it.
    if actor:
        req.responded_by_user_id = actor.id
    return None


@router.post("/{co_id}/approve", response_model=ChangeOrderOut)
def approve_change_order(
    co_id: int,
    payload: Optional[ChangeOrderApprove] = None,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
    guard=Depends(require_permission(CO_APPROVAL)),
):
    co = _get(db, co_id)
    guard.require_project(co.project_id)
    if co.status != "pending":
        raise HTTPException(
            409,
            f"CO-{co.co_number} is {co.status}, not awaiting approval. Only a "
            "change order that has been submitted can be approved — otherwise a "
            "second approval would re-stamp one the client already has.",
        )
    # ---- Staleness, checked twice, on purpose ----
    # (a) THE CLIENT'S CLAIM. Same field, shape and meaning as the PATCH's
    # optimistic lock, so an editor and an approver disagree with the server in
    # exactly the same way. The whole body is optional, so an SPA tab loaded
    # before this shipped simply does not make the claim.
    if (
        payload is not None
        and payload.expected_version is not None
        and co.version != payload.expected_version
    ):
        raise HTTPException(409, detail={
            "error": "stale_version",
            "message": "This change order was saved by someone else. Reload first.",
            "current_version": co.version,
        })
    # (b) THE SERVER'S OWN CHECK, independent of anything the client sends, and
    # the reason this endpoint was touched at all.
    #
    # A PENDING change order is still fully PATCH-editable — `_assert_editable`
    # only fires once it is approved or delivered — so the document can be
    # re-priced between the moment somebody is asked to approve it and the
    # moment they click the link in that email. Concretely: the approver is
    # emailed CO-7 at $80k, the PM edits the lines to $180k while it sits in the
    # approver's inbox, the approver opens the link, sees whatever is on screen,
    # and clicks Approve. The stamp lands on $180k, the archived PDF is built
    # from $180k, and nothing anywhere records that the person who authorised it
    # was asked about a different number. The adders make it silent: the markup
    # is folded into the line costs, so a re-priced CO still ties out perfectly.
    #
    # Guard (a) cannot cover this — it only fires if the client volunteers a
    # version, and an approver arriving fresh on a deep link has no prior
    # version to volunteer. So this one asks the DATABASE what that person was
    # actually shown, and refuses when the answer moved.
    #
    # Reads the caller's last UNANSWERED ask, pending or withdrawn, rather than
    # only their pending one: withdrawing is a CO_CREATION route, so a guard
    # that ignored cancelled rows could be switched off by the CO's own author
    # with a single DELETE. See `_latest_unanswered_request`.
    asked = _latest_unanswered_request(db, co.id, actor)
    if asked is not None and asked.co_version_at_request != (co.version or 1):
        raise HTTPException(409, detail={
            "error": "stale_co",
            "current_version": co.version,
            "requested_version": asked.co_version_at_request,
            "detail": (
                "This change order was edited after you were asked to "
                "approve it. Re-review before approving."
            ),
        })
    # Separation of duties, on top of the permission: whoever raised this CO is
    # not allowed to be the one who approves it. `created_by_id` is the creator
    # of record — `updated_by_id` moves with every save (including this one) and
    # `requested_by_user_id` is a free-text-ish attribution of who ASKED for the
    # work, which is often the client-facing PM rather than the author.
    assert_change_order_approvable(
        db,
        project_id=co.project_id,
        creator_user_id=co.created_by_id,
        actor=actor,
    )
    co.status = "approved"
    co.approved_by = (actor.name or actor.email) if actor else None
    co.approved_by_user_id = actor.id if actor else None
    co.approved_at = datetime.utcnow()
    if actor:
        co.updated_by_id = actor.id
    _bump(co)
    # The durable half of the record. The four columns above are mutable and
    # /reject NULLs every one of them; this row is what still says, afterwards,
    # that this person was asked and said yes at this price.
    _close_out_requests(
        db, co, actor,
        outcome=_REQ_APPROVED,
        note=((payload.note or "").strip() or None) if payload else None,
    )
    # DELIBERATELY NOT SENT HERE. The order is approve -> send-check -> Graph ->
    # mark-sent, and it stays that way: an auto-send on approval is how a real
    # client received the same priced change order twice.
    db.flush()
    _archive_pdf(co)   # file the final PDF to storage (best-effort)
    db.flush()
    return _out(co, db)


@router.post("/{co_id}/mark-sent", response_model=ChangeOrderOut)
def mark_change_order_sent(
    co_id: int,
    payload: ChangeOrderMarkSent,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
    guard=Depends(require_permission(CO_APPROVAL)),
):
    """Record that the approved CO PDF was emailed to the client. The send itself
    happens client-side — Microsoft Graph from the PM's mailbox, or handed off to
    the desktop Outlook client — so `method` is how the Sent tab tells them apart."""
    co = _get(db, co_id)
    guard.require_project(co.project_id)
    if co.status != "approved":
        # The record must not be able to claim a delivery the approval flow never
        # sanctioned. The send is client-side and cannot be stopped from here, so
        # /send-check is what a caller is supposed to clear FIRST; this is the
        # backstop for anyone who skips it.
        raise HTTPException(
            409,
            f"CO-{co.co_number} is {co.status}, not approved, so it cannot be "
            "recorded as sent to the client.",
        )
    recipients = (payload.recipients or "").strip() or None
    if co.sent_at is None:
        # First delivery is the one the archive is for: on a re-send we keep the
        # original date, recipients and method rather than overwriting the record
        # of when the client actually received it. There is no send-history table,
        # so a re-send that re-stamped would destroy the only copy of that fact.
        co.sent_at = datetime.utcnow()
        co.sent_to = recipients
        # Left NULL when the caller omits it, so an older client can't silently
        # mislabel a send as Graph.
        if payload.method:
            co.sent_method = payload.method
    elif recipients and recipients not in (co.sent_to or ""):
        # A re-send to someone new is worth recording — append rather than
        # replace, so the original recipient list survives.
        co.sent_to = f"{co.sent_to}, {recipients}" if co.sent_to else recipients
    if actor:
        co.updated_by_id = actor.id
    _bump(co)
    db.flush()
    return _out(co, db)


@router.post("/{co_id}/reject", response_model=ChangeOrderOut)
def reject_change_order(
    co_id: int,
    payload: Optional[ChangeOrderReject] = None,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
    guard=Depends(require_permission(CO_APPROVAL)),
):
    """Send a pending CO back to the requester (clears the approval stamp).

    Distinct 'sent_back' status (not plain 'draft') so returned COs surface in
    their own tab instead of blending in with fresh drafts. Editable + can be
    re-submitted (submit -> pending) from there.

    THE APPROVAL REQUESTS ARE NOT DELETED. This route NULLs approved_by,
    approved_by_user_id, approved_at and all three send stamps — which is
    exactly why those rows have to survive it. Without them, a change order
    approved on Tuesday and sent back on Wednesday reads on Thursday as though
    nobody had ever been asked and nobody had ever agreed. They are closed out
    by status, and that is the whole of what happens to them."""
    co = _get(db, co_id)
    guard.require_project(co.project_id)
    if co.status not in ("pending", "approved"):
        raise HTTPException(
            409,
            f"CO-{co.co_number} is {co.status} — there is nothing to send back.",
        )
    if co.sent_at is not None:
        # Sending back clears sent_at, which would erase the only record that the
        # client already has this document. Revising something already delivered
        # is a new version, not an edit of the one they are holding.
        raise HTTPException(
            409,
            f"CO-{co.co_number} has already gone to the client and cannot be "
            "sent back — that would erase the record of what they received. "
            "Raise a new version instead.",
        )
    co.status = "sent_back"
    co.approved_by = None
    co.approved_by_user_id = None
    co.approved_at = None
    # The delivery stamp goes back with the approval stamp. sent_at decides which
    # tab an approved CO lives in, so leaving it set would send a revised CO
    # straight to "Sent to client" on re-approval — filed as delivered while the
    # client still holds the superseded version, and never queued for sending.
    co.sent_at = None
    co.sent_to = None
    co.sent_method = None
    if actor:
        co.updated_by_id = actor.id
    _bump(co)
    _close_out_requests(
        db, co, actor,
        outcome=_REQ_REJECTED,
        note=((payload.note or "").strip() or None) if payload else None,
    )
    db.flush()
    return _out(co, db)


@router.delete("/{co_id}", status_code=204)
def delete_change_order(
    co_id: int,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
    guard=Depends(require_permission(CO_CREATION)),
):
    # Authoring-side permission: discarding a CO belongs with raising one, not
    # with deciding on it. An approver's job is to say yes or no, not to make the
    # request disappear.
    co = _get(db, co_id)
    guard.require_project(co.project_id)
    if co.status not in ("draft", "sent_back"):
        # Deleting an approved or delivered CO drops the line items, orphans the
        # archived PDF with nothing pointing at it, drops the approved-$ rollup,
        # and frees co_number for the next CO to reuse — so two different
        # documents end up sharing a number. There is no audit log, so nothing
        # would record that any of it happened.
        raise HTTPException(
            409,
            f"CO-{co.co_number} is {co.status} and cannot be deleted. Only a "
            "draft or a sent-back change order can be discarded; once it has "
            "been approved it is part of the record.",
        )
    db.delete(co)
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
