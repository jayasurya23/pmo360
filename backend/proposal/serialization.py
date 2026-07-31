"""Persistence + projection glue for the proposal module — framework-free.

Three jobs, all pure-Python (no web/ORM/pydantic coupling, so the package stays
importable on its own):

  parse_workbook_to_tree   workbook path -> scheduled ProposalItem tree + info
                           (wires build_model_rows -> flatten_to_template_rows
                           -> build_tree -> calculate_all_dates, exactly as the
                           desktop "Parse Workbook" button did).

  serialize_tree / deserialize_tree
                           ProposalItem tree <-> JSON-safe list[dict] for the
                           proposal_versions.tree_json column. Drops the
                           transient .parent (rebuilt on load); preserves
                           predecessor_type_user_set so __post_init__ never
                           clobbers a user's chosen predecessor type on reload.

  tree_to_schedule_rows    scheduled tree -> the plain row dicts PMO 360's
                           ScheduleItem/save_schedule pipeline consumes (the
                           "Sync to portfolio" projection). 0/1/2 indent maps
                           straight onto discipline/phase/task.
"""
from __future__ import annotations

from datetime import datetime, date
from typing import Optional

from .models import ProposalItem, ProjectInfo
from .parsing import build_model_rows, flatten_to_template_rows
from .scheduling import build_tree, calculate_all_dates, ScheduleConfig

# The desktop tool's fixed Client-Review insertion points (Full_proposal_V9.py:2032).
DEFAULT_REVIEW_PAIRS = {
    ("Civil", "30%"), ("Civil", "60%"),
    ("Electrical", "30%"), ("Electrical", "60%"),
}
HOURS_PER_DAY = 8.0  # desktop default (Full_proposal_V9.py:2036)
# Castillo product default for the "Client Review Days" field (intentional
# divergence from the desktop, whose field defaults to 0 / no-override). On a
# fresh workbook parse every Client Review task is set to this many days.
DEFAULT_CLIENT_REVIEW_DAYS = 5

# Scalar ProposalItem fields persisted per node (everything except children/parent).
_ITEM_FIELDS = (
    "name", "duration", "price", "start_date", "end_date", "is_milestone",
    "indent_level", "id", "predecessor_id", "predecessor_type",
    "predecessor_type_user_set", "lag", "targeted_hours", "is_start_pinned",
    "enabled", "price_only", "show_start_date", "show_end_date", "locked",
    "task_utilization", "parent_id",
)


# ---------------------------------------------------------------------------
# Date helpers (the runtime tree stores dates as "%m/%d/%y" strings)
# ---------------------------------------------------------------------------
def _to_mdy(value) -> str:
    """Normalize a date/ISO/`%m/%d/%y` value to the runtime `%m/%d/%y` string."""
    if value in (None, ""):
        return ""
    if isinstance(value, datetime):
        return value.strftime("%m/%d/%y")
    if isinstance(value, date):
        return value.strftime("%m/%d/%y")
    s = str(value).strip()
    for fmt in ("%m/%d/%y", "%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).strftime("%m/%d/%y")
        except ValueError:
            continue
    # Last resort: an ISO datetime prefix
    try:
        return datetime.fromisoformat(s[:19]).strftime("%m/%d/%y")
    except ValueError:
        pass
    # Mirror the desktop's tolerant pandas parse (Full_proposal_V9.py:9105-9119)
    # for oddly-formatted Date cells (e.g. "15-Jun-2026", "June 15, 2026").
    try:
        import pandas as _pd
        return _pd.to_datetime(s).strftime("%m/%d/%y")
    except Exception:
        return s


def _mdy_to_date(value: str) -> Optional[date]:
    """`%m/%d/%y` string -> date (None when empty/unparseable)."""
    if not value:
        return None
    s = str(value).strip()
    for fmt in ("%m/%d/%y", "%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


# ---------------------------------------------------------------------------
# Workbook -> scheduled tree (the "Parse Workbook" pipeline)
# ---------------------------------------------------------------------------
def parse_workbook_to_tree(
    path: str,
    *,
    project_start: Optional[str] = None,
    utilization_percent: float = 100.0,
    fs_start_next_day: bool = True,
    disabled_holidays: Optional[frozenset] = None,
    custom_holidays: Optional[frozenset] = None,
    price_source: str = "proposal",
):
    """Parse a Castillo cost workbook into a fully-scheduled ProposalItem tree.

    Returns ``(template_items, item_id_map, info_dict, cfg)``. ``project_start``
    is `%m/%d/%y`; when omitted it falls back to the workbook's Date cell, then
    to today — mirroring the desktop's project-start field default.
    """
    buckets, info = build_model_rows(path)
    rows_out = flatten_to_template_rows(
        buckets=buckets,
        hours_per_day=HOURS_PER_DAY,
        price_source=(price_source or "proposal").strip().lower(),
        review_pairs=DEFAULT_REVIEW_PAIRS,
    )
    template_items, item_id_map, _task_counter = build_tree(rows_out)

    # Apply the default Client Review Days override (5) to every Client Review
    # task before scheduling, so a freshly parsed proposal starts with 5-day
    # reviews (mirrors the desktop's _apply_client_review_change, but seeded by
    # default rather than only on a manual field edit).
    for _it in item_id_map.values():
        if not _it.is_milestone and "client review" in (_it.name or "").lower():
            _it.duration = DEFAULT_CLIENT_REVIEW_DAYS

    start = _to_mdy(project_start) if project_start else _to_mdy(info.get("date"))
    if not start:
        start = datetime.now().strftime("%m/%d/%y")

    cfg = ScheduleConfig(
        project_start=start,
        utilization_percent=float(utilization_percent or 100.0),
        fs_start_next_day=bool(fs_start_next_day),
        disabled_holidays=frozenset(disabled_holidays or ()),
        custom_holidays=frozenset(custom_holidays or ()),
    )
    calculate_all_dates(template_items, item_id_map, cfg)
    return template_items, item_id_map, info, cfg


# ---------------------------------------------------------------------------
# Tree <-> JSON
# ---------------------------------------------------------------------------
def serialize_tree(items) -> list[dict]:
    """Recursive tree -> JSON-safe dicts. Drops the transient ``.parent``."""
    out = []
    for it in items:
        node = {f: getattr(it, f) for f in _ITEM_FIELDS}
        node["children"] = serialize_tree(it.children)
        out.append(node)
    return out


def _adopt_unsaved_rows(items, item_id_map):
    """Give every row an id, and register it.

    Rows added in the UI arrive with ``id: null`` (blankNode in Proposals.tsx) and
    nothing has ever minted one. That matters because calculate_all_dates walks
    ``item_id_map.values()`` — a row missing from the map is invisible to the
    scheduler, so it silently never gets a start or finish date no matter how
    valid its duration and predecessor are. That was the whole "Client Review
    under a new section shows no dates" symptom: not a section-name problem, an
    unaddressable-row problem, and it hit every hand-added row equally.

    Ids continue from the highest in use so a new row can never collide with, or
    steal a predecessor reference from, an existing one.
    """
    def walk(nodes):
        for n in nodes:
            yield n
            yield from walk(n.children)

    all_nodes = list(walk(items))
    next_id = max((n.id for n in all_nodes if n.id is not None), default=0) + 1
    for n in all_nodes:
        if n.id is None:
            n.id = next_id
            next_id += 1
            item_id_map[n.id] = n
        # A hand-added row also arrives with no parent_id; the tree already knows
        # its parent, so fill it in rather than leaving a half-wired node behind.
        if n.parent_id is None and n.parent is not None:
            n.parent_id = n.parent.id


def deserialize_tree(tree_json):
    """JSON dicts -> ProposalItem tree. Rebuilds ``.parent`` + an id map.

    Mirrors only build_tree's parent-wiring loop — NOT its node-injection step
    (Client Review / Record Drawings are already baked into the stored tree).
    """
    item_id_map: dict = {}

    def build(nodes, parent=None):
        result = []
        for n in nodes:
            kwargs = {f: n.get(f) for f in _ITEM_FIELDS if f in n}
            # predecessor_type_user_set is persisted so __post_init__ leaves a
            # user-chosen predecessor_type intact.
            it = ProposalItem(**{k: v for k, v in kwargs.items() if k != "name"},
                              name=n.get("name", ""))
            it.parent = parent
            if it.id is not None:
                item_id_map[it.id] = it
            it.children = build(n.get("children", []), it)
            result.append(it)
        return result

    items = build(tree_json)
    _adopt_unsaved_rows(items, item_id_map)
    # Re-assert the desktop's type defaults (electrical "study" -> FS) the same
    # way calculate_all_dates does each run (Full_proposal_V9.py:6225,
    # only_type_defaults=True). Without this, ProposalItem.__post_init__ would
    # flip an electrical study task's stored FS back to FF on every reload
    # (it isn't predecessor_type_user_set), corrupting Save-Excel / PDF output.
    from .scheduling import apply_default_link_rules
    apply_default_link_rules(items, only_type_defaults=True)
    return items, item_id_map


# ---------------------------------------------------------------------------
# ProjectInfo <-> persistable dict
# ---------------------------------------------------------------------------
def info_dict_to_project_info(info: dict) -> ProjectInfo:
    """Map the parser's ``extract_project_info`` dict onto a ProjectInfo."""
    info = info or {}
    size = info.get("project_size_mw")
    return ProjectInfo(
        project_title=str(info.get("project") or "").strip(),
        customer_name=str(info.get("client") or "").strip(),
        project_location=str(info.get("project_location") or "").strip(),
        project_state=str(info.get("project_state") or "").strip(),
        project_size_mw=("" if size in (None, "") else str(size)),
        version=str(info.get("version") or "V1").strip() or "V1",
    )


def build_info_json(info: dict, project_info: ProjectInfo) -> dict:
    """info_json payload: ProjectInfo fields + every desktop project-info extra.

    Seeds the full option set the Tkinter tool exposed (PDF modes, financial
    adders, price source, logos) with the desktop defaults so the React panel
    shows correct initial values on first load. ``_num`` keeps a parser-provided
    value when present, else the desktop default.
    """
    info = info or {}

    def _num(key, default):
        v = info.get(key)
        return v if v is not None else default

    return {
        "project_title": project_info.project_title,
        "customer_name": project_info.customer_name,
        "project_location": project_info.project_location,
        "project_state": project_info.project_state,
        "project_size_mw": project_info.project_size_mw,
        "version": project_info.version,
        # extras carried for fidelity (not on ProjectInfo)
        "date": _to_mdy(info.get("date")) if info.get("date") else "",
        # financial (parsed from the workbook when available, else desktop defaults)
        "deposit_percent": _num("deposit_percent", 30.0),
        # PDF / export options (desktop defaults)
        "schedule_table_mode": info.get("schedule_table_mode", "both"),
        # Multi-select set of table modes bundled into the ZIP (the single PDF
        # picks "both" when selected, else the first). Defaults: Price Only +
        # Dates Only + Both, all bundled together.
        "schedule_table_modes": info.get("schedule_table_modes")
        or ["price_only", "dates_only", "both"],
        "include_gantt": bool(info.get("include_gantt", True)),
        "milestones_only_pdf": bool(info.get("milestones_only_pdf", False)),
        "price_source": info.get("price_source", "proposal"),
        # Client-Review days is a derived action value; persist last-used (OQ#1)
        "client_review_days": int(
            info.get("client_review_days", DEFAULT_CLIENT_REVIEW_DAYS)
            if info.get("client_review_days") not in (None, "")
            else DEFAULT_CLIENT_REVIEW_DAYS
        ),
        # logos (paths; upload is a follow-up — "" => bundled Castillo logo)
        "logo_path": info.get("logo_path", ""),
        "client_logo_path": info.get("client_logo_path", ""),
    }


def project_info_from_json(info_json: dict) -> ProjectInfo:
    info_json = info_json or {}
    return ProjectInfo(
        project_title=info_json.get("project_title", ""),
        customer_name=info_json.get("customer_name", ""),
        project_location=info_json.get("project_location", ""),
        project_state=info_json.get("project_state", ""),
        project_size_mw=info_json.get("project_size_mw", ""),
        version=info_json.get("version", "V1") or "V1",
        logo_path=info_json.get("logo_path", "") or "",
        client_logo_path=info_json.get("client_logo_path", "") or "",
    )


# ---------------------------------------------------------------------------
# Tree roll-up summary (for denormalized columns + list views)
# ---------------------------------------------------------------------------
def tree_summary(items) -> dict:
    """Earliest start / latest end / summed top-level price across the tree."""
    starts, ends = [], []

    def walk(nodes):
        for it in nodes:
            if not it.enabled:
                continue
            d0, d1 = _mdy_to_date(it.start_date), _mdy_to_date(it.end_date)
            if d0:
                starts.append(d0)
            if d1:
                ends.append(d1)
            walk(it.children)

    walk(items)
    total_price = sum(int(it.price or 0) for it in items
                      if it.enabled and it.indent_level == 0)
    return {
        "start_date": min(starts) if starts else None,
        "end_date": max(ends) if ends else None,
        "total_price": total_price,
    }


# ---------------------------------------------------------------------------
# Projection -> PMO 360 schedule rows ("Sync to portfolio")
# ---------------------------------------------------------------------------
def tree_to_schedule_rows(items) -> list[dict]:
    """Flatten the scheduled tree into ScheduleItem-shaped row dicts.

    Mirrors PMO 360's ParsedScheduleItem contract: indent 0 = discipline,
    1 = phase, 2 = task; discipline/phase carry the ancestor section/phase name;
    dates coerced from the runtime `%m/%d/%y` strings to ``date``; price in whole
    dollars. Disabled items are skipped (they don't belong in the schedule).
    """
    rows: list[dict] = []
    counter = {"i": 0}

    def walk(nodes, discipline: str, phase: str):
        for it in nodes:
            if not it.enabled:
                continue
            indent = max(0, min(int(it.indent_level or 0), 2))
            # The indent-0 ancestor names the discipline; indent-1 names the phase.
            if indent == 0:
                row_discipline, row_phase = it.name, ""
                child_discipline, child_phase = it.name, ""
            elif indent == 1:
                row_discipline, row_phase = discipline, it.name
                child_discipline, child_phase = discipline, it.name
            else:
                row_discipline, row_phase = discipline, phase
                child_discipline, child_phase = discipline, phase
            rows.append({
                "order_index": counter["i"],
                "indent_level": indent,
                "discipline": row_discipline,
                "phase": row_phase,
                "task": it.name,
                "duration_days": int(it.duration) if it.duration else None,
                "start_date": _mdy_to_date(it.start_date),
                "finish_date": _mdy_to_date(it.end_date),
                "price": int(it.price) if it.price else None,
                "is_milestone": bool(it.is_milestone),
            })
            counter["i"] += 1
            walk(it.children, child_discipline, child_phase)

    walk(items, "", "")
    return rows
