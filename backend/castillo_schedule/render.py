"""P6-style Gantt renderer with Castillo branding.

Entry point: render_schedule(schedule, out_path, theme=DEFAULT_THEME)
Output type follows the file extension (.pdf multi-page, .png first page only).

The page is drawn on a single axes whose units are inches, origin at the top-left
(y grows downward), so every layout number in theme.py is a physical size.
"""
from __future__ import annotations

import calendar
import math
import warnings
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
matplotlib.rcParams["pdf.fonttype"] = 42  # embed TrueType: sharp, searchable text
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager  # noqa: E402
from matplotlib.backends.backend_pdf import PdfPages  # noqa: E402
from matplotlib.patches import Polygon, Rectangle  # noqa: E402
from matplotlib.textpath import TextPath  # noqa: E402

from .model import WBS, Activity, Schedule  # noqa: E402
from .theme import ACTIVITY_ROW, BARS, DEFAULT_THEME, PALETTE, Theme, wbs_style  # noqa: E402

PT = 1 / 72.0  # inches per point


# --------------------------------------------------------------------------
# Fonts
# --------------------------------------------------------------------------
class Fonts:
    FILES = {"regular": "Jost-Regular.ttf", "semibold": "Jost-SemiBold.ttf", "bold": "Jost-Bold.ttf"}

    def __init__(self, fonts_dir: Path):
        self._fp = {}
        for weight, fname in self.FILES.items():
            path = Path(fonts_dir) / fname
            if path.exists():
                font_manager.fontManager.addfont(str(path))
                self._fp[weight] = font_manager.FontProperties(fname=str(path))
            else:
                warnings.warn(f"Jost font not found at {path}; falling back to DejaVu Sans. "
                              "Install Jost (Regular/SemiBold/Bold) for brand-correct output.")
                self._fp[weight] = font_manager.FontProperties(
                    family="DejaVu Sans", weight={"regular": "normal"}.get(weight, weight))

    def __call__(self, weight: str, size: float):
        fp = self._fp[weight].copy()
        fp.set_size(size)
        return fp

    def width(self, text: str, weight: str, size: float) -> float:
        """Rendered width of text in inches."""
        if not text:
            return 0.0
        return TextPath((0, 0), text, prop=self(weight, size)).get_extents().width * PT


# --------------------------------------------------------------------------
# Layout helpers
# --------------------------------------------------------------------------
@dataclass
class Row:
    level: int
    item: object  # WBS | Activity

    @property
    def is_wbs(self) -> bool:
        return isinstance(self.item, WBS)


class Timeline:
    def __init__(self, t0: date, t1: date, x0: float, x1: float):
        self.t0, self.t1, self.x0, self.x1 = t0, t1, x0, x1
        self.days = (t1 - t0).days

    def x(self, d: date) -> float:
        return self.x0 + (d - self.t0).days / self.days * (self.x1 - self.x0)


def _month_start(d: date) -> date:
    return d.replace(day=1)


def _next_month(d: date) -> date:
    return date(d.year + (d.month // 12), d.month % 12 + 1, 1)


def _fmt_date(d: date, theme: Theme) -> str:
    return d.strftime(theme.date_format)


# --------------------------------------------------------------------------
# Renderer
# --------------------------------------------------------------------------
class ScheduleRenderer:
    def __init__(self, schedule: Schedule, theme: Theme = DEFAULT_THEME):
        self.s = schedule
        self.t = theme
        self.f = Fonts(theme.fonts_dir)
        self.rows = [Row(lvl, item) for lvl, item in schedule.rows()]

        th = theme
        self.W, self.H = th.page_width, th.page_height
        self.left = th.margin
        self.right = self.W - th.margin
        self.header_top = th.margin
        self.grid_top = th.margin + th.header_height
        n_tiers = 3 if th.show_week_tier else 2
        self.colhead_h = th.timescale_tier_height * n_tiers
        self.body_top = self.grid_top + self.colhead_h
        self.footer_top = self.H - th.margin - th.footer_height
        self.body_bottom = self.footer_top - 0.12
        self.table_right = self.left + th.table_width
        self.chart_x0 = self.table_right
        self.chart_x1 = self.right

        avail = self.body_bottom - self.body_top
        rh = avail / max(len(self.rows), 1)
        self.row_h = min(max(rh, th.row_height_min), th.row_height_max)
        self.rows_per_page = max(1, int(math.floor(avail / self.row_h + 1e-9)))
        self.pages = [self.rows[i:i + self.rows_per_page]
                      for i in range(0, len(self.rows), self.rows_per_page)]
        self.timeline = self._build_timeline()

    # ---- timeline range: pad the end so every bar label fits --------------
    def _label(self, row: Row) -> str:
        if row.is_wbs:
            return row.item.name if self.t.label_summary_bars else ""
        return row.item.name

    def _build_timeline(self) -> Timeline:
        start = min(a.start for a in self.s.root.activities())
        finish = max(a.finish for a in self.s.root.activities())
        # Lead-in: start on the Monday at least 3 days before the first activity (P6-style padding)
        lead = start - timedelta(days=3)
        t0 = lead - timedelta(days=lead.weekday())
        w = self.chart_x1 - self.chart_x0
        need_days = (finish - t0).days + 8
        for r in self.rows:
            lbl = self._label(r)
            end = r.item.finish + timedelta(days=1)
            lw = self.f.width(lbl, "regular", 7.5) + 0.12 + (0.08 if not r.is_wbs and r.item.is_milestone else 0)
            if lw >= w * 0.9:
                continue
            days = (end - t0).days * w / (w - lw)
            need_days = max(need_days, math.ceil(days))
        t1 = t0 + timedelta(days=need_days)
        t1 += timedelta(days=(6 - t1.weekday()) % 7 + 1)  # finish on a Monday boundary
        return Timeline(t0, t1, self.chart_x0, self.chart_x1)

    # ---- primitives -------------------------------------------------------
    def _rect(self, ax, x, y, w, h, fc, ec="none", lw=0.0, z=1):
        ax.add_patch(Rectangle((x, y), w, h, facecolor=fc, edgecolor=ec, linewidth=lw, zorder=z))

    def _text(self, ax, x, y, s, weight="regular", size=8, color=None, ha="left", va="center", z=5, **kw):
        ax.text(x, y, s, fontproperties=self.f(weight, size), color=color or self.t.text_color,
                ha=ha, va=va, zorder=z, **kw)

    def _hline(self, ax, x0, x1, y, color, lw, z=2):
        ax.plot([x0, x1], [y, y], color=color, linewidth=lw, zorder=z, solid_capstyle="butt")

    def _vline(self, ax, x, y0, y1, color, lw, z=2, ls="-"):
        ax.plot([x, x], [y0, y1], color=color, linewidth=lw, zorder=z, linestyle=ls, solid_capstyle="butt")

    # ---- page sections ----------------------------------------------------
    def _draw_header(self, ax):
        t, h = self.t, self.s.header
        top = self.header_top
        fields = [("Customer", h.customer), ("Project", h.project), ("Location", h.location), ("Size", h.size)]
        fields = [(k, v) for k, v in fields if v]
        lab_w = max(self.f.width(k, "bold", 11) for k, _ in fields)
        line_h = 0.21
        for i, (k, v) in enumerate(fields):
            y = top + 0.12 + i * line_h
            self._text(ax, self.left, y, k, "bold", 11, t.label_color)
            self._text(ax, self.left + lab_w + 0.08, y, ":", "bold", 11, t.label_color)
            self._text(ax, self.left + lab_w + 0.22, y, v, "semibold", 11, t.text_color)

        cx = (self.left + self.right) / 2
        self._text(ax, cx, top + 0.22, h.title, "bold", 18, t.title_color, ha="center")
        sub = h.project + (f"  |  Project ID: {h.project_id}" if h.project_id else "")
        self._text(ax, cx, top + 0.50, sub, "semibold", 10.5, t.text_color, ha="center")
        self._text(ax, cx, top + 0.72,
                   f"Schedule Date: {_fmt_date(h.schedule_date, t)}   |   Revision: {h.revision}",
                   "regular", 9, PALETTE["gray"], ha="center")

        if t.logo_path and Path(t.logo_path).exists():
            img = plt.imread(str(t.logo_path))
            lh = 0.78
            lw = lh * img.shape[1] / img.shape[0]
            ax.imshow(img, extent=(self.right - lw, self.right, top + lh, top), zorder=5,
                      interpolation="antialiased")
        rule_y = self.grid_top - 0.10
        self._hline(ax, self.left, self.right, rule_y, t.title_color, 1.6)

    def _draw_column_headers(self, ax):
        t = self.t
        y0, h = self.grid_top, self.colhead_h
        self._rect(ax, self.left, y0, t.table_width, h, t.column_header_fill, z=1)
        x = self.left
        for i, c in enumerate(t.columns):
            self._text(ax, x + c.width / 2, y0 + h / 2, c.header, "bold", 8.5, t.column_header_text,
                       ha="center", linespacing=1.05)
            if i:
                self._vline(ax, x, y0, y0 + h, PALETTE["white"], 0.6, z=3)
            x += c.width

    def _draw_timescale(self, ax):
        t, tl = self.t, self.timeline
        th = t.timescale_tier_height
        y_year, y_month, y_week = self.grid_top, self.grid_top + th, self.grid_top + 2 * th
        x0, x1 = tl.x0, tl.x1
        self._rect(ax, x0, y_year, x1 - x0, th, t.year_tier_fill)
        self._rect(ax, x0, y_month, x1 - x0, th, t.month_tier_fill)
        if t.show_week_tier:
            self._rect(ax, x0, y_week, x1 - x0, th, t.week_tier_fill)

        # Years
        y = tl.t0.year
        while date(y, 1, 1) < tl.t1:
            a, b = max(date(y, 1, 1), tl.t0), min(date(y + 1, 1, 1), tl.t1)
            xa, xb = tl.x(a), tl.x(b)
            if xb - xa > 0.35:
                self._text(ax, (xa + xb) / 2, y_year + th / 2, str(y), "bold", 8.5, PALETTE["white"], ha="center")
            if a > tl.t0:
                self._vline(ax, xa, y_year, y_year + th, PALETTE["white"], 1.0, z=3)
            y += 1

        # Months
        m = _month_start(tl.t0)
        while m < tl.t1:
            nm = _next_month(m)
            a, b = max(m, tl.t0), min(nm, tl.t1)
            xa, xb = tl.x(a), tl.x(b)
            name = calendar.month_abbr[m.month] if xb - xa > 0.32 else (calendar.month_abbr[m.month][0] if xb - xa > 0.12 else "")
            self._text(ax, (xa + xb) / 2, y_month + th / 2, name, "semibold", 8, t.text_color, ha="center")
            if a > tl.t0:
                self._vline(ax, xa, y_month, y_month + th, t.month_line_color, 0.8, z=3)
            m = nm

        # Weeks (P6 week tier labelled with the Monday's day number)
        if t.show_week_tier:
            d = tl.t0 + timedelta(days=(7 - tl.t0.weekday()) % 7)
            week_w = 7 / tl.days * (x1 - x0)
            while d < tl.t1:
                xa = tl.x(d)
                self._vline(ax, xa, y_week, y_week + th, t.month_line_color, 0.4, z=3)
                if week_w > 0.16 and tl.x(d + timedelta(days=7)) <= x1 + 1e-6:
                    self._text(ax, xa + week_w / 2, y_week + th / 2, f"{d.day:02d}", "regular", 6.5,
                               PALETTE["gray"], ha="center")
                d += timedelta(days=7)
        self._hline(ax, x0, x1, y_month, t.border_color, 0.4, z=3)
        if t.show_week_tier:
            self._hline(ax, x0, x1, y_week, t.month_line_color, 0.5, z=3)

    def _draw_gridlines(self, ax, n_rows):
        t, tl = self.t, self.timeline
        y0, y1 = self.body_top, self.body_top + n_rows * self.row_h
        d = tl.t0 + timedelta(days=(7 - tl.t0.weekday()) % 7)
        while d < tl.t1:  # week lines
            self._vline(ax, tl.x(d), y0, y1, t.week_line_color, 0.4, z=1.5)
            d += timedelta(days=7)
        m = _next_month(tl.t0)
        while m < tl.t1:  # month lines
            col = t.border_color if m.month == 1 else t.month_line_color
            self._vline(ax, tl.x(m), y0, y1, col, 0.6 if m.month != 1 else 0.8, z=1.6)
            m = _next_month(m)

    def _cell_values(self, row: Row) -> dict:
        it, t = row.item, self.t
        dur = self.s.duration_of(it)
        vals = {
            "activity_id": "" if row.is_wbs else it.activity_id,
            "name": it.name,
            "duration": f"{dur}{t.duration_suffix}",
            "start": _fmt_date(it.start, t),
            "finish": _fmt_date(it.finish, t),
            "total_float": "" if row.is_wbs or it.total_float is None else str(it.total_float),
        }
        if not row.is_wbs and it.is_milestone:  # P6 leaves the irrelevant date blank
            if it.milestone == "start":
                vals["finish"] = ""
            else:
                vals["start"] = ""
        return vals

    def _draw_row(self, ax, row: Row, i: int):
        t = self.t
        y = self.body_top + i * self.row_h
        yc = y + self.row_h / 2
        style = wbs_style(row.level) if row.is_wbs else ACTIVITY_ROW
        indent = t.indent_per_level * (row.level - 1)

        # Table side
        self._rect(ax, self.left, y, t.table_width, self.row_h, style.fill, z=1)
        self._rect(ax, self.chart_x0, y, self.chart_x1 - self.chart_x0, self.row_h, style.gantt_fill, z=1)
        vals = self._cell_values(row)
        x = self.left
        for c in t.columns:
            v = vals.get(c.key, "")
            if row.is_wbs and c.key == "activity_id":
                # P6 band: WBS name starts in the first column and spans ID + Name
                self._text(ax, x + 0.06 + indent, yc, row.item.name, style.weight, style.size,
                           style.font_color)
            elif row.is_wbs and c.key == "name":
                pass
            else:
                pad = 0.06 + (indent if c.key == "name" else 0)
                hx = {"left": x + pad, "center": x + c.width / 2, "right": x + c.width - 0.06}[c.align]
                weight = style.weight if row.is_wbs else "regular"
                size = min(style.size, 8.5) if row.is_wbs else 8
                self._text(ax, hx, yc, v, weight, size, style.font_color, ha=c.align)
            x += c.width
        if not row.is_wbs:  # column dividers on activity rows only (P6 bands run unbroken)
            x = self.left
            for c in t.columns[:-1]:
                x += c.width
                self._vline(ax, x, y, y + self.row_h, t.sight_line_color, 0.6, z=2.4)
        self._hline(ax, self.left, self.chart_x1, y + self.row_h, t.sight_line_color if not row.is_wbs
                    else PALETTE["white"], 0.5, z=2.5)

        # Gantt side
        tl = self.timeline
        if row.is_wbs:
            self._draw_summary_bar(ax, tl.x(row.item.start), tl.x(row.item.finish + timedelta(days=1)), y)
            lbl = self._label(row)
            if lbl:
                self._text(ax, tl.x(row.item.finish + timedelta(days=1)) + 0.10, yc, lbl, "semibold", 7.5,
                           t.bar_label_color)
            return
        a = row.item
        if a.is_milestone:
            d = a.start if a.milestone == "start" else a.finish + timedelta(days=1)
            mx = tl.x(d)
            self._draw_diamond(ax, mx, yc, BARS["milestone"].height_frac * self.row_h)
            self._text(ax, mx + 0.11, yc, a.name, "regular", 7.5, t.bar_label_color)
        else:
            bs = BARS["critical"] if (a.critical and t.show_critical) else BARS["planned"]
            xa, xb = tl.x(a.start), tl.x(a.finish + timedelta(days=1))
            bh = bs.height_frac * self.row_h
            self._rect(ax, xa, yc - bh / 2, max(xb - xa, 0.02), bh, bs.color, z=4)
            self._text(ax, xb + 0.06, yc, a.name, "regular", 7.5, t.bar_label_color)

    def _draw_summary_bar(self, ax, xa, xb, y):
        """P6 WBS summary: thin bar in the upper part of the row with down-pointing triangle ends."""
        bs = BARS["summary"]
        bh = bs.height_frac * self.row_h
        top = y + self.row_h * 0.30
        self._rect(ax, xa, top, xb - xa, bh, bs.color, z=4)
        tw, tht = 0.055, self.row_h * 0.32
        for x in (xa, xb):
            ax.add_patch(Polygon([(x - tw, top), (x + tw, top), (x, top + bh + tht)], closed=True,
                                 facecolor=bs.color, edgecolor="none", zorder=4))

    def _draw_diamond(self, ax, x, yc, size):
        bs = BARS["milestone"]
        r = size / 2
        ax.add_patch(Polygon([(x, yc - r), (x + r, yc), (x, yc + r), (x - r, yc)], closed=True,
                             facecolor=bs.color, edgecolor=bs.edge, linewidth=0.6, zorder=6))

    def _draw_frame(self, ax, n_rows):
        t = self.t
        y0, y1 = self.grid_top, self.body_top + n_rows * self.row_h
        ax.add_patch(Rectangle((self.left, y0), self.right - self.left, y1 - y0, fill=False,
                               edgecolor=t.border_color, linewidth=0.9, zorder=7))
        self._vline(ax, self.table_right, y0, y1, t.border_color, 1.1, z=7)

    def _draw_footer(self, ax, page_no, n_pages):
        t, h = self.t, self.s.header
        y0, fh = self.footer_top, t.footer_height
        # Legend box
        lw_box = 4.0
        self._rect(ax, self.left, y0, lw_box, fh, "none", t.border_color, 0.8, z=3)
        self._rect(ax, self.left, y0, lw_box, 0.22, t.column_header_fill, z=2)
        self._text(ax, self.left + 0.08, y0 + 0.11, "Legend", "bold", 8.5, PALETTE["white"])
        items = ["planned"] + (["critical"] if t.show_critical else []) + ["milestone", "summary"]
        for k, key in enumerate(items):
            col, rowi = k // 2, k % 2
            ix = self.left + 0.15 + col * 2.0
            iy = y0 + 0.45 + rowi * 0.32
            bs = BARS[key]
            if key == "milestone":
                self._draw_diamond(ax, ix + 0.25, iy, 0.16)
            elif key == "summary":
                ax.add_patch(Rectangle((ix, iy - 0.06), 0.5, 0.035, facecolor=bs.color, zorder=4))
                for x in (ix, ix + 0.5):
                    ax.add_patch(Polygon([(x - 0.045, iy - 0.06), (x + 0.045, iy - 0.06), (x, iy + 0.04)],
                                         facecolor=bs.color, edgecolor="none", zorder=4))
            else:
                self._rect(ax, ix, iy - 0.05, 0.5, 0.10, bs.color, z=4)
            self._text(ax, ix + 0.62, iy, bs.label, "regular", 8, t.text_color)

        # Notes box (centre)
        rev_w = 4.6
        nx0 = self.left + lw_box + 0.12
        nx1 = self.right - rev_w - 0.12
        self._rect(ax, nx0, y0, nx1 - nx0, fh, "none", t.border_color, 0.8, z=3)
        self._rect(ax, nx0, y0, nx1 - nx0, 0.22, t.column_header_fill, z=2)
        self._text(ax, nx0 + 0.08, y0 + 0.11, "Notes", "bold", 8.5, PALETTE["white"])
        import textwrap
        max_chars = int((nx1 - nx0 - 0.2) / (8 * PT * 0.48))
        self._text(ax, nx0 + 0.08, y0 + 0.38, t.disclaimer_title, "bold", 8.5, t.title_color)
        notes = [t.disclaimer, t.calendar_note] + ([self.s.critical_basis] if t.show_critical and self.s.critical_basis else [])
        lines = [ln for n in notes for ln in textwrap.wrap(n, max_chars)]
        for i, ln in enumerate(lines[:4]):
            self._text(ax, nx0 + 0.08, y0 + 0.54 + i * 0.13, ln, "regular", 7.5, t.text_color)
        self._text(ax, nx0 + 0.08, y0 + fh - 0.12,
                   f"Layout: {t.layout_name}   |   Printed: {_fmt_date(date.today(), t)}",
                   "regular", 7, PALETTE["gray"])
        self._text(ax, nx1 - 0.08, y0 + fh - 0.12, f"Page {page_no} of {n_pages}", "semibold", 8,
                   t.text_color, ha="right")

        # Revision block (right)
        rx0 = self.right - rev_w
        cols = [("Rev", 0.45), ("Date", 0.85), ("Description", 2.1), ("By", 0.6), ("Chk", 0.6)]
        self._rect(ax, rx0, y0, rev_w, fh, "none", t.border_color, 0.8, z=3)
        self._rect(ax, rx0, y0, rev_w, 0.22, t.column_header_fill, z=2)
        x = rx0
        for name, w in cols:
            self._text(ax, x + w / 2, y0 + 0.11, name, "bold", 8, PALETTE["white"], ha="center")
            x += w
        revs = list(h.revisions)[-4:]
        rh = (fh - 0.22) / 4
        for i in range(4):
            ry = y0 + 0.22 + i * rh
            self._hline(ax, rx0, rx0 + rev_w, ry + rh, PALETTE["light_gray"], 0.4, z=3)
            if i < len(revs):
                r = revs[i]
                x = rx0
                for (name, w), v in zip(cols, [r.rev, _fmt_date(r.date, t), r.description, r.by, r.checked]):
                    ha = "left" if name == "Description" else "center"
                    self._text(ax, x + (0.06 if ha == "left" else w / 2), ry + rh / 2, v, "regular", 7.5,
                               t.text_color, ha=ha)
                    x += w
        x = rx0
        for _, w in cols[:-1]:
            x += w
            self._vline(ax, x, y0 + 0.22, y0 + fh, PALETTE["light_gray"], 0.4, z=3)

    # ---- public -----------------------------------------------------------
    def _page_figure(self, page_rows, page_no, n_pages):
        fig = plt.figure(figsize=(self.W, self.H))
        ax = fig.add_axes([0, 0, 1, 1])
        ax.set_xlim(0, self.W)
        ax.set_ylim(self.H, 0)
        ax.axis("off")
        self._draw_header(ax)
        self._draw_column_headers(ax)
        self._draw_timescale(ax)
        self._draw_gridlines(ax, len(page_rows))
        for i, r in enumerate(page_rows):
            self._draw_row(ax, r, i)
        self._draw_frame(ax, len(page_rows))
        self._draw_footer(ax, page_no, n_pages)
        return fig

    def render(self, out_path) -> Path:
        out = Path(out_path)
        n = len(self.pages)
        if out.suffix.lower() == ".pdf":
            with PdfPages(out, metadata={"Title": f"{self.s.header.title} - {self.s.header.project}",
                                         "Author": "Castillo Engineering"}) as pdf:
                for i, rows in enumerate(self.pages, 1):
                    fig = self._page_figure(rows, i, n)
                    pdf.savefig(fig)
                    plt.close(fig)
        else:
            fig = self._page_figure(self.pages[0], 1, n)
            fig.savefig(out, dpi=150)
            plt.close(fig)
        return out


def render_schedule(schedule: Schedule, out_path, theme: Theme = DEFAULT_THEME) -> Path:
    """Render a Castillo P6-style schedule to PDF (all pages) or PNG (page 1)."""
    return ScheduleRenderer(schedule, theme).render(out_path)
