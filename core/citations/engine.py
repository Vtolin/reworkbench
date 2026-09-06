"""
CSL citation engine (Phase 2 P0) - backend rendering via citeproc-py.

One shared engine for the web UI, CLI and PDF/HTML reports: citation
rendering lives here, not duplicated per client. Styles are vendored in
core/citations/styles/ (downloaded from the official CSL repository at
github.com/citation-style-language/styles); any other style from that
repository can be fetched on demand and cached, and users can add their
own CSL XML via Settings ("Add CSL style").

The engine renders BIBLIOGRAPHY entries from CSL-JSON. In-text pinpoint
locators (chunk-level "page 3, ¶ 42" citations) stay in
research_trail.format_citation's "plain" style - CSL has no locator
concept for that use.

CSL-JSON item shape produced by doc_to_csl_item():
    id, type, title, author[{family,given}], issued{date-parts},
    container-title, volume, issue, page, publisher, DOI, abstract
"""
import os
import re
import threading

from citeproc import CitationStylesStyle, CitationStylesBibliography, Citation, CitationItem
from citeproc import formatter
from citeproc.source.json import CiteProcJSON

import httpx

STYLES_DIR = os.path.join(os.path.dirname(__file__), "styles")
CUSTOM_STYLE_PATH = os.path.join(STYLES_DIR, "custom-user.csl")
CSL_REPO_RAW = "https://raw.githubusercontent.com/citation-style-language/styles/master/{name}.csl"
DEFAULT_STYLE = "apa"

# The styles that ship with the app (vendored from the CSL repository).
# This is a curated set - the app supports the CSL ecosystem via the
# fetch-by-name / add-your-own mechanisms, not a full catalogue claim.
_KNOWN_STYLES = ("apa", "chicago-author-date", "modern-language-association",
                 "oscola", "bluebook-law-review", "harvard-cite-them-right",
                 "australian-guide-to-legal-citation")

_LOCALE = "en-US"

_SOURCE_TYPE_TO_CSL = {
    "journal": "article-journal",
    "article": "article-journal",
    "empirical": "article-journal",
    "survey": "article-journal",
    "general": "article-journal",
    "legal": "legal_case",
    "legal_case": "legal_case",
    "thesis": "thesis",
    "report": "report",
    "book": "book",
    "webpage": "webpage",
    "web": "webpage",
}

_TITLE_RE = re.compile(r"<title>([^<]+)</title>")
_SLUG_RE = re.compile(r"[^a-z0-9]+")

_lock = threading.Lock()


def _style_path(style_id: str) -> str | None:
    """Resolve a style id to a vendored/cached/custom .csl file path."""
    style_id = (style_id or "").strip().lower()
    if not style_id:
        return None
    if style_id == "custom" and os.path.exists(CUSTOM_STYLE_PATH):
        return CUSTOM_STYLE_PATH
    path = os.path.join(STYLES_DIR, f"{style_id}.csl")
    if os.path.exists(path):
        return path
    return None


def style_title(style_id: str) -> str | None:
    path = _style_path(style_id)
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as f:
            head = f.read(4000)
        m = _TITLE_RE.search(head)
        return m.group(1).strip() if m else style_id
    except Exception:
        return style_id


def list_styles() -> list[dict]:
    """Vendored + custom styles as [{id, title, custom}]."""
    styles = []
    for style_id in _KNOWN_STYLES:
        path = _style_path(style_id)
        if path:
            styles.append({"id": style_id, "title": style_title(style_id) or style_id, "custom": False})
    if os.path.exists(CUSTOM_STYLE_PATH):
        styles.append({"id": "custom", "title": style_title("custom") or "Custom CSL", "custom": True})
    return styles


def fetch_style(style_name: str) -> dict | None:
    """Download a style from the official CSL repository and cache it.

    This is what actually exposes the wider CSL ecosystem: any style id
    from the repository (e.g. 'ieee', 'vancouver') can be pulled on
    demand. Returns {id, title} or None on failure.
    """
    style_id = _SLUG_RE.sub("-", (style_name or "").strip().lower()).strip("-")
    if not style_id:
        return None
    with _lock:
        try:
            resp = httpx.get(CSL_REPO_RAW.format(name=style_id), timeout=20.0, follow_redirects=True)
            if resp.status_code != 200:
                return None
            xml = resp.text
            if not xml.lstrip().startswith("<?xml") and "<style" not in xml[:200]:
                return None
            path = os.path.join(STYLES_DIR, f"{style_id}.csl")
            with open(path, "w", encoding="utf-8") as f:
                f.write(xml)
            return {"id": style_id, "title": style_title(style_id) or style_id, "custom": False}
        except Exception:
            return None


def save_custom_style(xml: str) -> bool:
    """Persist a user-supplied CSL style (Settings -> Add CSL style)."""
    xml = (xml or "").strip()
    if not xml or "<style" not in xml:
        return False
    with _lock:
        with open(CUSTOM_STYLE_PATH, "w", encoding="utf-8") as f:
            f.write(xml)
    return True


def _parse_author(name: str) -> dict | None:
    name = (name or "").strip()
    if not name:
        return None
    if "," in name:  # "Doe, John"
        family, _, given = name.partition(",")
        return {"family": family.strip(), "given": given.strip() or None}
    parts = name.split()
    if len(parts) == 1:
        return {"family": parts[0]}
    return {"family": parts[-1], "given": " ".join(parts[:-1])}


def doc_to_csl_item(doc: dict) -> dict:
    """Map a document (hydrated from DB) to CSL-JSON."""
    authors = []
    for name in doc.get("authors") or []:
        parsed = _parse_author(name)
        if parsed:
            authors.append(parsed)
    item = {
        "id": f"doc-{doc.get('id', 'x')}",
        "type": _SOURCE_TYPE_TO_CSL.get(doc.get("document_type") or "", "article"),
        "title": doc.get("title") or doc.get("original_filename") or "Untitled",
        "author": authors,
    }
    if doc.get("journal"):
        item["container-title"] = doc["journal"]
    for key, csl_key in (("volume", "volume"), ("issue", "issue"), ("pages", "page"),
                         ("publisher", "publisher"), ("doi", "DOI"), ("abstract", "abstract")):
        value = doc.get(key)
        if value not in (None, ""):
            item[csl_key] = str(value)
    if doc.get("year"):
        item["issued"] = {"date-parts": [[int(doc["year"])]]}
    # legal extras (populated by Phase 8 legal extraction where available)
    cit_md = doc.get("citation_metadata") or {}
    if isinstance(cit_md, str):
        import json as _json
        try:
            cit_md = _json.loads(cit_md)
        except Exception:
            cit_md = {}
    if cit_md.get("court"):
        item["authority"] = cit_md["court"]
    if cit_md.get("case_number"):
        item["number"] = cit_md["case_number"]
    if cit_md.get("url"):
        item["URL"] = cit_md["url"]
    return item


def _load_style(style_id: str):
    path = _style_path(style_id)
    if not path:
        raise ValueError(f"Unknown citation style {style_id!r}")
    return CitationStylesStyle(path, locale=_LOCALE, validate=False)


def render_citation(item: dict, style_id: str | None = None) -> str:
    """Render one CSL-JSON item as a plain-text bibliography entry."""
    style_id = style_id or DEFAULT_STYLE
    try:
        style = _load_style(style_id)
    except Exception:
        style = _load_style(DEFAULT_STYLE)
    source = CiteProcJSON([item])
    bib = CitationStylesBibliography(style, source, formatter.plain)
    bib.register(Citation([CitationItem(item["id"])]))
    bib.sort()
    entries = bib.bibliography()
    for entry in entries:
        return str(entry)
    return ""


def render_bibliography(items: list[dict], style_id: str | None = None) -> list[str]:
    """Render a sorted bibliography (each item on its own line)."""
    style_id = style_id or DEFAULT_STYLE
    if not items:
        return []
    try:
        style = _load_style(style_id)
    except Exception:
        style = _load_style(DEFAULT_STYLE)
    source = CiteProcJSON(items)
    bib = CitationStylesBibliography(style, source, formatter.plain)
    citation = Citation([CitationItem(item["id"]) for item in items])
    bib.register(citation)
    bib.sort()
    return [str(entry) for entry in bib.bibliography()]


def bibtex_entry(doc: dict) -> str:
    authors = " and ".join(doc.get("authors") or [])
    fields = [
        f"title={{{doc.get('title') or ''}}}",
    ]
    if authors:
        fields.append(f"author={{{authors}}}")
    if doc.get("journal"):
        fields.append(f"journal={{{doc['journal']}}}")
    if doc.get("year"):
        fields.append(f"year={{{doc['year']}}}")
    if doc.get("volume"):
        fields.append(f"volume={{{doc['volume']}}}")
    if doc.get("issue"):
        fields.append(f"number={{{doc['issue']}}}")
    if doc.get("pages"):
        fields.append(f"pages={{{doc['pages']}}}")
    if doc.get("publisher"):
        fields.append(f"publisher={{{doc['publisher']}}}")
    if doc.get("doi"):
        fields.append(f"doi={{{doc['doi']}}}")
    if doc.get("abstract"):
        fields.append(f"abstract={{{doc['abstract']}}}")
    entry_type = "misc"
    if doc.get("document_type") == "legal":
        entry_type = "misc"
    elif doc.get("journal"):
        entry_type = "article"
    elif doc.get("document_type") == "thesis":
        entry_type = "phdthesis"
    elif doc.get("publisher"):
        entry_type = "book"
    key = f"doc{doc.get('id', 'x')}"
    return f"@{entry_type}{{{key},\n  " + ",\n  ".join(fields) + "\n}}"


def ris_entry(doc: dict) -> str:
    lines = ["TY  - JOUR"]
    for name in doc.get("authors") or []:
        lines.append(f"AU  - {name}")
    if doc.get("title"):
        lines.append(f"TI  - {doc['title']}")
    if doc.get("year"):
        lines.append(f"PY  - {doc['year']}")
    if doc.get("journal"):
        lines.append(f"JO  - {doc['journal']}")
    if doc.get("volume"):
        lines.append(f"VL  - {doc['volume']}")
    if doc.get("issue"):
        lines.append(f"IS  - {doc['issue']}")
    if doc.get("pages"):
        lines.append(f"SP  - {doc['pages']}")
    if doc.get("publisher"):
        lines.append(f"PB  - {doc['publisher']}")
    if doc.get("doi"):
        lines.append(f"DO  - {doc['doi']}")
    if doc.get("abstract"):
        lines.append(f"AB  - {doc['abstract']}")
    lines.append("ER  - ")
    return "\n".join(lines)
