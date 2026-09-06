"""
Publication-year extraction (best-effort metadata for filtering).

Sequential filenames like journal4.pdf don't encode publication year, but
a document's front matter usually does - a copyright line, a
"Received/Accepted" date, a DOI stamp, volume/issue info. This scans the
first couple of pages for 4-digit years in a plausible range and scores
each occurrence by proximity to keywords that typically accompany a real
publication date, so a copyright-line year outranks an arbitrary year
mentioned in body text or buried in a references list.

Works on PDFs (via PyMuPDF) and on every other supported format: callers
that already extracted the front text (ingestion does, for non-PDF files)
pass it as first_page_text and skip the PDF layer entirely.

Best-effort, not bibliographic metadata extraction - it can pick the wrong
year on documents with unusual front matter, or find nothing at all
(returns None). Callers treat None as "year unknown" and just skip
year-based filtering for that document - the same graceful-degradation
pattern as heading_detection.py's empty section label.
"""
import re

import pymupdf as fitz  # `fitz` is the old import name; PyMuPDF now ships
                         # it as `pymupdf` and warns on the old name, but
                         # the API is identical, so aliasing it back to
                         # `fitz` avoids renaming every call in this file

YEAR_TOKEN_RE = re.compile(r"^(19|20)\d{2}$")
_YEAR_RE = re.compile(r"\b(19[0-9]{2}|20[0-9]{2})\b")

# Keywords whose nearby years are far more likely to be an actual
# publication date than an arbitrary year mentioned in running text or a
# reference-list entry.
_STRONG_SIGNALS = ("copyright", "©", "published", "publication date")
_MEDIUM_SIGNALS = ("received", "accepted", "doi", "issn", "issue", "volume")

_PAGES_TO_SCAN = 2
_PROXIMITY_WINDOW = 60  # chars on each side of a year to look for a signal word


def extract_year(path, first_page_text=None):
    """Best-effort publication year for one document, or None if nothing
    plausible was found (empty document, no 4-digit years on the scanned
    pages, or a file that fails to open). If first_page_text is given
    (non-PDF formats already have their text extracted upstream), the
    PDF-opening step is skipped entirely."""
    text = first_page_text
    if text is None:
        doc = None
        try:
            doc = fitz.open(path)
            text = ""
            for page in doc[:_PAGES_TO_SCAN]:
                text += page.get_text() + "\n"
        except Exception:
            return None
        finally:
            if doc is not None:
                try:
                    doc.close()
                except Exception:
                    pass
    return _extract_year_from_text(text)


def _extract_year_from_text(text):
    if not text or not isinstance(text, str):
        return None
    text_lower = text.lower()
    candidates = []  # (score, position, year) - lower position = earlier on the page

    for m in _YEAR_RE.finditer(text):
        year = int(m.group(0))
        # Deliberately NO "future year" ceiling: if the document really
        # says 2027, that's a date like any other - models have training
        # cutoffs, humans don't. The regex itself already bounds matches
        # to 19xx/20xx, which is enough sanity for the filtering use case.
        if year < 1900:
            continue
        window = text_lower[max(0, m.start() - _PROXIMITY_WINDOW): m.start() + _PROXIMITY_WINDOW]
        if any(sig in window for sig in _STRONG_SIGNALS):
            score = 2
        elif any(sig in window for sig in _MEDIUM_SIGNALS):
            score = 1
        else:
            score = 0
        candidates.append((score, m.start(), year))

    if not candidates:
        return None

    best_score = max(c[0] for c in candidates)
    top = sorted((c for c in candidates if c[0] == best_score), key=lambda c: c[1])
    return top[0][2]
