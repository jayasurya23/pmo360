"""Editable Word draft of the Change Order — the .docx twin of change_order_pdf.

Built on the real Castillo Word template (assets/co_template/co_template.docx):
the cover, services and back pages are the template's own full-page images and
text boxes, and page 2 — the template's blank body page, with its red top band
and its terms / hourly-rates footer already anchored to it — is filled with the
same "CHANGE ORDER - SUMMARY OF SERVICES" content the PDF prints. Everything the
client would see is editable; the three brand pages are pictures, as they are in
Castillo's own template.

What it shares with the PDF, deliberately: ``change_order_pdf.line_model`` — the
one place that turns line items into printed lines and folds the internal
PMO/admin adders into them. A Word draft that priced lines differently from the
PDF, or let the markup show, would be worse than none. The app-only "Internal
Notes" never render here either.

A draft is not the issued document. It carries a notice at the top — red and
loud while the CO is not approved, a quiet reminder once it is — and the route
names the file ``-DRAFT``. Nothing edited in Word comes back into PMO 360; the
approved PDF stays the only record of what the client was sent.

The template asset was prepared once from "Castillo Proposal - Company -
Project - V1.docx": cover banner repainted to "CHANGE ORDER" (it is pixels, not
text, in the source), footer reworded, the three page images recompressed to
JPEG, the preparer's name/title/phone/email replaced with {{PREPARER_*}} tokens
(and their mailto: hyperlinks removed), and the template author's name dropped
from the file properties. ``_prepare_page_two`` fails loudly if the template
stops having the shape this module relies on, rather than producing a wrong file.
"""
from __future__ import annotations

import copy
import functools
import io
from datetime import datetime
from pathlib import Path

from docx import Document
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

from config import BrandColors
from docgen.change_order_pdf import (
    _amt, _fmt_long_date, _fmt_short_date, _num, line_model,
)
from docgen.pdf_builder import _LOGO_PATHS

DOCX_MEDIA_TYPE = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)

_TEMPLATE = (
    Path(__file__).resolve().parent.parent / "assets" / "co_template" / "co_template.docx"
)

_FONT = "Jost"
_RED = BrandColors.RED.lstrip("#")           # bars + title
_DARK = "1A1A1A"
_GRAY = "4D4D4F"
_LINE = "D8D2CC"
_WHITE = "FFFFFF"

# Geometry, in inches. The template's section has 0.44in / 0.56in side margins and
# the footer text box is positioned relative to the LEFT margin, so the margins are
# left alone and the content is inset instead: the PDF's 0.6in margin is 0.16in in.
_INDENT = 0.16
_USABLE = 7.3                                # content width, matches the PDF
_DATA_TOP_MARGIN = 0.6                       # clears the template's 0.43in red band
_DATA_BOTTOM_MARGIN = 0.85                   # footer boxes start 10.38in down the page

# Where the cover's "PREPARED BY" block takes its lines, in order. Blank fields are
# squeezed out so the lines that exist sit together, as they do on the PDF.
_PREPARER_TOKENS = (
    "{{PREPARER_NAME}}", "{{PREPARER_TITLE}}",
    "{{PREPARER_PHONE}}", "{{PREPARER_EMAIL}}",
)

# Child order the schema requires, for the property blocks we hand-edit. Word is
# strict about this in places python-docx's own setters would have respected.
_TCPR = ("tcW", "gridSpan", "vMerge", "tcBorders", "shd", "noWrap", "tcMar",
         "textDirection", "tcFitText", "vAlign", "hideMark")
_TBLPR = ("tblStyle", "tblpPr", "tblOverlap", "bidiVisual", "tblStyleRowBandSize",
          "tblStyleColBandSize", "tblW", "jc", "tblCellSpacing", "tblInd",
          "tblBorders", "shd", "tblLayout", "tblCellMar", "tblLook")
_PPR = ("pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr",
        "widowControl", "numPr", "suppressLineNumbers", "pBdr", "shd", "tabs",
        "suppressAutoHyphens", "kinsoku", "wordWrap", "overflowPunct",
        "topLinePunct", "autoSpaceDE", "autoSpaceDN", "bidi", "adjustRightInd",
        "snapToGrid", "spacing", "ind", "contextualSpacing", "mirrorIndents",
        "suppressOverlap", "jc", "textDirection", "textAlignment",
        "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr", "sectPr",
        "pPrChange")
_TRPR = ("cnfStyle", "divId", "gridBefore", "gridAfter", "wBefore", "wAfter",
         "cantSplit", "trHeight", "tblHeader", "tblCellSpacing", "jc", "hidden")


@functools.lru_cache(maxsize=1)
def _template_bytes() -> bytes:
    return _TEMPLATE.read_bytes()


# ---------------------------------------------------------------------------
# Small OOXML helpers
# ---------------------------------------------------------------------------
def _put(parent, child, order):
    """Insert ``child`` into ``parent`` at its schema position, replacing any
    existing element of the same tag."""
    local = child.tag.split("}")[1]
    for existing in parent.findall(child.tag):
        parent.remove(existing)
    rank = order.index(local)
    for i, sibling in enumerate(parent):
        name = sibling.tag.split("}")[1]
        if name in order and order.index(name) > rank:
            parent.insert(i, child)
            return child
    parent.append(child)
    return child


def _el(tag, **attrs):
    e = OxmlElement(tag)
    for k, v in attrs.items():
        e.set(qn(k.replace("_", ":", 1)), str(v))
    return e


def _shade(cell, hex_fill):
    _put(cell._tc.get_or_add_tcPr(), _el("w:shd", w_val="clear", w_color="auto",
                                         w_fill=hex_fill), _TCPR)


def _borders(cell, **sides):
    """``bottom=(eighths_of_a_point, hex)`` etc."""
    b = OxmlElement("w:tcBorders")
    for side in ("top", "left", "bottom", "right"):
        if side in sides:
            size, color = sides[side]
            b.append(_el(f"w:{side}", w_val="single", w_sz=size, w_space=0, w_color=color))
    _put(cell._tc.get_or_add_tcPr(), b, _TCPR)


def _margins(cell, top=0, bottom=0, left=0, right=0):
    """Cell padding in points."""
    m = OxmlElement("w:tcMar")
    for side, val in (("top", top), ("left", left), ("bottom", bottom), ("right", right)):
        m.append(_el(f"w:{side}", w_w=int(round(val * 20)), w_type="dxa"))
    _put(cell._tc.get_or_add_tcPr(), m, _TCPR)


def _row_keep(row):
    _put(row._tr.get_or_add_trPr(), _el("w:cantSplit"), _TRPR)


def _table_layout(table, widths_in, indent_in=_INDENT):
    """Fixed column widths + a left inset, so Word cannot re-flow the grid."""
    tblPr = table._tbl.tblPr
    total = sum(widths_in)
    _put(tblPr, _el("w:tblW", w_w=int(round(total * 1440)), w_type="dxa"), _TBLPR)
    _put(tblPr, _el("w:tblInd", w_w=int(round(indent_in * 1440)), w_type="dxa"), _TBLPR)
    _put(tblPr, _el("w:tblLayout", w_type="fixed"), _TBLPR)
    _put(tblPr, _el("w:tblCellMar"), _TBLPR)           # zero default padding
    cm = tblPr.find(qn("w:tblCellMar"))
    for side in ("top", "left", "bottom", "right"):
        cm.append(_el(f"w:{side}", w_w=0, w_type="dxa"))
    table.autofit = False
    for col, w in zip(table.columns, widths_in):
        col.width = Inches(w)
    for row in table.rows:
        for cell, w in zip(row.cells, widths_in):
            cell.width = Inches(w)


def _para_fmt(p, *, before=0, after=0, line=None, align=None, left=0.0, right=0.0, keep_next=False):
    pf = p.paragraph_format
    pf.space_before, pf.space_after = Pt(before), Pt(after)
    if line is not None:
        pf.line_spacing = Pt(line)               # exact
    else:
        pf.line_spacing = 1.0
    if align is not None:
        p.alignment = align
    pf.left_indent, pf.right_indent = Inches(left), Inches(right)
    pf.keep_with_next = keep_next or None


def _run(p, text, *, size, bold=False, color=_DARK):
    r = p.add_run(text)
    r.font.name = _FONT
    r._r.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), _FONT)
    r.font.size = Pt(size)
    r.font.bold = bold
    r.font.color.rgb = RGBColor.from_string(color)
    return r


def _text_lines(p, text, **fmt):
    """Text with embedded newlines as soft line breaks (the PDF's <br/>)."""
    parts = (text or "").split("\n")
    for i, part in enumerate(parts):
        r = _run(p, part, **fmt)
        if i < len(parts) - 1:
            r.add_break(WD_BREAK.LINE)


def _cell_para(cell, **fmt):
    """The cell's first (existing) paragraph, formatted."""
    p = cell.paragraphs[0]
    _para_fmt(p, **fmt)
    return p


def _hr_below(p, color=_RED, eighths=9):
    pPr = p._p.get_or_add_pPr()
    bdr = OxmlElement("w:pBdr")
    bdr.append(_el("w:bottom", w_val="single", w_sz=eighths, w_space=1, w_color=color))
    _put(pPr, bdr, _PPR)


def _spacer(doc, height_pt):
    p = doc.add_paragraph()
    _para_fmt(p, line=height_pt)
    return p


# ---------------------------------------------------------------------------
# Template: page two, the preparer block, document properties
# ---------------------------------------------------------------------------
_MC_ALT = "{http://schemas.openxmlformats.org/markup-compatibility/2006}AlternateContent"


def _has(el, tag):
    """Does ``el`` contain ``tag`` anywhere below it? Accepts a prefixed name or a
    Clark-notation one (python-docx's qn() does not know the mc: prefix)."""
    return next(el.iter(qn(tag) if not tag.startswith("{") else tag), None) is not None


def _prepare_page_two(doc):
    """Clear page two and return the paragraph that carries its band + footer.

    The template's body page is eighteen empty paragraphs followed by one that
    holds the red top band and the footer text boxes (and the page break that
    ends the page). Content goes after that paragraph, so the page break comes out
    — the section break written at the end of the content ends the page instead.
    """
    body = doc.element.body
    kids = list(body)
    if len(kids) < 4 or not _has(kids[0], "wp:anchor"):
        raise RuntimeError("co_template.docx no longer starts with the cover page")
    anchored = next((k for k in kids[1:] if _has(k, "wp:anchor")), None)
    if anchored is None or not _has(anchored, "w:txbxContent"):
        raise RuntimeError("co_template.docx has no page-two footer paragraph")
    for k in kids[1:kids.index(anchored)]:
        if k.tag != qn("w:p") or _has(k, "w:t") or _has(k, "w:drawing") or _has(k, _MC_ALT):
            raise RuntimeError("co_template.docx page two has unexpected content")
        body.remove(k)
    for br in list(anchored.iter(qn("w:br"))):
        if br.get(qn("w:type")) == "page":
            run = br.getparent()
            run.getparent().remove(run) if len(run) == 1 else run.remove(br)
    # the band/footer paragraph only anchors things: make it one point tall
    _put(anchored.get_or_add_pPr(),
         _el("w:spacing", w_before=0, w_after=0, w_line=20, w_lineRule="exact"), _PPR)
    return anchored


def _fill_preparer(doc, co):
    """Replace the {{PREPARER_*}} tokens in the back cover's text box.

    Walks every w:t, which reaches both the modern text box and its legacy
    fallback copy, so Word and older readers show the same lines.
    """
    values = [s for s in (
        (getattr(co, "signatory_name", None) or "").strip(),
        (getattr(co, "signatory_title", None) or "").strip(),
        (getattr(co, "signatory_phone", None) or "").strip(),
        (getattr(co, "signatory_email", None) or "").strip(),
    ) if s]
    values += [""] * (len(_PREPARER_TOKENS) - len(values))
    mapping = dict(zip(_PREPARER_TOKENS, values))
    found = set()
    for t in doc.element.body.iter(qn("w:t")):
        if t.text in mapping:
            found.add(t.text)
            t.text = mapping[t.text]
    if found != set(_PREPARER_TOKENS):
        raise RuntimeError(
            f"co_template.docx is missing preparer tokens: {sorted(set(_PREPARER_TOKENS) - found)}"
        )


def _set_properties(doc, co):
    cp = doc.core_properties
    client = (getattr(co, "client_name", None) or "").strip()
    title = (getattr(co, "title", None) or "").strip()
    cp.title = " — ".join(s for s in ("Change Order (draft)", client, title) if s)
    cp.author = cp.last_modified_by = "PMO 360"
    cp.subject = cp.keywords = cp.comments = ""
    cp.created = cp.modified = datetime.utcnow()
    cp.revision = 1


# ---------------------------------------------------------------------------
# The data page
# ---------------------------------------------------------------------------
def _notice(doc, co):
    """The line that stops a draft being mistaken for the issued document."""
    p = doc.add_paragraph()
    _para_fmt(p, after=4, left=_INDENT)
    if getattr(co, "status", None) == "approved":
        _run(p, "Editable Word copy of the approved change order — changes made here "
                "are not saved to PMO 360.", size=7.5, color=_GRAY)
    else:
        _run(p, "DRAFT — NOT APPROVED — DO NOT SEND TO CLIENT", size=8.5, bold=True, color=_RED)
    return p


def _header_table(doc, co):
    proj_name = (
        getattr(co, "project_name", None)
        or (co.project.name if getattr(co, "project", None) else None)
        or (co.client_name or "")
    )
    rows = [
        ("Date:", _fmt_long_date(co.request_date), co.co_version or "V1", "Location:", co.location),
        ("Client:", co.client_name, "", "State:", co.state),
        ("Project:", proj_name, "", "Size MW:", co.size_mw),
    ]
    # Job number reads the CO's OWN snapshot, and the row is left out when there is
    # none — see the PDF's note on why a bare label on a signed document reads as a
    # mistake.
    if getattr(co, "project_number", None):
        rows.append(("Job No.:", co.project_number, "", "", ""))

    widths = [2.3, 0.62, 1.55, 0.55, 0.78, 1.2]
    t = doc.add_table(rows=len(rows), cols=len(widths))
    _table_layout(t, widths)
    for r, (lbl, val, ver, lbl2, val2) in enumerate(rows):
        cells = t.rows[r].cells
        for c, (text, bold, align) in enumerate((
            (lbl, True, WD_ALIGN_PARAGRAPH.RIGHT), (val, False, WD_ALIGN_PARAGRAPH.LEFT),
            (ver, True, WD_ALIGN_PARAGRAPH.CENTER), (lbl2, True, WD_ALIGN_PARAGRAPH.RIGHT),
            (val2, False, WD_ALIGN_PARAGRAPH.LEFT),
        ), start=1):
            _margins(cells[c], top=1.5, bottom=1.5, left=3, right=3)
            p = _cell_para(cells[c], align=align)
            if text:
                _run(p, str(text), size=9, bold=bold)
    logo = t.cell(0, 0).merge(t.cell(len(rows) - 1, 0))
    _margins(logo)
    logo.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
    lp = _cell_para(logo)
    path = _LOGO_PATHS.get("castillo_color")
    if path and Path(path).exists():
        try:
            # fit inside 2.1in x 0.72in, keeping the aspect ratio
            pic = lp.add_run().add_picture(str(path), height=Inches(0.72))
            if pic.width > Inches(2.1):
                pic.height = int(pic.height * Inches(2.1) / pic.width)
                pic.width = Inches(2.1)
        except Exception:
            pass                                                  # no logo beats no draft
    return t


def _details_table(doc, co, lines, shown):
    widths = [5.2, 0.4, _USABLE - 5.6]
    n = len(lines) or 1
    t = doc.add_table(rows=n + 2, cols=3)
    _table_layout(t, widths)

    hdr = t.rows[0].cells[0].merge(t.rows[0].cells[2])
    _shade(hdr, _RED)
    _margins(hdr, top=6, bottom=6, left=7, right=7)
    _run(_cell_para(hdr), "Change Order Details", size=10, bold=True, color=_WHITE)
    _row_keep(t.rows[0])

    def body_row(row, details, subs, amount):
        _row_keep(row)
        for c, cell in enumerate(row.cells):
            _margins(cell, top=6, bottom=6, left=7, right=7)
            _borders(cell, bottom=(4, _LINE))
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        p = _cell_para(row.cells[0])
        parts = []
        if details:
            parts.append((details, dict(size=9.5)))
        for s in subs:
            parts.append((f"→ {s}", dict(size=8, color=_GRAY)))
        if not parts:
            _run(p, "", size=9.5)
        for i, (text, fmt) in enumerate(parts):
            if i:
                p.runs[-1].add_break(WD_BREAK.LINE)
            _text_lines(p, text, **fmt)
        _run(_cell_para(row.cells[1]), "$", size=9.5)
        if amount is not None:
            _run(_cell_para(row.cells[2], align=WD_ALIGN_PARAGRAPH.RIGHT), _amt(amount), size=9.5)

    if lines:
        for i, ((details, subs, _), amount) in enumerate(zip(lines, shown), start=1):
            body_row(t.rows[i], details, subs, amount)
    else:                              # no lines -> keep a blank body row so the bars frame it
        body_row(t.rows[1], "", [], None)
        t.rows[1].cells[1].paragraphs[0].clear()

    total = sum(shown) if lines else _num(co.total_amount)
    tr = t.rows[n + 1]
    _row_keep(tr)
    for c, (text, align) in enumerate((("Total Change Order", None), ("$", None),
                                       (_amt(total), WD_ALIGN_PARAGRAPH.RIGHT))):
        _shade(tr.cells[c], _RED)
        _margins(tr.cells[c], top=6, bottom=6, left=7, right=7)
        tr.cells[c].vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        _run(_cell_para(tr.cells[c], align=align), text, size=11, bold=True, color=_WHITE)
    return t


def _signature_table(doc, co):
    colw, gap = (_USABLE - 0.5) / 2.0, 0.5
    fields = ["Company Name", "Print Name", "Title", "Signature", "Date"]
    left = ["Castillo Engineering Services", co.signatory_name or "",
            co.signatory_title or "", "", _fmt_short_date(co.request_date)]
    right = [co.client_name or "", co.client_signatory_name or "",
             co.client_signatory_title or "", "", ""]
    t = doc.add_table(rows=len(fields) * 2, cols=3)
    _table_layout(t, [colw, gap, colw])
    last = len(t.rows) - 1
    for i, label in enumerate(fields):
        vrow, lrow = t.rows[2 * i], t.rows[2 * i + 1]
        for row in (vrow, lrow):
            _row_keep(row)
        for c, val in ((0, left[i]), (2, right[i])):
            vc, lc = vrow.cells[c], lrow.cells[c]
            _margins(vc, top=18, bottom=2)
            _borders(vc, bottom=(6, _DARK))
            _run(_cell_para(vc, keep_next=True), val, size=10)
            _margins(lc, top=1, bottom=4)
            _run(_cell_para(lc, keep_next=(2 * i + 1) != last), label, size=7.5, color=_GRAY)
        _margins(vrow.cells[1])
        _cell_para(vrow.cells[1], keep_next=True)
        _margins(lrow.cells[1])
        _cell_para(lrow.cells[1], keep_next=(2 * i + 1) != last)
    return t


def _section_break(doc):
    """End the data page with a section break carrying its own top/bottom margins.

    Its margins govern everything above it (the cover and this page); the
    services and back pages keep the template's own, which is what the original
    sectPr at the end of the body still describes. Left/right are copied from it
    untouched because the footer text box is positioned relative to the left margin.
    """
    final = doc.element.body.find(qn("w:sectPr"))
    sect = copy.deepcopy(final)
    for t in sect.findall(qn("w:type")):
        sect.remove(t)
    mar = sect.find(qn("w:pgMar"))
    mar.set(qn("w:top"), str(int(_DATA_TOP_MARGIN * 1440)))
    mar.set(qn("w:bottom"), str(int(_DATA_BOTTOM_MARGIN * 1440)))
    p = doc.add_paragraph()
    _para_fmt(p, line=1)
    pPr = p._p.get_or_add_pPr()
    _put(pPr, sect, _PPR)
    return p


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
def build_change_order_docx(co) -> bytes:
    """Render a ChangeOrder ORM object (or an unsaved stand-in) to .docx bytes."""
    doc = Document(io.BytesIO(_template_bytes()))
    _fill_preparer(doc, co)
    cursor = _prepare_page_two(doc)

    lines, shown = line_model(co)
    built = []

    built.append(_notice(doc, co)._p)
    built.append(_header_table(doc, co)._tbl)

    rule = doc.add_paragraph()
    _para_fmt(rule, before=4, line=1, left=_INDENT, right=0.04)
    _hr_below(rule)
    built.append(rule._p)

    title = doc.add_paragraph()
    _para_fmt(title, before=12, after=7, left=_INDENT, keep_next=True)
    _run(title, "CHANGE ORDER - SUMMARY OF SERVICES", size=17, bold=True, color=_RED)
    built.append(title._p)

    built.append(_details_table(doc, co, lines, shown)._tbl)
    built.append(_spacer(doc, 36)._p)
    built.append(_signature_table(doc, co)._tbl)
    built.append(_section_break(doc)._p)

    for el in built:                      # python-docx appends; move into place
        cursor.addnext(el)
        cursor = el

    _set_properties(doc, co)
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()
