"""Layout + brand constants ported verbatim from the legacy proposal tool.

The brand red (#991f2b) is the Castillo dark-red that also lives in
config.BrandColors (PRIMARY #ad1f2b / dark #991f2b) — kept here as the literal
the Gantt/PDF renderers were tuned against so output matches the desktop tool
pixel-for-pixel.
"""
from __future__ import annotations

# Version of the desktop tool these constants/renderers were ported from.
PORTED_FROM_VERSION = "10.4"

# Gantt + table typography
FONTSIZE_TABLE = 8.5
FONTSIZE_CHART_REGULAR = 7.5
FONTSIZE_CHART_SUMMARY = 7.5
FONTSIZE_XTICK = 7.0

# Pagination + layout
MAX_ROWS_PER_PAGE = 38
LEFT_RIGHT_WIDTHS = [1.2, 2.8]          # table : chart width ratio
COL_EDGES = [0.00, 0.58, 0.7, 0.85, 1.00]
HEADERS = ["Task", "Duration", "Start", "Finish"]
MAX_NAME_LENGTH = 50
ROW_HEIGHT = 1.0
MIN_WIDTH_DAYS = 0.2

# Colors
PRIMARY = "#991f2b"
SECONDARY = "black"

# Milestone diamond sizing (fixed, independent of project span)
DIAMOND_HALF_WIDTH_IN = 0.06            # ~0.24" full width
DIAMOND_HALF_HEIGHT_ROW = 0.22          # half-height in row units (row height = 1.0)
MILESTONE_TEXT_GAP_IN = 0.06
