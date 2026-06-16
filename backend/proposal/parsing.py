"""Proposal Excel parsing + template-row building.

VERBATIM port of the parsing/build-rules block from the legacy Tkinter tool
(Full_proposal_V9.py lines ~8007-8949). Logic, column indices, scoring
thresholds, category/phase rules, predecessor wiring, and ordering are copied
exactly — nothing generalized or simplified — so parsed schedules are
byte-for-byte identical to the desktop generator.

Only mechanical changes vs the original:
  * the lazy global ``pd`` / ``_require_pandas`` pattern is kept as-is;
  * the debug ``print(...)`` in extract_project_info is dropped (not logic).

Public entry points used by the API/tree builder:
  - build_model_rows(path)            -> (buckets, project_info)
  - flatten_to_template_rows(...)     -> list[dict] (the ProposalGenerator row schema)
  - extract_project_info(path)        -> dict
  - load_proposal_page_rows(path)     -> list[dict]
"""
from __future__ import annotations

import math
import re

import numpy as np

# ---- Lazy pandas (ported verbatim from Full_proposal_V9.py:8007) ----
pd = None
_PANDAS_IMPORT_ERROR = None


def _require_pandas() -> None:
    global pd, _PANDAS_IMPORT_ERROR
    if pd is not None:
        return
    if _PANDAS_IMPORT_ERROR is None:
        try:
            import pandas as _pd  # type: ignore

            pd = _pd
            return
        except Exception as _e:  # pragma: no cover
            _PANDAS_IMPORT_ERROR = _e
    raise RuntimeError(
        "pandas is required for this action but failed to import in this environment. "
        f"Underlying error: {_PANDAS_IMPORT_ERROR}"
    )


# ===================
# Parsing & Build Rules
# ===================

EXACT_SUBTOTAL_LABELS = {
    "civil engineering", "electrical engineering", "structural engineering", "substation engineering",
    "additional services"
}

PHASES = ["30%", "60%", "IFP", "90%", "IFC"]


def _parse_additional_services_triple_block(pp):
    """Parse Additional Services laid out as Name / Milestone / Price columns on the left block.

    The Proposal Page sometimes lists Additional Services in three adjacent columns instead of the
    usual task/price pair. When present, treat them as individual milestone-like rows. Rows that
    start with "Electrical" are routed to Electrical Engineering; rows that start with "Civil" go
    to Civil Engineering; everything else remains under Additional Services. Milestone text is
    mapped to a phase using _infer_phase when possible.
    """

    nrows, ncols = pp.shape
    header_row = None
    name_col = None

    # Locate the Additional Services header cell to anchor the three-column block.
    # Prefer a header that is immediately followed by a "Milestone" column label.
    for r in range(nrows):
        for c in range(ncols):
            cell = pp.iat[r, c]
            if isinstance(cell, str) and "additional services" in cell.lower():
                nxt = pp.iat[r, c + 1] if c + 1 < ncols else None
                if isinstance(nxt, str) and "milestone" in nxt.lower():
                    header_row = r
                    name_col = c
                    break
        if header_row is not None:
            break

    # Fallback: first Additional Services cell if the Milestone-labelled block is not found
    if header_row is None:
        for r in range(nrows):
            for c in range(ncols):
                cell = pp.iat[r, c]
                if isinstance(cell, str) and "additional services" in cell.lower():
                    header_row = r
                    name_col = c
                    break
            if header_row is not None:
                break

    # Require at least three columns starting at the header position
    if header_row is None or name_col is None or name_col + 2 >= ncols:
        return []

    out = []
    blank_run = 0

    for r in range(header_row + 1, nrows):
        name = pp.iat[r, name_col]
        milestone = pp.iat[r, name_col + 1] if name_col + 1 < ncols else None
        price = pp.iat[r, name_col + 2] if name_col + 2 < ncols else None

        # End the block after two consecutive blank-ish rows to avoid pulling unrelated content
        if (
            (not isinstance(name, str) or not name.strip())
            and (not isinstance(milestone, str) or not milestone.strip())
            and (not pd.notna(price))
        ):
            blank_run += 1
            if blank_run >= 2:
                break
            continue
        blank_run = 0

        if isinstance(name, str):
            low_name = name.lower().strip()
            if any(k in low_name for k in ["stage total", "proposal summary", "engineering proposal"]):
                break
            if low_name == "additional services":
                # Header row for the block; skip but keep scanning below
                continue

        try:
            price_val = float(price) if pd.notna(price) else None
        except Exception:
            price_val = None
        if price_val is None:
            continue

        # Keep Additional Services category; routing to Civil/Electrical is handled later
        cat = "Additional Services"

        milestone_txt = milestone if isinstance(milestone, str) else None
        name_txt = name if isinstance(name, str) else None
        phase = _infer_phase(milestone_txt) or _infer_phase(name_txt) or "30%"

        out.append({
            "category": cat,
            "task": (name or "").strip(),
            "proposal_price": price_val,
            "phase": phase,
        })

    return out


def _pairs(pp):
    """Infer (task_col, price_col) pairs on 'Proposal Page' across template versions.

    V3 uses A/B and D/E blocks.
    V4 shifts the right-hand block to E/F (and the header area shifted right too).

    Instead of hard-coding column indices, we score adjacent column pairs by how many
    rows look like: <string task> + <numeric price>, while ignoring totals/headers.
    """
    # pp is a pandas DataFrame (header=None) of the Proposal Page
    nrows, ncols = pp.shape[0], pp.shape[1]

    def _is_num(v):
        # pandas sometimes gives numpy scalars; bools are numbers too, so exclude bool
        num_types = (int, float, np.number)
        return (v is not None) and (pd.notna(v)) and isinstance(v, num_types) and not isinstance(v, bool)

    def _is_task_txt(v):
        if not isinstance(v, str):
            return False
        s = v.strip()
        if not s:
            return False
        low = s.lower()
        # Ignore header/summary lines that often have numbers next to them
        if any(k in low for k in [
            "total", "engineering proposal", "summary of services", "proposal summary",
            "insurance adder", "pmo adder",
            "civil total", "electrical total", "structural total", "substation total", "bess total",
            "additional services"
        ]):
            return False
        return True

    scores = []
    # Start after the header area to avoid picking up 'Date/Client/Project' fields (esp. in V4)
    start_row = 5
    for c in range(0, max(0, ncols - 1)):
        cnt = 0
        for r in range(start_row, nrows):
            if _is_task_txt(pp.iat[r, c]) and _is_num(pp.iat[r, c + 1]):
                cnt += 1
        if cnt >= 8:
            scores.append((cnt, c, c + 1))

    # Ensure Additional Services columns are included even if they have fewer rows
    additional_cols = set()
    for r in range(start_row, nrows):
        for c in range(0, max(0, ncols - 1)):
            cell = pp.iat[r, c]
            if isinstance(cell, str) and "additional services" in cell.lower():
                additional_cols.add(c)

    # If inference fails (e.g., blank template), fall back to legacy V3 pairs
    if not scores:
        return [(0, 1), (3, 4), (6, 7), (9, 10), (10, 11)]

    # Keep top 3 by score, but de-dupe by text column
    scores.sort(reverse=True, key=lambda x: x[0])
    pairs = []
    used_txt_cols = set()
    for _, tc, pc in scores:
        if tc in used_txt_cols:
            continue
        pairs.append((tc, pc))
        used_txt_cols.add(tc)
        if len(pairs) >= 3:
            break

    # Prefer keeping A/B if present (common left block in both V3 and V4)
    if (0, 1) not in pairs and any(tc == 0 for tc, _ in pairs) is False and ncols > 1:
        # if A/B had a low score but exists, include it as a secondary block
        pairs.append((0, 1))

    # Add Additional Services columns if detected
    for c in sorted(additional_cols):
        if c + 1 < ncols:
            candidate = (c, c + 1)
            if candidate not in pairs:
                pairs.append(candidate)

    return pairs


def _categorize(text: str) -> str:
    t = (text or "").lower().strip()
    if t.startswith("civil"):
        return "Civil"
    if t.startswith("electrical"):
        return "Electrical"
    if t.startswith("structural"):
        return "Structural"
    if t.startswith("substation"):
        return "Substation"
    if t.startswith("additional services") or t.startswith("additional service"):
        return "Additional Services"
    # NEW: BESS detection (handles "BESS", "BESS Engineering", "Battery Energy Storage")
    if t.startswith("bess") or "battery energy storage" in t:
        return "BESS"
    return ""


def _infer_phase(text: str):
    t = (text or "").lower()
    if "30% design" in t or "30%" in t:
        return "30%"
    if "60% design" in t or "60%" in t:
        return "60%"
    if "ifp" in t:
        return "IFP"
    if "90% design" in t or "90%" in t:
        return "90%"
    if "ifc design" in t or "record drawings" in t or "ifc" in t:
        return "IFC"
    return None


def load_proposal_page_rows(path: str):
    _require_pandas()
    pp = pd.read_excel(path, sheet_name="Proposal Page",
                       header=None, engine="openpyxl")
    props = []
    ncols = pp.shape[1]

    def normalize(s):
        return (s or "").strip()

    for (txt_col, price_col) in _pairs(pp):
        current_phase = None
        current_category = None  # tracks the most recent category header
        in_summary_block = False

        for i in range(pp.shape[0]):
            txt = pp.iat[i, txt_col] if txt_col < ncols else None
            val = pp.iat[i, price_col] if price_col < ncols else None

            # Phase detection
            if isinstance(txt, str):
                maybe = _infer_phase(txt)
                if maybe:
                    current_phase = maybe

                # Proposal Summary block detection (ignore rows on the right under the summary)
                if "proposal summary" in txt.lower():
                    in_summary_block = True
                    continue

                # Category header detection (now includes Substation, BESS, Additional Services)
                low = txt.lower().strip()
                if low in (
                    "civil engineering",
                    "electrical engineering",
                    "structural engineering",
                    "substation engineering",
                    "bess",
                    "bess engineering",
                    "battery energy storage",
                    "battery energy storage system",
                ) or "additional services" in low:
                    in_summary_block = False
                    if "bess" in low or "battery energy storage" in low:
                        current_category = "BESS"
                    elif "additional services" in low:
                        current_category = "Additional Services"
                    elif low.startswith("substation"):
                        current_category = "Substation"
                    else:
                        # "Civil Engineering" -> "Civil", etc.
                        current_category = txt.split()[0].capitalize()
                    continue  # header row itself isn't a task

            # Candidate task row with a numeric price
            if isinstance(txt, str) and normalize(txt) and pd.notna(val):
                if in_summary_block:
                    continue
                lower = txt.lower().strip()
                # Skip totals/headers/etc.
                if any(k in lower for k in [
                    "total", "milestone", "summary of services", "proposal summary",
                    "engineering proposal", "insurance adder"
                ]):
                    continue
                if lower in EXACT_SUBTOTAL_LABELS:
                    continue

                # price
                try:
                    price = float(val)
                except Exception:
                    continue

                # Category assignment: explicit on the row, else the last seen header
                cat = _categorize(txt) or current_category or ""
                if not cat:
                    continue

                props.append({
                    "category": cat,
                    "task": normalize(txt),
                    "proposal_price": price,
                    "phase": current_phase or _infer_phase(txt) or "30%",
                })

    # Capture the three-column Additional Services block (Name / Milestone / Price)
    addl_props = _parse_additional_services_triple_block(pp)
    if addl_props:
        seen = {(p["category"], normalize(p["task"]).lower()) for p in props}
        for p in addl_props:
            key = (p["category"], normalize(p["task"]).lower())
            if key in seen:
                continue
            props.append(p)
            seen.add(key)
    return props


def _load_detail_map(path, sheet: str):
    """Return {Description: {hours, price}}; dedupe by keeping first priced/max price.
    path can be a file path string or a pd.ExcelFile for reuse."""
    _require_pandas()
    try:
        df = pd.read_excel(path, sheet_name=sheet,
                           header=None, engine="openpyxl")
    except Exception:
        return {}
    df2 = df.iloc[12:].reset_index(drop=True)  # after header row (index 11)
    DESC, HRS, COST = 2, 11, 12
    out = {}
    ncols = len(df2.columns)
    for row in df2.itertuples(index=False):
        desc = row[DESC] if ncols > DESC else None
        hours = row[HRS] if ncols > HRS else None
        price = row[COST] if ncols > COST else None
        if isinstance(desc, str) and desc.strip():
            name = desc.strip()
            h = float(hours) if pd.notna(hours) else 0.0
            p = 0.0
            if pd.notna(price) and str(price).strip().lower() != "not included":
                try:
                    p = float(price)
                except Exception:
                    p = 0.0
            if name not in out:
                out[name] = {"hours": h, "price": p}
            else:
                prev_p = float(out[name].get("price") or 0.0)
                if (prev_p <= 0 and p > 0) or (p > prev_p):
                    out[name] = {"hours": h, "price": p}
    return out


def _load_structural_from_electrical(path, sheet: str = "Electrical"):
    """Parse the 'Structural Engineering' section that lives inside the Electrical sheet.
    Returns: {task_name: {"hours": float, "price": float}}
    path can be a file path string or a pd.ExcelFile for reuse."""
    _require_pandas()
    try:
        df = pd.read_excel(path, sheet_name=sheet,
                           header=None, engine="openpyxl")
    except Exception:
        return {}

    out = {}
    DESC, HRS, COST = 2, 11, 12

    # Find the section header (handles misspelling 'Structrural Engineering')
    header_row = None
    for i in range(len(df)):
        row = df.iloc[i]
        if any(isinstance(v, str) and re.search(r"\bstruct\w*\s+engineering\b", v, re.I) for v in row.tolist()):
            header_row = i
            break
    if header_row is None:
        return {}

    # Collect rows until a new major section / stage total
    for i in range(header_row + 1, len(df)):
        row = df.iloc[i]
        desc = row.iloc[DESC] if len(row) > DESC else None
        if isinstance(desc, str) and desc.strip():
            low = desc.lower().strip()
            if "stage total" in low or any(k in low for k in ["substation", "bess", "additional services"]):
                break
            # skip echoed header lines like "Structural Engineering"
            if re.search(r"\bstruct\w*\s+engineering\b", low):
                continue

            hours = row.iloc[HRS] if len(row) > HRS else None
            price = row.iloc[COST] if len(row) > COST else None
            h = float(hours) if pd.notna(hours) else 0.0
            p = 0.0
            if pd.notna(price) and str(price).strip().lower() != "not included":
                try:
                    p = float(price)
                except Exception:
                    p = 0.0
            out[desc.strip()] = {"hours": h, "price": p}

    # Ensure we also capture a standalone "Structural Plan Set" if it appears outside the block
    df_ncols = len(df.columns)
    for row in df.itertuples(index=False):
        desc = row[DESC] if df_ncols > DESC else None
        if isinstance(desc, str) and "structural plan set" in desc.lower():
            hours = row[HRS] if df_ncols > HRS else None
            price = row[COST] if df_ncols > COST else None
            h = float(hours) if pd.notna(hours) else 0.0
            p = 0.0
            if pd.notna(price) and str(price).strip().lower() != "not included":
                try:
                    p = float(price)
                except Exception:
                    p = 0.0
            out[desc.strip()] = {"hours": h, "price": p}

    return out


def enrich_with_details(path: str, rows):
    """
    Attach 'hours' and 'detail_price' to each row by looking up the detail sheets.
    - Electrical tasks: from Electrical sheet
    - Civil tasks:      from Civil sheet
    - Structural tasks: from Structural section inside Electrical sheet
    - Substation tasks: primarily from Civil sheet (e.g., 'Substation Pad Design - Civ. ...')
    - BESS tasks:       primarily from Electrical sheet (e.g., 'BESS 60% - Design')
    """
    _require_pandas()
    xl = pd.ExcelFile(path, engine="openpyxl")
    civil_map = _load_detail_map(
        xl, "Civil") if "Civil" in xl.sheet_names else {}
    elec_map = _load_detail_map(
        xl, "Electrical") if "Electrical" in xl.sheet_names else {}
    structural_from_elec = _load_structural_from_electrical(xl)

    # Helper: tolerant key lookup (handles stray spaces, minor punctuation)
    def _norm(s: str) -> str:
        return re.sub(r"\s+", " ", (s or "").strip().lower())

    # Precompute normalized maps for fallback matching
    civil_norm = {_norm(k): v for k, v in civil_map.items()}
    elec_norm = {_norm(k): v for k, v in elec_map.items()}
    struc_norm = {_norm(k): v for k, v in structural_from_elec.items()}

    for r in rows:
        cat = (r.get("category") or "").strip()
        task = (r.get("task") or "").strip()
        key = _norm(task)

        # Primary source by category
        if cat == "Electrical":
            d = elec_map.get(task) or elec_map.get(
                task.strip()) or elec_norm.get(key, {})
        elif cat == "Civil":
            d = civil_map.get(task) or civil_map.get(
                task.strip()) or civil_norm.get(key, {})
        elif cat == "Structural":
            d = (structural_from_elec.get(task) or structural_from_elec.get(task.strip())
                 or struc_norm.get(key, {}))
        elif cat == "Substation":
            # Substation Pad Design rows live on the Civil sheet
            d = (civil_map.get(task) or civil_map.get(task.strip()) or civil_norm.get(key, {})
                 or elec_map.get(task) or elec_map.get(task.strip()) or elec_norm.get(key, {}))
        elif cat == "BESS":
            # BESS 60% - Design lives on the Electrical sheet
            d = (elec_map.get(task) or elec_map.get(task.strip()) or elec_norm.get(key, {})
                 or civil_map.get(task) or civil_map.get(task.strip()) or civil_norm.get(key, {}))
        else:
            d = {}

        r["hours"] = float(d.get("hours")) if d.get(
            "hours") is not None else None
        r["detail_price"] = float(d.get("price")) if d.get(
            "price") is not None else None

    return rows


def extract_project_info(path: str):
    """
    Robustly scan the 'Proposal Page' for:
      - date
      - client
      - project
      - location
      - state
      - project_size_mw  (numeric if possible; otherwise raw string)
      - deposit_percent / pmo_adder_percent / insurance_adder_percent (as % values, e.g. 30.0)
    Supports both Proposal Template V3 and V4 (where some header/value columns shifted).
    """
    _require_pandas()
    df = pd.read_excel(path, sheet_name="Proposal Page",
                       header=None, engine="openpyxl")

    info = {
        "date": None,
        "client": None,
        "project": None,
        "project_location": None,
        "project_state": None,
        "project_size_mw": None,
        "deposit_percent": None,
        "pmo_adder_percent": None,
        "insurance_adder_percent": None,
    }

    # Fixed-cell fallbacks (historical templates):
    # - V3: Date label at A2, value at B2  -> df.iat[1,1]
    # - V4: Date label at B2, value at C2  -> df.iat[1,2]
    for (r, c) in [(1, 1), (1, 2)]:
        try:
            v = df.iat[r, c]
            if pd.notna(v):
                info["date"] = v
                break
        except Exception:
            pass

    # Scan top-left area for label:value pairs (avoid picking up task text)
    max_rows = min(40, df.shape[0])
    max_cols = min(14, df.shape[1])

    label_map = {
        "date": ["date", "proposal date"],
        "client": ["client", "client name"],
        "project": ["project", "project name"],
        "project_location": ["location", "site location", "project location"],
        "project_state": ["state"],
        "project_size_mw": [
            "size(mw)", "sizemw", "size mw", "project size (mw)", "project size", "mw",
            "size (mwac)", "size (mw dc)", "size (mwac/mwdc)", "size (mwac/mw dc)"
        ],
        # NOTE: On Proposal Page these are usually label | amount | percent
        "deposit_percent": ["deposit%", "depositpercent", "deposit %", "depositpct", "deposit"],
        "pmo_adder_percent": ["pmoadder(%)", "pmoadder%", "pmoadder", "pmo(%)", "pmo%", "pmo", "pmo adder"],
        "insurance_adder_percent": ["insuranceadder(%)", "insuranceadder%", "insurance adder", "insurance(%)", "insurance%", "insurance"],
    }

    def norm_label(s: str) -> str:
        return re.sub(r"[\s:()/_-]+", "", (s or "").lower())

    variants = {k: {norm_label(v) for v in vals}
                for k, vals in label_map.items()}
    found = {}

    for r in range(max_rows):
        for c in range(max_cols - 1):
            cell = df.iat[r, c]
            if not isinstance(cell, str):
                continue
            key = norm_label(cell)
            for field, opts in variants.items():
                if key in opts:
                    # Percentage fields: label | amount | percent  (percent is +2)
                    if field in ("deposit_percent", "pmo_adder_percent", "insurance_adder_percent"):
                        val = df.iat[r, c +
                                     2] if (c + 2) < df.shape[1] else None
                    else:
                        val = df.iat[r, c +
                                     1] if (c + 1) < df.shape[1] else None
                    if pd.notna(val) and field not in found:
                        found[field] = val

    # Merge discovered values
    for k in ("date", "client", "project", "project_location", "project_state"):
        if k in found and (found[k] is not None and str(found[k]).strip()):
            info[k] = found[k]

    # Parse % values (accept "30%", 0.3, or 30)
    for k in ("deposit_percent", "pmo_adder_percent", "insurance_adder_percent"):
        if k in found and found[k] is not None:
            raw = str(found[k]).strip()
            if "%" in raw:
                m = re.search(r"([\d.,]+)", raw.replace("%", ""))
                info[k] = float(m.group(1).replace(",", "")) if m else 0.0
            else:
                try:
                    val = float(raw.replace(",", ""))
                    info[k] = (val * 100.0) if (0 < val < 1.0) else val
                except Exception:
                    info[k] = 0.0

    # Parse size_mw numerically when possible
    if "project_size_mw" in found and found["project_size_mw"] is not None:
        raw = str(found["project_size_mw"]).strip()
        m = re.search(r"([\d.,]+)", raw)
        if m:
            try:
                info["project_size_mw"] = float(m.group(1).replace(",", ""))
            except Exception:
                info["project_size_mw"] = raw
        else:
            info["project_size_mw"] = raw

    # (debug print from the original tool intentionally omitted)
    return info


def build_model_rows(path: str):
    rows = load_proposal_page_rows(path)
    rows = enrich_with_details(path, rows)

    # Normalize phases
    for r in rows:
        r["phase"] = r.get("phase") or _infer_phase(r["task"]) or "30%"

    # Keep rows with either proposal or detail pricing (> 0)
    filtered = []
    for r in rows:
        pp = r.get("proposal_price") or 0
        dp = r.get("detail_price") or 0
        if (pp > 0) or (dp > 0):
            filtered.append(r)
    rows = filtered

    # Bucket by category/phase (now includes Substation & BESS)
    buckets = {
        "Civil": {p: [] for p in PHASES},
        "Electrical": {p: [] for p in PHASES},
        "Structural": {p: [] for p in PHASES},
        "Substation": {p: [] for p in PHASES},
        "BESS": {p: [] for p in PHASES},
        "Additional Services": {p: [] for p in PHASES},
    }
    for r in rows:
        cat, ph = r["category"], r["phase"]
        if cat in buckets and ph in buckets[cat]:
            buckets[cat][ph].append(r)

    info = extract_project_info(path)
    return buckets, info


def flatten_to_template_rows(buckets, hours_per_day: float, price_source: str, review_pairs: set):
    """
    Flatten into the table format ProposalGenerator expects:
      - Project Initiation (with Civil/Electrical Due Diligence 1d)
      - Civil, Electrical, Structural, Substation, BESS (30/60/90/IFC)
      - Prices:
          * "proposal" → Proposal Page price
          * "detail"   → Detail price (fallback to Proposal)
      - Project Closeout (top-level only)
    """
    rows_out = []
    next_id = 1

    # cross-category predecessor trackers
    e60_first_task_id = None
    structural_first_task_applied = False

    # Precompute Additional Services split by prefix for Civil/Electrical placement
    addl_by_phase = buckets.get("Additional Services", {})
    addl_all = []
    for ph in PHASES:
        addl_all.extend(addl_by_phase.get(ph, []))

    civil_addl_tasks = []
    electrical_addl_tasks = []
    other_addl_tasks = []
    for t in addl_all:
        name_low = (t.get("task") or "").strip().lower()
        if name_low.startswith("electrical"):
            electrical_addl_tasks.append(t)
        elif name_low.startswith("civil"):
            civil_addl_tasks.append(t)
        else:
            other_addl_tasks.append(t)

    def add_item(item_id, name, duration, price, is_milestone, indent, enabled, pred_id, lag, pinned, parent_id, targeted_hours=None, price_only=False):
        rows_out.append({
            "ID": item_id,
            "Name": name,
            "Duration": int(duration or 0),
            "Targeted Hours": targeted_hours,
            "Price": int(price or 0),
            "Is Milestone": bool(is_milestone),
            "Indent Level": int(indent),
            "Enabled": bool(enabled),
            "Predecessor ID": pred_id,
            "Lag": int(lag or 0),
            "Is Start Pinned": bool(pinned),
            "Parent ID": parent_id,
            "Price Only": bool(price_only),
        })

    # ---- Project Initiation (Price Only – excluded from schedule/utilization) ----
    pi_id = next_id
    next_id += 1
    add_item(pi_id, "Project Initiation", 0, 0, True, 0,
             True, None, 0, False, None, price_only=True)

    last_pi_child = None
    civil_dd_id = None
    electrical_dd_id = None
    for name, dur in [
        ("Contract Signed", 0),
        ("Deposit", 0),
        ("Notice to Proceed", 0),
        ("Civil Start - Civil Due Diligence", 1),
        ("Electrical Start - Electrical Due Diligence", 1),
    ]:
        tid = next_id
        next_id += 1
        add_item(tid, name, dur, 0, False, 1, True, last_pi_child, 0,
                 False, pi_id, targeted_hours=None, price_only=True)
        last_pi_child = tid
        if name.startswith("Civil Start"):
            civil_dd_id = tid
        if name.startswith("Electrical Start"):
            electrical_dd_id = tid

    def build_category(cat_key, cat_label):
        nonlocal next_id, e60_first_task_id, structural_first_task_applied
        cat_id = next_id
        next_id += 1
        # disabled until we actually add children
        add_item(cat_id, cat_label, 0, 0, True, 0, False,
                 None, 0, False, None, targeted_hours=None)

        added_any = False

        def _price_of(t):
            if cat_key == "Structural":
                if price_source == "detail":
                    return (t.get("detail_price") or t.get("proposal_price") or 0)
                return (t.get("proposal_price") or t.get("detail_price") or 0)
            if price_source == "detail":
                return (t.get("detail_price") or t.get("proposal_price") or 0)
            return (t.get("proposal_price") or t.get("detail_price") or 0)

        def _reorder_for_30(tasks, phase):
            if phase != "30%":
                return list(tasks)

            def score(t):
                return 0 if "plan set" in (t.get("task", "").lower()) else 1
            return sorted(tasks, key=score)

        prev_phase_last_id = None

        for phase in PHASES:
            raw = buckets.get(cat_key, {}).get(phase, [])
            if not raw:
                continue

            added_any = True
            tasks = _reorder_for_30(raw, phase)

            # Phase milestone
            ms_id = next_id
            next_id += 1
            add_item(ms_id, f"{cat_label} — {phase} Design", 0, 0, True,
                     1, True, None, 0, False, cat_id, targeted_hours=None)

            first_task_id = None
            last_task_id = None

            for t in tasks:
                # Duration: use hours if available (now extended to Substation & BESS)
                raw_hours = t.get("hours")
                if raw_hours is not None and cat_key in ("Civil", "Electrical", "Structural", "Substation", "BESS", "Additional Services"):
                    dur_days = math.ceil(
                        (raw_hours or 0) / float(hours_per_day))
                else:
                    dur_days = 0

                tid = next_id
                next_id += 1
                add_item(
                    tid,
                    t["task"],
                    dur_days,
                    _price_of(t),
                    False,
                    2,              # under phase milestone
                    True,
                    last_task_id,   # sequential within phase
                    0,
                    False,
                    ms_id,
                    targeted_hours=raw_hours,
                )
                if first_task_id is None:
                    first_task_id = tid
                last_task_id = tid

            # Client Review for the selected pairs (unchanged policy)
            if (cat_key, phase) in review_pairs:
                cr_id = next_id
                next_id += 1
                add_item(cr_id, "Client Review", 10, 0, False, 2, True,
                         last_task_id, 0, False, ms_id, targeted_hours=None)
                last_task_id = cr_id

            # Capture first task of Electrical 60% to link Structural's first task later
            if cat_key == "Electrical" and phase == "60%" and first_task_id is not None and e60_first_task_id is None:
                e60_first_task_id = first_task_id
            elif cat_key == "Electrical" and phase == "90%" and first_task_id is not None and e60_first_task_id is None:
                e60_first_task_id = first_task_id  # fallback if 60% missing

            # Wire the first task's predecessor
            if first_task_id is not None:
                idx = next(i for i in range(len(rows_out))
                           if rows_out[i]["ID"] == first_task_id)
                if cat_key == "Structural" and (not structural_first_task_applied) and e60_first_task_id:
                    rows_out[idx]["Predecessor ID"] = e60_first_task_id
                    structural_first_task_applied = True
                elif prev_phase_last_id is not None:
                    rows_out[idx]["Predecessor ID"] = prev_phase_last_id
                else:
                    # For first phase, tie to Due Diligence where applicable; otherwise last Project Initiation child
                    if phase == "30%":
                        if cat_key == "Civil" and civil_dd_id:
                            rows_out[idx]["Predecessor ID"] = civil_dd_id
                        elif cat_key == "Electrical" and electrical_dd_id:
                            rows_out[idx]["Predecessor ID"] = electrical_dd_id
                        else:
                            rows_out[idx]["Predecessor ID"] = last_pi_child
                    else:
                        rows_out[idx]["Predecessor ID"] = last_pi_child

            prev_phase_last_id = last_task_id

        # --- Additional Services under Civil / Electrical as a separate milestone (prefix-based) ---
        if cat_key in ("Civil", "Electrical"):
            if cat_key == "Civil":
                addl_tasks = civil_addl_tasks + other_addl_tasks
            else:
                addl_tasks = electrical_addl_tasks

            if addl_tasks:
                added_any = True
                addl_ms_id = next_id
                next_id += 1
                add_item(
                    addl_ms_id,
                    "Additional Services",
                    0,
                    0,
                    True,
                    1,
                    True,
                    None,
                    0,
                    False,
                    cat_id,
                    targeted_hours=None,
                )

                first_addl_id = None
                last_addl_id = None

                for t in addl_tasks:
                    raw_hours = t.get("hours")
                    if raw_hours is not None:
                        dur_days = math.ceil(
                            (raw_hours or 0) / float(hours_per_day))
                    else:
                        dur_days = 0

                    tid = next_id
                    next_id += 1
                    add_item(
                        tid,
                        t["task"],
                        dur_days,
                        _price_of(t),
                        False,
                        2,
                        True,
                        last_addl_id,
                        0,
                        False,
                        addl_ms_id,
                        targeted_hours=raw_hours,
                        price_only=True,
                    )
                    if first_addl_id is None:
                        first_addl_id = tid
                    last_addl_id = tid

                # Link the first Additional Services task to the last phase task when available
                if first_addl_id is not None and prev_phase_last_id is not None:
                    idx = next(i for i in range(len(rows_out))
                               if rows_out[i]["ID"] == first_addl_id)
                    rows_out[idx]["Predecessor ID"] = prev_phase_last_id

        # enable the top-level only if we added content
        if added_any:
            for i in range(len(rows_out) - 1, -1, -1):
                if rows_out[i]["ID"] == cat_id:
                    rows_out[i]["Enabled"] = True
                    break

        return cat_id

    # Default review pairs policy remains the same
    review_pairs = {("Civil", "30%"), ("Civil", "60%"),
                    ("Electrical", "30%"), ("Electrical", "60%")}

    # Order: Civil → Electrical → Structural → Substation → BESS
    build_category("Civil", "Civil Engineering")
    build_category("Electrical", "Electrical Engineering")
    build_category("Structural", "Structural Engineering")
    build_category("Substation", "Substation Engineering")  # NEW
    build_category("BESS", "BESS")                          # NEW

    # ---- Project Closeout ----
    closeout_id = next_id
    next_id += 1
    add_item(closeout_id, "Project Closeout", 0, 0, True, 0,
             True, None, 0, False, None, targeted_hours=None)

    return rows_out
