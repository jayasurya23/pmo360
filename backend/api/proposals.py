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
    ProposalLinkRequest, ProposalLinkProjectRequest, ProposalSyncRequest, ProposalSyncResult,
    ProposalToTimelineRequest, ProposalToTimelineResult,
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
    tree_summary, tree_to_schedule_rows, _mdy_to_date,
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
    name = (file.filename or "").lower()
    if not (name.endswith(".xlsx") or name.endswith(".xlsm")):
        raise HTTPException(400, "Proposal upload must be a Castillo cost workbook (.xlsx / .xlsm).")
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    if portfolio_id is not None and not db.get(Project, portfolio_id):
        raise HTTPException(404, "Portfolio not found")

    suffix = ".xlsm" if name.endswith(".xlsm") else ".xlsx"
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    try:
        tmp.write(data)
        tmp.close()
        try:
            items, _id_map, info, cfg = parse_workbook_to_tree(
                tmp.name, project_start=project_start,
                utilization_percent=utilization_percent,
            )
        except Exception as exc:  # noqa: BLE001 — surface a clean 400 to the UI
            raise HTTPException(400, f"Could not parse workbook: {exc}") from exc
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass

    pinfo = info_dict_to_project_info(info)
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
        info_json=build_info_json(info, pinfo),
        config_json=_cfg_to_json(cfg),
        computed_start_date=summary["start_date"],
        computed_end_date=summary["end_date"],
        total_price=summary["total_price"],
        source_filename=file.filename, source_format=suffix.lstrip("."),
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
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    q = db.query(Proposal)
    if portfolio_id is not None:
        q = q.filter(Proposal.portfolio_id == portfolio_id)
    if project_id is not None:
        q = q.filter(Proposal.project_id == project_id)
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
    return _version_detail(v)


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
    return _version_detail(v)


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
    nv = ProposalVersion(
        proposal_id=p.id, label=label,
        tree_json=copy.deepcopy(active.tree_json),
        info_json=new_info,
        config_json=copy.deepcopy(active.config_json),
        computed_start_date=active.computed_start_date,
        computed_end_date=active.computed_end_date,
        total_price=active.total_price,
        source_filename=active.source_filename, source_format=active.source_format,
        created_by_id=actor.id,
    )
    db.add(nv)
    db.flush()
    p.current_version_id = nv.id
    db.flush()
    return _board(p, db)


@router.post("/{pid}/versions/{vid}/activate", response_model=ProposalBoardResponse)
def activate_version(
    pid: int, vid: int,
    db: Session = Depends(get_db), actor=Depends(require_db_user),
):
    p = _get_proposal(pid, db)
    v = _get_version(p, vid, db)
    p.current_version_id = v.id
    db.flush()
    return _board(p, db)


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
    name = (file.filename or "").lower()
    if not (name.endswith(".xlsx") or name.endswith(".xlsm")):
        raise HTTPException(400, "Template must be a saved proposal workbook (.xlsx / .xlsm).")
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    if portfolio_id is not None and not db.get(Project, portfolio_id):
        raise HTTPException(404, "Portfolio not found")

    try:
        parsed = read_template_xlsx(data)
    except Exception as exc:  # noqa: BLE001 — surface a clean 400 to the UI
        raise HTTPException(400, f"Could not read template workbook: {exc}") from exc

    # Reconstruct the live tree (no build_tree node-injection) + recompute dates.
    items, id_map = deserialize_tree(parsed["tree_json"])
    cfg = _cfg_from_json(parsed["config_json"])
    if not cfg.project_start:
        from datetime import datetime
        cfg.project_start = datetime.now().strftime("%m/%d/%y")
    try:
        calculate_all_dates(items, id_map, cfg)
    except CircularDependencyError as exc:
        raise HTTPException(422, str(exc)) from exc

    info_json = parsed["info_json"]
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
        source_format=("xlsm" if name.endswith(".xlsm") else "xlsx"),
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
    # can't dangle against a different portfolio.
    p.project_id = None
    p.updated_by_id = actor.id
    p.version = (p.version or 1) + 1
    db.flush()
    return p


@router.patch("/{pid}/link-project", response_model=ProposalOut)
def link_project(
    pid: int, payload: ProposalLinkProjectRequest,
    db: Session = Depends(get_db), actor=Depends(require_db_user),
):
    """Link a proposal to a Project (the tier under a Portfolio). The proposal's
    ``portfolio_id`` is derived from the project's portfolio so portfolio-scoped
    behavior (Sync, lists, CO rollups) keeps working."""
    p = _get_proposal(pid, db)
    _check_stale(payload.expected_version, p.version)
    proj = db.get(PortfolioProject, payload.project_id)
    if not proj:
        raise HTTPException(404, "Project not found")
    p.project_id = proj.id
    p.portfolio_id = proj.portfolio_id   # derive the portfolio from the project
    p.updated_by_id = actor.id
    p.version = (p.version or 1) + 1
    db.flush()
    return p


@router.patch("/{pid}/unlink", response_model=ProposalOut)
def unlink_portfolio(pid: int, db: Session = Depends(get_db), actor=Depends(require_db_user)):
    p = _get_proposal(pid, db)
    p.portfolio_id = None
    p.project_id = None   # project implies a portfolio, so clear both
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


def _proposal_timeline_project(p: Proposal, v: ProposalVersion, db: Session, actor) -> TimelineProject:
    """Get-or-create the Timeline project for a proposal (keyed on
    source_proposal_id), without creating any bars. Used by the palette drop."""
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
            source_proposal_id=p.id, notes=f"From proposal {v.label}",
            created_by_id=actor.id,
        )
        db.add(proj)
        db.flush()
    return proj


@router.post("/{pid}/send-to-timeline", response_model=ProposalToTimelineResult)
def send_to_timeline(
    pid: int, payload: ProposalToTimelineRequest,
    db: Session = Depends(get_db), actor=Depends(require_db_user),
):
    """Bulk-project a proposal version's schedule into the Timeline: one
    TimelineProject + one UNASSIGNED bar per design-phase milestone, at the
    schedule's dates. Re-import replaces the prior import (keyed off the exact
    source_proposal_id)."""
    p = _get_proposal(pid, db)
    v = _get_version(p, payload.version_id, db) if payload.version_id else _active_version(p, db)
    if v is None:
        raise HTTPException(422, "No version to send to the Timeline")
    project_name, client = _proposal_display(p, v)

    bars, skipped = _proposal_timeline_bars(v)
    if not bars:
        raise HTTPException(
            422, "This version has no dated design-phase milestones to send to the Timeline."
        )

    # One Timeline project per proposal (get-or-create on the unique
    # source_proposal_id). The refresh is NON-DESTRUCTIVE of a PM's work: when
    # replace_existing, we remove only the prior auto-generated UNASSIGNED bars
    # and re-add the schedule's phases — bars staffed onto an engineer
    # (resource_id set, e.g. dragged from the milestone palette) are kept, and we
    # don't re-add an unassigned duplicate of a phase already staffed. So "Send
    # to Timeline" can never wipe palette/manual placements.
    proj = _proposal_timeline_project(p, v, db, actor)
    proj.name = project_name
    proj.client = client
    proj.notes = f"Imported from proposal {v.label}"

    existing = (
        db.query(TimelineAssignment)
        .filter(TimelineAssignment.timeline_project_id == proj.id)
        .all()
    )
    staffed = {(a.discipline, a.milestone) for a in existing if a.resource_id is not None}
    kept = sum(1 for a in existing if a.resource_id is not None)
    replaced = False
    if payload.replace_existing:
        for a in existing:
            if a.resource_id is None:
                db.delete(a)
                replaced = True

    added = 0
    for b in bars:
        if (b["discipline"], b["milestone"]) in staffed:
            continue   # already placed onto someone — leave it as-is
        db.add(TimelineAssignment(
            timeline_project_id=proj.id, resource_id=None,
            discipline=b["discipline"], milestone=b["milestone"],
            start_date=b["start_date"], end_date=b["end_date"],
            utilization=1.0, status=None, label=None,
            order_index=b["order_index"], created_by_id=actor.id,
        ))
        added += 1

    db.flush()
    return ProposalToTimelineResult(
        timeline_project_id=proj.id, project_name=project_name,
        assignment_count=added + kept, replaced_existing=replaced,
        skipped_no_dates=skipped,
        start_date=min(b["start_date"] for b in bars),
        end_date=max(b["end_date"] for b in bars),
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
    bulk bars), then creates the assignment for the dropped resource + dates."""
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
        created_by_id=actor.id,
    )
    db.add(a)
    db.flush()
    return ProposalTimelineBarResult(timeline_project_id=proj.id, assignment_id=a.id)
