"""WCAG contrast audit of the PMO 360 theme tokens, light and dark.

Run from anywhere:  python frontend/scripts/contrast_audit.py
Exit 0 == every checked pair clears its threshold.

Parses the real `:root` / `.dark` blocks out of styles/index.css so this
checks what actually ships, not a copy of the palette.

AA needs 4.5:1 for body text, 3.0:1 for large text (>=18.66px bold / 24px)
and for UI component boundaries.
"""
import re
import sys

CSS = r"D:\code\pmo360-modern\frontend\src\styles\index.css"


def parse_block(css: str, selector: str) -> dict[str, tuple[int, int, int]]:
    m = re.search(re.escape(selector) + r"\s*\{(.*?)\n\}", css, re.S)
    assert m, f"could not find {selector} block"
    out = {}
    for name, val in re.findall(r"--([\w-]+):\s*([0-9]+ [0-9]+ [0-9]+)\s*;", m.group(1)):
        r, g, b = (int(x) for x in val.split())
        out[name] = (r, g, b)
    return out


def lum(rgb):
    def ch(c):
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(x) for x in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(fg, bg):
    a, b = lum(fg), lum(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


WHITE = (255, 255, 255)

# (foreground, background, minimum, label)
PAIRS = [
    ("brand-black", "surface-page", 4.5, "body text on page"),
    ("brand-black", "surface-card", 4.5, "body text on card"),
    ("brand-gray", "surface-card", 4.5, "secondary text on card"),
    ("brand-gray", "surface-page", 4.5, "secondary text on page"),
    ("brand-gray", "surface-rowhover", 4.5, "secondary text on hovered row"),
    ("brand-lightgray", "surface-card", 3.0, "micro-label on card (large/decorative)"),
    ("brand-red-on", "surface-card", 4.5, "red text/link on card"),
    ("brand-red-on", "surface-page", 4.5, "red text on page"),
    ("brand-deepgold", "surface-card", 4.5, "gold text on card"),
    ("brand-deepblue", "surface-card", 4.5, "blue text on card"),
    ("brand-green-on", "surface-card", 4.5, "green text on card"),
    ("brand-brightred-on", "surface-card", 4.5, "destructive text on card"),
    ("status-open-text", "status-open-bg", 4.5, "Open pill"),
    ("status-pending-text", "status-pending-bg", 4.5, "Pending pill"),
    ("status-completed-text", "status-completed-bg", 4.5, "Completed pill"),
    ("status-cancelled-text", "status-cancelled-bg", 4.5, "Cancelled pill"),
    ("surface-border", "surface-card", 1.2, "card border vs card (visible edge)"),
    ("surface-border", "surface-page", 1.10, "card border vs page"),
    ("surface-hairline", "surface-card", 1.08, "in-card divider"),
]

# White text sitting on a solid brand fill (primary buttons, badges, bars).
ON_FILL = [
    ("brand-red", 4.5, "white on primary button"),
    ("brand-darkred", 4.5, "white on primary button (hover)"),
    ("brand-green", 4.5, "white on green fill"),
    ("brand-brightred", 4.5, "white on alert fill"),
]


def audit(theme_name, tok):
    print(f"\n{'=' * 66}\n{theme_name}\n{'=' * 66}")
    fails = []
    for fg, bg, minimum, label in PAIRS:
        if fg not in tok or bg not in tok:
            print(f"  ?? missing token: {fg} / {bg}")
            continue
        r = ratio(tok[fg], tok[bg])
        ok = r >= minimum
        if not ok:
            fails.append((label, r, minimum))
        print(f"  {'ok  ' if ok else 'FAIL'} {r:5.2f}:1  (min {minimum:>4})  {label}")
    for fill, minimum, label in ON_FILL:
        r = ratio(WHITE, tok[fill])
        ok = r >= minimum
        if not ok:
            fails.append((label, r, minimum))
        print(f"  {'ok  ' if ok else 'FAIL'} {r:5.2f}:1  (min {minimum:>4})  {label}")
    return fails


def main():
    css = open(CSS, encoding="utf-8").read()
    light = parse_block(css, ":root")
    dark = parse_block(css, ".dark")
    print(f"parsed {len(light)} light tokens, {len(dark)} dark tokens")

    lf = audit("LIGHT", light)
    df = audit("DARK", {**light, **dark})  # dark inherits any token it doesn't override

    print(f"\n{'=' * 66}")
    if not lf and not df:
        print("PASS — every checked pair meets its WCAG threshold in both themes")
        return 0
    for theme, fails in (("LIGHT", lf), ("DARK", df)):
        for label, r, minimum in fails:
            print(f"  {theme}: {label} = {r:.2f}:1, needs {minimum}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
