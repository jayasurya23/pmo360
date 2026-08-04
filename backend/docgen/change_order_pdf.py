"""Castillo-branded Change Order deliverable — the final approved client document.

Reproduces the Castillo "Change Order - Summary of Services" template (the Word
output template Gary uses). The deliverable is four pages:

  1. cover      — "PROPOSAL / PROFESSIONAL ENGINEERING SERVICES" brand cover
  2. data       — the generated "CHANGE ORDER - SUMMARY OF SERVICES" page
  3. services   — "SERVICES OFFERED" brand page
  4. back        — Castillo "C" back cover + "PREPARED BY" contact block

Only page 2 is generated from the ChangeOrder; the cover / services / back pages
are the static Castillo brand pages (assets/co_template/, extracted verbatim from
the source template) and are merged around the generated page with pikepdf. If
those assets are missing the builder degrades gracefully to the data page alone.

The data page header carries Date / Version / Location / Client / State / Size MW;
the body is a "Change Order Details" table (line details + cost) with a red
"Total Proposal" bar, a two-party signature block, and a footer with the standard
terms + hourly billing rates. The app-only "Internal Notes" never render here.
Neither do the internal PMO/admin cost adders: they are marked into the printed
line amounts via co_pricing.distribute_markup, so the lines still add up to the
"Total Proposal" on their own and nothing on the page hints the markup exists.
Jost font + brand red are reused from docgen.pdf_builder for consistency.
"""
from io import BytesIO
from pathlib import Path

import pikepdf
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor, white
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_RIGHT, TA_CENTER, TA_LEFT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image, HRFlowable,
    KeepTogether,
)

from co_pricing import distribute_markup
from config import BrandColors
from docgen.pdf_builder import PRIMARY_FONT, PRIMARY_BOLD, _LOGO_PATHS


RED = HexColor(BrandColors.RED)         # #ad1f2b — bars + title
DARK_RED = HexColor(BrandColors.DARK_RED)
DARK = HexColor("#1a1a1a")
GRAY = HexColor("#4d4d4f")
LINE = HexColor("#d8d2cc")

_ASSET_DIR = Path(__file__).resolve().parent.parent / "assets" / "co_template"
_COVER = _ASSET_DIR / "co_cover.pdf"
_SERVICES = _ASSET_DIR / "co_services.pdf"
_BACK = _ASSET_DIR / "co_back.pdf"

PAGE_W, PAGE_H = letter
_MARGIN = 0.6 * inch
_USABLE = PAGE_W - 2 * _MARGIN   # 7.3in content width

# Standard Castillo hourly billing rates printed in the footer (matches the
# template's HOURLY BILLING RATES block).
_FOOTER_RATES_L = [("Project Engineer", "$250"), ("Project Manager", "$300")]
_FOOTER_RATES_R = [("Senior Engineer", "$350"), ("Administrative Tasks", "$150")]
_FOOTER_TERMS = [
    "Proposal Valid for 30 days.",
    "30% Deposit. Remaining deliverables invoiced upon their respective milestones.",
    "All documents delivered in PDF format. Hard copies - $0.50 per sq. ft.",
]


def _num(v) -> float:
    """Coerce any value to float, never raising (bad data degrades to 0)."""
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _money(v) -> str:
    """Whole-dollar when round (matches the template's "$10,000"), else 2dp."""
    v = _num(v)
    return f"${int(round(v)):,}" if abs(v - round(v)) < 0.005 else f"${v:,.2f}"


def _amt(v) -> str:
    """Amount without the leading $ (the $ lives in its own table column)."""
    return _money(v)[1:]


def _fmt_long_date(d) -> str:
    try:
        return f"{d.strftime('%B')} {d.day}, {d.year}" if d else ""
    except Exception:
        return ""


def _fmt_short_date(d) -> str:
    try:
        return d.strftime("%m/%d/%Y") if d else ""
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Page furniture drawn on every data page: top red band + footer block
# ---------------------------------------------------------------------------
def _draw_furniture(canvas, doc):
    canvas.saveState()
    # top full-bleed red band
    canvas.setFillColor(DARK_RED)
    canvas.rect(0, PAGE_H - 10, PAGE_W, 10, fill=1, stroke=0)

    # ---- footer: terms (left) + hourly billing rates (right) ----
    top = 0.82 * inch
    canvas.setFillColor(DARK)
    canvas.setFont(PRIMARY_BOLD, 6.5)
    ty = top
    for line in _FOOTER_TERMS:
        canvas.drawString(_MARGIN, ty, line)
        ty -= 9.5

    rx = _MARGIN + 3.45 * inch
    canvas.setFont(PRIMARY_BOLD, 6.5)
    canvas.drawString(rx, top, "HOURLY BILLING RATES")
    canvas.setFont(PRIMARY_FONT, 6.5)
    c1, c2 = rx, rx + 1.85 * inch
    yy = top - 12
    for (l_lbl, l_amt), (r_lbl, r_amt) in zip(_FOOTER_RATES_L, _FOOTER_RATES_R):
        canvas.drawString(c1, yy, f"• {l_lbl}")
        canvas.drawRightString(c1 + 1.6 * inch, yy, l_amt)
        canvas.drawString(c2, yy, f"• {r_lbl}")
        canvas.drawRightString(c2 + 1.6 * inch, yy, r_amt)
        yy -= 10
    canvas.restoreState()


# ---------------------------------------------------------------------------
# The generated "CHANGE ORDER - SUMMARY OF SERVICES" data page
# ---------------------------------------------------------------------------
def _build_data_page(co) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=letter,
        topMargin=0.45 * inch, bottomMargin=1.15 * inch,
        leftMargin=_MARGIN, rightMargin=_MARGIN,
    )

    S = {
        "title": ParagraphStyle("title", fontName=PRIMARY_BOLD, fontSize=17,
                                textColor=RED, alignment=TA_LEFT, leading=21),
        "mk": ParagraphStyle("mk", fontName=PRIMARY_BOLD, fontSize=9,
                             textColor=DARK, alignment=TA_RIGHT, leading=13),
        "mv": ParagraphStyle("mv", fontName=PRIMARY_FONT, fontSize=9,
                             textColor=DARK, leading=13),
        "ver": ParagraphStyle("ver", fontName=PRIMARY_BOLD, fontSize=9,
                              textColor=DARK, alignment=TA_CENTER, leading=13),
        "bar": ParagraphStyle("bar", fontName=PRIMARY_BOLD, fontSize=10,
                             textColor=white, leading=13),
        "td": ParagraphStyle("td", fontName=PRIMARY_FONT, fontSize=9.5,
                             textColor=DARK, leading=13),
        "tdr": ParagraphStyle("tdr", fontName=PRIMARY_FONT, fontSize=9.5,
                              textColor=DARK, alignment=TA_RIGHT, leading=13),
        "totk": ParagraphStyle("totk", fontName=PRIMARY_BOLD, fontSize=11,
                              textColor=white, leading=14),
        "totv": ParagraphStyle("totv", fontName=PRIMARY_BOLD, fontSize=11,
                              textColor=white, alignment=TA_RIGHT, leading=14),
        "sig_v": ParagraphStyle("sig_v", fontName=PRIMARY_FONT, fontSize=10,
                               textColor=DARK, leading=12),
        "sig_l": ParagraphStyle("sig_l", fontName=PRIMARY_FONT, fontSize=7.5,
                               textColor=GRAY, leading=9),
    }

    el = []

    # ---- header band: Castillo color logo (left) + meta grid (right) ----
    # Editable Project label snapshot wins; fall back to the portfolio name.
    proj_name = (
        getattr(co, "project_name", None)
        or (co.project.name if getattr(co, "project", None) else None)
        or (co.client_name or "")
    )
    logo_cell = ""
    logo_path = _LOGO_PATHS.get("castillo_color")
    if logo_path and logo_path.exists():
        try:
            img = Image(str(logo_path))
            img._restrictSize(2.1 * inch, 0.72 * inch)
            img.hAlign = "LEFT"
            logo_cell = img
        except Exception:
            logo_cell = ""

    def mk(s):
        return Paragraph(f"{s}:", S["mk"])

    def mv(s):
        return Paragraph(s or "", S["mv"])

    meta = Table(
        [
            [mk("Date"), mv(_fmt_long_date(co.request_date)),
             Paragraph(co.co_version or "V1", S["ver"]),
             mk("Location"), mv(co.location)],
            [mk("Client"), mv(co.client_name), "",
             mk("State"), mv(co.state)],
            [mk("Project"), mv(proj_name), "",
             mk("Size MW"), mv(co.size_mw)],
        ],
        colWidths=[0.62 * inch, 1.55 * inch, 0.55 * inch, 0.78 * inch, 1.2 * inch],
    )
    meta.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 1.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
    ]))

    head = Table([[logo_cell, meta]], colWidths=[2.3 * inch, _USABLE - 2.3 * inch])
    head.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    el += [head, Spacer(1, 0.06 * inch),
           HRFlowable(width="100%", thickness=1.1, color=RED,
                      spaceBefore=0, spaceAfter=0)]

    # ---- title ----
    el += [Spacer(1, 0.16 * inch),
           Paragraph("CHANGE ORDER - SUMMARY OF SERVICES", S["title"]),
           Spacer(1, 0.1 * inch)]

    # ---- Change Order Details table (details | $ | amount) ----
    col_d, col_s, col_a = 5.2 * inch, 0.4 * inch, _USABLE - 5.6 * inch
    items = sorted(co.line_items, key=lambda li: (li.order_index or 0))
    hourly = (co.rate_type or "fixed") == "hourly"
    rendered = []   # (details html, base amount) per line, before any markup
    for li in items:
        details = (li.details or "").strip().replace("\n", "<br/>")
        allocs = (li.allocations or []) if hourly else []
        if hourly and allocs:
            # one task, several people at different rates: sum the line, and
            # list the per-role hour breakdown as sub-bullets (template style).
            line_total = sum(_num(a.get("rate")) * _num(a.get("hours")) for a in allocs)
            subs = []
            for a in allocs:
                hrs, role = _num(a.get("hours")), (a.get("role") or "").strip()
                if not hrs and not role:
                    continue
                label = (f"{hrs:g} hours" if hrs else "")
                if role:
                    label = f"{label} — {role}" if label else role
                subs.append(f"&#8594;&nbsp;{label}")
            if subs:
                bullets = "<br/>".join(f'<font color="#4d4d4f" size="8">{s}</font>'
                                       for s in subs)
                details = (details + "<br/>" if details else "") + bullets
        elif hourly:
            line_total = _num(li.hourly_rate) * _num(li.hours)
        else:
            line_total = _num(li.cost)
        rendered.append((details, line_total))

    # The internal PMO/admin adders are absorbed INTO the printed line amounts.
    # A separate markup row, or lines that fell a cent short of the total, would
    # both hand the client the very number this is meant to keep private — so the
    # apportionment lives in co_pricing (one implementation, largest-remainder)
    # and the bar below prints the sum of exactly these lines, which is also what
    # the API stores as total_amount.
    shown = distribute_markup([amt for _, amt in rendered],
                              _num(co.pmo_pct), _num(co.admin_pct))

    data = [[Paragraph("Change Order Details", S["bar"]), "", ""]]
    for (details, _), amount in zip(rendered, shown):
        data.append([
            Paragraph(details or "&nbsp;", S["td"]),
            Paragraph("$", S["td"]),
            Paragraph(_amt(amount), S["tdr"]),
        ])
    if not items:   # no lines -> keep a blank body row so the bars frame it
        data.append([Paragraph("&nbsp;", S["td"]), "", ""])
    # Print the sum of the rendered lines so the total always matches what's shown
    # (falls back to the stored total only when there are no lines).
    grand_total = sum(shown) if items else _num(co.total_amount)
    data.append([Paragraph("Total Proposal", S["totk"]),
                 Paragraph("$", S["totv"]),
                 Paragraph(_amt(grand_total), S["totv"])])

    n = len(data)
    tbl = Table(data, colWidths=[col_d, col_s, col_a])
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), RED),
        ("SPAN", (0, 0), (-1, 0)),
        ("BACKGROUND", (0, n - 1), (-1, n - 1), RED),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("ALIGN", (2, 0), (2, -1), "RIGHT"),
        ("ALIGN", (1, 1), (1, -1), "LEFT"),
    ]
    for r in range(1, n - 1):   # thin separators between body rows
        style.append(("LINEBELOW", (0, r), (-1, r), 0.4, LINE))
    tbl.setStyle(TableStyle(style))
    el += [tbl, Spacer(1, 0.5 * inch)]

    # ---- signature block (Castillo | client) ----
    gap = 0.5 * inch
    colw = (_USABLE - gap) / 2.0

    def sig_field(value):
        return [Paragraph(value or "&nbsp;", S["sig_v"])]

    sig_date = _fmt_short_date(co.request_date)   # prepopulated document date
    # `fields` is indexed by BOTH columns, so a row appended here appears on the
    # Castillo AND the client side — left_vals/right_vals would have to be
    # decoupled from it first. Deliberately left coupled: the client signatory's
    # email/phone are captured for addressing the CO, not for printing. Castillo's
    # own phone/email don't appear in this block either (they're on the back-cover
    # PREPARED BY), and each extra row costs ~46pt = two line items off a page
    # that only holds about ten.
    fields = ["Company Name", "Print Name", "Title", "Signature", "Date"]
    # Castillo dates the document on preparation; the client dates it when they
    # counter-sign, so leave the client Date line blank for wet-ink.
    left_vals = ["Castillo Engineering Services",
                 co.signatory_name or "", co.signatory_title or "", "", sig_date]
    right_vals = [co.client_name or "",
                  co.client_signatory_name or "", co.client_signatory_title or "",
                  "", ""]

    def sig_cell(value, label):
        t = Table([[Paragraph(value or "&nbsp;", S["sig_v"])],
                   [Paragraph(label, S["sig_l"])]], colWidths=[colw])
        t.setStyle(TableStyle([
            ("LINEBELOW", (0, 0), (0, 0), 0.8, DARK),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (0, 0), 14),
            ("BOTTOMPADDING", (0, 0), (0, 0), 2),
            ("TOPPADDING", (0, 1), (0, 1), 1),
            ("BOTTOMPADDING", (0, 1), (0, 1), 0),
        ]))
        return t

    sig_rows = [[sig_cell(left_vals[i], fields[i]), "", sig_cell(right_vals[i], fields[i])]
                for i in range(len(fields))]
    sig = Table(sig_rows, colWidths=[colw, gap, colw])
    sig.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    # The Table splits by row and the overflow is silent, so a long CO used to
    # orphan a couple of signature lines onto a page of their own wedged between
    # the data page and SERVICES OFFERED. Keep the block whole instead.
    el.append(KeepTogether(sig))

    doc.build(el, onFirstPage=_draw_furniture, onLaterPages=_draw_furniture)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Dynamic "PREPARED BY" block overlaid on the static back cover (page 4)
# ---------------------------------------------------------------------------
def _preparer_overlay(co):
    """A single-page overlay that draws the "PREPARED BY" preparer lines from the
    change order's Castillo signatory. The back cover's baked-in preparer lines
    were redacted out, so there is no hard-coded default — if no signatory is set
    the block stays blank under the static "PREPARED BY" header. Returns a
    pikepdf.Pdf."""
    name = (co.signatory_name or "").strip()
    lines = [s for s in (name, (co.signatory_title or "").strip(),
                         (co.signatory_phone or "").strip(),
                         (co.signatory_email or "").strip()) if s]

    buf = BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    # The static back cover has its preparer lines redacted out (clean red), so
    # we only need to draw the dynamic lines — no cover rectangle, no seam.
    cx = PAGE_W / 2.0
    c.setFillColor(white)
    c.setFont(PRIMARY_BOLD, 8.5)
    y = PAGE_H - 616.0   # first dynamic line baseline (just below PREPARED BY)
    for ln in lines:
        c.drawCentredString(cx, y, ln)
        y -= 14.4        # template line spacing
    c.showPage()
    c.save()
    buf.seek(0)
    return pikepdf.open(buf)


# ---------------------------------------------------------------------------
# Merge: cover + generated data page(s) + services + back
# ---------------------------------------------------------------------------
def build_change_order_pdf(co) -> bytes:
    """Render a ChangeOrder ORM object to the full branded 4-page PDF bytes."""
    data_bytes = _build_data_page(co)

    dst = pikepdf.Pdf.new()
    srcs = []
    try:
        def add_path(p: Path):
            if p.exists():
                s = pikepdf.open(str(p))
                srcs.append(s)
                dst.pages.extend(s.pages)

        add_path(_COVER)
        ds = pikepdf.open(BytesIO(data_bytes))
        srcs.append(ds)
        dst.pages.extend(ds.pages)
        add_path(_SERVICES)
        # back cover with a dynamic PREPARED BY block stamped over the static one
        if _BACK.exists():
            back = pikepdf.open(str(_BACK))
            srcs.append(back)
            try:
                ov = _preparer_overlay(co)
                srcs.append(ov)
                back.pages[0].add_overlay(ov.pages[0])
            except Exception:
                pass   # fall back to the untouched static back cover
            dst.pages.extend(back.pages)

        if len(dst.pages) == 0:   # paranoia: nothing assembled
            return data_bytes
        out = BytesIO()
        dst.save(out)
        return out.getvalue()
    except Exception:
        # Any merge failure -> still hand back the data page so the download works.
        return data_bytes
    finally:
        for s in srcs:
            try:
                s.close()
            except Exception:
                pass
