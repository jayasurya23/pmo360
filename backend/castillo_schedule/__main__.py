"""Command line:  python -m castillo_schedule INPUT.json -o OUTPUT.pdf [--assign-ids] [--png]"""
import argparse
import sys

from .activity_ids import assign_ids, validate_ids
from .cpm import CPMOptions, LogicError, apply_cpm, has_logic
from .model import load_json
from .render import render_schedule
from .theme import INTERNAL_COLUMNS, Theme


def main(argv=None):
    p = argparse.ArgumentParser(description="Render a Castillo P6-style schedule")
    p.add_argument("input", help="schedule JSON (see examples/mesquite_flats.json)")
    p.add_argument("-o", "--output", default="schedule.pdf")
    p.add_argument("--assign-ids", action="store_true", help="fill missing Activity IDs (Castillo standard)")
    p.add_argument("--critical-method", choices=["total_float", "longest_path"], default="total_float",
                   help="how critical activities are defined (P6 Schedule Options)")
    p.add_argument("--float-threshold", type=int, default=0, help="critical if Total Float <= this")
    p.add_argument("--update-dates", action="store_true",
                   help="recalculate dates from logic instead of using the dates supplied")
    p.add_argument("--no-critical", action="store_true", help="draw all activities as planned (blue)")
    p.add_argument("--internal", action="store_true", help="add Total Float column (internal use)")
    p.add_argument("--png", action="store_true", help="also write a PNG preview of page 1")
    a = p.parse_args(argv)

    sched = load_json(a.input)
    if a.assign_ids:
        for name, aid in assign_ids(sched).items():
            print(f"  {aid:<10} {name}")
    if has_logic(sched):
        try:
            res = apply_cpm(sched, CPMOptions(method=a.critical_method, float_threshold=a.float_threshold,
                                              update_dates=a.update_dates))
        except LogicError as e:
            sys.exit(f"LOGIC ERROR: {e}")
        print(f"Critical path ({a.critical_method}): {len(res.critical)} activities, "
              f"project finish {res.project_finish}")
        for w in res.warnings:
            print("WARNING:", w, file=sys.stderr)
    else:
        print("No predecessors in input: using the 'critical' flags as supplied.")
    problems = validate_ids(sched)
    for msg in problems:
        print("WARNING:", msg, file=sys.stderr)

    theme = Theme(show_critical=not a.no_critical)
    if a.internal:
        theme.columns = INTERNAL_COLUMNS
    out = render_schedule(sched, a.output, theme)
    print("Wrote", out)
    if a.png:
        png = out.with_suffix(".png")
        render_schedule(sched, png, theme)
        print("Wrote", png)


if __name__ == "__main__":
    main()
