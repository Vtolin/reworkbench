"""
Bibliographic metadata providers (Phase 1 - automated metadata fetching).

Pluggable provider architecture: each network provider implements the
`MetadataProvider` interface and produces the same normalized candidate
dict, so callers never know which backend produced a result, and new
providers (Crossref, PubMed, ...) can be added without touching callers.

Normalized candidate shape (JSON-safe dict):

    {
        "source": "openalex" | "local" | ...,
        "title": str | None,
        "authors": [str, ...],
        "year": int | None,
        "doi": str | None,          # normalized (lowercase, trailing punct stripped)
        "journal": str | None,
        "volume": str | None,
        "issue": str | None,
        "pages": str | None,        # "1-10" or "7"
        "publisher": str | None,
        "abstract": str | None,
        "document_type": str | None,  # legal|empirical|survey|thesis|general
        "confidence": float,        # 0..1 - how sure we are this is the right record
        "extras": dict,             # provider-specific JSON (raw ids, counts, ...)
    }

Everything is best-effort and non-authoritative: proposals are shown to
the user for Accept/Edit/Reject and persisted with metadata_source /
metadata_confidence / metadata_verified so nothing silently overwrites
user-entered metadata.
"""
import abc
import os
import re
from urllib.parse import quote

import httpx

from core.ingestion.deduplication import title_fuzzy_score

# A DOI match from a provider is about as certain as dedup-by-DOI.
DOI_MATCH_CONFIDENCE = 0.97
# Title-search proposals below this are still shown, but with the low
# confidence on the label (the UI surfaces the number either way).
TITLE_MATCH_THRESHOLD = 0.85

OPENALEX_BASE_URL = "https://api.openalex.org"
OPENALEX_TIMEOUT_S = 10.0
OPENALEX_MAILTO = os.environ.get("OPENALEX_MAILTO", "")  # polite pool; optional

# DOIs are often pasted with trailing punctuation (",", ".", ")" ...).
_TRAILING_PUNCT_RE = re.compile(r"[.,;)\]]+$")
# OpenAlex returns `ids.doi` as a full URL ("https://doi.org/10.x/y").
_DOI_URL_PREFIX_RE = re.compile(r"^(?:https?://)?(?:dx\.)?doi\.org/", re.IGNORECASE)


def _clean_doi(doi: str | None) -> str | None:
    if not doi:
        return None
    doi = doi.strip().lower()
    doi = _TRAILING_PUNCT_RE.sub("", doi)
    doi = _DOI_URL_PREFIX_RE.sub("", doi)
    return doi or None


def _format_pages(first_page, last_page) -> str | None:
    fp = str(first_page).strip() if first_page not in (None, "") else None
    lp = str(last_page).strip() if last_page not in (None, "") else None
    if fp and lp:
        return f"{fp}-{lp}"
    return fp or lp


def _reconstruct_abstract(inverted_index, max_chars: int = 2000) -> str | None:
    """OpenAlex stores abstracts as {word: [positions]}. Rebuild the text."""
    if not inverted_index:
        return None
    positions: dict[int, str] = {}
    for word, pos_list in inverted_index.items():
        for p in pos_list:
            positions[p] = word
    text = " ".join(positions[i] for i in sorted(positions))
    return text[:max_chars] or None


_OPENALEX_TYPE_MAP = {
    "review": "survey",
    "dissertation": "thesis",
}


def make_candidate(*, source, title=None, authors=None, year=None, doi=None,
                   journal=None, volume=None, issue=None, pages=None,
                   publisher=None, abstract=None, document_type=None,
                   confidence=0.0, extras=None) -> dict:
    return {
        "source": source,
        "title": (title or "").strip() or None,
        "authors": [a for a in (authors or []) if a],
        "year": year,
        "doi": _clean_doi(doi),
        "journal": (journal or "").strip() or None,
        "volume": (volume or "").strip() or None,
        "issue": (issue or "").strip() or None,
        "pages": pages,
        "publisher": (publisher or "").strip() or None,
        "abstract": (abstract or "").strip() or None,
        "document_type": document_type,
        "confidence": round(float(confidence or 0.0), 2),
        "extras": extras or {},
    }


class MetadataProvider(abc.ABC):
    """Interface every network metadata provider implements."""

    name = "base"

    @abc.abstractmethod
    async def fetch_by_doi(self, doi: str) -> dict | None:
        """Return a normalized candidate for `doi`, or None if unknown."""

    @abc.abstractmethod
    async def search_by_title(self, title: str, authors: list[str] | None = None) -> list[dict]:
        """Return normalized candidates for a title search, best first."""


class OpenAlexProvider(MetadataProvider):
    """OpenAlex API (https://api.openalex.org) - free, no key required.

    `client` is injectable for tests (e.g. httpx.MockTransport); when
    omitted a short-lived client is created per request.
    """

    name = "openalex"

    def __init__(self, client: httpx.AsyncClient | None = None):
        self._client = client

    async def _get_json(self, url: str, params: dict | None = None) -> dict | None:
        if self._client is not None:
            resp = await self._client.get(url, params=params)
        else:
            async with httpx.AsyncClient(timeout=OPENALEX_TIMEOUT_S) as client:
                resp = await client.get(url, params=params)
        if resp.status_code != 200:
            return None
        try:
            return resp.json()
        except Exception:
            return None

    def _query_params(self, extra: dict | None = None) -> dict:
        params = dict(extra or {})
        if OPENALEX_MAILTO:
            params["mailto"] = OPENALEX_MAILTO
        return params

    async def fetch_by_doi(self, doi: str) -> dict | None:
        clean = _clean_doi(doi)
        if not clean:
            return None
        url = f"{OPENALEX_BASE_URL}/works/https://doi.org/{quote(clean, safe='/')}"
        data = await self._get_json(url, params=self._query_params())
        if not data:
            return None
        return normalize_openalex_work(data, confidence=DOI_MATCH_CONFIDENCE)

    async def search_by_title(self, title: str, authors: list[str] | None = None) -> list[dict]:
        if not title:
            return []
        data = await self._get_json(
            f"{OPENALEX_BASE_URL}/works",
            params=self._query_params({"search": title, "per-page": 5}),
        )
        results = (data or {}).get("results") or []
        candidates = []
        for work in results:
            cand = normalize_openalex_work(work, confidence=None)
            if not cand.get("title"):
                continue
            cand["confidence"] = _title_search_confidence(title, cand, authors or [])
            candidates.append(cand)
        candidates.sort(key=lambda c: c["confidence"], reverse=True)
        return candidates


class LocalMetadataProvider:
    """Deterministic fallback built from the existing local extractors
    (DOI regex, year/jurisdiction extraction, doc-type classifier).

    Not a network provider - it wraps what `server._extract_meta_from_bytes`
    already found, so the pipeline always has a labeled proposal even when
    offline or when no remote record exists.
    """

    name = "local"

    def build(self, local_fields: dict, *, doi: str | None = None) -> dict:
        return make_candidate(
            source=self.name,
            title=local_fields.get("title"),
            authors=local_fields.get("authors") or [],
            year=local_fields.get("year"),
            doi=doi or local_fields.get("doi"),
            journal=local_fields.get("journal"),
            document_type=local_fields.get("document_type"),
            confidence=0.45,
            extras={
                "jurisdiction": local_fields.get("jurisdiction"),
                "label": "Extracted from the file itself - verify manually",
            },
        )


def normalize_openalex_work(work: dict, confidence: float | None = None) -> dict:
    """Map an OpenAlex `work` object to the normalized candidate shape."""
    ids = work.get("ids") or {}
    biblio = work.get("biblio") or {}
    primary = work.get("primary_location") or {}
    src = primary.get("source") or {}
    authors = [
        a.get("author", {}).get("display_name", "").strip()
        for a in (work.get("authorships") or [])
        if a.get("author", {}).get("display_name")
    ]
    oa_type = (work.get("type") or "").lower()
    return make_candidate(
        source="openalex",
        title=work.get("title"),
        authors=authors,
        year=work.get("publication_year"),
        doi=ids.get("doi") or work.get("doi"),
        journal=src.get("display_name"),
        volume=biblio.get("volume"),
        issue=biblio.get("issue"),
        pages=_format_pages(biblio.get("first_page"), biblio.get("last_page")),
        publisher=src.get("host_organization_name"),
        abstract=_reconstruct_abstract(work.get("abstract_inverted_index")),
        document_type=_OPENALEX_TYPE_MAP.get(oa_type),
        confidence=confidence,
        extras={
            "openalex_id": work.get("id"),
            "openalex_type": oa_type,
            "cited_by_count": work.get("cited_by_count"),
            "is_oa": (work.get("open_access") or {}).get("is_oa"),
        },
    )


def _first_author_surname(author: str) -> str:
    parts = [p for p in author.split() if p]
    return parts[-1].lower() if parts else ""


def _title_search_confidence(query_title: str, candidate: dict, query_authors: list[str]) -> float:
    """Fuzzy title ratio + a small bonus when the first author overlaps."""
    conf = title_fuzzy_score(query_title or "", candidate.get("title") or "")
    if query_authors:
        q = _first_author_surname(query_authors[0])
        if q and any(q == _first_author_surname(a) for a in candidate.get("authors") or []):
            conf = min(conf + 0.05, 0.99)
    return round(conf, 2)


async def fetch_metadata(*, doi: str | None = None, title: str | None = None,
                         authors: list[str] | None = None, local_fields: dict | None = None,
                         offline: bool = False, providers: list[MetadataProvider] | None = None):
    """Orchestrate provider lookups.

    Returns (proposal, candidates, error):
      - `proposal`: the best candidate to show (best remote match, or the
        local fallback when nothing remote matched / offline).
      - `candidates`: all remote title-search candidates (empty for DOI hits
        and local fallbacks) so the UI can offer "choose another".
      - `error`: provider error message (None when all lookups succeeded).

    A remote lookup failure never breaks ingestion - it degrades to the
    local provider.
    """
    providers = providers if providers is not None else [OpenAlexProvider()]
    local_fields = local_fields or {}
    candidates: list[dict] = []
    error: str | None = None

    if not offline:
        for provider in providers:
            try:
                if doi:
                    candidate = await provider.fetch_by_doi(doi)
                    if candidate:
                        return candidate, [], None
                if title:
                    candidates.extend(await provider.search_by_title(title, authors))
            except Exception as exc:  # provider failure -> keep going / fall back
                error = f"{provider.name} lookup failed: {exc}"

    best = max(candidates, key=lambda c: c["confidence"]) if candidates else None
    if best is not None:
        return best, candidates, error
    proposal = LocalMetadataProvider().build(local_fields, doi=doi)
    return proposal, candidates, error
