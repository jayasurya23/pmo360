"""Server-side Gantt chart renderer — verbatim port of the desktop tool.

The matplotlib drawing functions below are copied 1:1 from the legacy Tkinter
app (Full_proposal_V9.py lines 228-938):

  _draw_year_month_header / _add_year_month_header   :228 / :325
  _draw_milestone_diamond / _place_gantt_label       :347 / :362
  _build_one_page_with_version                       :382
  build_gantt_with_version                           :885

Only mechanical changes were made for headless server use:
  * matplotlib forced onto the non-interactive "Agg" backend (no display);
  * Jost fonts loaded from backend/templates/fonts/ instead of resource_path();
  * print() progress lines kept but harmless (captured by the server logs);
  * build_gantt_rows() is the port of ProposalGenerator._add_gantt_page's inner
    collect_tasks_recursive (:7269) — the bridge from the scheduled item tree to
    the row dicts the renderer consumes.

Nothing about the layout math, colours, fonts, or row logic was generalised.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path
from typing import Optional

import matplotlib
matplotlib.use("Agg")  # headless: render straight to PDF, never open a window
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import matplotlib.transforms as mtransforms
from matplotlib.patches import Rectangle, Polygon
from matplotlib.lines import Line2D
from matplotlib.dates import MonthLocator, WeekdayLocator
from matplotlib.backends.backend_pdf import PdfPages

from .calendar import duration_for_table, estimate_text_width_in_days, adjusted_duration
from .scheduling import is_in_project_initiation
from .constants import (
    PRIMARY,
    SECONDARY,
    FONTSIZE_TABLE,
    FONTSIZE_CHART_REGULAR,
    FONTSIZE_CHART_SUMMARY,
    FONTSIZE_XTICK,
    MAX_ROWS_PER_PAGE,
    LEFT_RIGHT_WIDTHS,
    COL_EDGES,
    HEADERS,
    MAX_NAME_LENGTH,
    MIN_WIDTH_DAYS,
    DIAMOND_HALF_WIDTH_IN,
    DIAMOND_HALF_HEIGHT_ROW,
    MILESTONE_TEXT_GAP_IN,
)

# Jost lives alongside the rest of the docgen fonts (registered for ReportLab in
# config.py too). resource_path() in the desktop tool resolved the bundled TTFs;
# here we point straight at the repo copy.
_TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates"
_FONT_DIR = _TEMPLATES_DIR / "fonts"


def resource_path(name: str) -> str:
    """Port of the desktop tool's resource_path, scoped to the bundled fonts."""
    return str(_FONT_DIR / name)


def brand_logo_path() -> str:
    """Absolute path to the bundled Castillo Engineering logo, or "" if absent.
    Used as the default logo on the Gantt + milestones-table PDF headers."""
    p = _TEMPLATES_DIR / "castillo_logo.png"
    return str(p) if p.exists() else ""


def _tabs_to_spaces(s: str) -> str:
    """The desktop tool's header f-strings use literal tabs (\\t) to roughly
    align the Customer/Project/Location/Size labels. In the tool's environment
    matplotlib rendered those tabs as whitespace; with the bundled Jost TTF and
    matplotlib 3.x the tab control-char renders as a `.notdef` box instead.
    Rendering each tab as a space reproduces the desktop output exactly (clean
    aligned labels, as in the reference Gantt PDF) without changing the text."""
    return s.replace("\t", " ")


def _draw_year_month_header(header_ax, x0, x1, draw_outer_edges=False):
    """
    Draws a two-row (Months + Years) header inside the given header_ax.
    header_ax must already be positioned/sized in figure coords to match the table header.
    x0/x1 are the chart data limits in Matplotlib date numbers (mdates).
    """
    header_ax.set_xlim(x0, x1)
    header_ax.set_ylim(0, 1)
    header_ax.axis("off")

    trans = mtransforms.blended_transform_factory(
        header_ax.transData, header_ax.transAxes)

    # helpers
    def month_start(d): return datetime(d.year, d.month, 1)
    def next_month(d): return datetime(d.year + (1 if d.month == 12 else 0),
                                       1 if d.month == 12 else d.month + 1, 1)

    d0 = mdates.num2date(x0).replace(tzinfo=None)
    d1 = mdates.num2date(x1).replace(tzinfo=None)

    MONTH_H = 0.48
    YEAR_Y = MONTH_H
    EDGE_LW = 0.9
    month_fill = (1.0, 1.0, 1.0)
    year_fill = (1.0, 1.0, 1.0)
    MIN_VISIBLE_FRAC = 0.45

    try:
        fs_m = max(7, FONTSIZE_XTICK - 3)
        fs_y = max(7, FONTSIZE_XTICK - 2)
    except NameError:
        fs_m, fs_y = 8, 9

    # MONTH ROW
    cur = month_start(d0)
    end = next_month(month_start(d1))
    months = []
    first_month_checked = False
    while cur < end:
        nxt = next_month(cur)
        xl = mdates.date2num(cur)
        xr = mdates.date2num(nxt)
        vl = max(xl, x0)
        vr = min(xr, x1)
        vis = vr - vl
        full = xr - xl
        if vis > 0:
            if not first_month_checked:
                first_month_checked = True
                if vl > xl and (vis/full) < MIN_VISIBLE_FRAC:
                    cur = nxt
                    continue
            months.append((vl, vr, cur))
        cur = nxt

    for vl, vr, d in months:
        w = vr - vl
        header_ax.add_patch(Rectangle((vl, 0.0), w, MONTH_H,
                            transform=trans, facecolor=month_fill,
                            edgecolor="black", linewidth=EDGE_LW, clip_on=True))
        header_ax.text(vl + w/2.0, MONTH_H*0.50, d.strftime("%b"),
                       ha="center", va="center", transform=trans, fontsize=fs_m)

    # YEAR ROW
    def ystart(year): return datetime(year, 1, 1)
    def yend(year): return datetime(year + 1, 1, 1)

    first_year = d0.year
    last_year = d1.year if d1.month > 1 or d1.day > 1 else (d1.year - 1)

    y = first_year
    while True:
        ys = max(x0, mdates.date2num(ystart(y)))
        ye = min(x1, mdates.date2num(yend(y)))
        if ye > ys:
            w = ye - ys
            header_ax.add_patch(Rectangle((ys, YEAR_Y), w, 1.0 - YEAR_Y,
                                transform=trans, facecolor=year_fill,
                                edgecolor="black", linewidth=EDGE_LW, clip_on=True))
            header_ax.text(ys + w/2.0, YEAR_Y + (1.0 - YEAR_Y)/2.0, str(y),
                           ha="center", va="center", transform=trans, fontsize=fs_y)
            boundary_x = mdates.date2num(ystart(y))
            if x0 < boundary_x < x1:
                header_ax.plot([boundary_x, boundary_x], [YEAR_Y, 1.0],
                               transform=trans, color="black", linewidth=EDGE_LW, clip_on=True)
        if y >= last_year:
            break
        y += 1

    if draw_outer_edges:
        header_ax.plot([x0, x0], [0.0, 1.0], transform=trans,
                       color="black", linewidth=1.2, clip_on=True)
        header_ax.plot([x1, x1], [0.0, 1.0], transform=trans,
                       color="black", linewidth=1.2, clip_on=True)


def _add_year_month_header(ax):
    """
    Two-row header above ax (white):
      - Bottom: boxed months (skips tiny left partial month)
      - Top: year blocks spanning the full chart width, even if a month is skipped
    Delegates to _draw_year_month_header to avoid code duplication.
    """
    HEADER_H = 0.0425
    hdr = ax.inset_axes([0.0, 1.0005, 1.0, HEADER_H], transform=ax.transAxes)
    x0, x1 = ax.get_xlim()
    _draw_year_month_header(hdr, x0, x1, draw_outer_edges=True)


def _draw_milestone_diamond(ax, x, y, half_w_days, half_h_row):
    """Draw a diamond marker at (x, y) and return the Polygon patch."""
    verts = [
        (x, y + half_h_row),
        (x + half_w_days, y),
        (x, y - half_h_row),
        (x - half_w_days, y),
        (x, y + half_h_row),
    ]
    diamond = Polygon(verts, facecolor=PRIMARY,
                      edgecolor=SECONDARY, linewidth=1.0)
    ax.add_patch(diamond)
    return diamond


def _place_gantt_label(ax, x_pos, y_pos, name_text, fontsize, text_width_days,
                       margin_days, chart_left_edge, chart_right_edge,
                       gap_left=0, gap_right=0, force_fallback=True):
    """Place a text label to the right or left of a point, with optional fallback."""
    right_x = x_pos + gap_right
    left_x = x_pos - gap_left
    space_right = chart_right_edge - right_x - margin_days
    space_left = left_x - chart_left_edge - margin_days

    if space_right >= text_width_days:
        ax.text(right_x, y_pos, name_text, va="center", ha="left",
                fontsize=fontsize, color=SECONDARY)
    elif space_left >= text_width_days:
        ax.text(left_x, y_pos, name_text, va="center", ha="right",
                fontsize=fontsize, color=SECONDARY)
    elif force_fallback:
        ax.text(right_x, y_pos, name_text, va="center", ha="left",
                fontsize=fontsize, color=SECONDARY)


def _build_one_page_with_version(pdf, page_rows, page_num, total_pages, x_min, x_max, true_start,
                                 total_span_days, chart_width_inches, title, project_title, customer_name, logo_path, version="V1", project_location="", project_state="", project_size_mw="", logo_img_cache=None):
    """Renders a single page of the Gantt chart with version info."""
    header_row = {
        "name": "Task", "start": None, "finish": None, "kind": "header", "dur": "Duration"
    }
    from matplotlib import font_manager as fm, rcParams
    if not getattr(_build_one_page_with_version, "_jost_loaded", False):
        try:
            jost_regular = resource_path("Jost-Regular.ttf")
            jost_bold = resource_path("Jost-Bold.ttf")
            # Register Jost fonts with Matplotlib so they embed in the PDF
            if os.path.exists(jost_regular):
                fm.fontManager.addfont(jost_regular)
            if os.path.exists(jost_bold):
                fm.fontManager.addfont(jost_bold)
            rcParams["font.family"] = "Jost"
            rcParams["pdf.fonttype"] = 42   # Embed TTF (Type 42)
            rcParams["ps.fonttype"] = 42
            _build_one_page_with_version._jost_loaded = True
        except Exception as e:
            print(f"Warning: could not load Jost fonts; using default. {e}")
    all_rows_for_page = [header_row] + page_rows

    fig = plt.figure(figsize=(16, 10))

    # Manual Axes Creation for Fixed Row Height
    left_margin, right_margin, bottom_margin, top_margin = 0.03, 0.99, 0.1, 0.88

    plot_area_w = right_margin - left_margin
    full_plot_area_h = top_margin - bottom_margin

    # FIXED: Calculate heights based on data rows only (excluding header)
    data_rows_count = len(page_rows)  # Only actual data rows
    rows_on_full_page = MAX_ROWS_PER_PAGE
    height_ratio = data_rows_count / rows_on_full_page
    data_plot_h = full_plot_area_h * height_ratio

# Single source of truth for BOTH table and chart headers (constant height)
    HEADER_HEIGHT = 0.035
    header_height = HEADER_HEIGHT
    header_gap = 0.0  # headers meet cleanly without overlaps
    total_content_h = header_height + header_gap + data_plot_h

    current_bottom = top_margin - total_content_h
    table_w = plot_area_w * (LEFT_RIGHT_WIDTHS[0] / sum(LEFT_RIGHT_WIDTHS))
    chart_w = plot_area_w * (LEFT_RIGHT_WIDTHS[1] / sum(LEFT_RIGHT_WIDTHS))
    table_l, chart_l = left_margin, left_margin + table_w

    # Create header and data areas with slight overlap to eliminate gap
    header_bottom = current_bottom + data_plot_h + header_gap

    # === HEADER SETUP (clean + tunable borders) ===============================
    ax_header_left = fig.add_axes(
        [table_l, header_bottom, table_w, HEADER_HEIGHT])
    ax_header_right = fig.add_axes(
        [chart_l, header_bottom, chart_w, HEADER_HEIGHT])

    ax_left = fig.add_axes([table_l, current_bottom, table_w, data_plot_h])
    ax_right = fig.add_axes([chart_l, current_bottom, chart_w, data_plot_h])
    ax_right.sharey(ax_left)

    # -----------------------------
    # Tunable line weights (points)
    # -----------------------------
    # Use these to match the rest of your table/grid lines:
    OUTER_BORDER_LW = 1.5  # NEW: Thick outer border for entire Gantt perimeter

    HEADER_OUTER_LW = 0.8   # top/left/right/bottom frame around the whole header band
    # vertical splits between Task / Duration / Start / Finish in header
    HEADER_SPLITS_LW = 0.8
    # the vertical divider between table and chart (intentionally thicker)
    TABLE_CHART_DIV_LW = 0.8
    CAPSTYLE = "butt"  # "butt" avoids rounded ends that can look thicker at corners

    # Turn off spines/ticks on header axes (we draw everything explicitly)
    for _ax in (ax_header_left, ax_header_right):
        _ax.set_axis_off()
        for side in ("top", "right", "left", "bottom"):
            if side in _ax.spines:
                _ax.spines[side].set_visible(False)

    # Top edge across entire width (table + chart)
    fig.add_artist(Line2D([table_l, chart_l + chart_w],
                          [header_bottom + HEADER_HEIGHT,
                              header_bottom + HEADER_HEIGHT],
                          transform=fig.transFigure, linewidth=OUTER_BORDER_LW,
                          color="black", solid_capstyle=CAPSTYLE))

    # Left edge (table side)
    fig.add_artist(Line2D([table_l, table_l],
                          [current_bottom, header_bottom + HEADER_HEIGHT],
                          transform=fig.transFigure, linewidth=OUTER_BORDER_LW,
                          color="black", solid_capstyle=CAPSTYLE))

    # Right edge (chart side)
    fig.add_artist(Line2D([chart_l + chart_w, chart_l + chart_w],
                          [current_bottom, header_bottom + HEADER_HEIGHT],
                          transform=fig.transFigure, linewidth=OUTER_BORDER_LW,
                          color="black", solid_capstyle=CAPSTYLE))

    # Bottom edge across entire width (table + chart)
    fig.add_artist(Line2D([table_l, chart_l + chart_w],
                          [current_bottom, current_bottom],
                          transform=fig.transFigure, linewidth=OUTER_BORDER_LW,
                          color="black", solid_capstyle=CAPSTYLE))
    # ---------------------------------------------
    # 2) Table–Chart vertical separator (emphasized)
    # ---------------------------------------------
    fig.add_artist(Line2D([chart_l, chart_l],
                          [header_bottom, header_bottom + HEADER_HEIGHT],
                          transform=fig.transFigure, linewidth=TABLE_CHART_DIV_LW,
                          color="black", solid_capstyle=CAPSTYLE))

    # -------------------------------------------------
    # 3) Header fill + labels (NO edges on rectangles)
    # -------------------------------------------------
    ax_header_left.set_xlim(0, 1)
    ax_header_left.set_ylim(-0.5, 0.5)
    ax_header_left.axis("off")

    # Column background fills (no edges -> avoids double-thick borders)
    for c in range(4):
        x0 = COL_EDGES[c]
        w = COL_EDGES[c + 1] - COL_EDGES[c]
        ax_header_left.add_patch(Rectangle(
            (x0, -0.5), w, 1.0,
            facecolor=PRIMARY,
            edgecolor="none", linewidth=0
        ))

    # Header labels
    for c, header_text in enumerate(HEADERS):
        center_x = (COL_EDGES[c] + COL_EDGES[c + 1]) / 2
        ax_header_left.text(center_x, 0, header_text,
                            va="center", ha="center",
                            fontsize=FONTSIZE_TABLE, fontweight="bold", color="white")

    # ---------------------------------------------
    # 4) Internal column split lines inside header
    # ---------------------------------------------
    for x in COL_EDGES[1:-1]:
        ax_header_left.plot([x, x], [-0.5, 0.5],
                            color=SECONDARY, linewidth=HEADER_SPLITS_LW,
                            solid_capstyle=CAPSTYLE)

    # LEFT: data table (only page_rows, no header)
    ax_left.set_xlim(0, 1)
    ax_left.set_ylim(-0.5, len(page_rows) - 0.5)
    ax_left.invert_yaxis()
    ax_left.axis("off")

    # Draw only the data rows (skip header processing)
    for idx, r in enumerate(page_rows):
        is_summary_row = r["kind"] == "summary"
        is_top_level = (r.get("indent", 0) == 0)

        for c in range(4):
            x0 = COL_EDGES[c]
            w = COL_EDGES[c + 1] - COL_EDGES[c]

            if is_summary_row and is_top_level:
                # Section headers stay red
                ax_left.add_patch(Rectangle((x0, idx - 0.5), w, 1.0,
                                            facecolor=PRIMARY, edgecolor=SECONDARY, linewidth=0.6))
            elif is_summary_row:
                # Sub-summary rows go gray
                ax_left.add_patch(Rectangle((x0, idx - 0.5), w, 1.0,
                                            facecolor="#D3D3D3", edgecolor=SECONDARY, linewidth=0.6))
            else:
                ax_left.add_patch(Rectangle((x0, idx - 0.5), w, 1.0,
                                            fill=False, edgecolor=SECONDARY, linewidth=0.6))

        name_text = r["name"].replace('\n', ' ').replace('\r', ' ')
        if len(name_text) > MAX_NAME_LENGTH:
            name_text = name_text[:MAX_NAME_LENGTH-3] + "..."

        text_color = "white" if (
            is_summary_row and is_top_level) else SECONDARY
        font_weight = "bold" if is_summary_row else "normal"

        ax_left.text(COL_EDGES[0] + 0.008, idx, name_text, va="center", ha="left",
                     fontsize=FONTSIZE_TABLE, fontweight=font_weight, color=text_color)
        ax_left.text((COL_EDGES[1] + COL_EDGES[2]) / 2, idx,
                     ("" if r["dur"] is None else f"{r['dur']}"),
                     va="center", ha="center", fontsize=FONTSIZE_TABLE, color=text_color)
        if r["start"]:
            ax_left.text((COL_EDGES[2] + COL_EDGES[3]) / 2, idx,
                         r["start"].strftime("%m/%d/%y"), va="center", ha="center", fontsize=FONTSIZE_TABLE, color=text_color)
        if r["finish"]:
            ax_left.text((COL_EDGES[3] + COL_EDGES[4]) / 2, idx,
                         r["finish"].strftime("%m/%d/%y"), va="center", ha="center", fontsize=FONTSIZE_TABLE, color=text_color)

    ax_left.axhline(y=-0.5, linestyle="-",
                    linewidth=OUTER_BORDER_LW, color=SECONDARY)
    ax_left.axhline(y=len(page_rows) - 0.5, linestyle="-",
                    linewidth=OUTER_BORDER_LW, color=SECONDARY)
    ax_left.axvline(x=0, linestyle="-",
                    linewidth=OUTER_BORDER_LW, color=SECONDARY)

    # RIGHT: chart
    chart_right_edge = mdates.date2num(x_max)
    ax_right.set_xlim(mdates.date2num(x_min), chart_right_edge)
    # Set up x-axis ticks to align with month boundaries

    # Create month locator for major ticks
    month_locator = MonthLocator()
    ax_right.xaxis.set_major_locator(month_locator)

    # Position ticks at month boundaries
    ax_right.tick_params(axis="x", which="major",
                         bottom=True, top=False,
                         labelbottom=False, labeltop=False,
                         length=0, width=1, color=SECONDARY)

    # Add minor ticks for weeks
    week_locator = WeekdayLocator(byweekday=0)  # Monday
    ax_right.xaxis.set_minor_locator(week_locator)

    ax_right.tick_params(axis="x", which="minor",
                         bottom=True, top=False,
                         labelbottom=False, labeltop=False,

                         length=0, width=0.5, color=SECONDARY)
    span_months = (x_max.year - x_min.year) * 12 + \
        (x_max.month - x_min.month) + 1
    _draw_year_month_header(
        ax_header_right,
        mdates.date2num(x_min),
        mdates.date2num(x_max),
        draw_outer_edges=False  # important: borders handled at figure level
    )

    if span_months <= 12:
        ax_right.grid(which="minor", axis="x", linestyle=(
            0, (5, 10)), linewidth=0.4, color=SECONDARY, alpha=0.25)
        ax_right.grid(which="major", axis="x", linestyle="--",
                      linewidth=0.8, color=SECONDARY, alpha=0.6)
    else:
        ax_right.grid(which="major", axis="x", linestyle=(
            0, (5, 10)), linewidth=0.4, color=SECONDARY, alpha=0.6)

    for y in range(len(page_rows) + 1):
        ax_right.axhline(y=y - 0.5, linestyle="--",
                         linewidth=0.6, color=SECONDARY, alpha=0.5)

    ax_right.axhline(y=-0.5, linestyle="-",
                     linewidth=OUTER_BORDER_LW, color=SECONDARY)
    ax_right.axhline(y=len(page_rows) - 0.5, linestyle="-",
                     linewidth=OUTER_BORDER_LW, color=SECONDARY)
    ax_right.axvline(x=chart_right_edge, linestyle="-",
                     linewidth=OUTER_BORDER_LW, color=SECONDARY)

    ax_right.set_yticks([])
    chart_left_edge = mdates.date2num(x_min)

    # Pre-compute values used repeatedly in the rendering loop (P3-14)
    days_per_inch = total_span_days / chart_width_inches
    diamond_half_w_days = DIAMOND_HALF_WIDTH_IN * days_per_inch
    margin_days = max(1.5, total_span_days * 0.015)
    gap_days = MILESTONE_TEXT_GAP_IN * days_per_inch

    # FIXED: Process only page_rows (data rows), adjust indices accordingly
    for idx, r in enumerate(page_rows):

        if r["start"] and r["finish"] and r.get("kind") != "summary":

            start_num, finish_num = mdates.date2num(
                r["start"]), mdates.date2num(r["finish"])

            # Use stored duration to determine milestone vs task - MUST be exactly 0
            stored_duration = r.get("dur", 0)
            is_milestone = (stored_duration == 0)

            if is_milestone:
                _draw_milestone_diamond(
                    ax_right, start_num, idx, diamond_half_w_days, DIAMOND_HALF_HEIGHT_ROW)

                name_text = r["name"].replace('\n', ' ').replace('\r', ' ')
                text_width_days = estimate_text_width_in_days(
                    name_text, FONTSIZE_CHART_SUMMARY, total_span_days, chart_width_inches)

                _place_gantt_label(ax_right, start_num, idx, name_text, FONTSIZE_CHART_SUMMARY,
                                   text_width_days, margin_days, chart_left_edge, chart_right_edge,
                                   gap_left=diamond_half_w_days + gap_days,
                                   gap_right=diamond_half_w_days + gap_days,
                                   force_fallback=True)

            else:
                span = max(finish_num - start_num, MIN_WIDTH_DAYS)
                bar_height, bar_y = 0.5, idx - 0.25
                ax_right.broken_barh([(start_num, span)], (bar_y, bar_height),
                                     facecolors=PRIMARY, edgecolors=SECONDARY, linewidth=0.8)
                name_text = r["name"].replace('\n', ' ').replace('\r', ' ')
                text_width_days = estimate_text_width_in_days(
                    name_text, FONTSIZE_CHART_REGULAR, total_span_days, chart_width_inches)
                _place_gantt_label(ax_right, finish_num, idx, name_text, FONTSIZE_CHART_REGULAR,
                                   text_width_days, margin_days, chart_left_edge, chart_right_edge,
                                   gap_left=finish_num - start_num + margin_days,
                                   gap_right=margin_days,
                                   force_fallback=False)
        elif r["kind"] == "summary" and r["start"] and r["finish"]:
            start_num, finish_num = mdates.date2num(
                r["start"]), mdates.date2num(r["finish"])
            span = max(finish_num - start_num, MIN_WIDTH_DAYS)

            # KEEP 'Project Closeout' as a milestone even though it's a summary row
            if (r.get("indent", 0) == 0
                and r.get("dur", 0) == 0
                    and str(r.get("name", "")).strip().lower() == "project closeout"):
                _draw_milestone_diamond(
                    ax_right, start_num, idx, diamond_half_w_days, DIAMOND_HALF_HEIGHT_ROW)

                name_text = r["name"].replace("\n", " ").replace("\r", " ")
                text_width_days = estimate_text_width_in_days(
                    name_text, FONTSIZE_CHART_SUMMARY, total_span_days, chart_width_inches
                )

                # Candidate positions
                text_right_x = start_num + diamond_half_w_days + gap_days
                space_on_right = chart_right_edge - text_right_x - margin_days

                text_left_x = start_num - diamond_half_w_days - gap_days
                space_on_left = text_left_x - chart_left_edge - margin_days

                if space_on_right >= text_width_days:
                    x, ha = text_right_x, "left"
                elif space_on_left >= text_width_days:
                    x, ha = text_left_x, "right"
                else:
                    x, ha = min(text_right_x, chart_right_edge -
                                margin_days - max(0.0, text_width_days)), "left"

                ax_right.text(x, idx, name_text,
                              va="center", ha=ha, fontsize=FONTSIZE_CHART_SUMMARY, color=SECONDARY)
                continue

            bar_height, bar_y, cap_height = 0.1, idx - 0.05, 0.4
            name_text = r["name"].replace('\n', ' ').replace('\r', ' ')
            text_width_days = estimate_text_width_in_days(
                name_text, FONTSIZE_CHART_SUMMARY, total_span_days, chart_width_inches)
            space_on_right = chart_right_edge - \
                (start_num + span) - margin_days
            space_on_left = start_num - chart_left_edge - margin_days
            if space_on_right >= text_width_days:
                ax_right.broken_barh([(start_num, span)], (bar_y, bar_height),
                                     facecolors=SECONDARY, edgecolors=SECONDARY, linewidth=1.0)
                ax_right.plot([start_num, start_num], [
                              idx - cap_height/2, idx + cap_height/2], color=SECONDARY, linewidth=2)
                ax_right.plot([start_num + span, start_num + span], [idx -
                              cap_height/2, idx + cap_height/2], color=SECONDARY, linewidth=2)
                ax_right.text(start_num + span + margin_days, idx, name_text, va="center",
                              ha="left", fontsize=FONTSIZE_CHART_SUMMARY, color=SECONDARY)
            elif space_on_left >= text_width_days:
                ax_right.broken_barh([(start_num, span)], (bar_y, bar_height),
                                     facecolors=SECONDARY, edgecolors=SECONDARY, linewidth=1.0)
                ax_right.plot([start_num, start_num], [
                              idx - cap_height/2, idx + cap_height/2], color=SECONDARY, linewidth=2)
                ax_right.plot([start_num + span, start_num + span], [idx -
                              cap_height/2, idx + cap_height/2], color=SECONDARY, linewidth=2)
                ax_right.text(start_num - margin_days, idx, name_text, va="center",
                              ha="right", fontsize=FONTSIZE_CHART_SUMMARY, color=SECONDARY)
            else:
                bar_center = start_num + span / 2
                text_space_needed = min(text_width_days + 0.2, span * 0.9)
                left_split_end = bar_center - text_space_needed / 2
                right_split_start = bar_center + text_space_needed / 2
                min_segment_width = max(0.5, total_span_days * 0.005)
                if left_split_end > start_num and (left_split_end - start_num) >= min_segment_width:
                    ax_right.broken_barh([(start_num, left_split_end - start_num)], (bar_y,
                                         bar_height), facecolors=SECONDARY, edgecolors=SECONDARY, linewidth=1.0)
                    ax_right.plot([start_num, start_num], [
                                  idx - cap_height/2, idx + cap_height/2], color=SECONDARY, linewidth=2)
                if right_split_start < start_num + span and ((start_num + span) - right_split_start) >= min_segment_width:
                    ax_right.broken_barh([(right_split_start, (start_num + span) - right_split_start)],
                                         (bar_y, bar_height), facecolors=SECONDARY, edgecolors=SECONDARY, linewidth=1.0)
                    ax_right.plot([start_num + span, start_num + span], [idx -
                                  cap_height/2, idx + cap_height/2], color=SECONDARY, linewidth=2)
                ax_right.text(bar_center, idx, name_text, va="center",
                              ha="center", fontsize=FONTSIZE_CHART_SUMMARY, color=SECONDARY)

    ax_right.axvline(mdates.date2num(true_start), linestyle="--",
                     linewidth=1.0, color=SECONDARY, alpha=0.4)

    # --- header & title (updated) ---
    # Center "Project Schedule" vertically in the header band (between top_margin=0.88 and 0.99 -> ~0.935)
    title_y = 0.935
    fig.text(0.5, title_y, title, ha='center', va='center',
             fontsize=16, fontweight='bold', color=PRIMARY)

    # Left-side project info (moved slightly down) - Customer on top, then Project, then Location/State, then Size
    info_y = 0.975
    line_step = 0.022

    if customer_name:
        fig.text(0.03, info_y, _tabs_to_spaces(f"Customer\t:\t\t{customer_name}"), ha='left', va='top',
                 fontsize=13, fontweight='bold', color=PRIMARY)
        info_y -= line_step

    if project_title:
        fig.text(0.03, info_y, _tabs_to_spaces(f"Project    \t:\t\t{project_title}"), ha='left', va='top',
                 fontsize=13, fontweight='bold', color=PRIMARY)
        info_y -= line_step

    # Location and State
    loc_bits = [b for b in [project_location, project_state] if b]
    if loc_bits:
        fig.text(0.03, info_y, _tabs_to_spaces(f"Location  \t:\t\t{', '.join(loc_bits)}"), ha='left', va='top',
                 fontsize=13, fontweight='bold', color=PRIMARY)
        info_y -= line_step

    # Size (MW)
    if project_size_mw:
        fig.text(0.03, info_y, _tabs_to_spaces(f"Size\t\t\t\t  \t:\t\t{str(project_size_mw)} MW"), ha='left', va='top',
                 fontsize=13,  fontweight='bold', color=PRIMARY)
        info_y -= line_step
    # Logo (use cached image if available to avoid re-reading from disk per page)
    _logo = logo_img_cache
    if _logo is None and logo_path:
        try:
            _logo = plt.imread(logo_path)
        except Exception as e:
            print(f"Warning: Could not load logo. Error: {e}")
            _logo = None

    if _logo is not None:
        try:
            desired_height_in = 0.8
            TARGET_DPI = 300
            max_height_in = _logo.shape[0] / TARGET_DPI
            logo_height_in = min(desired_height_in, max_height_in)

            fig_width_in, fig_height_in = fig.get_size_inches()
            logo_height_fig = logo_height_in / fig_height_in

            aspect_ratio = _logo.shape[1] / _logo.shape[0]
            logo_width_in = logo_height_in * aspect_ratio
            logo_width_fig = logo_width_in / fig_width_in

            right_edge, top_edge = 0.99, 0.975
            left_pos = right_edge - logo_width_fig
            bottom_pos = top_edge - logo_height_fig

            ax_logo = fig.add_axes([left_pos, bottom_pos, logo_width_fig, logo_height_fig],
                                   anchor='NE', zorder=10)
            ax_logo.imshow(_logo, interpolation="none")
            ax_logo.axis('off')
        except Exception as e:
            print(f"Warning: Could not place logo. Error: {e}")

    # Footer with date and version
    date_str = datetime.now().strftime("%B %d, %Y")
    fig.text(0.03, 0.02, f"{date_str} - {version}",
             ha='left', va='bottom', fontsize=8, color='gray')

    pdf.savefig(fig, bbox_inches="tight", dpi=300)
    plt.close(fig)


def build_gantt_with_version(rows, out_pdf, title="Project Schedule", project_title="", customer_name="", logo_path="", version="V1", project_location="", project_state="", project_size_mw="",):
    """Render the Gantt to PDF with version info in footer."""
    if not rows:
        print("Warning: No tasks to plot.")
        return

    starts = [r["start"] for r in rows if r["start"]]
    finishes = [r["finish"] for r in rows if r["finish"]]
    if not starts or not finishes:
        raise ValueError("No dated tasks found.")
    true_start, true_finish = min(starts), max(finishes)

    span_days = max(1, (true_finish.date() - true_start.date()).days)

    # Fixed diamond half-width in *inches* converted to days -> consistent across projects
    chart_width_inches = 16 * LEFT_RIGHT_WIDTHS[1] / sum(LEFT_RIGHT_WIDTHS)
    days_per_inch = span_days / chart_width_inches
    diamond_half_w_days = DIAMOND_HALF_WIDTH_IN * days_per_inch

    left_pad_days = diamond_half_w_days + 2
    right_pad_days = max(1, int(span_days * 0.05))
    x_min = true_start - timedelta(days=left_pad_days)
    x_max = true_finish + timedelta(days=right_pad_days)
    total_span_days = (x_max.date() - x_min.date()).days

    for r in rows:
        r["dur"] = duration_for_table(r)

    # Pre-load logo image once for all pages (P1-6)
    logo_img_cache = None
    if logo_path:
        try:
            logo_img_cache = plt.imread(logo_path)
        except Exception:
            logo_img_cache = None

    with PdfPages(out_pdf) as pdf:
        total_pages = (len(rows) + MAX_ROWS_PER_PAGE - 1) // MAX_ROWS_PER_PAGE
        chart_width_inches = 16 * LEFT_RIGHT_WIDTHS[1] / sum(LEFT_RIGHT_WIDTHS)

        for i in range(0, len(rows), MAX_ROWS_PER_PAGE):
            page_rows_chunk = rows[i: i + MAX_ROWS_PER_PAGE]
            page_num = (i // MAX_ROWS_PER_PAGE) + 1
            print(f"Generating page {page_num} of {total_pages}...")
            _build_one_page_with_version(
                pdf=pdf, page_rows=page_rows_chunk, page_num=page_num, total_pages=total_pages,
                x_min=x_min, x_max=x_max, true_start=true_start, total_span_days=total_span_days,
                chart_width_inches=chart_width_inches, title=title, project_title=project_title,
                customer_name=customer_name, logo_path=logo_path, version=version, project_location=project_location, project_state=project_state, project_size_mw=project_size_mw,
                logo_img_cache=logo_img_cache
            )


# ---------------------------------------------------------------------------
# Tree -> Gantt rows.  Port of ProposalGenerator._add_gantt_page's inner
# collect_tasks_recursive (Full_proposal_V9.py:7269).  Skips disabled and
# price-only items; top-level section headers are always emitted (falling back
# to the project end/start date when undated); everything else is emitted only
# once it has both dates.  kind = "summary" for sections/parents, else "task".
# ---------------------------------------------------------------------------
def build_gantt_rows(
    template_items,
    *,
    project_utilization: float,
    project_end_date: Optional[str] = None,
    project_start_date: str = "",
):
    """Flatten the scheduled item tree into the row dicts build_gantt consumes."""
    rows = []

    def _adjusted(item):
        return adjusted_duration(
            item.duration,
            is_milestone=item.is_milestone,
            in_project_initiation=is_in_project_initiation(item),
            name=item.name,
            task_utilization=getattr(item, "task_utilization", None),
            project_utilization=project_utilization,
        )

    def collect_tasks_recursive(items):
        for item in items:
            # Skip price-only items in Gantt chart
            if item.enabled and not item.price_only:
                # Include section headers even if they don't have dates or child tasks
                if item.is_milestone and item.indent_level == 0:  # Top-level section headers
                    # For section headers without dates, use project end date as placeholder
                    if not item.start_date or not item.end_date:
                        try:
                            if project_end_date:
                                end_dt = datetime.strptime(
                                    project_end_date, "%m/%d/%y")
                                start_dt = end_dt  # Same day for headers without duration
                            else:
                                project_start = datetime.strptime(
                                    project_start_date, "%m/%d/%y")
                                start_dt = project_start
                                end_dt = project_start
                        except (ValueError, AttributeError):
                            start_dt = datetime.now()
                            end_dt = datetime.now()
                    else:
                        try:
                            start_dt = datetime.strptime(
                                item.start_date, "%m/%d/%y")
                            end_dt = datetime.strptime(
                                item.end_date, "%m/%d/%y")
                        except (ValueError, TypeError):
                            continue

                    stored_duration = _adjusted(item)

                    rows.append({
                        "name": item.name,
                        "start": start_dt,
                        "finish": end_dt,
                        "kind": "summary",
                        "indent": int(getattr(item, "indent_level", 0)),
                        "dur": int(stored_duration)
                    })

                # Include regular tasks with dates
                elif item.start_date and item.end_date:
                    try:
                        start_dt = datetime.strptime(
                            item.start_date, "%m/%d/%y")
                        end_dt = datetime.strptime(
                            item.end_date, "%m/%d/%y")

                        # Determine kind based on item properties
                        if item.children:
                            kind = "summary"
                        else:
                            kind = "task"

                        stored_duration = _adjusted(item)

                        rows.append({
                            "name": item.name,
                            "start": start_dt,
                            "finish": end_dt,
                            "kind": kind,
                            "indent": int(getattr(item, "indent_level", 0)),
                            "dur": int(stored_duration)
                        })
                    except (ValueError, TypeError):
                        continue

            if item.children:
                collect_tasks_recursive(item.children)

    collect_tasks_recursive(template_items)
    return rows


def render_gantt_bytes(
    rows,
    *,
    title="Project Schedule",
    project_title="",
    customer_name="",
    logo_path="",
    version="V1",
    project_location="",
    project_state="",
    project_size_mw="",
) -> bytes:
    """Render the Gantt to an in-memory PDF and return the bytes.

    Thin wrapper around build_gantt_with_version (which writes to a path) so the
    API layer can stream the PDF without juggling temp files itself.
    """
    buf = BytesIO()
    build_gantt_with_version(
        rows=rows,
        out_pdf=buf,
        title=title,
        project_title=project_title,
        customer_name=customer_name,
        logo_path=logo_path,
        version=version,
        project_location=project_location,
        project_state=project_state,
        project_size_mw=project_size_mw,
    )
    return buf.getvalue()
