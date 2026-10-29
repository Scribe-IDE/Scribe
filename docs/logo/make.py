#!/usr/bin/env python3
"""Builds docs/logo-dark.svg and docs/logo-light.svg: the app icon beside the name and tagline.

The words are typeset by TeX in Computer Modern and turned into outlines by dvisvgm, so the
SVGs need no fonts. Needs TeX Live (latex, dvisvgm).

    python3 docs/logo/make.py
"""
import re
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
DOCS = HERE.parent
ICON = DOCS.parent / "src-tauri" / "icons" / "icon.svg"

THEMES = {
    "dark": {"name": "ECE8DF", "tagline": "9B968C"},
    "light": {"name": "1A1917", "tagline": "6E6A62"},
}

TILE = 104      # the icon's rounded square, in px
GAP = 26        # between the tile and the words

WORDS = r"""\documentclass[border=0pt]{standalone}
\usepackage{fix-cm}
\usepackage[T1]{fontenc}
\usepackage{xcolor}
\begin{document}
\begin{tabular}{@{}l@{}}
{\color[HTML]{%(name)s}\fontsize{76}{76}\selectfont scribe}\\[10pt]
{\color[HTML]{%(tagline)s}\fontsize{16.5}{20}\selectfont the \LaTeX\ editor for working scientists}
\end{tabular}
\end{document}
"""


def words(colors: dict) -> tuple[list[float], str]:
    """The typeset words as SVG: their viewBox and the markup inside the <svg>."""
    with tempfile.TemporaryDirectory() as tmp:
        tex = Path(tmp) / "words.tex"
        tex.write_text(WORDS % colors)
        subprocess.run(["latex", "-interaction=nonstopmode", "-halt-on-error", tex.name], cwd=tmp, check=True, capture_output=True)
        subprocess.run(["dvisvgm", "--no-fonts", "--exact-bbox", "-o", "words.svg", "words.dvi"], cwd=tmp, check=True, capture_output=True)
        svg = (Path(tmp) / "words.svg").read_text()
    box = [float(v) for v in re.search(r"viewBox='([^']+)'", svg).group(1).split()]
    inner = re.search(r"<svg[^>]*>(.*)</svg>", svg, re.S).group(1)
    inner = re.sub(r"<!--.*?-->", "", inner, flags=re.S).strip()
    return box, inner


def icon() -> str:
    """The app icon's shapes, scaled so its rounded square is TILE px wide at the origin."""
    svg = ICON.read_text()
    inner = re.search(r"<svg[^>]*>(.*)</svg>", svg, re.S).group(1).strip()
    scale = TILE / 824  # the square spans 100..924 of the icon's 1024
    return f'<g transform="scale({scale:.6f}) translate(-100 -100)">{inner}</g>'


def build(theme: str) -> str:
    (x, y, w, h), inner = words(THEMES[theme])
    # the words sit beside the tile, centred on it, a touch low as a baseline would have them
    height = max(TILE, h)
    dy = (height - h) / 2 + 4
    width = TILE + GAP + w
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'width="{width:.1f}" height="{height + 8:.1f}" viewBox="0 0 {width:.2f} {height + 8:.2f}" '
        f'role="img" aria-label="Scribe: the LaTeX editor for working scientists">\n'
        f'<g transform="translate(0 {(height + 8 - TILE) / 2:.2f})">{icon()}</g>\n'
        f'<g transform="translate({TILE + GAP - x:.2f} {dy - y:.2f})">{inner}</g>\n'
        f"</svg>\n"
    )


if __name__ == "__main__":
    for theme in THEMES:
        out = DOCS / f"logo-{theme}.svg"
        out.write_text(build(theme))
        print(f"wrote {out.relative_to(DOCS.parent)}")
