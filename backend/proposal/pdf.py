"""Server-side schedule-table PDF — verbatim port of the desktop ReportLab builder.

Page 1 of the Castillo "Project Schedule" deliverable: the hierarchical
milestones/values table with the project header band + logos. Ported from the
desktop ProposalGenerator (Full_proposal_V9.py + proposal_generator.py):

  _setup_reportlab_styles   (V9:6792)  — per-mode column widths + Jost styles
  _create_pdf_header        (V9:6847)  — company/project + client logo + company logo
  _create_table_data        (V9:6971)  — header + summary + recursive rows per mode
  _style_table              (V9:7182)  — header/summary fills + milestone row colors

Schedule-table modes (``schedule_table_mode``), 1:1 with the desktop:
  both           Name / Days / Start / Finish / Price   (default)
  price_only     Deliverables / Price                   (Schedule of Values)
  dates_only     Project Schedule / Days / Start / Finish
  no_dates       Project Schedule / Days / Price
  duration_only  Project Schedule / Days
Plus ``milestones_only`` (drop non-milestone rows in any non-price mode).

The "both" layout keeps the confirmed reference styling ("Project Milestones"
header + project-name grand-total row, from proposal_generator.py); the other
four modes use the V9 labels + "TOTAL" summary, exactly as the desktop tool.

Mechanical changes only for headless use: ``tk.BooleanVar.get()`` -> plain bool,
fonts from backend/templates/fonts/, renders to BytesIO.
"""
from __future__ import annotations

import os
from datetime import datetime
from io import BytesIO
from typing import Optional

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.utils import ImageReader
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Table, TableStyle, Paragraph,
    Spacer, Image,
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

from .gantt import resource_path
from .calendar import business_days_inclusive, adjusted_duration
from .scheduling import is_in_project_initiation
from .models import ProjectInfo

VALID_MODES = ("both", "price_only", "dates_only", "no_dates", "duration_only")


# ---------------------------------------------------------------------------
# Styles + per-mode column widths (V9 _setup_reportlab_styles)
# ---------------------------------------------------------------------------
def _setup_reportlab_styles(mode: str):
    font_size, leading, header_font_size, header_leading = 7, 9, 8, 11
    if mode == "price_only":
        col_widths = [5.6 * inch, 1.6 * inch]
    elif mode == "dates_only":
        col_widths = [3.9 * inch, 0.7 * inch, 1.0 * inch, 1.6 * inch]
    elif mode == "no_dates":
        col_widths = [4.7 * inch, 0.8 * inch, 1.7 * inch]
    elif mode == "duration_only":
        col_widths = [5.6 * inch, 1.6 * inch]
    else:  # both
        col_widths = [3.3 * inch, 0.7 * inch, 1.0 * inch, 1.0 * inch, 1.2 * inch]
    header_padding, row_padding = 3, 1

    font_name, font_name_bold = "Jost", "Jost-Bold"
    try:
        pdfmetrics.registerFont(TTFont(font_name, resource_path("Jost-Regular.ttf")))
        pdfmetrics.registerFont(TTFont(font_name_bold, resource_path("Jost-Bold.ttf")))
        # Link the faces so <b> markup (header / milestone rows) resolves to
        # Jost-Bold and embeds it (otherwise bold silently falls back to Regular).
        from reportlab.pdfbase.pdfmetrics import registerFontFamily
        registerFontFamily(
            font_name, normal=font_name, bold=font_name_bold,
            italic=font_name, boldItalic=font_name_bold,
        )
    except Exception as e:
        print(f"Could not load custom fonts, falling back to Helvetica. Error: {e}")
        font_name, font_name_bold = "Helvetica", "Helvetica-Bold"

    styles = getSampleStyleSheet()
    table_styles = {
        "header_project": ParagraphStyle("header_project_style", parent=styles["Normal"], fontName=font_name_bold, fontSize=14, alignment=0),
        "table_text": ParagraphStyle("table_text_style", parent=styles["Normal"], fontName=font_name, fontSize=font_size, leading=leading, alignment=0),
        "table_bold": ParagraphStyle("table_bold_style", parent=styles["Normal"], fontName=font_name_bold, fontSize=font_size, leading=leading, alignment=0),
        "table_bold_white": ParagraphStyle("table_bold_white_style", parent=styles["Normal"], fontName=font_name_bold, fontSize=font_size, leading=leading, textColor=colors.white, alignment=0),
        "table_header_left": ParagraphStyle("table_header_style_left", parent=styles["Normal"], fontName=font_name_bold, fontSize=header_font_size, leading=header_leading, alignment=0, textColor=colors.white),
        "table_header_right": ParagraphStyle("table_header_style_right", parent=styles["Normal"], fontName=font_name_bold, fontSize=header_font_size, leading=header_leading, alignment=2, textColor=colors.white),
    }
    return {"styles": table_styles, "col_widths": col_widths,
            "header_padding": header_padding, "row_padding": row_padding}


def _exists(path: str) -> bool:
    try:
        return bool(path) and os.path.exists(path)
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Header band (V9 _create_pdf_header) — company/project, client logo, company logo
# ---------------------------------------------------------------------------
def _create_pdf_header(style_settings, info: ProjectInfo):
    styles = style_settings["styles"]
    col_widths = style_settings["col_widths"]

    left_para = Paragraph(
        f"<font color='#991f2b'>{info.customer_name}<br/><br/>{info.project_title}</font>",
        styles["header_project"],
    )

    client_logo_path = getattr(info, "client_logo_path", "") or ""
    mid = Paragraph("", styles["header_project"])
    if _exists(client_logo_path):
        try:
            mid = Image(client_logo_path, width=2.0 * inch, height=1.0 * inch, kind="proportional")
            mid.hAlign = "CENTER"
        except Exception:
            mid = Paragraph("", styles["header_project"])

    if len(col_widths) == 3:
        header_col_widths = [3.7 * inch, 2.2 * inch, 1.3 * inch]
    else:
        header_col_widths = col_widths

    right = Paragraph("", styles["header_project"])
    if _exists(info.logo_path):
        try:
            img = ImageReader(info.logo_path)
            iw, ih = img.getSize()
            if len(col_widths) >= 5:
                max_w = float(col_widths[3] + col_widths[4])
            elif len(col_widths) == 3:
                max_w = float(header_col_widths[-1])
            else:
                max_w = float(col_widths[-1])
            max_h = 0.85 * inch
            scale = min(max_w / float(iw), max_h / float(ih))
            right = Image(info.logo_path, width=float(iw) * scale,
                          height=float(ih) * scale, kind="proportional")
            right.hAlign = "RIGHT"
        except Exception:
            right = Paragraph("", styles["header_project"])

    if len(col_widths) >= 5:
        hdr_row = [left_para, mid, "", right, ""]
    elif len(col_widths) == 4:
        hdr_row = [left_para, mid, "", right]
    elif len(col_widths) == 3:
        hdr_row = [left_para, mid, right]
    else:
        hdr_row = [left_para, right]

    hdr = Table([hdr_row], colWidths=header_col_widths, hAlign="LEFT")
    ts = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (0, 0), "LEFT"),
        ("TOPPADDING", (0, 0), (-1, -1), 15),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ("LEFTPADDING", (0, 0), (0, 0), 0.15 * inch),
    ]
    if len(col_widths) >= 3:
        last_center_col = 2 if len(col_widths) >= 4 else 1
        ts.extend([
            ("ALIGN", (1, 0), (last_center_col, 0), "CENTER"),
            ("LEFTPADDING", (1, 0), (last_center_col, 0), 0),
            ("RIGHTPADDING", (1, 0), (last_center_col, 0), 0),
        ])
    if len(col_widths) >= 5:
        ts.extend([
            ("ALIGN", (3, 0), (4, 0), "RIGHT"), ("SPAN", (1, 0), (2, 0)),
            ("SPAN", (3, 0), (4, 0)), ("LEFTPADDING", (3, 0), (4, 0), 0),
            ("RIGHTPADDING", (3, 0), (4, 0), -0.2 * inch),
        ])
    elif len(col_widths) == 4:
        ts.extend([
            ("ALIGN", (3, 0), (3, 0), "RIGHT"), ("SPAN", (1, 0), (2, 0)),
            ("LEFTPADDING", (3, 0), (3, 0), 0), ("RIGHTPADDING", (3, 0), (3, 0), -0.2 * inch),
        ])
    elif len(col_widths) == 3:
        ts.extend([
            ("ALIGN", (2, 0), (2, 0), "RIGHT"),
            ("LEFTPADDING", (2, 0), (2, 0), 0), ("RIGHTPADDING", (2, 0), (2, 0), -0.2 * inch),
        ])
    else:
        ts.extend([
            ("ALIGN", (1, 0), (1, 0), "RIGHT"),
            ("LEFTPADDING", (1, 0), (1, 0), 0), ("RIGHTPADDING", (1, 0), (1, 0), -0.2 * inch),
        ])
    hdr.setStyle(TableStyle(ts))
    return hdr


# ---------------------------------------------------------------------------
# Per-item display duration (V9 get_adjusted_duration)
# ---------------------------------------------------------------------------
def _display_duration(item, project_util: float) -> int:
    return adjusted_duration(
        int(item.duration or 0),
        is_milestone=item.is_milestone,
        in_project_initiation=is_in_project_initiation(item),
        name=item.name,
        task_utilization=getattr(item, "task_utilization", None),
        project_utilization=project_util,
    )


# ---------------------------------------------------------------------------
# Table data (V9 _create_table_data) — header + summary + recursive rows
# ---------------------------------------------------------------------------
def _create_table_data(styles, template_items, info, mode, milestones_only,
                       disabled, project_util):
    all_table_data = []
    table_text_style = styles["table_text"]
    table_bold_style = styles["table_bold"]
    table_bold_white_style = styles["table_bold_white"]
    th_left = styles["table_header_left"]
    th_right = styles["table_header_right"]

    # ---- header row ----
    if mode == "price_only":
        # "Schedule of Values" titles the price-only deliverable (the SOV PDF).
        header = [Paragraph("Schedule of Values", th_left), Paragraph("Price", th_right)]
    elif mode == "dates_only":
        header = [Paragraph("Project Schedule", th_left), Paragraph("Days", th_left),
                  Paragraph("Start", th_left), Paragraph("Finish", th_left)]
    elif mode == "no_dates":
        header = [Paragraph("Project Schedule", th_left), Paragraph("Days", th_left),
                  Paragraph("Price", th_right)]
    elif mode == "duration_only":
        header = [Paragraph("Project Schedule", th_left), Paragraph("Days", th_right)]
    else:  # both — matches V9 desktop header label ("Project Schedule")
        header = [Paragraph("Project Schedule", th_left), Paragraph("Days", th_left),
                  Paragraph("Start", th_left), Paragraph("Finish", th_left),
                  Paragraph("Price", th_right)]
    all_table_data.append(header)

    # ---- summary row ----
    def _price_style(parent):
        return ParagraphStyle("p_sum", parent=parent, alignment=2)

    if mode == "price_only":
        total_price = sum(
            int(it.price or 0) for it in _walk_all(template_items)
            if it.enabled and not it.is_milestone and (it.price or 0) > 0
        )
        all_table_data.append([
            Paragraph("<b>TOTAL</b>", table_bold_white_style),
            Paragraph(f"${total_price:,}", _price_style(table_bold_white_style)),
        ])
    else:
        total_price = sum(int(it.price or 0) for it in template_items
                          if it.enabled and it.indent_level == 0)
        valid = [d for it in template_items if it.enabled
                 for d in (_parse(it.start_date), _parse(it.end_date)) if d]
        earliest = min(valid).strftime("%m/%d/%y") if valid else ""
        latest = max(valid).strftime("%m/%d/%y") if valid else ""
        total_dur = business_days_inclusive(min(valid), max(valid), disabled) if valid else 0
        if mode == "dates_only":
            all_table_data.append([
                Paragraph("<b>TOTAL</b>", table_bold_white_style),
                Paragraph(f"{total_dur}", table_bold_white_style),
                Paragraph(earliest, table_bold_white_style),
                Paragraph(latest, table_bold_white_style),
            ])
        elif mode == "no_dates":
            all_table_data.append([
                Paragraph("<b>TOTAL</b>", table_bold_white_style),
                Paragraph(f"{total_dur}", table_bold_white_style),
                Paragraph(f"${total_price:,}", _price_style(table_bold_white_style)),
            ])
        elif mode == "duration_only":
            all_table_data.append([
                Paragraph("<b>TOTAL</b>", table_bold_white_style),
                Paragraph(f"{total_dur}", _price_style(table_bold_white_style)),
            ])
        else:  # both — matches V9 desktop (literal "TOTAL" grand-total row)
            all_table_data.append([
                Paragraph("<b>TOTAL</b>", table_bold_white_style),
                Paragraph(f"{total_dur}", table_bold_white_style),
                Paragraph(earliest, table_bold_white_style),
                Paragraph(latest, table_bold_white_style),
                Paragraph(f"${total_price:,}", _price_style(table_bold_white_style)),
            ])

    # ---- recursive rows ----
    def build(items, in_pi=False):
        for item in items:
            if not item.enabled:
                continue
            if item.is_milestone and item.indent_level == 0:
                in_pi = (item.name or "").strip().lower() == "project initiation"
            is_main = item.is_milestone and item.indent_level == 0

            if mode == "price_only":
                if item.is_milestone or (item.price or 0) <= 0:
                    if item.children:
                        build(item.children, in_pi)
                    continue
            elif milestones_only and not item.is_milestone:
                if item.children:
                    build(item.children, in_pi)
                continue

            current = (table_bold_white_style if is_main
                       else table_bold_style if item.is_milestone else table_text_style)
            price_style = ParagraphStyle("p_row", parent=current, alignment=2)
            indent = "&nbsp;" * 4 * int(item.indent_level or 0)
            if item.is_milestone:
                name_text, name_style = f"<b>{indent}{item.name}</b>", current
            elif mode == "price_only":
                name_text, name_style = f"{item.name}", current
            else:
                name_text, name_style = f"{indent}{item.name}", current
            name_para = Paragraph(name_text, name_style)

            dur_disp = "" if item.price_only else f"{_display_duration(item, project_util)}"
            if item.price_only and not in_pi:
                start_disp = end_disp = ""
            else:
                start_disp, end_disp = item.start_date, item.end_date
            if not item.show_start_date:
                start_disp = ""
            if not item.show_end_date:
                end_disp = ""
            price_disp = (f"${int(item.price):,}" if (item.price or 0) > 0
                          else ("$0" if item.is_milestone else ""))

            if mode == "price_only":
                row = [name_para, Paragraph(f"${int(item.price or 0):,}", price_style)]
            elif mode == "dates_only":
                row = [name_para, Paragraph(dur_disp, current),
                       Paragraph(start_disp, current), Paragraph(end_disp, current)]
            elif mode == "no_dates":
                row = [name_para, Paragraph(dur_disp, current), Paragraph(price_disp, price_style)]
            elif mode == "duration_only":
                row = [name_para, Paragraph(dur_disp, ParagraphStyle("d_r", parent=current, alignment=2))]
            else:
                row = [name_para, Paragraph(dur_disp, current),
                       Paragraph(start_disp, current), Paragraph(end_disp, current),
                       Paragraph(price_disp, price_style)]
            all_table_data.append(row)

            if item.children:
                build(item.children, in_pi)

    build(template_items)
    return all_table_data


# ---------------------------------------------------------------------------
# Table styling (V9 _style_table) — header/summary fills + milestone row colors
# ---------------------------------------------------------------------------
def _style_table(full_table, style_settings, template_items, mode, milestones_only):
    cmds = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, 0), style_settings["header_padding"]),
        ("BOTTOMPADDING", (0, 0), (-1, 0), style_settings["header_padding"]),
        ("TOPPADDING", (0, 1), (-1, -1), style_settings["row_padding"]),
        ("BOTTOMPADDING", (0, 1), (-1, -1), style_settings["row_padding"]),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#991f2b")),
        ("LINEBELOW", (0, 0), (-1, 0), 0.5, colors.black),
        ("BACKGROUND", (0, 1), (-1, 1), colors.black),
        ("LINEBELOW", (0, 1), (-1, 1), 0.5, colors.black),
        ("BOX", (0, 0), (-1, -1), 1, colors.black),
        ("LEFTPADDING", (0, 0), (0, -1), 4),
        ("RIGHTPADDING", (-1, 0), (-1, -1), 4),
        ("LINEBELOW", (0, "splitlast"), (-1, "splitlast"), 0.75, colors.black),
    ]
    price_only = mode == "price_only"
    if price_only:
        cmds.append(("ROWBACKGROUNDS", (0, 2), (-1, -1),
                     [colors.white, colors.HexColor("#d9d9d9")]))

    def style_ms(items, idx):
        for item in items:
            if not item.enabled:
                continue
            if price_only:
                if item.is_milestone or (item.price or 0) <= 0:
                    if item.children:
                        idx = style_ms(item.children, idx)
                    continue
                idx += 1
                if item.children:
                    idx = style_ms(item.children, idx)
                continue
            if milestones_only and not item.is_milestone:
                if item.children:
                    idx = style_ms(item.children, idx)
                continue
            if item.is_milestone:
                bg = (colors.HexColor("#991f2b") if item.indent_level == 0
                      else colors.HexColor("#D3D3D3"))
                cmds.append(("BACKGROUND", (0, idx), (-1, idx), bg))
            idx += 1
            if item.children:
                idx = style_ms(item.children, idx)
        return idx

    style_ms(template_items, 2)
    full_table.setStyle(TableStyle(cmds))
    return full_table


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _walk_all(items):
    for it in items:
        yield it
        if it.children:
            yield from _walk_all(it.children)


def _parse(s: str):
    if not s:
        return None
    for fmt in ("%m/%d/%y", "%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(str(s).strip(), fmt)
        except ValueError:
            continue
    return None


# ---------------------------------------------------------------------------
# Public renderer
# ---------------------------------------------------------------------------
def render_schedule_table_bytes(
    template_items,
    info: ProjectInfo,
    *,
    disabled_holidays: Optional[frozenset] = None,
    mode: str = "both",
    milestones_only: bool = False,
    project_utilization: float = 100.0,
) -> bytes:
    """Render the page-1 schedule table to PDF bytes in the requested mode."""
    mode = (mode or "both").strip().lower()
    if mode not in VALID_MODES:
        mode = "both"

    buf = BytesIO()
    doc = BaseDocTemplate(buf, topMargin=0.5 * inch, bottomMargin=0.4 * inch,
                          leftMargin=0.3 * inch, rightMargin=0.3 * inch)
    doc.addPageTemplates([PageTemplate(
        id="PortraitPage",
        frames=[Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="f")],
        pagesize=letter,
    )])

    style_settings = _setup_reportlab_styles(mode)
    styles = style_settings["styles"]
    elements = [_create_pdf_header(style_settings, info), Spacer(1, 0.2 * inch)]

    table_data = _create_table_data(styles, template_items, info, mode,
                                    milestones_only, disabled_holidays, project_utilization)
    full_table = Table(table_data, colWidths=style_settings["col_widths"], repeatRows=1)
    full_table = _style_table(full_table, style_settings, template_items, mode, milestones_only)
    elements.append(full_table)

    doc.build(elements)
    return buf.getvalue()
