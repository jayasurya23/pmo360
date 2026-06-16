"""Self-contained regression for the Save/Load Excel template round-trip.

Builds a synthetic proposal tree (section -> milestone -> tasks, plus a
price-only marker and a "study" task), serializes it, runs it through
write_template_xlsx -> read_template_xlsx, and asserts:

  * node count is stable (NO Client-Review / Record-Drawings injection on load)
  * every persisted ProposalItem field round-trips exactly
  * the split-deposit memory blob (frontend string-keyed shape) round-trips
  * project_start / utilization / custom_holidays survive in config_json
  * the "study" FF default + an explicit user-set FF both survive

Run:  python scripts/proposal_template_roundtrip_test.py   (exit 0 == pass)
No external workbook needed, so it is safe to run in CI.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ on path

from proposal.models import ProposalItem  # noqa: E402
from proposal.serialization import serialize_tree, deserialize_tree  # noqa: E402
from proposal.template_xlsx import write_template_xlsx, read_template_xlsx  # noqa: E402

_FIELDS = (
    "id", "name", "duration", "price", "is_milestone", "indent_level",
    "enabled", "price_only", "predecessor_id", "predecessor_type",
    "predecessor_type_user_set", "lag", "is_start_pinned",
    "show_start_date", "show_end_date", "task_utilization", "parent_id",
)


def _flatten(nodes, out):
    for n in nodes:
        out.append(n)
        _flatten(n.children, out)
    return out


def _build_tree():
    """Section(1) -> [Milestone(2) -> [Task(3) price-only, Study task(4) FF],
    Task(5) explicit user-set FF]."""
    section = ProposalItem(name="Electrical Engineering", indent_level=0, id=1)
    milestone = ProposalItem(name="30% Design", indent_level=1, id=2,
                             is_milestone=True, parent_id=1)
    t_marker = ProposalItem(name="Contract Signed", indent_level=2, id=3,
                            parent_id=2, price=24970, price_only=True,
                            show_start_date=False, show_end_date=False)
    t_study = ProposalItem(name="Electrical Study - Arc Flash", indent_level=2,
                           id=4, parent_id=2, price=1400, duration=1,
                           predecessor_id=3)  # name has "study" -> FF by rule
    t_user = ProposalItem(name="Plan Set", indent_level=1, id=5, parent_id=1,
                          price=10330, duration=8, predecessor_id=4,
                          predecessor_type="FF", predecessor_type_user_set=True,
                          task_utilization=50.0, lag=2, is_start_pinned=True)
    milestone.children = [t_marker, t_study]
    milestone.parent = section
    t_marker.parent = milestone
    t_study.parent = milestone
    t_user.parent = section
    section.children = [milestone, t_user]
    return [section]


def main() -> int:
    items = _build_tree()
    tree_json = serialize_tree(items)

    info_json = {
        "project_title": "Synthetic Test Project",
        "customer_name": "Acme Solar",
        "project_location": "Phoenix",
        "project_state": "AZ",
        "project_size_mw": "5.2",
        "version": "V3",
        "deposit_percent": 30.0,
        "logo_path": "",
        "client_logo_path": "",
        "split_deposit_memory": {
            "deposit_percentage": 30.0,
            "split_mode": "percent_of_each",
            "deposit_target": "due_diligence",
            "has_been_applied": True,
            "task_percentages": {"4": 50.0, "5": 25.0},
            "original_task_prices": {"4": 1400.0, "5": 10330.0},
            "original_target_prices": {"3": 24970.0},
            "selected_task_keys": ["4", "5"],
        },
    }
    config_json = {
        "project_start": "12/22/25",
        "utilization_percent": 75.0,
        "fs_start_next_day": False,
        "disabled_holidays": [],
        "custom_holidays": ["2026-01-01", "2026-02-16"],
    }

    xbytes = write_template_xlsx(
        tree_json=tree_json, info_json=info_json, config_json=config_json)
    parsed = read_template_xlsx(xbytes)
    items2, _ = deserialize_tree(parsed["tree_json"])

    f0 = sorted(_flatten(items, []), key=lambda x: x.id)
    f2 = sorted(_flatten(items2, []), key=lambda x: x.id)

    # 1. node count stable (no injection)
    assert len(f0) == len(f2) == 5, f"node count {len(f0)} -> {len(f2)} (expect 5)"

    # 2. every field round-trips exactly
    for a, b in zip(f0, f2):
        for fld in _FIELDS:
            assert getattr(a, fld) == getattr(b, fld), (
                f"id {a.id} field {fld}: {getattr(a, fld)!r} != {getattr(b, fld)!r}")

    # 3. study FF rule + explicit user-set FF survive
    by_id = {n.id: n for n in f2}
    assert by_id[4].predecessor_type == "FF", "study task should default FF"
    assert by_id[4].predecessor_type_user_set is False
    assert by_id[5].predecessor_type == "FF" and by_id[5].predecessor_type_user_set is True

    # 4. split-deposit memory round-trips (frontend string-keyed shape)
    sdm = parsed["info_json"]["split_deposit_memory"]
    assert sdm["deposit_target"] == "due_diligence"
    assert sdm["has_been_applied"] is True
    assert sdm["task_percentages"] == {"4": 50.0, "5": 25.0}
    assert sdm["original_task_prices"] == {"4": 1400.0, "5": 10330.0}
    assert sdm["original_target_prices"] == {"3": 24970.0}
    assert sdm["selected_task_keys"] == ["4", "5"]

    # 5. config survives
    assert parsed["config_json"]["project_start"] == "12/22/25"
    assert parsed["config_json"]["utilization_percent"] == 75.0
    assert parsed["config_json"]["custom_holidays"] == ["2026-01-01", "2026-02-16"]

    # 6. info subset survives
    assert parsed["info_json"]["project_title"] == "Synthetic Test Project"
    assert parsed["info_json"]["version"] == "V3"
    assert parsed["info_json"]["project_size_mw"] == "5.2"

    print("proposal template round-trip: ALL ASSERTIONS PASS "
          f"({len(f2)} nodes, fields + split memory + config verified)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
