"""Castillo schedule theme: the single source of truth for colors, fonts and layout.

Every value here mirrors the Castillo P6 standard layout
("P6 Castillo Color Table", Castillo Engineering Branding Style Sheet V2).
If the brand palette or the P6 layout changes, change it HERE and nowhere else.
Do not hard-code colors or fonts in the renderer or in calling code.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

PKG_DIR = Path(__file__).resolve().parent
ASSET_DIR = PKG_DIR.parent  # fonts/ and castillo_logo.png live next to the package

# --------------------------------------------------------------------------
# 1. Brand palette (hex) - Castillo Branding Style Sheet V2
# --------------------------------------------------------------------------
PALETTE = {
    # Primary
    "castillo_red": "#ad1f2b",
    "charcoal": "#333132",
    "gray": "#4d4d4f",
    "dark_red": "#991f2b",
    "brown": "#5e4b40",
    "light_gray": "#bcbec0",
    # Secondary
    "bright_red": "#e12a3f",
    "blue": "#1aa6c9",
    "olive": "#c7bb2e",
    "dark_green": "#278747",
    "light_green": "#4ab751",
    "pale_gray": "#e6e7e8",
    "white": "#ffffff",
    "black": "#000000",
}


def tint(hex_color: str, amount: float) -> str:
    """Mix a color with white. amount=0 -> white, 1 -> the color."""
    h = hex_color.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    mix = lambda c: round(255 - (255 - c) * amount)  # noqa: E731
    return "#{:02x}{:02x}{:02x}".format(mix(r), mix(g), mix(b))


# --------------------------------------------------------------------------
# 2. Row styles (P6: Table, Font and Row)
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class RowStyle:
    fill: str          # table-side fill
    font_color: str
    weight: str        # "regular" | "semibold" | "bold"
    size: float        # points
    gantt_fill: str    # Gantt-side fill (pale tint so summary bars stay legible)


WBS_LEVEL_STYLES = {
    1: RowStyle(PALETTE["castillo_red"], PALETTE["white"], "bold", 11, tint(PALETTE["castillo_red"], 0.14)),
    2: RowStyle(PALETTE["charcoal"], PALETTE["white"], "bold", 10, tint(PALETTE["charcoal"], 0.10)),
    3: RowStyle(PALETTE["gray"], PALETTE["white"], "semibold", 9, tint(PALETTE["gray"], 0.08)),
    4: RowStyle(PALETTE["light_gray"], PALETTE["black"], "semibold", 9, tint(PALETTE["light_gray"], 0.25)),
    5: RowStyle(PALETTE["pale_gray"], PALETTE["black"], "semibold", 8, tint(PALETTE["pale_gray"], 0.5)),
    6: RowStyle(PALETTE["pale_gray"], PALETTE["dark_red"], "semibold", 8, tint(PALETTE["pale_gray"], 0.5)),
}
ACTIVITY_ROW = RowStyle(PALETTE["white"], PALETTE["black"], "regular", 8, PALETTE["white"])


def wbs_style(level: int) -> RowStyle:
    return WBS_LEVEL_STYLES.get(level, WBS_LEVEL_STYLES[6])


# --------------------------------------------------------------------------
# 3. Bar styles (P6: Bars) - preliminary / client layout
#    No actuals, no remaining work, no baseline, no data date in a prelim.
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class BarStyle:
    label: str           # legend text
    color: str
    height_frac: float   # fraction of row height
    edge: str | None = None


BARS = {
    "planned": BarStyle("Planned Activity", PALETTE["blue"], 0.50),
    "critical": BarStyle("Critical Activity", PALETTE["bright_red"], 0.50),
    "milestone": BarStyle("Milestone", PALETTE["olive"], 0.62, edge=PALETTE["charcoal"]),
    "summary": BarStyle("WBS Summary", PALETTE["charcoal"], 0.16),
}


# --------------------------------------------------------------------------
# 4. Columns (P6: Columns)
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class ColumnSpec:
    key: str        # activity_id | name | duration | start | finish | total_float
    header: str
    width: float    # inches
    align: str      # "left" | "center" | "right"


CLIENT_PRELIM_COLUMNS = (
    ColumnSpec("activity_id", "Activity ID", 0.95, "left"),
    ColumnSpec("name", "Activity Name", 2.70, "left"),
    ColumnSpec("duration", "Original\nDuration", 0.68, "center"),
    ColumnSpec("start", "Start", 0.78, "center"),
    ColumnSpec("finish", "Finish", 0.78, "center"),
)

# Internal working version: add Total Float when the schedule is not for a client.
INTERNAL_COLUMNS = CLIENT_PRELIM_COLUMNS + (ColumnSpec("total_float", "Total\nFloat", 0.6, "center"),)


# --------------------------------------------------------------------------
# 5. Theme object passed to the renderer
# --------------------------------------------------------------------------
@dataclass
class Theme:
    # Page: 11x17 (Tabloid) landscape
    page_width: float = 17.0
    page_height: float = 11.0
    margin: float = 0.40

    columns: tuple = CLIENT_PRELIM_COLUMNS
    date_format: str = "%d-%b-%y"          # P6 default style: 02-Nov-26
    duration_suffix: str = ""              # "" -> "25", "d" -> "25d"

    show_critical: bool = True             # color critical activities Bright Red
    show_week_tier: bool = True            # 3-tier timescale Year / Month / Week
    label_summary_bars: bool = False       # P6 normally labels activities only
    indent_per_level: float = 0.14         # inches of indent per WBS level

    # Row heights (inches). Rows stretch to fill the page between min and max.
    row_height_min: float = 0.19
    row_height_max: float = 0.30
    timescale_tier_height: float = 0.20

    header_height: float = 1.15
    footer_height: float = 1.15

    # Header / table header colors
    title_color: str = PALETTE["castillo_red"]
    label_color: str = PALETTE["castillo_red"]
    text_color: str = PALETTE["charcoal"]
    column_header_fill: str = PALETTE["gray"]
    column_header_text: str = PALETTE["white"]
    year_tier_fill: str = PALETTE["gray"]
    month_tier_fill: str = PALETTE["pale_gray"]
    week_tier_fill: str = PALETTE["white"]
    border_color: str = PALETTE["charcoal"]
    sight_line_color: str = PALETTE["pale_gray"]
    month_line_color: str = PALETTE["light_gray"]
    week_line_color: str = "#f0f0f1"
    bar_label_color: str = PALETTE["charcoal"]

    layout_name: str = "Castillo Prelim - Client"
    disclaimer_title: str = "PRELIMINARY - FOR DISCUSSION PURPOSES ONLY"
    disclaimer: str = (
        "Dates are planned and subject to change "
        "based on Notice to Proceed, client review durations and receipt of required information."
    )
    calendar_note: str = "Durations are in working days (5-day work week, holidays excluded)."

    fonts_dir: Path = field(default_factory=lambda: ASSET_DIR / "fonts")
    logo_path: Path | None = field(default_factory=lambda: ASSET_DIR / "castillo_logo.png")

    @property
    def table_width(self) -> float:
        return sum(c.width for c in self.columns)


DEFAULT_THEME = Theme()
