"""Check the frontend's business-day counter against the real backend engine.

The Schedule table's "Dur" column comes from numpy `busday_count` against the
`holidays` package (backend/proposal/calendar.py). The Project Summary's
business-day figure is computed in the browser by src/lib/businessDays.ts.
If those two ever disagree, PMs see two different numbers for the same span —
which is exactly the confusion this pairing exists to prevent.

This transpiles the real TS module with esbuild, runs it in node, and compares
it to the Python engine over several thousand random spans.

    python frontend/scripts/verify_business_days.py
"""
import json
import os
import random
import subprocess
import sys
import tempfile
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
FRONTEND = os.path.dirname(HERE)
REPO = os.path.dirname(FRONTEND)
sys.path.insert(0, os.path.join(REPO, "backend"))

import numpy as np  # noqa: E402
from proposal.calendar import us_holiday_array  # noqa: E402

TS_MODULE = os.path.join(FRONTEND, "src", "lib", "businessDays.ts")

# Cover leap years, the 2021 Juneteenth introduction, and year boundaries.
YEAR_LO, YEAR_HI = 2024, 2032
SPANS = 3000


def python_business_days(start: date, end: date) -> int:
    hols = us_holiday_array(start.year, end.year)
    return int(
        np.busday_count(
            np.datetime64(start, "D"),
            np.datetime64(end + timedelta(days=1), "D"),  # inclusive end
            holidays=hols,
        )
    )


def node_business_days(spans) -> list:
    """Transpile the real TS module and run every span through it."""
    with tempfile.TemporaryDirectory() as tmp:
        js = os.path.join(tmp, "bd.mjs")
        subprocess.run(
            ["npx", "esbuild", TS_MODULE, "--format=esm", f"--outfile={js}"],
            cwd=FRONTEND, check=True, capture_output=True, shell=(os.name == "nt"),
        )
        # Spans go through a file, not argv — Windows caps the command line
        # well below a few thousand date pairs.
        spans_file = os.path.join(tmp, "spans.json")
        driver = os.path.join(tmp, "run.mjs")
        with open(driver, "w", encoding="utf-8") as f:
            f.write(
                "import { readFileSync } from 'node:fs';\n"
                # Windows absolute paths need a file:// URL for the ESM loader.
                "import { businessDaysBetween } from "
                + json.dumps("file:///" + js.replace("\\", "/")) + ";\n"
                "const spans = JSON.parse(readFileSync(process.argv[2], 'utf8'));\n"
                "const out = spans.map(([a, b]) => {\n"
                "  const [y1,m1,d1] = a.split('-').map(Number);\n"
                "  const [y2,m2,d2] = b.split('-').map(Number);\n"
                "  return businessDaysBetween(new Date(y1,m1-1,d1), new Date(y2,m2-1,d2));\n"
                "});\n"
                "process.stdout.write(JSON.stringify(out));\n"
            )
        with open(spans_file, "w", encoding="utf-8") as f:
            json.dump([[a.isoformat(), b.isoformat()] for a, b in spans], f)
        r = subprocess.run(
            ["node", driver, spans_file],
            capture_output=True, text=True, shell=(os.name == "nt"),
        )
        if r.returncode != 0:
            print("node failed:\n" + (r.stderr or "")[:2000])
            raise SystemExit(1)
        return json.loads(r.stdout)


def main() -> int:
    rng = random.Random(20260729)
    lo, hi = date(YEAR_LO, 1, 1), date(YEAR_HI, 12, 31)
    total_days = (hi - lo).days

    spans = []
    for _ in range(SPANS):
        a = lo + timedelta(days=rng.randint(0, total_days))
        b = a + timedelta(days=rng.randint(0, 900))
        if b > hi:
            b = hi
        spans.append((a, b))
    # Pin a few spans that specifically probe observation edge cases.
    spans += [
        (date(2026, 7, 1), date(2026, 7, 10)),    # Jul 4 2026 = Saturday
        (date(2027, 7, 1), date(2027, 7, 10)),    # Jul 4 2027 = Sunday
        (date(2027, 12, 20), date(2028, 1, 5)),   # Jan 1 2028 = Saturday
        (date(2025, 12, 22), date(2026, 1, 2)),   # Christmas + New Year run
        (date(2032, 12, 24), date(2032, 12, 31)),
    ]

    print(f"comparing {len(spans)} spans, {YEAR_LO}-{YEAR_HI} …")
    js_vals = node_business_days(spans)
    py_vals = [python_business_days(a, b) for a, b in spans]

    bad = [
        (a, b, j, p)
        for (a, b), j, p in zip(spans, js_vals, py_vals)
        if j != p
    ]
    if bad:
        print(f"\nMISMATCH on {len(bad)} of {len(spans)} spans:")
        for a, b, j, p in bad[:15]:
            print(f"  {a} -> {b}:  ts={j}  python={p}  (diff {j - p:+d})")
        return 1

    print(f"PASS - all {len(spans)} spans agree with the backend engine")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
