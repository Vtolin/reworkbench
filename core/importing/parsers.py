"""
Reference import/export parsers (Phase 3 P0).

Formats: BibTeX / BibLaTeX, RIS, EndNote XML, CSL-JSON.
All parsers are dependency-free and return the same normalized dict:

    {
        "title": str | None, "authors": [str], "year": int | None,
        "doi": str | None, "journal": str | None, "volume": str | None,
        "issue": str | None, "pages": str | None, "publisher": str | None,
        "abstract": str | None, "raw_key": str | None,
    }

Tolerant by design: a malformed entry is skipped, never fatal.
"""
import json
import re
import xml.etree.ElementTree as ET

# ---------------------------------------------------------------- BibTeX
_ENTRY_RE = re.compile(r"@(\w+)\s*[{(]\s*([^,\s]*)\s*,", re.IGNORECASE)
_FIELD_RE = re.compile(
    r"([a-zA-Z][\w:.-]*)\s*=\s*(?:\{([^{}]*)\}|\"([^\"]*)\"|([^,}\s]+))\s*,?"
)


def _strip_braces(value: str) -> str:
    value = value.strip()
    while value.startswith("{") and value.endswith("}") and _balanced(value):
        value = value[1:-1].strip()
    value = value.replace("\\&", "&").replace("\\%", "%").replace("\\_", "_").replace("\\#", "#")
    value = re.sub(r"[{}]", "", value)
    return " ".join(value.split())


def _balanced(s: str) -> bool:
    depth = 0
    for ch in s:
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth < 0:
                return False
    return depth == 0


def _extract_balanced(text: str, start: int) -> tuple[str, int]:
    """Extract a {..} value starting at `start` (index of '{')."""
    depth = 0
    i = start
    while i < len(text):
        ch = text[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start + 1:i], i + 1
        i += 1
    return text[start + 1:], len(text)


def parse_bibtex(text: str) -> list[dict]:
    entries = []
    pos = 0
    while True:
        m = _ENTRY_RE.search(text, pos)
        if not m:
            break
        entry_type, key = m.group(1).lower(), m.group(2).strip()
        body_start = m.end()
        # find the end of this entry: balance braces
        depth = 0
        end = -1
        for i in range(m.start(), len(text)):
            ch = text[i]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = i
                    break
        if end == -1:
            break
        body = text[body_start:end]
        # values can contain nested braces -> parse char by char
        fields = {}
        fpos = 0
        while fpos < len(body):
            fm = _FIELD_RE.match(body, fpos)
            if fm:
                fname = fm.group(1).lower()
                val = fm.group(2) if fm.group(2) is not None else (
                    fm.group(3) if fm.group(3) is not None else fm.group(4))
                fields[fname] = _strip_braces(val or "")
                fpos = fm.end()
                continue
            # a field whose value starts with '{' and contains nested braces
            name_m = re.match(r"\s*([a-zA-Z][\w:.-]*)\s*=\s*\{", body[fpos:])
            if name_m:
                fname = name_m.group(1).lower()
                inner, consumed = _extract_balanced(body, fpos + name_m.end() - 1)
                fields[fname] = _strip_braces(inner)
                fpos += name_m.end() - 1 + (consumed - (fpos + name_m.end() - 1))
                continue
            fpos += 1
        if not fields:
            pos = end + 1
            continue
        entry = _bibtex_fields_to_record(fields, key)
        if entry.get("title") or entry.get("authors"):
            entries.append(entry)
        pos = end + 1
    return entries


def _bibtex_fields_to_record(fields: dict, key: str) -> dict:
    authors = []
    for name in re.split(r"\s+and\s+", fields.get("author") or "", flags=re.IGNORECASE):
        name = name.strip()
        if name:
            authors.append(name)
    year = None
    ym = re.search(r"\d{4}", str(fields.get("year") or ""))
    if ym:
        year = int(ym.group(0))
    pages = fields.get("pages") or ""
    if "--" in pages:
        pages = pages.replace("--", "-")
    journal = fields.get("journal") or fields.get("journaltitle") or fields.get("booktitle")
    # Preserve collection structures from Zotero/JabRef exports:
    # JabRef groups, Mendeley keywords, or explicit collection field
    collections = []
    for field in ("groups", "collection", "collections"):
        if fields.get(field):
            collections.extend([c.strip() for c in re.split(r"[;,]", fields[field]) if c.strip()])
    # keywords often contain collection-like tags; treat them as potential collections
    # but also keep them as keywords for tag creation downstream
    keywords = fields.get("keywords") or fields.get("keyword") or ""
    if keywords:
        # Split by comma/semicolon, filter small generic keywords? Keep all for now
        kw_collections = [c.strip() for c in re.split(r"[;,]", keywords) if c.strip()]
        # Only treat keywords as collections if they look like collection names (capitals, not super generic)
        collections.extend(kw_collections)
    # File field often contains linked PDF path (e.g., file = {:path/to/file.pdf:PDF})
    file_field = fields.get("file") or ""
    return {
        "title": fields.get("title") or None,
        "authors": authors,
        "year": year,
        "doi": fields.get("doi") or None,
        "journal": journal or None,
        "volume": fields.get("volume") or None,
        "issue": fields.get("number") or fields.get("issue") or None,
        "pages": pages or None,
        "publisher": fields.get("publisher") or None,
        "abstract": fields.get("abstract") or None,
        "raw_key": key or None,
        "collections": list(dict.fromkeys(collections))[:5],  # dedupe, limit 5
        "file": file_field or None,
    }


# ------------------------------------------------------------------- RIS
_RIS_KEYS = {
    "TY": "type", "AU": "author", "TI": "title", "T1": "title", "PY": "year",
    "JO": "journal", "JF": "journal", "T2": "journal", "VL": "volume",
    "IS": "issue", "SP": "pages", "EP": "pages_end", "PB": "publisher",
    "DO": "doi", "AB": "abstract", "N1": "note",
}


def parse_ris(text: str) -> list[dict]:
    records = []
    current: dict[str, list[str]] = {}
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        if line.startswith("TY  - ") and current:
            records.append(_ris_to_record(current))
            current = {}
        if "  - " in line:
            tag, _, value = line.partition("  - ")
            tag = tag.strip().upper()
            current.setdefault(tag, []).append(value.strip())
        elif line.startswith("ER"):
            records.append(_ris_to_record(current))
            current = {}
    if current:
        records.append(_ris_to_record(current))
    return [r for r in records if r and (r.get("title") or r.get("authors"))]


def _ris_to_record(fields: dict) -> dict:
    def first(key):
        vals = fields.get(key) or []
        return vals[0] if vals else None

    authors = fields.get("AU") or []
    year = None
    if first("PY"):
        ym = re.search(r"\d{4}", str(first("PY")))
        if ym:
            year = int(ym.group(0))
    pages = first("SP")
    ep = first("EP")
    if pages and ep:
        pages = f"{pages}-{ep}"
    # Preserve collections from KW/DB fields — Zotero RIS export often uses KW for tags
    # and DB for collection info; we treat both as potential collections
    collections = []
    for kw in fields.get("KW") or []:
        if kw.strip():
            collections.extend([c.strip() for c in re.split(r"[;,]", kw) if c.strip()])
    # DB field sometimes contains collection name in Zotero
    if first("DB") and first("DB").strip():
        db_val = first("DB").strip()
        if db_val not in collections:
            collections.append(db_val)
    return {
        "title": first("TI") or first("T1"),
        "authors": authors,
        "year": year,
        "doi": first("DO"),
        "journal": first("JO") or first("JF") or first("T2"),
        "volume": first("VL"),
        "issue": first("IS"),
        "pages": pages,
        "publisher": first("PB"),
        "abstract": first("AB"),
        "raw_key": None,
        "collections": list(dict.fromkeys(collections))[:5],
        "file": first("L1") or first("UR") or None,
    }


# -------------------------------------------------------------- EndNote XML
def parse_endnote_xml(text: str) -> list[dict]:
    try:
        root = ET.fromstring(text)
    except Exception:
        return []
    records = []
    for rec in root.iter("record"):
        def txt(tag):
            el = rec.find(tag)
            if el is None:
                return None
            val = (el.text or "").strip()
            return val or None

        authors = [a.text.strip() for a in rec.findall(".//authors/author") if a.text and a.text.strip()]
        year = None
        if txt("year") or txt("pub-dates/year"):
            ym = re.search(r"\d{4}", str(txt("year") or txt("pub-dates/year")))
            if ym:
                year = int(ym.group(0))
        # Collection from group or keywords
        collections = []
        for tag in ("group", "collection", "keywords"):
            val = txt(tag)
            if val:
                collections.extend([c.strip() for c in re.split(r"[;,]", val) if c.strip()])
        records.append({
            "title": txt("title"),
            "authors": authors,
            "year": year,
            "doi": txt("electronic-resource-num") or txt("doi"),
            "journal": txt("periodical/full-title") or txt("journal"),
            "volume": txt("volume"),
            "issue": txt("number") or txt("issue"),
            "pages": txt("pages"),
            "publisher": txt("publisher"),
            "abstract": txt("abstract"),
            "raw_key": txt("rec-number") or txt("accession-num"),
            "collections": list(dict.fromkeys(collections))[:5],
            "file": None,
        })
    return [r for r in records if r.get("title") or r.get("authors")]


# ---------------------------------------------------------------- CSL-JSON
def parse_csl_json(text: str) -> list[dict]:
    try:
        data = json.loads(text)
    except Exception:
        return []
    if isinstance(data, dict):
        data = [data]
    records = []
    for item in data:
        if not isinstance(item, dict):
            continue
        authors = []
        for a in item.get("author") or []:
            given = (a.get("given") or "").strip()
            family = (a.get("family") or "").strip()
            if family:
                authors.append(f"{given} {family}".strip())
        year = None
        dp = (item.get("issued") or {}).get("date-parts") or [[None]]
        if dp and dp[0] and dp[0][0] not in (None, ""):
            try:
                year = int(dp[0][0])
            except Exception:
                year = None
        # Collection from CSL custom field if present
        collections = []
        coll_val = item.get("collection-title") or item.get("collection")
        if coll_val:
            collections = [c.strip() for c in re.split(r"[;,]", str(coll_val)) if c.strip()]
        records.append({
            "title": item.get("title"),
            "authors": authors,
            "year": year,
            "doi": item.get("DOI"),
            "journal": item.get("container-title"),
            "volume": item.get("volume"),
            "issue": item.get("issue"),
            "pages": item.get("page"),
            "publisher": item.get("publisher"),
            "abstract": item.get("abstract"),
            "raw_key": str(item.get("id") or ""),
            "collections": list(dict.fromkeys(collections))[:5],
            "file": item.get("URL") or None,
        })
    return records


def detect_format(text: str) -> str:
    stripped = (text or "").lstrip()
    if not stripped:
        return "unknown"
    if stripped.startswith("{"):
        return "csl-json"
    if stripped.startswith("[") and stripped.strip().startswith("["):
        return "csl-json"
    if stripped.startswith("<"):
        return "endnote-xml"
    if re.match(r"@\w+\s*[{(]", stripped):
        return "bibtex"
    if re.match(r"TY\s+-\s+", stripped):
        return "ris"
    return "unknown"


def parse_references(text: str, fmt: str | None = None) -> list[dict]:
    """Detect + parse references in any supported format."""
    fmt = (fmt or detect_format(text)).lower()
    if fmt == "bibtex" or fmt == "biblatex":
        return parse_bibtex(text)
    if fmt == "ris":
        return parse_ris(text)
    if fmt == "endnote-xml":
        return parse_endnote_xml(text)
    if fmt == "csl-json":
        return parse_csl_json(text)
    # last resort: try each parser
    for parser in (parse_bibtex, parse_ris, parse_csl_json, parse_endnote_xml):
        records = parser(text)
        if records:
            return records
    return []


# ---------------------------------------------------------------- Serializers
def docs_to_ris(docs: list[dict]) -> str:
    from core.citations.engine import ris_entry
    return "\n".join(ris_entry(d) for d in docs)


def docs_to_bibtex(docs: list[dict]) -> str:
    from core.citations.engine import bibtex_entry
    return "\n\n".join(bibtex_entry(d) for d in docs)


def docs_to_csl_json(docs: list[dict]) -> str:
    from core.citations.engine import doc_to_csl_item
    return json.dumps([doc_to_csl_item(d) for d in docs], indent=2, ensure_ascii=False)
