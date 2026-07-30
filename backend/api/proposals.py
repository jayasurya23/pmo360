"""/api/proposals — Castillo Proposal builder (ported desktop tool).

A self-contained vertical: upload a cost workbook, edit the computed schedule
tree, version it (V1/V2…), generate the merged "Project Schedule" PDF (page-1
milestones table + page-2 Gantt), and — only when explicitly linked + synced —
project the schedule into a PMO 360 portfolio's existing Schedule/Deliverable
tables (reusing the same save_schedule pipeline the AI parser uses).

Works fully standalone: a proposal needs no client/portfolio. ``portfolio_id``
(nullable) is the tie-in hinge. All endpoints require a signed-in user only.
"""
from __future__ import annotations

import base64
import copy
import io
import os
import re
import tempfile
from typing import Optional

from fastapi import (
    APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from auth import require_db_user
from core.deps import get_db
from db.models import (
    Proposal, ProposalVersion, ProposalDocument, Project, Deliverable, Schedule,
    TimelineProject, TimelineAssignment, TimelineResource, PortfolioProject,
)
from schemas.common import (
    ProposalOut, ProposalListItem, ProposalVersionOut, ProposalVersionDetail,
    ProposalBoardResponse, ProposalPatch, ProposalTreePut, ProposalRecomputeRequest,
    ProposalLinkRequest, ProposalLinkProjectRequest, ProposalLinkProjectResult,
    ProposalDemotedOut, ProposalSyncRequest, ProposalSyncResult,
    ProposalToTimelineRequest, ProposalToTimelineResult, ProposalTimelineResyncOut,
    ProposalTimelineMilestonesOut, ProposalTimelineMilestoneOut,
    ProposalTimelineBarRequest, ProposalTimelineBarResult,
    ProposalLogos, ProposalLogosUpdate,
    ScheduleSaveRequest, ParsedScheduleOut, ParsedScheduleItemOut,
)
from storage.backend import get_storage
from api.schedules import save_schedule

from proposal.serialization import (
    parse_workbook_to_tree, serialize_tree, deserialize_tree,
    info_dict_to_project_info, build_info_json, project_info_from_json,
    tree_summary, tree_to_schedule_rows, _mdy_to_date, _to_mdy,
)
from proposal.scheduling import (
    ScheduleConfig, calculate_all_dates, CircularDependencyError,
    get_project_end_date,
)
from proposal.gantt import build_gantt_rows, render_gantt_bytes, brand_logo_path
from proposal.pdf import render_schedule_table_bytes
from proposal.template_xlsx import write_template_xlsx, read_template_xlsx

XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


router = APIRouter(prefix="/api/proposals", tags=["proposals"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _check_stale(expected: Optional[int], current: Optional[int], kind: str = "proposal") -> None:
    if expected is not None and (current or 1) != expected:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "stale_version",
                "message": f"This {kind} was changed by someone else. Reload to see the latest.",
                "current_version": current,
                "submitted_version": expected,
            },
        )


def _cfg_from_json(d: Optional[dict]) -> ScheduleConfig:
    d = d or {}
    from datetime import datetime, date
    # config_json stores custom_holidays as ISO date strings, but ScheduleConfig
    # (and holiday_np_array, which reads `.year`) expects datetime.date objects.
    # Parse them here, or calculate_all_dates crashes for any proposal that has
    # custom holidays — both on import_template AND on in-app Recompute.
    hols = set()
    for x in (d.get("custom_holidays") or ()):
        if isinstance(x, date):
            hols.add(x)
        else:
            try:
                hols.add(date.fromisoformat(str(x)[:10]))
            except ValueError:
                pass
    return ScheduleConfig(
        project_start=d.get("project_start") or datetime.now().strftime("%m/%d/%y"),
        utilization_percent=float(d.get("utilization_percent", 100.0) or 100.0),
        fs_start_next_day=bool(d.get("fs_start_next_day", True)),
        disabled_holidays=frozenset(d.get("disabled_holidays") or ()),
        custom_holidays=frozenset(hols),
    )


def _cfg_to_json(cfg: ScheduleConfig) -> dict:
    from datetime import date
    return {
        "project_start": cfg.project_start,
        "utilization_percent": cfg.utilization_percent,
        "fs_start_next_day": cfg.fs_start_next_day,
        "disabled_holidays": sorted(cfg.disabled_holidays),
        # back to JSON-safe ISO strings (symmetric with _cfg_from_json)
        "custom_holidays": sorted(h.isoformat() if isinstance(h, date) else str(h)
                                  for h in cfg.custom_holidays),
    }


def _apply_summary(version: ProposalVersion, items) -> None:
    s = tree_summary(items)
    version.computed_start_date = s["start_date"]
    version.computed_end_date = s["end_date"]
    version.total_price = s["total_price"]


async def _parse_upload(
    file: UploadFile,
    source: str = "workbook",
    project_start: Optional[str] = None,
    utilization_percent: float = 100.0,
    prev_config: Optional[dict] = None,
) -> "tuple[list, dict, ScheduleConfig, str]":
    """Read an uploaded spreadsheet -> ``(items, info_json, cfg, source_format)``.

    The single parse pipeline behind every entry point that turns a file into a
    proposal tree: a brand-new proposal from a cost workbook (/upload) or from a
    saved template (/template), and a new VERSION of an existing proposal from
    either (/{pid}/versions/from-upload). Kept in one place so the three callers
    can't drift — the error strings, the extension guard and the template's
    "no re-injection" rule are all load-bearing.

    ``source="workbook"`` runs the Castillo cost-workbook parser, which injects
    Client Review / Record Drawings rows and schedules them. ``"template"``
    rebuilds a previously exported tree verbatim (deserialize, NOT build_tree, so
    nothing is injected twice) and only re-runs the date calc.

    ``prev_config`` is the config_json of the version being superseded, and seeds
    the CALENDAR settings a cost workbook cannot state — see the workbook branch.
    A template is ignored here on purpose: it ships its own saved calendar, which
    is the whole point of loading one.
    """
    src = (source or "workbook").strip().lower()
    if src not in ("workbook", "template"):
        raise HTTPException(400, "source must be 'workbook' or 'template'.")

    name = (file.filename or "").lower()
    if not (name.endswith(".xlsx") or name.endswith(".xlsm")):
        raise HTTPException(400, (
            "Template must be a saved proposal workbook (.xlsx / .xlsm)."
            if src == "template"
            else "Proposal upload must be a Castillo cost workbook (.xlsx / .xlsm)."
        ))
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    source_format = "xlsm" if name.endswith(".xlsm") else "xlsx"

    if src == "template":
        try:
            parsed = read_template_xlsx(data)
        except Exception as exc:  # noqa: BLE001 — surface a clean 400 to the UI
            raise HTTPException(400, f"Could not read template workbook: {exc}") from exc
        items, id_map = deserialize_tree(parsed["tree_json"])
        cfg = _cfg_from_json(parsed["config_json"])
        # An explicitly supplied start beats the template's stored one: a saved
        # template is a reusable shape, and re-dating it is the whole point of
        # loading it into a new version.
        if project_start:
            cfg.project_start = _to_mdy(project_start) or cfg.project_start
        if not cfg.project_start:
            from datetime import datetime
            cfg.project_start = datetime.now().strftime("%m/%d/%y")
        try:
            calculate_all_dates(items, id_map, cfg)
        except CircularDependencyError as exc:
            raise HTTPException(422, str(exc)) from exc
        return items, parsed["info_json"], cfg, source_format

    # Which holidays the team observes and whether an FS successor starts the next
    # day are the PM's calendar POLICY — a cost workbook states neither, so
    # parsing a re-bid on the parser's defaults silently dropped the client
    # shutdown dates and the FS rule entered on the version being superseded.
    # Seeded BEFORE the date calc, since holidays move every date: patching cfg
    # afterwards would store a calendar the stored dates do not obey. The
    # project_start stays the workbook's/caller's — a re-bid is re-dated by
    # definition, and both it and utilization are on the upload dialog.
    prev = _cfg_from_json(prev_config) if prev_config else None
    tmp = tempfile.NamedTemporaryFile(suffix=f".{source_format}", delete=False)
    try:
        tmp.write(data)
        tmp.close()
        try:
            items, _id_map, info, cfg = parse_workbook_to_tree(
                tmp.name, project_start=project_start,
                utilization_percent=utilization_percent,
                fs_start_next_day=(prev.fs_start_next_day if prev else True),
                disabled_holidays=(prev.disabled_holidays if prev else None),
                custom_holidays=(prev.custom_holidays if prev else None),
            )
        except Exception as exc:  # noqa: BLE001 — surface a clean 400 to the UI
            raise HTTPException(400, f"Could not parse workbook: {exc}") from exc
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
    return items, build_info_json(info, info_dict_to_project_info(info)), cfg, source_format


def _get_proposal(pid: int, db: Session) -> Proposal:
    p = db.get(Proposal, pid)
    if not p:
        raise HTTPException(404, "Proposal not found")
    return p


def _get_version(proposal: Proposal, vid: int, db: Session) -> ProposalVersion:
    v = db.get(ProposalVersion, vid)
    if not v or v.proposal_id != proposal.id:
        raise HTTPException(404, "Proposal version not found")
    return v


def _active_version(proposal: Proposal, db: Session) -> Optional[ProposalVersion]:
    if proposal.current_version_id:
        v = db.get(ProposalVersion, proposal.current_version_id)
        if v:
            return v
    return proposal.versions[-1] if proposal.versions else None


def _next_label(proposal: Proposal) -> str:
    """Next version label as ``V{N+1}``.

    N is the highest numeric label seen — but floored at the version count and
    guarded against collisions, so the label still increments cleanly when the
    existing labels are non-numeric/custom (e.g. an uploaded workbook's version
    cell like "Issued for Proposal" or a date). Without the floor a non-parseable
    label left N at 0 and every new version came out "V1" (duplicate)."""
    versions = list(proposal.versions)
    existing = {(v.label or "").strip() for v in versions}
    n = len(versions)
    for v in versions:
        # Only a clean "V12"/"12" label is treated as a version number — a label
        # that merely starts with digits (e.g. a date "2024-11-12") is opaque.
        m = re.fullmatch(r"[vV]?(\d+)", (v.label or "").strip())
        if m:
            n = max(n, int(m.group(1)))
    candidate = f"V{n + 1}"
    while candidate in existing:
        n += 1
        candidate = f"V{n + 1}"
    return candidate


def _version_detail(v: ProposalVersion) -> ProposalVersionDetail:
    return ProposalVersionDetail(
        id=v.id, proposal_id=v.proposal_id, label=v.label,
        computed_start_date=v.computed_start_date, computed_end_date=v.computed_end_date,
        total_price=v.total_price, source_filename=v.source_filename,
        source_format=v.source_format, linked_schedule_id=v.linked_schedule_id,
        version=v.version, created_at=v.created_at,
        info=v.info_json or {}, config=v.config_json or {}, tree=v.tree_json or [],
    )


def _board(proposal: Proposal, db: Session) -> ProposalBoardResponse:
    active = _active_version(proposal, db)
    if active is None:
        raise HTTPException(404, "Proposal has no versions")
    versions = sorted(proposal.versions, key=lambda v: v.id)
    return ProposalBoardResponse(
        proposal=ProposalOut.model_validate(proposal),
        version=_version_detail(active),
        versions=[ProposalVersionOut.model_validate(v) for v in versions],
    )


def _safe_filename(s: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "_", (s or "Proposal").strip()) or "Proposal"
    return s[:180]


def _merge_pdfs(table_bytes: bytes, gantt_bytes: Optional[bytes]) -> bytes:
    if not gantt_bytes:
        return table_bytes
    import pikepdf
    pdf = pikepdf.open(io.BytesIO(table_bytes))
    gantt = pikepdf.open(io.BytesIO(gantt_bytes))
    try:
        pdf.pages.extend(gantt.pages)
        out = io.BytesIO()
        pdf.save(out)
        return out.getvalue()
    finally:
        pdf.close()
        gantt.close()


def _merge_pdf_list(parts: "list[bytes]") -> bytes:
    """Concatenate several single-PDF blobs into one (e.g. SOV page(s) +
    Project Schedule page(s) + Gantt) preserving order."""
    parts = [p for p in parts if p]
    if not parts:
        return b""
    if len(parts) == 1:
        return parts[0]
    import pikepdf
    opened = [pikepdf.open(io.BytesIO(p)) for p in parts]
    try:
        base = opened[0]
        for extra in opened[1:]:
            base.pages.extend(extra.pages)
        out = io.BytesIO()
        base.save(out)
        return out.getvalue()
    finally:
        for o in opened:
            o.close()


# Branding logos (#7) — uploaded as data URLs, stored on the Proposal, rendered
# onto the deliverable header. Raster only (ReportLab/matplotlib render these).
_LOGO_MIME_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg"}
_LOGO_MAX_BYTES = 2 * 1024 * 1024  # 2 MB decoded — logos are small
_LOGO_DATA_URL_RE = re.compile(r"^data:(image/[a-zA-Z.+-]+);base64,(.+)$", re.DOTALL)


def _validate_logo_data_url(data_url: "str | None") -> "str | None":
    """Validate an uploaded logo data URL; return it as-is, or None to clear.
    Raises HTTPException(400) on a non-image / malformed / oversized payload."""
    if not data_url:
        return None  # clear
    m = _LOGO_DATA_URL_RE.match(data_url)
    if not m or m.group(1).lower() not in _LOGO_MIME_EXT:
        raise HTTPException(400, "Logo must be a base64 PNG or JPEG image data URL.")
    try:
        raw = base64.b64decode(m.group(2), validate=True)
    except Exception:
        raise HTTPException(400, "Logo image is not valid base64.")
    if not raw:
        raise HTTPException(400, "Logo image is empty.")
    if len(raw) > _LOGO_MAX_BYTES:
        raise HTTPException(400, "Logo image is too large (max 2 MB).")
    return data_url


def _materialize_logo(data_url: "str | None", tmp_paths: "list[str]") -> str:
    """Decode a logo data URL to a temp file (tracked in ``tmp_paths`` for later
    cleanup) and return its path; "" when there is nothing to render."""
    if not data_url:
        return ""
    m = _LOGO_DATA_URL_RE.match(data_url)
    if not m:
        return ""
    ext = _LOGO_MIME_EXT.get(m.group(1).lower(), ".png")
    try:
        raw = base64.b64decode(m.group(2))
        fd, path = tempfile.mkstemp(suffix=ext, prefix="proposal_logo_")
        with os.fdopen(fd, "wb") as fh:
            fh.write(raw)
        tmp_paths.append(path)
        return path
    except Exception:
        return ""


def _build_proposal_pdf(
    v: ProposalVersion,
    proposal: "Proposal | None" = None,
    mode: "str | None" = None,
    kind: "str | None" = None,
) -> bytes:
    """Render page-1 milestones table + page-2 Gantt and merge → PDF bytes.

    When ``proposal`` is given, its live identity fields (title/customer/etc.)
    overlay the version's persisted info_json, so ANY version's PDF reflects the
    current proposal identity without needing that version re-saved first (#2).
    """
    items, id_map = deserialize_tree(v.tree_json)
    cfg = _cfg_from_json(v.config_json)
    info = project_info_from_json(v.info_json)
    tmp_logo_paths: "list[str]" = []
    if proposal is not None:
        info.project_title = proposal.title or info.project_title
        info.customer_name = proposal.customer_name or info.customer_name
        info.project_location = proposal.project_location or info.project_location
        info.project_state = proposal.project_state or info.project_state
        info.project_size_mw = proposal.project_size_mw or info.project_size_mw
        # Uploaded branding logos (#7): company overrides the bundled default;
        # client renders only when present. Stored as data URLs → temp files.
        company_path = _materialize_logo(getattr(proposal, "company_logo", None), tmp_logo_paths)
        client_path = _materialize_logo(getattr(proposal, "client_logo", None), tmp_logo_paths)
        if company_path:
            info.logo_path = company_path
        if client_path:
            info.client_logo_path = client_path
    opts = v.info_json or {}

    # PDF export options (desktop parity): milestones-only + gantt toggle.
    milestones_only = bool(opts.get("milestones_only_pdf", False))
    include_gantt_opt = bool(opts.get("include_gantt", True))

    # Decide which table(s) to render + whether the Gantt page is appended:
    #   mode= (legacy, used per-mode by the ZIP export): one explicit table + Gantt.
    #   kind="sov"      -> Schedule of Values only (price table, no Gantt).
    #   kind="both"     -> Schedule of Values, then the dated Project Schedule + Gantt.
    #   kind="schedule" (default) -> the dated Project Schedule + Gantt.
    if mode is not None:
        table_modes, want_gantt = [mode], include_gantt_opt
    elif kind == "sov":
        table_modes, want_gantt = ["price_only"], False
    elif kind == "both":
        table_modes, want_gantt = ["price_only", "both"], include_gantt_opt
    else:
        table_modes, want_gantt = ["both"], include_gantt_opt

    # Company logo on both pages: an uploaded company_logo (set above) wins, else
    # any logo stored on the version's info, else the bundled Castillo default.
    logo = info.logo_path or brand_logo_path()
    info.logo_path = logo

    try:
        parts: "list[bytes]" = [
            render_schedule_table_bytes(
                items, info, disabled_holidays=cfg.disabled_holidays,
                mode=m, milestones_only=milestones_only,
                project_utilization=cfg.utilization_percent,
            )
            for m in table_modes
        ]

        if want_gantt:
            rows = build_gantt_rows(
                items,
                project_utilization=cfg.utilization_percent,
                project_end_date=get_project_end_date(id_map),
                project_start_date=cfg.project_start,
            )
            if rows:
                parts.append(render_gantt_bytes(
                    rows, title="Project Schedule",
                    project_title=info.project_title, customer_name=info.customer_name,
                    version=info.version, project_location=info.project_location,
                    project_state=info.project_state, project_size_mw=info.project_size_mw,
                    logo_path=logo,
                ))
        return _merge_pdf_list(parts)
    finally:
        for _p in tmp_logo_paths:
            try:
                os.remove(_p)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Upload + list + board
# ---------------------------------------------------------------------------
@router.post("/upload", response_model=ProposalBoardResponse, status_code=201)
async def upload_proposal(
    file: UploadFile = File(...),
    portfolio_id: Optional[int] = Form(None),
    project_start: Optional[str] = Form(None),
    utilization_percent: float = Form(100.0),
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    if portfolio_id is not None and not db.get(Project, portfolio_id):
        raise HTTPException(404, "Portfolio not found")

    items, info_json, cfg, source_format = await _parse_upload(
        file, "workbook", project_start, utilization_percent,
    )
    pinfo = project_info_from_json(info_json)
    proposal = Proposal(
        title=pinfo.project_title or (file.filename or "Untitled Proposal"),
        customer_name=pinfo.customer_name or None,
        project_location=pinfo.project_location or None,
        project_state=pinfo.project_state or None,
        project_size_mw=pinfo.project_size_mw or None,
        portfolio_id=portfolio_id,
        created_by_id=actor.id, updated_by_id=actor.id,
    )
    db.add(proposal)
    db.flush()

    summary = tree_summary(items)
    v = ProposalVersion(
        proposal_id=proposal.id, label="V1",
        tree_json=serialize_tree(items),
        info_json=info_json,
        config_json=_cfg_to_json(cfg),
        computed_start_date=summary["start_date"],
        computed_end_date=summary["end_date"],
        total_price=summary["total_price"],
        source_filename=file.filename, source_format=source_format,
        created_by_id=actor.id,
    )
    db.add(v)
    db.flush()
    proposal.current_version_id = v.id
    db.flush()
    return _board(proposal, db)


@router.get("", response_model=list[ProposalListItem])
def list_proposals(
    portfolio_id: Optional[int] = Query(None),
    project_id: Optional[int] = Query(None),
    active_only: bool = Query(False),
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    q = db.query(Proposal)
    if portfolio_id is not None:
        q = q.filter(Proposal.portfolio_id == portfolio_id)
    if project_id is not None:
        q = q.filter(Proposal.project_id == project_id)
    if active_only:
        # The picker deliberately does NOT use this (history rows must stay
        # reachable); it exists for callers that want only the live proposal.
        q = q.filter(Proposal.is_active_for_project.is_(True))
    out = []
    for p in q.order_by(Proposal.updated_at.desc()).all():
        active = db.get(ProposalVersion, p.current_version_id) if p.current_version_id else None
        out.append(ProposalListItem(
            **ProposalOut.model_validate(p).model_dump(),
            current_label=active.label if active else None,
            version_count=len(p.versions),
            portfolio_name=p.portfolio.name if p.portfolio else None,
        ))
    return out


@router.get("/{pid}/board", response_model=ProposalBoardResponse)
def get_board(pid: int, db: Session = Depends(get_db), actor=Depends(require_db_user)):
    return _board(_get_proposal(pid, db), db)


@router.patch("/{pid}", response_model=ProposalOut)
def patch_proposal(
    pid: int, payload: ProposalPatch,
    db: Session = Depends(get_db), actor=Depends(require_db_user),
):
    p = _get_proposal(pid, db)
    _check_stale(payload.expected_version, p.version)
    for f in ("title", "customer_name", "project_location", "project_state", "project_size_mw"):
        val = getattr(payload, f)
        if val is not None:
            setattr(p, f, val)
    p.updated_by_id = actor.id
    p.version = (p.version or 1) + 1
    db.flush()
    return p


@router.get("/{pid}/logos", response_model=ProposalLogos)
def get_proposal_logos(pid: int, db: Session = Depends(get_db), actor=Depends(require_db_user)):
    """The proposal's branding logos (data URLs) for the editor's upload widgets.
    Kept off the list/board responses to keep those lean."""
    p = _get_proposal(pid, db)
    return ProposalLogos(company_logo=p.company_logo, client_logo=p.client_logo)


@router.put("/{pid}/logos", response_model=ProposalLogos)
def put_proposal_logos(
    pid: int, payload: ProposalLogosUpdate,
    db: Session = Depends(get_db), actor=Depends(require_db_user),
):
    """Set/replace/clear the deliverable's branding logos. Only fields present in
    the body are touched; an explicit null clears that logo (company => bundled
    Castillo default, client => none)."""
    p = _get_proposal(pid, db)
    fields = payload.model_fields_set
    if "company_logo" in fields:
        p.company_logo = _validate_logo_data_url(payload.company_logo)
    if "client_logo" in fields:
        p.client_logo = _validate_logo_data_url(payload.client_logo)
    p.updated_by_id = actor.id
    db.flush()
    return ProposalLogos(company_logo=p.company_logo, client_logo=p.client_logo)


@router.delete("/{pid}", status_code=204)
def delete_proposal(pid: int, db: Session = Depends(get_db), actor=Depends(require_db_user)):
    db.delete(_get_proposal(pid, db))
    return None


# ---------------------------------------------------------------------------
# Versions: edit tree / recompute / snapshot / activate
# ---------------------------------------------------------------------------
# Fields a per-row "lock" protects from edits — mirrors the inputs the UI
# disables when a row is locked. The lock toggle (`locked`) itself, structure,
# and the on/milestone/price-only toggles stay editable.
_LOCKED_PROTECTED_FIELDS = (
    "name", "duration", "price", "targeted_hours", "task_utilization",
    "predecessor_id", "predecessor_type", "lag",
)


def _locked_nodes_by_id(tree_json) -> dict:
    """Map id -> stored node dict for every node persisted as locked."""
    out: dict = {}

    def walk(nodes):
        for n in nodes or []:
            if n.get("locked") and n.get("id") is not None:
                out[n["id"]] = n
            walk(n.get("children"))

    walk(tree_json)
    return out


def _enforce_locked_fields(items, locked_map: dict) -> None:
    """Restore protected fields on any incoming row that is locked in BOTH the
    stored version and the payload, so a tampered/stale client request can't
    change a locked row's price/duration/etc. (closes the API-level gap behind
    the UI's disabled inputs). Unlocking a row in the same save lets edits
    through. Applied before date calc so schedules recompute from locked inputs.
    """
    def walk(nodes):
        for it in nodes:
            if getattr(it, "locked", False) and it.id in locked_map:
                stored = locked_map[it.id]
                for f in _LOCKED_PROTECTED_FIELDS:
                    if f in stored:
                        setattr(it, f, stored[f])
            walk(it.children)

    walk(items)


@router.put("/{pid}/versions/{vid}/tree", response_model=ProposalVersionDetail)
def put_tree(
    pid: int, vid: int, payload: ProposalTreePut,
    db: Session = Depends(get_db), actor=Depends(require_db_user),
):
    p = _get_proposal(pid, db)
    v = _get_version(p, vid, db)
    _check_stale(payload.expected_version, v.version, "proposal version")

    # Lock guard must read the STORED tree before we overwrite it below.
    locked_map = _locked_nodes_by_id(v.tree_json)
    items, id_map = deserialize_tree([n.model_dump() for n in payload.tree])
    _enforce_locked_fields(items, locked_map)
    cfg = _cfg_from_json(payload.config or v.config_json)
    try:
        calculate_all_dates(items, id_map, cfg)
    except CircularDependencyError as exc:
        raise HTTPException(422, str(exc)) from exc

    v.tree_json = serialize_tree(items)
    if payload.info is not None:
        v.info_json = payload.info
    v.config_json = _cfg_to_json(cfg)
    _apply_summary(v, items)
    v.version = (v.version or 1) + 1
    db.flush()
    detail = _version_detail(v)
    # Only the ACTIVE version owns the Timeline projection — re-dating the board
    # from an archived version would overwrite it with stale geometry.
    if p.current_version_id == v.id:
        rs = _resync_proposal_timeline(p, v, db, actor)
        detail.timeline_resync = ProposalTimelineResyncOut(**rs) if rs else None
    return detail


@router.post("/{pid}/versions/{vid}/recompute", response_model=ProposalVersionDetail)
def recompute_version(
    pid: int, vid: int, payload: ProposalRecomputeRequest,
    db: Session = Depends(get_db), actor=Depends(require_db_user),
):
    p = _get_proposal(pid, db)
    v = _get_version(p, vid, db)
    _check_stale(payload.expected_version, v.version, "proposal version")

    items, id_map = deserialize_tree(v.tree_json)
    cfg = _cfg_from_json(payload.config or v.config_json)
    try:
        calculate_all_dates(items, id_map, cfg, payload.unpin_all)
    except CircularDependencyError as exc:
        raise HTTPException(422, str(exc)) from exc

    v.tree_json = serialize_tree(items)
    v.config_json = _cfg_to_json(cfg)
    _apply_summary(v, items)
    v.version = (v.version or 1) + 1
    db.flush()
    detail = _version_detail(v)
    if p.current_version_id == v.id:   # see put_tree — active version only
        rs = _resync_proposal_timeline(p, v, db, actor)
        detail.timeline_resync = ProposalTimelineResyncOut(**rs) if rs else None
    return detail


@router.get("/{pid}/versions", response_model=list[ProposalVersionOut])
def list_versions(pid: int, db: Session = Depends(get_db), actor=Depends(require_db_user)):
    p = _get_proposal(pid, db)
    return sorted(p.versions, key=lambda v: v.id)


@router.post("/{pid}/versions", response_model=ProposalBoardResponse, status_code=201)
def new_version(pid: int, db: Session = Depends(get_db), actor=Depends(require_db_user)):
    p = _get_proposal(pid, db)
    active = _active_version(p, db)
    if active is None:
        raise HTTPException(400, "No active version to copy")
    label = _next_label(p)
    new_info = copy.deepcopy(active.info_json) or {}
    new_info["version"] = label
    # Attach via the relationship rather than assigning proposal_id. `_next_label`
    # just loaded `p.versions`, and a raw FK assignment never reaches an
    # already-loaded collection — so `_board()` would report the new version as
    # active while still listing only the old ones, and the picker wouldn't
    # catch up until the page was reloaded.
    nv = ProposalVersion(
        label=label,
        tree_json=copy.deepcopy(active.tree_json),
        info_json=new_info,
        config_json=copy.deepcopy(active.config_json),
        computed_start_date=active.computed_start_date,
        computed_end_date=active.computed_end_date,
        total_price=active.total_price,
        source_filename=active.source_filename, source_format=active.source_format,
        created_by_id=actor.id,
    )
    p.versions.append(nv)
    db.flush()
    p.current_version_id = nv.id
    db.flush()
    rs = _resync_proposal_timeline(p, nv, db, actor)
    board = _board(p, db)
    board.timeline_resync = ProposalTimelineResyncOut(**rs) if rs else None
    return board


# info_json keys a new-from-upload version inherits from the version it
# supersedes: the PM's deliverable/export preferences, which belong to the
# proposal rather than to any one spreadsheet. Deliberately NOT carried:
# `split_deposit_memory` (its keys are task ids from the old tree, which
# build_tree has just re-minted) and `client_review_days` (already baked into
# the freshly parsed durations).
_UPLOAD_CARRY_FORWARD_INFO_KEYS = (
    "schedule_table_mode", "schedule_table_modes", "include_gantt",
    "milestones_only_pdf", "logo_path", "client_logo_path",
)


@router.post("/{pid}/versions/from-upload", response_model=ProposalBoardResponse, status_code=201)
async def new_version_from_upload(
    pid: int,
    file: UploadFile = File(...),
    source: str = Form("workbook"),
    project_start: Optional[str] = Form(None),
    # Optional, unlike the create-a-proposal upload: omitted means "keep what the
    # superseded version used" instead of snapping the schedule back to 100%.
    utilization_percent: Optional[float] = Form(None),
    update_identity: bool = Form(False),
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    """Add a version to an EXISTING proposal from a freshly uploaded spreadsheet.

    The re-bid path: same proposal, same Timeline project, same client — a new
    cost workbook (or saved template). The parsed tree REPLACES the old one, so
    row locks and hand edits from the previous version do not survive (build_tree
    mints fresh ids and no id mapping exists); the dialog says so. Export/PDF
    preferences and the schedule calendar (holidays + FS rule, and utilization
    unless this request states one) do carry over.
    """
    p = _get_proposal(pid, db)
    prev = _active_version(p, db)
    prev_config = (prev.config_json if prev else None) or {}
    if utilization_percent is None:
        utilization_percent = float(prev_config.get("utilization_percent") or 100.0)
    items, info_json, cfg, source_format = await _parse_upload(
        file, source, project_start, utilization_percent, prev_config,
    )

    # Label before the append: _next_label() reads p.versions, which must not yet
    # contain the row we are about to add.
    label = _next_label(p)
    prev_info = (prev.info_json if prev else None) or {}
    for k in _UPLOAD_CARRY_FORWARD_INFO_KEYS:
        if k in prev_info:
            info_json[k] = prev_info[k]
    # The spreadsheet's own version cell is meaningless here — _build_proposal_pdf
    # stamps info.version onto the Gantt header, so without this every uploaded
    # version's PDF would claim to be whatever the file said (usually "V1").
    info_json["version"] = label

    if update_identity:
        pinfo = project_info_from_json(info_json)
        p.title = pinfo.project_title or p.title
        p.customer_name = pinfo.customer_name or p.customer_name
        p.project_location = pinfo.project_location or p.project_location
        p.project_state = pinfo.project_state or p.project_state
        p.project_size_mw = pinfo.project_size_mw or p.project_size_mw
        p.updated_by_id = actor.id
        p.version = (p.version or 1) + 1

    nv = ProposalVersion(
        label=label,
        tree_json=serialize_tree(items),
        info_json=info_json,
        config_json=_cfg_to_json(cfg),
        source_filename=file.filename, source_format=source_format,
        created_by_id=actor.id,
    )
    _apply_summary(nv, items)
    # Relationship append, never proposal_id= — see new_version() above.
    p.versions.append(nv)
    db.flush()
    p.current_version_id = nv.id
    db.flush()
    rs = _resync_proposal_timeline(p, nv, db, actor)
    board = _board(p, db)
    board.timeline_resync = ProposalTimelineResyncOut(**rs) if rs else None
    return board


@router.post("/{pid}/versions/{vid}/activate", response_model=ProposalBoardResponse)
def activate_version(
    pid: int, vid: int,
    db: Session = Depends(get_db), actor=Depends(require_db_user),
):
    p = _get_proposal(pid, db)
    v = _get_version(p, vid, db)
    p.current_version_id = v.id
    db.flush()
    rs = _resync_proposal_timeline(p, v, db, actor)
    board = _board(p, db)
    board.timeline_resync = ProposalTimelineResyncOut(**rs) if rs else None
    return board


# ---------------------------------------------------------------------------
# PDF generate + serve
# ---------------------------------------------------------------------------
_PDF_KIND_SUFFIX = {
    "sov": "Schedule-of-Values",
    "schedule": "Project-Schedule",
    "both": "Proposal",
}


@router.post("/{pid}/versions/{vid}/pdf")
def generate_pdf(
    pid: int, vid: int,
    kind: str = Query("schedule", description="sov | schedule | both"),
    db: Session = Depends(get_db), actor=Depends(require_db_user),
):
    p = _get_proposal(pid, db)
    v = _get_version(p, vid, db)
    kind = kind if kind in _PDF_KIND_SUFFIX else "schedule"
    merged = _build_proposal_pdf(v, p, kind=kind)
    title = (v.info_json or {}).get("project_title") or p.title
    fname = _safe_filename(f"{title}-{v.label}-{_PDF_KIND_SUFFIX[kind]}") + ".pdf"
    rel = f"proposals/{p.id}/{v.id}/{fname}"
    get_storage().save(rel, merged)
    doc = ProposalDocument(
        proposal_version_id=v.id, kind="proposal_pdf",
        filename=fname, storage_path=rel, file_size_bytes=len(merged),
    )
    db.add(doc)
    db.flush()
    return {"document_id": doc.id, "filename": fname, "file_size_bytes": len(merged)}


@router.get("/{pid}/versions/{vid}/pdf/file")
def serve_pdf(
    pid: int, vid: int,
    db: Session = Depends(get_db), actor=Depends(require_db_user),
):
    p = _get_proposal(pid, db)
    v = _get_version(p, vid, db)
    doc = (
        db.query(ProposalDocument)
        .filter_by(proposal_version_id=v.id)
        .order_by(ProposalDocument.id.desc())
        .first()
    )
    content = None
    fname = None
    if doc:
        try:
            content = get_storage().read(doc.storage_path)
            fname = doc.filename
        except Exception:  # noqa: BLE001 — fall back to building on the fly
            content = None
    if content is None:
        content = _build_proposal_pdf(v, p)
        title = (v.info_json or {}).get("project_title") or p.title
        fname = _safe_filename(f"{title}-{v.label}-Project-Schedule") + ".pdf"
    return Response(
        content=content, media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{fname}"'},
    )


# ---------------------------------------------------------------------------
# Save / Load Excel template (desktop "Save Template" / "Load Template")
# ---------------------------------------------------------------------------
@router.get("/{pid}/versions/{vid}/template.xlsx")
def export_template(
    pid: int, vid: int,
    db: Session = Depends(get_db), actor=Depends(require_db_user),
):
    """Stream the saved-template .xlsx built from the persisted version."""
    p = _get_proposal(pid, db)
    v = _get_version(p, vid, db)
    content = write_template_xlsx(
        tree_json=v.tree_json or [],
        info_json=v.info_json or {},
        config_json=v.config_json or {},
    )
    title = (v.info_json or {}).get("project_title") or p.title
    fname = _safe_filename(f"{title}_{v.label}") + ".xlsx"
    return Response(
        content=content, media_type=XLSX_MEDIA,
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.get("/{pid}/versions/{vid}/bundle.zip")
def export_bundle(
    pid: int, vid: int,
    db: Session = Depends(get_db), actor=Depends(require_db_user),
):
    """Stream a ZIP bundling one branded PDF per selected schedule table mode +
    the editable Excel template — one download for the full deliverable set."""
    import io
    import zipfile
    p = _get_proposal(pid, db)
    v = _get_version(p, vid, db)
    xlsx_bytes = write_template_xlsx(
        tree_json=v.tree_json or [],
        info_json=v.info_json or {},
        config_json=v.config_json or {},
    )
    title = (v.info_json or {}).get("project_title") or p.title
    base = _safe_filename(f"{title}_{v.label}")
    modes = (v.info_json or {}).get("schedule_table_modes") or ["price_only", "dates_only", "both"]
    # Human-readable filename suffix per table mode.
    mode_suffix = {
        "price_only": "Schedule-of-Values",
        "dates_only": "Project-Schedule",
        "both": "Schedule-with-Prices",
        "no_dates": "No-Dates",
        "duration_only": "Durations",
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        seen: set = set()
        for m in modes:
            if m in seen:
                continue
            seen.add(m)
            zf.writestr(
                f"{base}_{mode_suffix.get(m, m)}.pdf",
                _build_proposal_pdf(v, p, mode=m),
            )
        zf.writestr(f"{base}.xlsx", xlsx_bytes)
    return Response(
        content=buf.getvalue(), media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{base}.zip"'},
    )


@router.post("/template", response_model=ProposalBoardResponse, status_code=201)
async def import_template(
    file: UploadFile = File(...),
    portfolio_id: Optional[int] = Form(None),
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    """Load a saved proposal template .xlsx -> fresh Proposal + V1 (no injection)."""
    if portfolio_id is not None and not db.get(Project, portfolio_id):
        raise HTTPException(404, "Portfolio not found")

    items, info_json, cfg, source_format = await _parse_upload(file, "template")
    pinfo = project_info_from_json(info_json)
    proposal = Proposal(
        title=pinfo.project_title or (file.filename or "Imported Proposal"),
        customer_name=pinfo.customer_name or None,
        project_location=pinfo.project_location or None,
        project_state=pinfo.project_state or None,
        project_size_mw=pinfo.project_size_mw or None,
        portfolio_id=portfolio_id,
        created_by_id=actor.id, updated_by_id=actor.id,
    )
    db.add(proposal)
    db.flush()

    summary = tree_summary(items)
    v = ProposalVersion(
        proposal_id=proposal.id, label=(info_json.get("version") or "V1"),
        tree_json=serialize_tree(items),
        info_json=info_json,
        config_json=_cfg_to_json(cfg),
        computed_start_date=summary["start_date"],
        computed_end_date=summary["end_date"],
        total_price=summary["total_price"],
        source_filename=file.filename,
        source_format=source_format,
        created_by_id=actor.id,
    )
    db.add(v)
    db.flush()
    proposal.current_version_id = v.id
    db.flush()
    return _board(proposal, db)


# ---------------------------------------------------------------------------
# Portfolio tie-in: link / unlink / sync
# ---------------------------------------------------------------------------
def _active_proposal_conflict() -> HTTPException:
    """409 for a lost race on the one-active-proposal-per-Project slot. Shaped
    like _check_stale's body so the UI's existing stale-version handling picks
    it up unchanged."""
    return HTTPException(
        status_code=409,
        detail={
            "error": "stale_version",
            "message": "Someone else just changed the active proposal for this "
                       "project. Reload first.",
        },
    )


def _activate_for_project(p: Proposal, db: Session) -> "Proposal | None":
    """Hand ``p`` the single ACTIVE slot on its Project, demoting the incumbent.
    Returns the proposal that lost the slot (None when there was none) so callers
    can say whose contract of record just became history.

    The demotion is flushed BEFORE the promotion: the partial unique index on
    (project_id) WHERE active is evaluated per statement, so promoting first
    would collide with the very row we are about to demote.
    """
    holders = (db.query(Proposal)
                 .filter(Proposal.project_id == p.project_id,
                         Proposal.id != p.id,
                         Proposal.is_active_for_project.is_(True)))
    incumbent = holders.first()
    holders.update({Proposal.is_active_for_project: False}, synchronize_session=False)
    db.flush()
    p.is_active_for_project = True
    return incumbent


@router.patch("/{pid}/link", response_model=ProposalOut)
def link_portfolio(
    pid: int, payload: ProposalLinkRequest,
    db: Session = Depends(get_db), actor=Depends(require_db_user),
):
    p = _get_proposal(pid, db)
    if not db.get(Project, payload.portfolio_id):
        raise HTTPException(404, "Portfolio not found")
    p.portfolio_id = payload.portfolio_id
    # A direct portfolio link bypasses the project tier — clear any project so it
    # can't dangle against a different portfolio. The ACTIVE slot belongs to a
    # Project, so it goes with it; leaving it set would silently re-activate the
    # proposal the moment it is linked to a project again.
    p.project_id = None
    p.is_active_for_project = False
    p.updated_by_id = actor.id
    p.version = (p.version or 1) + 1
    db.flush()
    return p


@router.patch("/{pid}/link-project", response_model=ProposalLinkProjectResult)
def link_project(
    pid: int, payload: ProposalLinkProjectRequest,
    db: Session = Depends(get_db), actor=Depends(require_db_user),
):
    """Link a proposal to a Project (the tier under a Portfolio). The proposal's
    ``portfolio_id`` is derived from the project's portfolio so portfolio-scoped
    behavior (Sync, lists, CO rollups) keeps working.

    ``make_active`` unset means True — linking has always made the proposal the
    live one, and pre-existing callers must keep that. Pass False to file it as
    history under the project instead.

    Because the default promotes, linking can file the Project's current — often
    signed — proposal as history. That demotion is reported in
    ``demoted_proposal`` so the UI can name it instead of leaving the PM to spot
    the badge move."""
    p = _get_proposal(pid, db)
    _check_stale(payload.expected_version, p.version)
    proj = db.get(PortfolioProject, payload.project_id)
    if not proj:
        raise HTTPException(404, "Project not found")
    p.project_id = proj.id
    p.portfolio_id = proj.portfolio_id   # derive the portfolio from the project
    # Drop the old Project's ACTIVE slot BEFORE anything can flush: carrying it
    # across would collide with the new Project's incumbent on the partial
    # unique index. _activate_for_project re-takes it when make_active.
    p.is_active_for_project = False
    demoted = None
    if payload.make_active is None or payload.make_active:
        demoted = _activate_for_project(p, db)
    p.updated_by_id = actor.id
    p.version = (p.version or 1) + 1
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise _active_proposal_conflict() from exc
    out = ProposalLinkProjectResult.model_validate(p)
    if demoted is not None:
        out.demoted_proposal = ProposalDemotedOut(id=demoted.id, title=demoted.title)
    return out


@router.post("/{pid}/activate-for-project", response_model=ProposalOut)
def activate_proposal_for_project(
    pid: int, db: Session = Depends(get_db), actor=Depends(require_db_user),
):
    """Promote this proposal to the live one for its Project, demoting whichever
    sibling holds the slot today. There is no matching deactivate: "no active
    proposal" is reached by unlinking, or by activating a sibling."""
    p = _get_proposal(pid, db)
    if not p.project_id:
        raise HTTPException(400, "Link the proposal to a project first.")
    if p.is_active_for_project:
        return p        # already live — don't churn the version counter
    _activate_for_project(p, db)
    p.updated_by_id = actor.id
    p.version = (p.version or 1) + 1
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise _active_proposal_conflict() from exc
    return p


@router.patch("/{pid}/unlink", response_model=ProposalOut)
def unlink_portfolio(pid: int, db: Session = Depends(get_db), actor=Depends(require_db_user)):
    p = _get_proposal(pid, db)
    p.portfolio_id = None
    p.project_id = None   # project implies a portfolio, so clear both
    p.is_active_for_project = False   # …and the ACTIVE slot belongs to a project
    p.updated_by_id = actor.id
    p.version = (p.version or 1) + 1
    db.flush()
    return p


@router.post("/{pid}/sync", response_model=ProposalSyncResult)
def sync_to_portfolio(
    pid: int, payload: ProposalSyncRequest,
    db: Session = Depends(get_db), actor=Depends(require_db_user),
):
    p = _get_proposal(pid, db)
    if not p.portfolio_id:
        raise HTTPException(400, "Link the proposal to a portfolio before syncing.")
    portfolio = db.get(Project, p.portfolio_id)
    if not portfolio:
        raise HTTPException(404, "The linked portfolio no longer exists.")

    v = _get_version(p, payload.version_id, db) if payload.version_id else _active_version(p, db)
    if v is None:
        raise HTTPException(400, "No version to sync")

    items, _ = deserialize_tree(v.tree_json)
    rows = tree_to_schedule_rows(items)
    info = project_info_from_json(v.info_json)
    parsed = ParsedScheduleOut(
        version=v.label, source_format=(v.source_format or "xlsx"),
        source_filename=v.source_filename or "",
        project_name=info.project_title or portfolio.name,
        project_start_date=_mdy_to_date((v.config_json or {}).get("project_start", "")),
        total_duration_days=None, total_price=v.total_price,
        items=[ParsedScheduleItemOut(**r) for r in rows],
        parse_engine="proposal",
    )
    # Reuse the existing schedule-save pipeline (creates Schedule + ScheduleItem
    # rows and bumps the portfolio's schedule_version) — a fresh version each sync.
    sched = save_schedule(ScheduleSaveRequest(project_id=p.portfolio_id, parsed=parsed), db)
    p.linked_schedule_id = sched.id
    v.linked_schedule_id = sched.id

    deliverable_count = 0
    if payload.seed_deliverables:
        # Opt-in: seed real deliverables — leaf tasks with a delivery date
        # (section/phase milestones are roll-up markers, not deliverables).
        for r in rows:
            if not r["is_milestone"] and r["finish_date"] is not None:
                db.add(Deliverable(
                    project_id=p.portfolio_id,
                    project_segment=(r["discipline"] or None),
                    task=r["task"],
                    start_status="Not Started",
                    delivery_date=r["finish_date"],
                    source="schedule",
                    schedule_version_added=v.label,
                ))
                deliverable_count += 1

    db.flush()
    return ProposalSyncResult(
        schedule_id=sched.id, schedule_version=sched.version,
        item_count=len(rows), deliverable_count=deliverable_count,
    )


# Proposal section names are verbose ("Civil Engineering", "Substation
# Engineering", "BESS"…); the Timeline discipline enum is short. Map by
# substring so the discipline color tag + engineer-view grouping stay valid;
# default to "Electrical" (the Timeline model default) for anything unmapped so
# we never write a value outside the enum.
def _timeline_discipline(name: "str | None") -> str:
    s = (name or "").lower()
    if "civil" in s or "geotech" in s or "survey" in s:
        return "Civil"
    if "structural" in s:
        return "Structural"
    if "substation" in s or "electrical" in s or "bess" in s or "battery" in s:
        return "Electrical"
    if "water" in s:
        return "Water"
    if any(k in s for k in ("additional", "closeout", "initiation", "permit", "environmental")):
        return "General"
    return "Electrical"


def _timeline_milestone_label(phase: "str | None", task: "str | None", discipline: "str | None") -> "str | None":
    """The bar label: the phase name with a redundant leading discipline prefix
    stripped ("Electrical Engineering – 30% Design" → "30% Design"), clamped to
    the 60-char column."""
    ms = (phase or task or "").strip()
    disc = (discipline or "").strip()
    if disc and ms.lower().startswith(disc.lower()):
        ms = ms[len(disc):].lstrip(" -–—:·").strip()
    return ms[:60] or None


def _proposal_display(p: Proposal, v: ProposalVersion) -> "tuple[str, str | None]":
    """(project_name, client) for a Timeline project derived from a proposal."""
    info = project_info_from_json(v.info_json)
    return (
        info.project_title or p.title or "Untitled Proposal",
        info.customer_name or p.customer_name,
    )


def _proposal_timeline_bars(v: ProposalVersion) -> "tuple[list[dict], int]":
    """Project a version's tree into Timeline bars: one per indent-1 design-phase
    milestone with a real (non-zero) span, plus a fallback bar for any dated
    discipline section that produced no phase. Returns (bars, skipped); each bar
    is {discipline, milestone, start_date, end_date, order_index} with discipline
    already normalized to the Timeline enum. Shared by the bulk send-to-timeline
    import and the milestone palette."""
    items, _ = deserialize_tree(v.tree_json or [])   # NULL tree → empty, not a 500
    rows = tree_to_schedule_rows(items)

    def _dated(r: dict) -> bool:
        # a real, non-degenerate span — skip zero-duration point milestones
        # (Project Initiation / Closeout etc.), which carry no capacity.
        return bool(r["start_date"] and r["finish_date"] and r["finish_date"] > r["start_date"])

    bars: "list[dict]" = []
    skipped = 0
    seen: set = set()
    for r in rows:                       # indent-1 design-phase milestones
        if r["indent_level"] == 1 and r["is_milestone"]:
            if _dated(r):
                bars.append({
                    "discipline": _timeline_discipline(r["discipline"]),
                    "milestone": _timeline_milestone_label(r["phase"], r["task"], r["discipline"]),
                    "start_date": r["start_date"], "end_date": r["finish_date"],
                    "order_index": r["order_index"],
                })
                seen.add(r["discipline"])
            else:
                skipped += 1
    for r in rows:                       # fallback: dated section with no phase
        if r["indent_level"] == 0 and _dated(r) and r["discipline"] not in seen:
            bars.append({
                "discipline": _timeline_discipline(r["discipline"]),
                "milestone": None,
                "start_date": r["start_date"], "end_date": r["finish_date"],
                "order_index": r["order_index"],
            })
            seen.add(r["discipline"])
    return bars, skipped


# Stamped into TimelineProject.notes by the explicit bulk send, and the marker
# that ARMS implicit projection (see _timeline_bulk_sent). A palette drop writes
# the other one, so the two ways a Timeline project can be born stay tellable
# apart after the fact.
_TIMELINE_IMPORT_NOTE = "Imported from proposal"
_TIMELINE_PALETTE_NOTE = "From proposal"


def _proposal_timeline_project(p: Proposal, v: ProposalVersion, db: Session, actor) -> TimelineProject:
    """Get-or-create the Timeline project for a proposal (keyed on
    source_proposal_id), without creating any bars. Used by the palette drop —
    which is why creating one here must NOT arm the implicit projection."""
    proj = (
        db.query(TimelineProject)
        .filter(TimelineProject.source_proposal_id == p.id)
        .order_by(TimelineProject.id)
        .first()
    )
    if proj is None:
        project_name, client = _proposal_display(p, v)
        proj = TimelineProject(
            name=project_name, client=client, status="in_progress",
            source_proposal_id=p.id, notes=f"{_TIMELINE_PALETTE_NOTE} {v.label}",
            created_by_id=actor.id,
        )
        db.add(proj)
        db.flush()
    return proj


def _timeline_bulk_sent(proj: TimelineProject, db: Session) -> bool:
    """Was this proposal ever explicitly bulk-sent to the Timeline?

    NOT the same question as "does a Timeline project exist": the milestone
    palette drops one chip at a time and has to get-or-create the project to land
    it, so keying implicit projection off mere existence turned a single drag
    into a standing order to bulk-import every other phase of the proposal on the
    next save. The explicit send stamps the project notes; any bar it left behind
    that no human has taken over is the fallback, so rewriting those notes on the
    board (they are editable) does not silently disarm the projection.
    """
    if (proj.notes or "").startswith(_TIMELINE_IMPORT_NOTE):
        return True
    return (
        db.query(TimelineAssignment.id)
        .filter(TimelineAssignment.timeline_project_id == proj.id,
                TimelineAssignment.origin == "proposal",
                TimelineAssignment.manual_edit.is_(False))
        .first()
    ) is not None


def _resync_proposal_timeline(p, v, db, actor, *, explicit: bool = False) -> "dict | None":
    """Re-project version `v` onto the proposal's EXISTING Timeline project.

    NO-OP (returns None) when the proposal has never been BULK-SENT to the
    Timeline — a project the milestone palette had to create in passing does not
    count (see _timeline_bulk_sent). ``explicit`` marks the send_to_timeline call
    itself, which is doing the arming and so cannot be gated on it.
    Rebuilds only bars this projection owns and that no human has touched;
    preserves + reports everything else.

    Failing to INTERPRET the proposal (malformed tree_json or info_json) returns
    None rather than raising: there is one transaction per request
    (core/deps.py), so letting a projection error escape would roll back the PM's
    proposal save along with it. A genuine database write failure is deliberately
    NOT swallowed — after a failed flush the session cannot be committed anyway,
    so hiding it would trade a visible 500 for a silently dropped save.
    """
    from datetime import datetime          # house style: function-local import
    proj = (db.query(TimelineProject)
              .filter(TimelineProject.source_proposal_id == p.id)
              .order_by(TimelineProject.id).first())
    if proj is None:
        return None                                    # guard rail 1
    if not explicit and not _timeline_bulk_sent(proj, db):
        return None                                    # guard rail 1b
    try:
        bars, skipped = _proposal_timeline_bars(v)
        # Resolved inside the same guard: project_info_from_json reads
        # PM-supplied info_json, so it is the other half of the "bad stored JSON
        # must not cost the caller their save" risk.
        renamed = _proposal_display(p, v) if explicit else None
    except Exception:
        return None                                    # guard rail 3
    if not bars:
        return None                                    # guard rail 2 (never a 422)

    existing = (db.query(TimelineAssignment)
                  .filter(TimelineAssignment.timeline_project_id == proj.id).all())
    protected = [a for a in existing if a.manual_edit or a.origin != "proposal"]
    protected_keys = {(a.discipline, a.milestone) for a in protected}
    # The subset of `protected` this projection could ever have owned. A bar the
    # PM built on the board themselves (origin="manual" — right-click Add, ⧉
    # Duplicate) still blocks a duplicate via protected_keys, but it is their own
    # entry: counting it as a "preserved" proposal bar overstated the tally, and
    # reporting it as a vanished phase nagged them on every single save to fix a
    # bar that was never a proposal phase in the first place.
    owned_manual = [a for a in existing if a.origin == "proposal" and a.manual_edit]
    auto: dict = {}
    for a in existing:
        if a.origin == "proposal" and not a.manual_edit:
            auto.setdefault((a.discipline, a.milestone), []).append(a)
    live_keys = {(b["discipline"], b["milestone"]) for b in bars}

    added = updated = removed = 0
    for b in bars:
        key = (b["discipline"], b["milestone"])
        rows = auto.get(key) or []
        if rows:
            # Re-date the auto row even when a protected bar shares this key.
            # Skipping on `key in protected_keys` (as this once did) left the auto
            # sibling un-dated AND stranded it in the leftovers below — so a phase
            # that was still perfectly live lost its bar because some other bar
            # happened to carry the same (discipline, milestone) pair.
            a = rows.pop(0)                            # reuse the row -> id is stable
            if (a.start_date != b["start_date"] or a.end_date != b["end_date"]
                    or (a.order_index or 0) != b["order_index"]):
                a.start_date = b["start_date"]
                a.end_date = b["end_date"]
                a.order_index = b["order_index"]
                a.version = (a.version or 1) + 1
                a.updated_at = datetime.utcnow()
                updated += 1
        elif key in protected_keys:
            continue          # a PM owns this phase — don't add a duplicate bar
        else:
            db.add(TimelineAssignment(
                timeline_project_id=proj.id, resource_id=None,
                discipline=b["discipline"], milestone=b["milestone"],
                start_date=b["start_date"], end_date=b["end_date"],
                utilization=1.0, status=None, label=None,
                order_index=b["order_index"],
                origin="proposal", manual_edit=False,
                created_by_id=actor.id))
            added += 1

    # Leftover auto rows are REPORTED, never deleted. `origin`/`manual_edit` are
    # only trustworthy for bars this code created after fb1a2b3c4d5e6; that
    # migration back-stamped every pre-existing UNASSIGNED bar on a
    # proposal-sourced project as auto, and some of those were placed by a human
    # (a palette drop onto the Unassigned row, a bar dragged back off an
    # engineer, or a bar whose engineer was later deleted from the roster — none
    # of which left a marker, because patch_assignment only began latching
    # manual_edit in that same batch). Deleting on that basis destroyed real
    # scheduling work on the next ordinary save, so an implicit resync now only
    # ever adds and re-dates. A stale bar the PM can see and remove beats one we
    # silently removed for them.
    stale = [a for rows in auto.values() for a in rows]

    # Split by who owns the stranded bar: a human's is actionable (relink it or
    # delete it), ours is informational (safe to delete, we just no longer do it
    # for them). `orphaned` stays the concatenation so existing readers keep
    # working — it only loses the origin="manual" rows that never belonged in it.
    orphaned_manual = [a for a in owned_manual
                       if (a.discipline, a.milestone) not in live_keys]
    orphaned = orphaned_manual + stale
    if renamed is not None:                            # ONLY from send_to_timeline
        proj.name, proj.client = renamed
        proj.notes = f"{_TIMELINE_IMPORT_NOTE} {v.label}"
    db.flush()

    def _orphan(a) -> dict:
        return {"assignment_id": a.id, "discipline": a.discipline,
                "milestone": a.milestone, "resource_id": a.resource_id,
                "start_date": a.start_date, "end_date": a.end_date}

    return {
        "timeline_project_id": proj.id, "version_label": v.label,
        "bars_added": added, "bars_updated": updated, "bars_removed": removed,
        "preserved_manual": len(owned_manual), "skipped_no_dates": skipped,
        "orphaned": [_orphan(a) for a in orphaned],
        "orphaned_manual": [_orphan(a) for a in orphaned_manual],
        "orphaned_auto": [_orphan(a) for a in stale],
    }


@router.post("/{pid}/send-to-timeline", response_model=ProposalToTimelineResult)
def send_to_timeline(
    pid: int, payload: ProposalToTimelineRequest,
    db: Session = Depends(get_db), actor=Depends(require_db_user),
):
    """Bulk-project a proposal version's schedule into the Timeline: one
    TimelineProject + one UNASSIGNED bar per design-phase milestone, at the
    schedule's dates. Re-import updates the prior import in place (keyed off the
    exact source_proposal_id).

    This is the only endpoint that ARMS implicit projection: a proposal save
    re-dates the Timeline only once a PM has explicitly sent it here. A palette
    drop also creates the TimelineProject (it has to, to land the bar), but it
    stakes no claim on the rest of the schedule."""
    p = _get_proposal(pid, db)
    v = _get_version(p, payload.version_id, db) if payload.version_id else _active_version(p, db)
    if v is None:
        raise HTTPException(422, "No version to send to the Timeline")

    bars, skipped = _proposal_timeline_bars(v)
    if not bars:
        raise HTTPException(
            422, "This version has no dated design-phase milestones to send to the Timeline."
        )

    # Get-or-create first, then run the same projection every implicit resync
    # uses — so the explicit button and an automatic re-date can never diverge.
    # `replace_existing` is now moot: the projection re-dates the bars it owns in
    # place instead of delete+insert, and anything a PM has touched is preserved
    # and reported rather than replaced.
    proj = _proposal_timeline_project(p, v, db, actor)
    rs = _resync_proposal_timeline(p, v, db, actor, explicit=True) or {}

    count = (
        db.query(TimelineAssignment)
        .filter(TimelineAssignment.timeline_project_id == proj.id)
        .count()
    )
    return ProposalToTimelineResult(
        timeline_project_id=proj.id, project_name=proj.name,
        assignment_count=count,
        # "a prior import was replaced" now means "bars that already existed were
        # re-dated or dropped" — nothing is deleted-and-recreated any more.
        replaced_existing=bool(rs.get("bars_updated") or rs.get("bars_removed")),
        skipped_no_dates=rs.get("skipped_no_dates", skipped),
        start_date=min(b["start_date"] for b in bars),
        end_date=max(b["end_date"] for b in bars),
        preserved_manual=rs.get("preserved_manual", 0),
        orphaned=rs.get("orphaned", []),
        orphaned_manual=rs.get("orphaned_manual", []),
        orphaned_auto=rs.get("orphaned_auto", []),
    )


@router.get("/{pid}/timeline-milestones", response_model=ProposalTimelineMilestonesOut)
def timeline_milestones(
    pid: int, version_id: Optional[int] = Query(None),
    db: Session = Depends(get_db), actor=Depends(require_db_user),
):
    """A proposal version's design-phase milestones as a draggable Timeline
    palette (read-only, no persistence). Includes the linked Timeline project id
    when one already exists, so the board can route drops to it."""
    p = _get_proposal(pid, db)
    v = _get_version(p, version_id, db) if version_id else _active_version(p, db)
    if v is None:
        raise HTTPException(422, "No version on this proposal")
    project_name, _client = _proposal_display(p, v)
    bars, _ = _proposal_timeline_bars(v)
    existing = (
        db.query(TimelineProject.id)
        .filter(TimelineProject.source_proposal_id == p.id)
        .order_by(TimelineProject.id)
        .first()
    )
    return ProposalTimelineMilestonesOut(
        proposal_id=p.id, project_name=project_name,
        version_id=v.id, version_label=v.label,
        timeline_project_id=(existing[0] if existing else None),
        milestones=[
            ProposalTimelineMilestoneOut(
                discipline=b["discipline"], milestone=b["milestone"],
                start_date=b["start_date"], end_date=b["end_date"],
            )
            for b in bars
        ],
    )


@router.post("/{pid}/timeline-bar", response_model=ProposalTimelineBarResult, status_code=201)
def place_timeline_bar(
    pid: int, payload: ProposalTimelineBarRequest,
    db: Session = Depends(get_db), actor=Depends(require_db_user),
):
    """Place ONE proposal milestone onto the board as an assignment (palette
    drag-drop). Ensures the proposal's Timeline project exists (get-or-create, no
    bulk bars), then creates the assignment for the dropped resource + dates.

    Creating that project is deliberately NOT an opt-in to bulk projection: the
    palette exists to staff proposals one chip at a time (the board only offers
    proposals that are not already on it), so a single drag must not sign the PM
    up for a bar per phase on their next proposal save. "Send to Timeline" is
    what asks for the whole schedule.

    A drop is a deliberate human placement, so the bar is born ``manual_edit``
    and the auto-resync leaves it alone. It matters most for a drop onto the
    Unassigned row: keyed only on ``resource_id IS NULL`` it would otherwise be
    indistinguishable from an auto-generated bar and be deleted on the next
    proposal save."""
    from datetime import datetime
    p = _get_proposal(pid, db)
    v = _get_version(p, payload.version_id, db) if payload.version_id else _active_version(p, db)
    if v is None:
        raise HTTPException(422, "No version on this proposal")
    if payload.end_date < payload.start_date:
        raise HTTPException(422, "end_date is before start_date")
    if payload.resource_id is not None and not db.get(TimelineResource, payload.resource_id):
        raise HTTPException(404, "Resource not found")

    proj = _proposal_timeline_project(p, v, db, actor)
    a = TimelineAssignment(
        timeline_project_id=proj.id,
        resource_id=payload.resource_id,
        discipline=(_timeline_discipline(payload.discipline) if payload.discipline else "Electrical"),
        milestone=((payload.milestone or "")[:60] or None),
        start_date=payload.start_date, end_date=payload.end_date,
        utilization=(payload.utilization if payload.utilization is not None else 1.0),
        status=None, label=None, order_index=0,
        origin="proposal", manual_edit=True, manual_edit_at=datetime.utcnow(),
        created_by_id=actor.id,
    )
    db.add(a)
    db.flush()
    return ProposalTimelineBarResult(timeline_project_id=proj.id, assignment_id=a.id)
