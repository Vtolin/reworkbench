"""
Deterministic legal-case extraction (Phase 8 P3).

Extracts, from document text, the structured case metadata that the CSL
engine and the legal citation graph need:
    court, case_number, decision_date, parties, judges, decision_type,
plus every reference the case makes to other cases / statutes / articles.

Regex-based and dependency-free - the same policy as the rest of the
deterministic extraction layer: exact identifiers are guaranteed correct
because no LLM touches them; the LLM layer (legal reasoning extraction in
core/research/analysis.py) handles the interpretive sections.
"""
import re

# Indonesian court abbreviations (PN, PT, MA, MK, ...) as they appear in
# putusan headers and case numbers.
_COURTS = [
    "Mahkamah Konstitusi", "Mahkamah Agung", "Pengadilan Negeri",
    "Pengadilan Tinggi", "Pengadilan Agama", "Pengadilan Tinggi Agama",
    "PTUN", "Pengadilan Tata Usaha Negara", "Mahkamah Syar'iyah",
    "Pengadilan Militer", "Pengadilan Tindak Pidana Korupsi",
    "Pengadilan Niaga", "Pengadilan Hubungan Industrial",
]
_COURTS_PATTERN = re.compile("|".join(re.escape(c) for c in sorted(_COURTS, key=len, reverse=True)), re.IGNORECASE)
# Court short codes in case numbers: PN.Jkt.Sel, PT.DKI, MA, MK, ...
_COURT_CODES = {
    "MK": "Mahkamah Konstitusi",
    "MA": "Mahkamah Agung",
    "PN": "Pengadilan Negeri",
    "PT": "Pengadilan Tinggi",
    "PA": "Pengadilan Agama",
    "PTA": "Pengadilan Tinggi Agama",
    "PTUN": "Pengadilan Tata Usaha Negara",
}

# Case numbers: "No. 12/Pdt.G/2023/PN.Jkt.Sel", "Putusan Nomor 90/PUU-XXI/2023"
CASE_NUMBER_RE = re.compile(
    r"(?:No(?:mor)?\.?\s*)?(\d{1,4}\s*/\s*[A-Za-z][A-Za-z0-9.\-/]*?/\s*\d{4}\s*/\s*(?:PN|PT|PA|PTA|PTUN|MA|MK)[A-Za-z0-9.\-]*)",
    re.IGNORECASE,
)
MK_CASE_NUMBER_RE = re.compile(
    r"(?:No(?:mor)?\.?\s*)?(\d{1,3}\s*/\s*PUU\s*[-/][A-Z0-9]+/\s*\d{4})",
    re.IGNORECASE,
)

# References to other cases ("Putusan Mahkamah Konstitusi Nomor 90/PUU-XXI/2023",
# "putusan MA No. 123/K/2020", plain "90/PUU-XXI/2023")
CITED_CASE_RE = re.compile(
    r"(?:(?:putusan|keputusan)\s+)?(?:mahkamah\s+konstitusi|mk|mahkamah\s+agung|ma|pengadilan\s+(?:negeri|tinggi)|pn|pt|pa|ptun)\s+"
    r"(?:no(?:mor)?\.?\s*)?(\d{1,4}\s*/\s*[A-Za-z][A-Za-z0-9.\-/]*?/\s*\d{4}(?:\s*/\s*(?:PN|PT|PA|PTA|PTUN|MA|MK)[A-Za-z0-9.\-]*)?)",
    re.IGNORECASE,
)
CITED_PUU_RE = re.compile(r"(\d{1,3}\s*/\s*PUU\s*[-/][A-Z0-9]+/\s*\d{4})", re.IGNORECASE)

# Statutes: "UU 11/2008", "Undang-Undang Nomor 11 Tahun 2008", "PP 71/2019"
STATUTE_RE = re.compile(
    r"(?:(?:undang-undang|uu|perppu|peraturan\s+pemerintah|pp|perpres|perda)\s+)?"
    r"(?:no(?:mor)?\.?\s*)?(\d{1,3})\s*/\s*(\d{4})",
    re.IGNORECASE,
)
STATUTE_NAME_RE = re.compile(
    r"(undang-undang|uu|perppu|peraturan\s+pemerintah|pp|perpres|peraturan\s+daerah|perda)",
    re.IGNORECASE,
)

# Constitutional articles: "Pasal 28D ayat (1)", "Pasal 28E"
ARTICLE_RE = re.compile(
    r"pasal\s+(\d{1,4}\s?[A-Z]?)\s*(?:ayat\s*\(?(\d{1,3}(?:\s*,\s*\d{1,3})*)\)?)?",
    re.IGNORECASE,
)

PARTY_RE = re.compile(
    r"\b(Para\s+Pemohon|Pemohon|Para\s+Termohon|Termohon|Penggugat|Tergugat|Terbanding|Pembanding|Penuntut\s+Umum|Terdakwa|Pihak\s+Terkait)\b",
    re.IGNORECASE,
)

JUDGE_RE = re.compile(
    r"(?:hakim\s+(?:anggota|ketua)|majelis\s+hakim|ketua\s+majelis)",
    re.IGNORECASE,
)

# Full names (for parties/judges): 2-4 capitalized words
NAME_RE = re.compile(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}\b")


def normalize_case_number(value: str) -> str:
    """Normalize a case number: strip spaces, uppercase, drop 'No.' prefix."""
    v = re.sub(r"\s+", "", (value or "").strip())
    v = re.sub(r"^(?:no|nomor)\.?:?", "", v, flags=re.IGNORECASE)
    return v.upper()


def extract_case_metadata(text: str) -> dict:
    """Best-effort case metadata from raw document text."""
    if not text:
        return {}
    out: dict = {}

    court_names = sorted(set(m.group(0) for m in _COURTS_PATTERN.finditer(text[:20000])))
    out["court"] = court_names[0] if court_names else None

    case_number = None
    m = CASE_NUMBER_RE.search(text)
    if m:
        case_number = normalize_case_number(m.group(1))
    else:
        m2 = MK_CASE_NUMBER_RE.search(text)
        if m2:
            case_number = normalize_case_number(m2.group(1))
    out["case_number"] = case_number

    parties = []
    for m in PARTY_RE.finditer(text[:30000]):
        role = m.group(1)
        # capture up to ~160 chars after the role for the party name
        tail = text[m.end():m.end() + 160]
        tail = tail.split("\n")[0].strip(" ,.()")
        tail = tail.lstrip(": ")
        name_m = NAME_RE.match(tail)
        if name_m:
            parties.append(f"{role}: {name_m.group(0)}")
    out["parties"] = list(dict.fromkeys(parties))[:12]

    out["decision_type"] = "putusan" if re.search(r"\bputusan\b", text[:5000], re.IGNORECASE) else None

    # date: "diputuskan ... 12 Maret 2021" or ISO
    date_m = re.search(
        r"(\d{1,2})\s+(Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)\s+(\d{4})",
        text[:30000],
        re.IGNORECASE,
    )
    if date_m:
        months = {m: i for i, m in enumerate(
            ["januari", "februari", "maret", "april", "mei", "juni", "juli",
             "agustus", "september", "oktober", "november", "desember"], 1)}
        out["decision_date"] = f"{date_m.group(3)}-{months.get(date_m.group(2).lower(), 1):02d}-{int(date_m.group(1)):02d}"
    else:
        iso = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", text[:5000])
        out["decision_date"] = iso.group(0) if iso else None

    return out


def extract_cited_identifiers(text: str) -> list[dict]:
    """References this document makes to other cases/statutes/articles.

    Returns [{kind: case|statute|article, identifier, locator}].
    """
    if not text:
        return []
    refs: list[dict] = []
    seen: set[tuple[str, str]] = set()

    for m in CITED_PUU_RE.finditer(text):
        ident = normalize_case_number(m.group(1))
        if (ident, "case") not in seen:
            seen.add((ident, "case"))
            refs.append({"kind": "case", "identifier": ident, "locator": None})

    for m in CITED_CASE_RE.finditer(text):
        ident = normalize_case_number(m.group(1))
        if (ident, "case") not in seen:
            seen.add((ident, "case"))
            refs.append({"kind": "case", "identifier": ident, "locator": None})

    for m in ARTICLE_RE.finditer(text):
        ayat = m.group(2)
        ident = f"PASAL {m.group(1).upper()}" + (f" AYAT ({ayat})" if ayat else "")
        if (ident, "article") not in seen:
            seen.add((ident, "article"))
            refs.append({"kind": "article", "identifier": ident, "locator": None})

    for m in STATUTE_NAME_RE.finditer(text):
        window = text[m.end():m.end() + 200]
        ident = None
        num_m = STATUTE_RE.search(window)  # "UU 11/2008", "11/2008"
        if num_m:
            ident = f"{m.group(1).upper()} {num_m.group(1)}/{num_m.group(2)}"
        else:
            named_m = re.search(r"(?:no(?:mor)?\.?\s*)?(\d{1,3})\s+tahun\s+(\d{4})", window, re.IGNORECASE)
            if named_m:
                ident = f"{m.group(1).upper()} {named_m.group(1)}/{named_m.group(2)}"
        if ident and (ident, "statute") not in seen:
            seen.add((ident, "statute"))
            refs.append({"kind": "statute", "identifier": ident, "locator": None})

    return refs
