"""Self-contained regression for the Change Order Word draft.

Builds synthetic change orders (no database, no network) and asserts that the
.docx twin of the PDF keeps the promises the PDF makes:

  * the internal PMO/admin adders are folded INTO the printed line amounts and the
    printed lines add up to the total bar — the unmarked subtotal never appears
  * "Internal Notes" (on the CO and on a line) never render
  * the template's own preparer (name / phone / email / mailto link / file author)
    never leaks into a generated file; the CO's signatory takes its place, with
    blank fields squeezed out
  * an unapproved CO says so loudly on the page; an approved one gets a quiet note
  * the word "Proposal" does not survive anywhere in the document
  * the template still has the shape the builder relies on (it raises loudly if not)

Run:  python scripts/change_order_docx_test.py   (exit 0 == pass)
"""
from __future__ import annotations

import io
import re
import sys
import zipfile
from datetime import date
from pathlib import Path
from types import SimpleNamespace as NS

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ on path

from docx import Document  # noqa: E402

from docgen.change_order_docx import build_change_order_docx  # noqa: E402
from docgen.change_order_pdf import line_model  # noqa: E402


def _li(i, details, cost=None, rate=None, hours=None, allocs=None):
    return NS(order_index=i, details=details, allocations=allocs, cost=cost,
              hourly_rate=rate, hours=hours, role=None, internal_notes="SECRET LINE NOTE")


def _co(lines, rate_type="fixed", pmo=0, admin=0, **kw):
    base = dict(
        project_name="Sample Solar Project", project=None, client_name="Acme Energy",
        request_date=date(2026, 10, 23), co_version="V2", location="Orlando", state="FL",
        size_mw="50", project_number="J-1234", rate_type=rate_type, line_items=lines,
        pmo_pct=pmo, admin_pct=admin, total_amount=0, status="pending",
        notes="SECRET CO NOTE", title="Geotech",
        signatory_name="Pat Preparer", signatory_title="Senior PM",
        signatory_phone="407-555-0142", signatory_email="pat@example.com",
        client_signatory_name="Jane Client", client_signatory_title="Director",
    )
    base.update(kw)
    return NS(**base)


def _package(data: bytes) -> dict:
    z = zipfile.ZipFile(io.BytesIO(data))
    return {n: z.read(n) for n in z.namelist()}


def _doc_text(data: bytes) -> str:
    d = Document(io.BytesIO(data))
    cells = [c.text for t in d.tables for r in t.rows for c in r.cells]
    return "\n".join([p.text for p in d.paragraphs] + cells)


def _amount_column(data: bytes) -> list[float]:
    """The right-hand column of the details table, last entry being the total."""
    d = Document(io.BytesIO(data))
    t = next(t for t in d.tables if t.rows[0].cells[0].text.strip() == "Change Order Details")
    out = []
    for row in t.rows[1:]:
        txt = row.cells[-1].text.strip().replace(",", "")
        if txt:
            out.append(float(txt))
    return out


def main() -> int:
    # --- markup folded in, lines add up, nothing internal leaks ---------------
    fixed = _co([_li(0, "Geotechnical review", 10000), _li(1, "Revised layout", 7500)], pmo=5, admin=5)
    data = build_change_order_docx(fixed)
    amounts = _amount_column(data)
    assert amounts == [11000.0, 8250.0, 19250.0], amounts
    assert abs(sum(amounts[:-1]) - amounts[-1]) < 0.005, "lines must add up to the total bar"
    raw = b"".join(_package(data).values()).decode("latin-1")
    text = _doc_text(data)
    assert "17,500" not in text, "the unmarked subtotal must never be printed"
    for secret in ("SECRET CO NOTE", "SECRET LINE NOTE"):
        assert secret not in raw, f"{secret} leaked into the draft"
    lines, shown = line_model(fixed)
    assert [round(s, 2) for s in shown] == [11000.0, 8250.0] and len(lines) == 2

    # --- the template's own people never ride along ---------------------------
    parts = _package(data)
    blob = b"\n".join(parts.values()).decode("utf8", "ignore")
    for ghost in ("Gary Joseph", "gjoseph", "702-573-9644", "Ana Maier", "mailto:"):
        assert ghost not in blob, f"template leftover: {ghost!r}"
    assert "{{PREPARER" not in blob, "an unfilled preparer token reached the output"
    doc_xml = parts["word/document.xml"].decode("utf8")
    for want in ("Pat Preparer", "Senior PM", "407-555-0142", "pat@example.com"):
        assert doc_xml.count(want) >= 1, want
    core = parts["docProps/core.xml"].decode("utf8")
    assert "<dc:creator>PMO 360</dc:creator>" in core and "Ana Maier" not in core

    # blank signatory fields are squeezed out, not left as gaps between the rest
    sparse = build_change_order_docx(_co([_li(0, "x", 1)], signatory_title="", signatory_phone=""))
    sx = _package(sparse)["word/document.xml"].decode("utf8")
    order = [sx.index("Pat Preparer"), sx.index("pat@example.com")]
    assert order == sorted(order) and "{{PREPARER" not in sx

    # --- wording ---------------------------------------------------------------
    assert "Proposal" not in doc_xml and "PROPOSAL" not in doc_xml
    assert "Total Change Order" in text and "CHANGE ORDER - SUMMARY OF SERVICES" in text
    assert "Change Order Valid for 30 days." in doc_xml

    # --- draft notice ------------------------------------------------------------
    assert "DRAFT — NOT APPROVED — DO NOT SEND TO CLIENT" in text
    approved = _doc_text(build_change_order_docx(_co([_li(0, "x", 1)], status="approved")))
    assert "Editable Word copy of the approved change order" in approved
    assert "NOT APPROVED" not in approved

    # --- structure -----------------------------------------------------------------
    d = Document(io.BytesIO(data))
    assert len(d.sections) == 2, "data page must be its own section (cover+data / services+back)"
    assert d.sections[0].top_margin.inches > 0 and d.sections[0].bottom_margin.inches > 0.5
    last_sect_xml = d.element.body.find(
        "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}sectPr")
    assert last_sect_xml is not None

    # --- hourly line worked by several people: sub-bullets, summed line -------------
    hourly = _co([_li(0, "Load flow", allocs=[
        {"role": "Project Engineer", "rate": 250, "hours": 10},
        {"role": "Senior Engineer", "rate": 350, "hours": 4},
        {"role": "", "rate": 150, "hours": 2.5},
    ])], rate_type="hourly")
    htext = _doc_text(build_change_order_docx(hourly))
    assert "→ 10 hours — Project Engineer" in htext and "→ 4 hours — Senior Engineer" in htext
    assert "→ 2.5 hours" in htext
    assert _amount_column(build_change_order_docx(hourly)) == [4275.0, 4275.0]   # 2500+1400+375

    # --- edge cases still build -------------------------------------------------------
    for odd in (_co([]),
                _co([_li(0, "R&D <b>bold</b> review\nsecond line", 5000)]),
                _co([_li(i, f"Task {i}", 1000 + i) for i in range(30)])):
        out = build_change_order_docx(odd)
        Document(io.BytesIO(out))          # must be a valid, re-openable package
    assert "R&D <b>bold</b> review" in _doc_text(build_change_order_docx(
        _co([_li(0, "R&D <b>bold</b> review\nsecond line", 5000)])))

    print("change order docx: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
