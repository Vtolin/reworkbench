"""
HTML + PDF report export for whole-document summaries.

Only produced when explicitly requested ('summarize: X html' / ' pdf'), so
the default terminal output stays clean. Both formats share the same
markdown -> HTML step via the `markdown` package; the PDF path renders
that HTML with xhtml2pdf (pure Python, no external binaries).

Math: the narrative summaries are already plain-text math (no LaTeX), so
the PDF needs no JS renderer. A Unicode-capable TTF (Arial on Windows,
DejaVu elsewhere) is registered so the cleanup pass's symbols (+-, ~=,
<=, >=, Greek letters) render; if no usable TTF is found, those symbols
are folded to ASCII as a last resort. MathJax remains in the HTML version
(CDN) purely as insurance for LaTeX surviving in the verbatim appendix.
"""
import os
import re
from datetime import datetime
from html import escape

import markdown

from config import SUMMARY_EXPORT_DIR

_HTML_HEAD = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<script>
window.MathJax = { tex: { inlineMath: [['$', '$'], ['\\(', '\\)']] } };
</script>
<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js" async></script>
<style>
body { font-family: Georgia, 'Times New Roman', serif; max-width: 900px; margin: 2.5rem auto; padding: 0 1.2rem; line-height: 1.6; color: #1a1a1a; }
h1 { border-bottom: 2px solid #333; padding-bottom: .35rem; }
h2 { border-bottom: 1px solid #bbb; padding-bottom: .2rem; margin-top: 2rem; }
h3 { margin-top: 1.6rem; }
table { border-collapse: collapse; margin: 1rem 0; font-size: .9em; }
th, td { border: 1px solid #999; padding: .3rem .6rem; text-align: left; }
th { background: #f0f0f0; }
code { background: #f4f4f4; padding: .1rem .3rem; border-radius: 3px; font-size: .9em; }
.meta { color: #555; font-size: .95em; }
hr { border: none; border-top: 1px solid #ddd; margin: 2rem 0; }
</style>
</head>
<body>
"""

_HTML_FOOT = """
</body>
</html>
"""

# Last-resort symbol folding when no Unicode-capable TTF can be registered.
_ASCII_FOLD = {
    "\u00b1": "+/-", "\u2248": "~", "\u2264": "<=", "\u2265": ">=",
    "\u2260": "!=", "\u00d7": "x", "\u00b7": ".", "\u0394": "Delta",
    "\u03b1": "alpha", "\u03b2": "beta", "\u03b3": "gamma",
    "\u03b4": "delta", "\u03b5": "epsilon", "\u03bc": "mu",
    "\u03c3": "sigma", "\u03b8": "theta", "\u03c0": "pi", "\u03bb": "lambda",
}

_FONT_CANDIDATES = [
    ("Arial", r"C:\Windows\Fonts\arial.ttf"),
    ("Georgia", r"C:\Windows\Fonts\georgia.ttf"),
    ("DejaVuSans", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ("DejaVuSerif", "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"),
]


def _safe_base(display_name):
    base = os.path.splitext(os.path.basename(display_name))[0]
    base = re.sub(r"[^\w\-]+", "_", base).strip("_")
    return base or "summary"


def _meta_line(stats):
    return (
        f"*Method: {stats.get('method')} | Document type: {stats.get('doc_type', 'unknown')} "
        f"| Pages: {stats.get('page_count')} | Chunks: {stats.get('chunk_count')} "
        f"| Tables: {stats.get('table_count', 0)} | Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}*"
    )


def _render_body(display_name, summary, stats):
    """Shared markdown -> HTML step for both export formats. display_name
    is escaped before it reaches the HTML (markdown passes raw HTML
    through, so an unescaped filename could inject into the report)."""
    markdown_text = f"# Summary: {escape(display_name)}\n\n{_meta_line(stats)}\n\n{summary}"
    return markdown.markdown(markdown_text, extensions=["tables"])


def _ensure_export_dir():
    try:
        os.makedirs(SUMMARY_EXPORT_DIR, exist_ok=True)
        return True
    except OSError:
        return False


def _register_pdf_font():
    """Register a Unicode-capable TTF for the PDF render. Returns the
    registered font family name, or None (caller folds symbols to ASCII)."""
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    for name, path in _FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                pdfmetrics.registerFont(TTFont(name, path))
                return name
            except Exception:
                continue
    return None


def _fold_to_ascii(text):
    for symbol, repl in _ASCII_FOLD.items():
        text = text.replace(symbol, repl)
    return text.encode("ascii", errors="replace").decode("ascii")


def export_summary_html(display_name, summary, stats):
    """Render `summary` to SUMMARY_EXPORT_DIR/<doc>_summary.html. Returns
    the written path, or None if the file couldn't be written."""
    if not summary or not _ensure_export_dir():
        return None

    path = os.path.join(SUMMARY_EXPORT_DIR, f"{_safe_base(display_name)}_summary.html")
    title = f"Summary: {escape(display_name)}"
    try:
        body = _render_body(display_name, summary, stats)
    except Exception:
        return None

    html = _HTML_HEAD.replace("{title}", title) + body + _HTML_FOOT
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(html)
    except OSError:
        return None
    return path


def export_summary_pdf(display_name, summary, stats):
    """Render `summary` to SUMMARY_EXPORT_DIR/<doc>_summary.pdf via
    xhtml2pdf. Returns the written path, or None on failure."""
    if not summary or not _ensure_export_dir():
        return None

    try:
        body = _render_body(display_name, summary, stats)
    except Exception:
        return None

    font_family = _register_pdf_font()
    if font_family:
        font_css = f"body, h1, h2, h3, th, td {{ font-family: {font_family}; }}"
    else:
        font_css = ""
        body = _fold_to_ascii(body)

    title = f"Summary: {escape(display_name)}"
    html = (
        _HTML_HEAD.replace("{title}", title).replace(
            "</style>",
            font_css + "\n@page { size: A4; margin: 2cm; }\n</style>",
        )
        + body
        + _HTML_FOOT
    )

    path = os.path.join(SUMMARY_EXPORT_DIR, f"{_safe_base(display_name)}_summary.pdf")
    try:
        from xhtml2pdf import pisa

        with open(path, "wb") as f:
            result = pisa.CreatePDF(html, dest=f)
        if result.err or not os.path.exists(path) or os.path.getsize(path) < 500:
            return None
    except Exception:
        return None
    return path
