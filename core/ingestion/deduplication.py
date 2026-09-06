"""
Duplicate detection priority:
 SHA-256 file hash -> DOI -> normalized title -> author/year -> fuzzy title similarity
No LLM needed.
"""
import re
import difflib
from pathlib import Path

def normalize_title(title: str) -> str:
    if not title:
        return ""
    t = title.lower().strip()
    t = re.sub(r"\s+", " ", t)
    t = re.sub(r"[^\w\s]", "", t)
    return t.strip()

def normalize_authors(authors: list[str]) -> str:
    if not authors:
        return ""
    return "|".join(sorted(a.lower().strip() for a in authors if a.strip()))

DOI_RE = re.compile(r"10\.\d{4,9}/[-._;()/:A-Z0-9]+", re.I)

def extract_doi(text: str | None) -> str | None:
    if not text:
        return None
    m = DOI_RE.search(text)
    return m.group(0).lower() if m else None

def check_duplicates(proposed: dict, existing_docs: list[dict]) -> list[dict]:
    """
    proposed: {file_hash, doi, title, authors, year}
    existing_docs: list of doc dicts from DB (with file_hash, doi, title, authors, year)
    Returns list of {document, reason, confidence} sorted by priority.
    """
    results = []
    ph = (proposed.get("file_hash") or "").lower()
    pdoi = (proposed.get("doi") or "").lower().strip()
    ptitle_norm = normalize_title(proposed.get("title") or "")
    pauth_norm = normalize_authors(proposed.get("authors") or [])
    pyear = proposed.get("year")

    for doc in existing_docs:
        eh = (doc.get("file_hash") or "").lower()
        edoi = (doc.get("doi") or "").lower().strip() if doc.get("doi") else ""
        etitle_norm = normalize_title(doc.get("title") or "")
        eauth_norm = normalize_authors(doc.get("authors") or [])
        eyear = doc.get("year")

        # 1. SHA-256 exact
        if ph and eh and ph == eh:
            results.append({"document": doc, "reason": "hash", "confidence": 1.0, "label": "Identical file (SHA-256 match)"})
            continue
        # 2. DOI exact
        if pdoi and edoi and pdoi == edoi:
            results.append({"document": doc, "reason": "doi", "confidence": 0.98, "label": "Same DOI"})
            continue
        # 3. Normalized title exact
        if ptitle_norm and etitle_norm and ptitle_norm == etitle_norm:
            results.append({"document": doc, "reason": "title_exact", "confidence": 0.92, "label": "Identical title"})
            continue
        # 4. Author + year
        if pauth_norm and eauth_norm and pyear and eyear and pauth_norm == eauth_norm and str(pyear) == str(eyear):
            # also require title fuzzy >0.6 to avoid false positives from common names?
            # spec says author/year as separate signal, so keep it.
            results.append({"document": doc, "reason": "author_year", "confidence": 0.78, "label": "Same authors & year"})
            continue
        # 5. Fuzzy title similarity >0.85
        if ptitle_norm and etitle_norm and len(ptitle_norm) > 10 and len(etitle_norm) > 10:
            ratio = difflib.SequenceMatcher(None, ptitle_norm, etitle_norm).ratio()
            if ratio >= 0.85:
                results.append({"document": doc, "reason": "title_fuzzy", "confidence": round(ratio, 2), "label": f"Similar title ({int(ratio*100)}% match)"})

    # sort by confidence descending
    results.sort(key=lambda x: x["confidence"], reverse=True)
    return results


def title_fuzzy_score(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, normalize_title(a), normalize_title(b)).ratio()
