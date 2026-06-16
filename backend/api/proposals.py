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
)
from schemas.common import (
    ProposalOut, ProposalListItem, ProposalVersionOut, ProposalVersionDetail,
    ProposalBoardResponse, ProposalPatch, ProposalTreePut, ProposalRecomputeRequest,
    ProposalLinkRequest, ProposalSyncRequest, ProposalSyncResult,
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
    from datetime import datetime
    return ScheduleConfig(
        project_start=d.get("project_start") or datetime.now().strftime("%m/%d/%y"),
        utilization_percent=float(d.get("utilization_percent", 100.0) or 100.0),
        fs_start_next_day=bool(d.get("fs_start_next_day", False)),
        disabled_holidays=frozenset(d.get("disabled_holidays") or ()),
        custom_holidays=frozenset(d.get("custom_holidays") or ()),
    )


def _cfg_to_json(cfg: ScheduleConfig) -> dict:
    return {
        "project_start": cfg.project_start,
        "utilization_percent": cfg.utilization_percent,
        "fs_start_next_day": cfg.fs_start_next_day,
        "disabled_holidays": sorted(cfg.disabled_holidays),
        "custom_holidays": sorted(cfg.custom_holidays),
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
    n = 0
    for v in proposal.versions:
        m = re.match(r"[vV]?(\d+)", v.label or "")
        if m:
            n = max(n, int(m.group(1)))
    return f"V{n + 1}"


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


def _build_proposal_pdf(v: ProposalVersion) -> bytes:
    """Render page-1 milestones table + page-2 Gantt and merge → PDF bytes."""
    items, id_map = deserialize_tree(v.tree_json)
    cfg = _cfg_from_json(v.config_json)
    info = project_info_from_json(v.info_json)
    opts = v.info_json or {}

    # PDF export options (desktop parity): table mode, milestones-only, gantt toggle.
    mode = (opts.get("schedule_table_mode") or "both")
    milestones_only = bool(opts.get("milestones_only_pdf", False))
    include_gantt = bool(opts.get("include_gantt", True))

    # Brand the deliverable with the Castillo logo (top-right of both pages),
    # falling back to any logo stored on the version's info.
    logo = info.logo_path or brand_logo_path()
    info.logo_path = logo

    table_bytes = render_schedule_table_bytes(
        items, info, disabled_holidays=cfg.disabled_holidays,
        mode=mode, milestones_only=milestones_only,
        project_utilization=cfg.utilization_percent,
    )

    gantt_bytes = None
    if include_gantt:
        rows = build_gantt_rows(
            items,
            project_utilization=cfg.utilization_percent,
            project_end_date=get_project_end_date(id_map),
            project_start_date=cfg.project_start,
        )
        if rows:
            gantt_bytes = render_gantt_bytes(
                rows, title="Project Schedule",
                project_title=info.project_title, customer_name=info.customer_name,
                version=info.version, project_location=info.project_location,
                project_state=info.project_state, project_size_mw=info.project_size_mw,
                logo_path=logo,
            )
    return _merge_pdfs(table_bytes, gantt_bytes)


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
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    q = db.query(Proposal)
    if portfolio_id is not None:
        q = q.filter(Proposal.portfolio_id == portfolio_id)
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


@router.delete("/{pid}", status_code=204)
def delete_proposal(pid: int, db: Session = Depends(get_db), actor=Depends(require_db_user)):
    db.delete(_get_proposal(pid, db))
    return None


# ---------------------------------------------------------------------------
# Versions: edit tree / recompute / snapshot / activate
# ---------------------------------------------------------------------------
@router.put("/{pid}/versions/{vid}/tree", response_model=ProposalVersionDetail)
def put_tree(
    pid: int, vid: int, payload: ProposalTreePut,
    db: Session = Depends(get_db), actor=Depends(require_db_user),
):
    p = _get_proposal(pid, db)
    v = _get_version(p, vid, db)
    _check_stale(payload.expected_version, v.version, "proposal version")

    items, id_map = deserialize_tree([n.model_dump() for n in payload.tree])
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
@router.post("/{pid}/versions/{vid}/pdf")
def generate_pdf(
    pid: int, vid: int,
    db: Session = Depends(get_db), actor=Depends(require_db_user),
):
    p = _get_proposal(pid, db)
    v = _get_version(p, vid, db)
    merged = _build_proposal_pdf(v)
    title = (v.info_json or {}).get("project_title") or p.title
    fname = _safe_filename(f"{title}-{v.label}-Project-Schedule") + ".pdf"
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
        content = _build_proposal_pdf(v)
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
    p.updated_by_id = actor.id
    p.version = (p.version or 1) + 1
    db.flush()
    return p


@router.patch("/{pid}/unlink", response_model=ProposalOut)
def unlink_portfolio(pid: int, db: Session = Depends(get_db), actor=Depends(require_db_user)):
    p = _get_proposal(pid, db)
    p.portfolio_id = None
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
