"""Framework-free domain model for the proposal builder.

A plain-dataclass port of the legacy Tkinter ``ProposalItem``: its
``tk.BooleanVar`` fields (enabled, price_only, show_start_date, show_end_date)
become ordinary bools, and parent/child links are kept by id so the tree
serializes cleanly to/from JSON for the React UI and the DB.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class ProposalItem:
    """A single task, section, or milestone in the proposal schedule tree."""

    name: str
    duration: int = 0
    price: float = 0.0
    start_date: str = ""          # ISO yyyy-mm-dd ("" when unset)
    end_date: str = ""
    is_milestone: bool = False
    indent_level: int = 0

    # Identity + dependency tracking
    id: Optional[int] = None
    predecessor_id: Optional[int] = None
    predecessor_type: str = "FS"          # 'FS' (finish-to-start) or 'FF' (finish-to-finish)
    predecessor_type_user_set: bool = False
    lag: int = 0                          # lag in days

    # Display-only raw hours imported from the schedule workbook (no rounding)
    targeted_hours: Optional[float] = None

    # Manually pinned start date (excluded from auto predecessor recalculation)
    is_start_pinned: bool = False

    # Row toggles (were tk.BooleanVar in the desktop tool)
    enabled: bool = True
    # Show price in PDF but skip in date/predecessor calculations
    price_only: bool = False
    show_start_date: bool = True
    show_end_date: bool = True

    # Per-task utilization override. None = inherit project-wide utilization.
    # Client-Review tasks always ignore utilization (see calendar.adjusted_duration).
    task_utilization: Optional[float] = None

    # Tree structure (kept by id so the model is JSON-serializable)
    parent_id: Optional[int] = None
    children: list["ProposalItem"] = field(default_factory=list)
    # Transient runtime parent link (set by scheduling.build_tree); excluded
    # from repr/eq so the tree doesn't recurse. Mirrors the desktop tool's
    # item.parent so the scheduler walks ancestors (is_in_project_initiation)
    # verbatim. Not serialized.
    parent: Optional["ProposalItem"] = field(
        default=None, repr=False, compare=False)

    def __post_init__(self) -> None:
        # Legacy default rule (Full_proposal_V9.py line 92): a task whose name
        # contains "study" defaults to Finish-to-Finish, otherwise Finish-to-Start.
        # Only applied until the user explicitly picks a type.
        if not self.predecessor_type_user_set:
            self.predecessor_type = "FF" if "study" in (self.name or "").lower() else "FS"


@dataclass
class ProjectInfo:
    """Header/meta for a proposal, surfaced on the Gantt + PDF cover.

    Field set mirrors what build_gantt_with_version / extract_project_info use;
    extended as the parser port fills it in.
    """

    project_title: str = ""
    customer_name: str = ""
    project_location: str = ""
    project_state: str = ""
    project_size_mw: str = ""
    version: str = "V1"
    logo_path: str = ""
    client_logo_path: str = ""
