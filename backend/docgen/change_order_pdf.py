"""Castillo-branded Change Order Request PDF — the final approved deliverable.

Mirrors the Excel "Change Order Request Form": a client/project header band, the
CO meta (number, version, dates, requested/approved by), and a line-item table
that switches on rate type (fixed: Details/Cost; hourly: Details/Rate/Hours/Total)
plus a Total row. The app-only "Internal Notes" column is intentionally omitted
from this client-facing document. Reuses the Jost font + logo helpers from
docgen.pdf_builder so branding stays consistent with the other deliverables.
"""
from io import BytesIO

from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor, white
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_RIGHT, TA_CENTER
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image,
)

from config import BrandColors
from docgen.pdf_builder import PRIMARY_FONT, PRIMARY_BOLD, _LOGO_PATHS


RED = HexColor(BrandColors.RED)
DARK_RED = HexColor(BrandColors.DARK_RED)
DARK = HexColor("#1a1a1a")
GRAY = HexColor("#4d4d4f")
BAND = HexColor("#f3f0ec")


def _money(v) -> str:
    try:
        return f"${float(v or 0):,.2f}"
    except (TypeError, ValueError):
        return "$0.00"


def _fmt_date(d) -> str:
    try:
        return d.strftime("%m/%d/%Y") if d else ""
    except Exception:
        return ""


def build_change_order_pdf(co) -> bytes:
    """Render a ChangeOrder ORM object to branded PDF bytes."""
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=letter,
        topMargin=0.55 * inch, bottomMargin=0.55 * inch,
        leftMargin=0.6 * inch, rightMargin=0.6 * inch,
    )
    usable = doc.width  # 7.3in
    hourly = (co.rate_type or "fixed") == "hourly"

    S = {
        "hleft": ParagraphStyle("hleft", fontName=PRIMARY_BOLD, fontSize=14,
                                textColor=RED, leading=18),
        "title": ParagraphStyle("title", fontName=PRIMARY_BOLD, fontSize=16,
                                textColor=DARK_RED, alignment=TA_CENTER, leading=20),
        "mk": ParagraphStyle("mk", fontName=PRIMARY_BOLD, fontSize=9, textColor=GRAY),
        "mv": ParagraphStyle("mv", fontName=PRIMARY_FONT, fontSize=9, textColor=DARK),
        "th": ParagraphStyle("th", fontName=PRIMARY_BOLD, fontSize=9, textColor=white),
        "thr": ParagraphStyle("thr", fontName=PRIMARY_BOLD, fontSize=9,
                              textColor=white, alignment=TA_RIGHT),
        "td": ParagraphStyle("td", fontName=PRIMARY_FONT, fontSize=9,
                             textColor=DARK, leading=12),
        "tdr": ParagraphStyle("tdr", fontName=PRIMARY_FONT, fontSize=9,
                              textColor=DARK, alignment=TA_RIGHT, leading=12),
        "tk": ParagraphStyle("tk", fontName=PRIMARY_BOLD, fontSize=10, textColor=DARK),
        "tv": ParagraphStyle("tv", fontName=PRIMARY_BOLD, fontSize=10,
                             textColor=DARK_RED, alignment=TA_RIGHT),
    }

    el = []

    # ---- header band: client/project (left) + Castillo logo (right) ----
    proj_name = co.project.name if getattr(co, "project", None) else ""
    left = Paragraph(f"{co.client_name or ''}<br/>{proj_name or ''}", S["hleft"])
    logo_cell = ""
    logo_path = _LOGO_PATHS.get("castillo_color")
    if logo_path and logo_path.exists():
        try:
            img = Image(str(logo_path))
            img._restrictSize(2.4 * inch, 0.7 * inch)
            img.hAlign = "RIGHT"
            logo_cell = img
        except Exception:
            logo_cell = ""
    head = Table([[left, logo_cell]], colWidths=[usable * 0.6, usable * 0.4])
    head.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (1, 0), (1, 0), "RIGHT"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ]))
    el += [head, Spacer(1, 0.18 * inch)]

    # ---- title ----
    el += [Paragraph("Change Order Request", S["title"]), Spacer(1, 0.14 * inch)]

    # ---- meta grid (2 key/value pairs per row) ----
    def kv(k, v):
        return [Paragraph(k, S["mk"]), Paragraph(v or "—", S["mv"])]

    meta_rows = [
        kv("Change Order", f"CO-{co.co_number}") + kv("Version", co.co_version or "V1"),
        kv("Request Date", _fmt_date(co.request_date)) + kv("Requested by", co.requested_by or ""),
    ]
    if co.status == "approved":
        meta_rows.append(
            kv("Approved by", co.approved_by or "") + kv("Approved", _fmt_date(co.approved_at))
        )
    meta = Table(meta_rows, colWidths=[usable * 0.14, usable * 0.36,
                                       usable * 0.14, usable * 0.36])
    meta.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ]))
    el += [meta, Spacer(1, 0.18 * inch)]

    # ---- line-item table ----
    if hourly:
        header = [Paragraph("#", S["th"]), Paragraph("Change Order Details", S["th"]),
                  Paragraph("Hourly Rate", S["thr"]), Paragraph("Hours", S["thr"]),
                  Paragraph("Total", S["thr"])]
        widths = [usable * 0.06, usable * 0.50, usable * 0.16, usable * 0.10, usable * 0.18]
    else:
        header = [Paragraph("#", S["th"]), Paragraph("Change Order Details", S["th"]),
                  Paragraph("Cost", S["thr"])]
        widths = [usable * 0.06, usable * 0.74, usable * 0.20]

    data = [header]
    items = sorted(co.line_items, key=lambda li: (li.order_index or 0))
    for i, li in enumerate(items, start=1):
        if hourly:
            line_total = float(li.hourly_rate or 0) * float(li.hours or 0)
            data.append([
                Paragraph(str(i), S["td"]),
                Paragraph((li.details or "").replace("\n", "<br/>"), S["td"]),
                Paragraph(_money(li.hourly_rate), S["tdr"]),
                Paragraph(f"{(li.hours or 0):g}" if li.hours else "", S["tdr"]),
                Paragraph(_money(line_total), S["tdr"]),
            ])
        else:
            data.append([
                Paragraph(str(i), S["td"]),
                Paragraph((li.details or "").replace("\n", "<br/>"), S["td"]),
                Paragraph(_money(li.cost), S["tdr"]),
            ])

    # total row spans the leading columns, value in the last column
    span_cols = len(header) - 1
    total_row = [Paragraph("Total Proposal", S["tk"])] + [""] * (span_cols - 1) + [
        Paragraph(_money(co.total_amount), S["tv"])]
    data.append(total_row)

    tbl = Table(data, colWidths=widths, repeatRows=1)
    n = len(data)
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), RED),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("LINEBELOW", (0, 0), (-1, -2), 0.25, HexColor("#d8d2cc")),
        # total row
        ("SPAN", (0, n - 1), (span_cols - 1, n - 1)),
        ("LINEABOVE", (0, n - 1), (-1, n - 1), 1, DARK_RED),
        ("TOPPADDING", (0, n - 1), (-1, n - 1), 6),
    ]
    # banded body rows (between header and total)
    for r in range(1, n - 1):
        if r % 2 == 0:
            style.append(("BACKGROUND", (0, r), (-1, r), BAND))
    tbl.setStyle(TableStyle(style))
    el.append(tbl)

    doc.build(el)
    return buf.getvalue()
