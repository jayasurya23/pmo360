"""Backfill ``Project.project_number`` (the Castillo job number) from monday.com.

monday.com's Portfolio board is the source of truth for the job number. This
reads that board and fills the number in on portfolios whose names match, then
reports everything it could NOT decide so a human can.

READ-ONLY AGAINST MONDAY, ALWAYS
--------------------------------
``_post`` refuses to send anything containing "mutation". This script can never
change a Monday board, only read one.

DRY RUN BY DEFAULT
------------------
Without ``--apply`` nothing is written to the database either. Run it, read the
report, then run it again with ``--apply``.

WHAT IT DELIBERATELY DOES NOT DO
--------------------------------
It does not create portfolios, rename clients, or write anything other than
``projects.project_number``. An earlier prototype had ``--create-missing`` and
``--reconcile-clients``; both are gone on purpose. The Monday-to-PMO mapping is
genuinely many-to-many in both directions ("Highland South (1 & 2)" is one
Monday item covering two of our portfolios; "Coal City 1/2/3 IFC" is three
Monday items covering one), so an unmatched board row is much more often a
naming difference than a missing portfolio. Auto-creating on that signal
produces duplicate portfolios in production, which is far more expensive to
undo than typing a job number in by hand.

EXACT MATCHES ONLY
------------------
Names are compared with case, punctuation and spacing removed, and nothing
looser. This mirrors the deliberate choice already made elsewhere in the
codebase: fuzzy distance starts guessing, and a wrong mapping silently files a
number against another client's project — worse than no match at all. Anything
that is not an unambiguous exact match is reported, never written.

DB target follows the config switch (LOCAL_DEV_MODE / DATABASE_URL), so to run
against production use LOCAL_DEV_MODE=false with DATABASE_URL pointed at the
prod Postgres server.

Run from backend/:
    export MONDAY_API_TOKEN=...
    python -m scripts.sync_projects_from_monday                 # dry run
    python -m scripts.sync_projects_from_monday --apply         # write
    python -m scripts.sync_projects_from_monday --apply --overwrite
    python -m scripts.sync_projects_from_monday --set "Snapdragon=264-066"
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db import session_scope
from db.models import Client, PortfolioProject, Project

API = "https://api.monday.com/v2"
API_VERSION = "2024-10"
#: The Portfolio board. One item per project; the job number is the column
#: TITLED "Project ID" — resolved by title, never by id, because column ids are
#: opaque and get re-generated when a column is recreated.
BOARD = "18403099969"
NUMBER_COLUMN_TITLE = "Project ID"
CLIENT_COLUMN_TITLE = "Client Name"


# ---------------------------------------------------------------- Monday I/O

class MondayError(RuntimeError):
    pass


def _post(query: str, variables: dict | None = None, *, token: str) -> dict:
    """POST a GraphQL *query*. Refuses mutations outright.

    The guard is a substring check on purpose: it is a tripwire against a future
    edit to this file, not a parser. This script has no business writing to
    Monday and should fail loudly if someone makes it try.
    """
    if "mutation" in query.lower():
        raise MondayError("This script is read-only against Monday; refusing to send a mutation.")

    last: Exception | None = None
    for attempt in range(4):
        try:
            r = requests.post(
                API,
                json={"query": query, "variables": variables or {}},
                headers={
                    "Authorization": token,
                    "Content-Type": "application/json",
                    "API-Version": API_VERSION,
                },
                timeout=(10, 60),
            )
            r.raise_for_status()
            payload = r.json()
            if "errors" in payload:
                raise MondayError(str(payload["errors"])[:400])
            return payload["data"]
        except (requests.Timeout, requests.ConnectionError, requests.HTTPError) as exc:
            last = exc
            if attempt < 3:
                time.sleep(2 ** attempt)
    raise MondayError(f"Monday API unreachable after 4 attempts: {last}")


def fetch_portfolio(token: str, board: str) -> list[dict]:
    """Every item on the board as {name, number, client, url}.

    board_relation and mirror columns return ``text=None`` even when populated;
    the value lives in ``display_value``, which is why both are unwrapped below.
    """
    meta = _post(
        "query($i:[ID!]){boards(ids:$i){columns{id title}}}",
        {"i": [board]}, token=token,
    )
    boards = meta.get("boards") or []
    if not boards:
        raise MondayError(f"Board {board} not found, or the token cannot see it.")
    by_title = {c["title"].strip().lower(): c["id"] for c in boards[0]["columns"]}

    wanted = {}
    for key, title in (("number", NUMBER_COLUMN_TITLE), ("client", CLIENT_COLUMN_TITLE)):
        cid = by_title.get(title.lower())
        if not cid:
            raise MondayError(
                f"No column titled {title!r} on board {board}. "
                f"Columns present: {sorted(by_title)}"
            )
        wanted[key] = cid
    rev = {v: k for k, v in wanted.items()}

    FIELDS = """items{id name url column_values(ids:$c){id text
        ... on BoardRelationValue { display_value }
        ... on MirrorValue { display_value }}}"""

    items: list[dict] = []
    data = _post(
        f"query($i:[ID!],$c:[String!]){{boards(ids:$i){{items_page(limit:100){{cursor {FIELDS}}}}}}}",
        {"i": [board], "c": list(wanted.values())}, token=token,
    )
    page = data["boards"][0]["items_page"]
    items += page["items"]
    cursor = page["cursor"]
    while cursor:
        data = _post(
            f"query($cu:String!,$c:[String!]){{next_items_page(cursor:$cu,limit:100){{cursor {FIELDS}}}}}",
            {"cu": cursor, "c": list(wanted.values())}, token=token,
        )
        page = data["next_items_page"]
        items += page["items"]
        cursor = page["cursor"]

    rows = []
    for it in items:
        row = {"name": (it["name"] or "").strip(), "url": it["url"], "number": None, "client": None}
        for cv in it["column_values"]:
            key = rev.get(cv["id"])
            if key:
                row[key] = ((cv.get("text") or cv.get("display_value") or "").strip()) or None
        rows.append(row)
    return rows


# ---------------------------------------------------------------- matching

def norm(s: str | None) -> str:
    """Case, punctuation and spacing removed. Deliberately not fuzzy.

    'Beloit II' and 'beloit ii' must collide. 'Highland South (1 & 2)' and
    'Highland South 1' must NOT.
    """
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def match(rows: list[dict], projects: list[Project], sub_names: dict[str, list[str]]):
    """Split the board into what can be written and what a human must decide."""
    ours: dict[str, list[Project]] = defaultdict(list)
    for p in projects:
        ours[norm(p.name)].append(p)

    theirs: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        theirs[norm(r["name"])].append(r)

    res = {"exact": [], "ambiguous": [], "sub_only": [], "orphan": [], "unnumbered": []}
    for key, group in theirs.items():
        if not key:
            continue
        if len(group) > 1:
            res["ambiguous"].append(("monday", group))
            continue
        row = group[0]
        ourside = ours.get(key, [])
        if len(ourside) > 1:
            res["ambiguous"].append(("pmo", [row] + ourside))
        elif len(ourside) == 1:
            if row["number"]:
                res["exact"].append((ourside[0], row))
            else:
                res["unnumbered"].append((ourside[0], row))
        elif key in sub_names:
            # Matches a SUB-project, not a portfolio. Never written: the job
            # number lives on the portfolio tier, and guessing which portfolio
            # a sub-project's number belongs to is exactly the wrong-mapping
            # failure this script refuses to risk.
            res["sub_only"].append((row, sub_names[key]))
        else:
            res["orphan"].append(row)
    return res


# ---------------------------------------------------------------- reporting

def report(res, projects, writes, skipped, args) -> None:
    W = 74
    print(f"\nMonday Portfolio board {BOARD}")
    print(f"{len(projects)} portfolios in PMO 360\n")

    def block(title, n):
        print(f"\n{'=' * W}\n{title}  ({n})\n{'=' * W}")

    block("WILL WRITE" if args.apply else "WOULD WRITE (dry run - pass --apply)", len(writes))
    for p, row in writes:
        was = f"  (was {p.project_number!r})" if p.project_number else ""
        print(f"  {p.name:<44} -> {row['number']}{was}")
    if not writes:
        print("  (nothing)")

    if skipped:
        block("ALREADY SET, DIFFERENT IN MONDAY - not overwritten", len(skipped))
        print("  Pass --overwrite to take Monday's value, or fix Monday.\n")
        for p, row in skipped:
            print(f"  {p.name:<44} ours={p.project_number!r}  monday={row['number']!r}")
            print(f"    {row['url']}")

    # Duplicates are computed over what WILL be in the database afterwards —
    # every row we are about to write, plus every number already stored that we
    # are not touching. Computing it over the write list alone would miss a new
    # number colliding with an existing one.
    final: dict[str, list[str]] = defaultdict(list)
    pending = {id(p) for p, _ in writes}
    for p, row in writes:
        final[row["number"]].append(p.name)
    for p in projects:
        if p.project_number and id(p) not in pending:
            final[p.project_number].append(p.name)
    dupes = {k: v for k, v in final.items() if len(v) > 1}
    if dupes:
        block("DUPLICATE JOB NUMBERS after this run", len(dupes))
        print("  Not an error - one Monday item can cover two portfolios. Confirm each.\n")
        for num, names in sorted(dupes.items()):
            print(f"  {num}: {', '.join(names)}")

    if res["ambiguous"]:
        block("AMBIGUOUS - same name more than once", len(res["ambiguous"]))
        for side, group in res["ambiguous"]:
            if side == "monday":
                print(f"  Monday has {len(group)} items named {group[0]['name']!r}:")
                for r in group:
                    print(f"    {r['number'] or 'no number'}  {r['url']}")
            else:
                row, *ps = group
                print(f"  Monday {row['name']!r} matches {len(ps)} portfolios: "
                      f"{', '.join(p.name for p in ps)}")
                print(f"    {row['url']}")

    if res["sub_only"]:
        block("MATCHES A SUB-PROJECT, NOT A PORTFOLIO - never written", len(res["sub_only"]))
        print("  The job number lives on the portfolio. Set it by hand if it belongs there.\n")
        for row, portfolios in res["sub_only"]:
            print(f"  {row['name']:<44} {row['number'] or 'no number'}")
            print(f"    sub-project under: {', '.join(portfolios)}")
            print(f"    {row['url']}")

    if res["unnumbered"]:
        block("MATCHED, BUT MONDAY HAS NO NUMBER", len(res["unnumbered"]))
        for p, row in res["unnumbered"]:
            print(f"  {p.name:<44} {row['url']}")

    if res["orphan"]:
        block("IN MONDAY, NOT IN PMO 360", len(res["orphan"]))
        print("  Usually a naming difference, occasionally a genuinely absent portfolio.")
        print("  Nothing is created automatically - check each, then rename or add by hand.\n")
        for row in res["orphan"]:
            print(f"  {row['name']:<44} {row['number'] or 'no number':<12} {row['client'] or ''}")
            print(f"    {row['url']}")

    missing = [p for p in projects if not p.project_number and p not in [w[0] for w in writes]]
    if missing:
        block("STILL WITHOUT A JOB NUMBER after this run", len(missing))
        for p in missing:
            print(f"  {p.name}")


# ---------------------------------------------------------------- main

def main() -> int:
    # Windows consoles default to cp1252, which cannot encode the box-drawing
    # and dash characters this report used to print. Output is ASCII now, but
    # portfolio and client names come from Monday and may not be, so make the
    # stream tolerant rather than let one accented name kill the whole report.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass

    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--apply", action="store_true",
                    help="write to the database (default is a dry run)")
    ap.add_argument("--overwrite", action="store_true",
                    help="replace a number that is already set and differs from Monday")
    ap.add_argument("--set", action="append", default=[], metavar="NAME=NUMBER",
                    help="set one portfolio by hand, bypassing Monday; repeatable")
    ap.add_argument("--board", default=BOARD, help=f"Monday board id (default {BOARD})")
    args = ap.parse_args()

    manual = {}
    for pair in args.set:
        if "=" not in pair:
            print(f"--set expects NAME=NUMBER, got {pair!r}", file=sys.stderr)
            return 2
        name, _, number = pair.partition("=")
        manual[norm(name)] = (name.strip(), number.strip())

    token = os.getenv("MONDAY_API_TOKEN", "")
    if not token and not manual:
        print("MONDAY_API_TOKEN not set.", file=sys.stderr)
        return 2

    with session_scope() as s:
        projects = s.query(Project).order_by(Project.name).all()
        sub_names: dict[str, list[str]] = defaultdict(list)
        for sp in s.query(PortfolioProject).all():
            parent = s.get(Project, sp.portfolio_id)
            sub_names[norm(sp.name)].append(parent.name if parent else f"#{sp.portfolio_id}")

        writes: list[tuple[Project, dict]] = []
        skipped: list[tuple[Project, dict]] = []
        res = {"exact": [], "ambiguous": [], "sub_only": [], "orphan": [], "unnumbered": []}

        if manual:
            by_norm = {norm(p.name): p for p in projects}
            for key, (raw, number) in manual.items():
                p = by_norm.get(key)
                if not p:
                    print(f"  ! no portfolio named {raw!r}", file=sys.stderr)
                    continue
                writes.append((p, {"number": number, "url": "(--set)"}))

        if token:
            rows = fetch_portfolio(token, args.board)
            res = match(rows, projects, sub_names)
            claimed = {id(p) for p, _ in writes}
            for p, row in res["exact"]:
                if id(p) in claimed:
                    continue          # an explicit --set wins over the board
                if not p.project_number:
                    writes.append((p, row))
                elif p.project_number != row["number"]:
                    (writes if args.overwrite else skipped).append((p, row))

        report(res, projects, writes, skipped, args)

        if args.apply:
            for p, row in writes:
                p.project_number = row["number"]
            print(f"\nApplied {len(writes)} update(s).")
        else:
            print(f"\nDry run - nothing written. Re-run with --apply to write {len(writes)}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
