"""
Layout-based section heading detection.

PDFs don't carry a "this is a heading" flag - PyPDFLoader (used in the
original pipeline) just gives back a flat text blob per page with no
structural information. This module uses PyMuPDF (fitz) instead, which
exposes each line's font size and bold/italic flags, and applies a
heuristic: headings are lines that are meaningfully larger and/or bolder
than the document's own body text, are short, and don't end like a
sentence.

This is heuristic, not perfect - a PDF with unconventional styling (e.g.
headings in the same size as body text, distinguished only by color) will
under-detect. It degrades gracefully in that case: chunks just fall back to
an empty section label, exactly like before this feature existed.
"""
import re
from collections import Counter
from dataclasses import dataclass

import pymupdf as fitz  # `fitz` is the old import name; PyMuPDF now ships
                         # it as `pymupdf` and warns on the old name, but
                         # the API is identical, so aliasing it back to
                         # `fitz` avoids renaming every call in this file

# Silence PyMuPDF's one-time "consider pymupdf_layout" marketing print -
# it leaks into server logs on first PDF touch and users read it as our
# log line. Our column-reorder (_reorder_page_blocks) already covers layout.
try:
    fitz.no_recommend_layout()
except AttributeError:
    pass

from config import TABLE_MAX_ROWS_PER_TABLE, TABLE_MAX_TOTAL_ROWS

# PyMuPDF span flag bit for bold (see mupdf's text_flags: bit 4 = bold).
_BOLD_FLAG = 1 << 4

# A heading candidate must be at least this many x larger than body text,
# UNLESS it's also bold (bold headings can be the same size as body text).
_SIZE_RATIO_FOR_PLAIN = 1.15

# Headings are short lines, not paragraphs. A line longer than this is
# almost certainly body text even if it happens to be bold/large (e.g. a
# bolded key term at the start of a sentence).
_MAX_HEADING_WORDS = 14

# Lines ending in these are essentially never headings - they read like
# sentences, not titles.
_SENTENCE_ENDINGS = (".", ",", ";", ":")

# Common numbered/lettered heading prefixes: "1.", "1.2", "IV.", "A.", "Chapter 3"
_HEADING_PREFIX_RE = re.compile(
    r"^\s*(chapter\s+\d+|appendix\s+[a-z]|\d+(\.\d+)*\.?|[ivxlc]+\.|[a-z]\))\s+",
    re.IGNORECASE,
)


@dataclass
class Line:
    text: str
    size: float
    bold: bool
    page: int  # 0-indexed


def _extract_lines(pdf_path):
    """Flatten a PDF into an ordered list of Lines with font metadata,
    reading-order preserved. PyMuPDF's block/line order follows the page's
    content-stream order - correct for single-column documents, but a
    two-column journal page emits left and right column lines interleaved.
    _reorder_page_blocks re-sorts multi-column pages column-by-column
    before lines are flattened, so the text fed to heading detection and
    chunking reads column 1 top-to-bottom, then column 2 - not a zig-zag
    of alternating left/right lines."""
    lines = []
    doc = None
    try:
        doc = fitz.open(pdf_path)
        for page_num, page in enumerate(doc):
            page_dict = page.get_text("dict")
            blocks = _reorder_page_blocks(
                [b for b in page_dict.get("blocks", []) if b.get("type") == 0 and b.get("lines")],
                page.rect.width,
            )
            for block in blocks:
                for line in block.get("lines", []):
                    spans = line.get("spans", [])
                    if not spans:
                        continue
                    text = "".join(s["text"] for s in spans).strip()
                    if not text:
                        continue
                    size = max(s["size"] for s in spans)
                    bold = any(
                        (s["flags"] & _BOLD_FLAG) or "bold" in s.get("font", "").lower()
                        for s in spans
                    )
                    lines.append(Line(text=text, size=round(size, 1), bold=bold, page=page_num))
    finally:
        if doc is not None:
            doc.close()
    return lines


# =====================================================================
# MULTI-COLUMN BLOCK REORDERING
# =====================================================================
# How far (points) one block's left edge may intrude into a column band's
# x-range before it still counts as the same column - small overlaps come
# from indentation/kerning, not a second column.
_COLUMN_X_TOLERANCE = 12.0

# A block wider than this fraction of the page spans columns (headers,
# figures, full-width tables) and is placed by its vertical position
# instead of being assigned to one column.
_WIDE_BLOCK_RATIO = 0.75


def _reorder_page_blocks(blocks, page_width):
    """Return `blocks` in reading order. Single-column pages (or pages
    with fewer than two narrow blocks) come back unchanged, so existing
    behavior is untouched where there's nothing to fix. Multi-column
    pages get column-major ordering: left column top-to-bottom, then
    right column top-to-bottom, with full-width blocks interleaved at
    their vertical position."""
    if len(blocks) < 2 or page_width <= 0:
        return blocks

    def width(b):
        x0, _, x1, _ = b["bbox"]
        return x1 - x0

    narrow = [b for b in blocks if width(b) <= _WIDE_BLOCK_RATIO * page_width]
    if len(narrow) < 2:
        return blocks

    # Greedy column bands: sort by left edge; a block starts a new band
    # only if it begins clearly to the right of the current band's extent.
    narrow_sorted = sorted(narrow, key=lambda b: b["bbox"][0])
    bands = []  # each band: [x_min, x_max]
    for b in narrow_sorted:
        x0, _, x1, _ = b["bbox"]
        for band in bands:
            if x0 <= band[1] + _COLUMN_X_TOLERANCE:
                band[1] = max(band[1], x1)
                break
        else:
            bands.append([x0, x1])

    if len(bands) < 2:
        return blocks  # single column after all

    def band_of(b):
        x0 = b["bbox"][0]
        for i, band in enumerate(bands):
            if x0 <= band[1] + _COLUMN_X_TOLERANCE:
                return i
        return 0

    wide = [b for b in blocks if width(b) > _WIDE_BLOCK_RATIO * page_width]
    wide_sorted = sorted(wide, key=lambda b: b["bbox"][1])
    ordered = sorted(
        (b for b in blocks if b not in wide),
        key=lambda b: (band_of(b), b["bbox"][1]),
    )

    result = []
    wi = 0
    for b in ordered:
        while wi < len(wide_sorted) and wide_sorted[wi]["bbox"][1] <= b["bbox"][1]:
            result.append(wide_sorted[wi])
            wi += 1
        result.append(b)
    result.extend(wide_sorted[wi:])
    return result


def _body_font_size(lines):
    """The document's dominant font size, weighted by character count so a
    handful of large headings don't skew the baseline. Falls back to 11pt
    (a common default) if the PDF has no extractable text at all."""
    counts = Counter()
    for ln in lines:
        counts[ln.size] += len(ln.text)
    return counts.most_common(1)[0][0] if counts else 11.0


def _looks_like_heading(line, body_size):
    words = line.text.split()
    if not words or len(words) > _MAX_HEADING_WORDS:
        return False
    if line.text.rstrip().endswith(_SENTENCE_ENDINGS) and not line.text.rstrip().endswith(":"):
        # Trailing ':' is fine ("Results:") - it's the sentence-style
        # punctuation (. , ;) that rules a line out.
        return False

    has_numbering = bool(_HEADING_PREFIX_RE.match(line.text))
    big_enough = line.size >= body_size * _SIZE_RATIO_FOR_PLAIN
    bold_and_not_smaller = line.bold and line.size >= body_size

    return big_enough or bold_and_not_smaller or (has_numbering and (line.bold or big_enough))


def detect_sections(pdf_path):
    """
    Returns a list of (page_num, section_title) marking every detected
    heading in reading order, e.g. [(0, "1. Introduction"), (1, "2.1 Data
    Collection"), (1, "3. Results"), ...]. Empty list if nothing looked
    like a heading (caller should treat every chunk as having no section).
    """
    lines = _extract_lines(pdf_path)
    if not lines:
        return []
    body_size = _body_font_size(lines)
    return [(ln.page, ln.text) for ln in lines if _looks_like_heading(ln, body_size)]


def build_page_texts_with_sections(pdf_path):
    """
    Re-walks the PDF and returns, per page, a list of (section_title, text)
    segments - text is everything on that page belonging to that section
    (section_title == "" for any text before the first heading on the
    page, which inherits the last section carried over from a prior page).

    Returns: {page_num: [(section_title, text), ...]}
    """
    lines = _extract_lines(pdf_path)
    if not lines:
        return {}

    body_size = _body_font_size(lines)
    pages = {}
    current_section = ""
    current_page = None
    buffer = []
    has_body_since_heading = False

    def flush():
        if current_page is not None and buffer:
            pages.setdefault(current_page, []).append((current_section, "\n".join(buffer)))

    for ln in lines:
        if current_page is None:
            current_page = ln.page
        if ln.page != current_page:
            flush()
            buffer.clear()
            current_page = ln.page
            # has_body_since_heading intentionally NOT reset here - a
            # section that started on the previous page and is still
            # accumulating body text on this one shouldn't be treated as
            # "heading-only" just because the page turned.

        if _looks_like_heading(ln, body_size):
            if has_body_since_heading or not buffer:
                # Real content under the current section, or nothing
                # buffered yet (first heading in the doc) - close it out.
                flush()
            # else: previous buffer was only an unbroken run of headings
            # (e.g. a title immediately followed by "1. Introduction")
            # with no body text yet - drop it rather than emit a
            # near-empty section, and let the more specific heading win.
            buffer.clear()
            current_section = ln.text.strip()
            buffer.append(ln.text)
            has_body_since_heading = False
        else:
            buffer.append(ln.text)
            has_body_since_heading = True

    flush()
    return pages


# =====================================================================
# PDF TABLE EXTRACTION
# =====================================================================
def extract_pdf_tables(pdf_path, max_rows_per_table=None, max_total_rows=None):
    """Pull structured tables out of a PDF using PyMuPDF's built-in
    find_tables() (no Java/ghostscript dependency, unlike tabula/camelot).

    Returns a list of {"page": 0-indexed, "rows": [[cell, ...], ...]} in
    reading order. Rows/cells that are None/empty are filtered, and both
    per-table and whole-document caps (config) keep a pathological PDF
    from producing an unbounded appendix.

    Best-effort by design: find_tables() works on ruled/grid-aligned text
    and misses borderless or image-based tables. Callers treat the result
    as supplementary verbatim data, never as a replacement for the
    deterministic regex extraction.
    """
    max_rows_per_table = max_rows_per_table or TABLE_MAX_ROWS_PER_TABLE
    max_total_rows = max_total_rows or TABLE_MAX_TOTAL_ROWS

    doc = None
    tables = []
    total_rows = 0
    try:
        doc = fitz.open(pdf_path)
        for page_num, page in enumerate(doc):
            try:
                found = page.find_tables()
            except Exception:
                continue
            for table in found.tables:
                try:
                    data = table.extract()
                except Exception:
                    continue
                rows = []
                for row in data:
                    cells = [str(c).strip() if c is not None else "" for c in row]
                    if any(cells):
                        rows.append(cells)
                if len(rows) < 2 or len(rows[0]) < 2:
                    continue  # not really a table (one column / header only)
                rows = rows[:max_rows_per_table]
                tables.append({"page": page_num, "rows": rows})
                total_rows += len(rows)
                if total_rows >= max_total_rows:
                    break
            if total_rows >= max_total_rows:
                break
    finally:
        if doc is not None:
            doc.close()
    return tables
