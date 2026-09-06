"""
Bibliographic metadata providers (Phase 1 - automated metadata fetching).

Pluggable provider architecture: each provider implements the
`MetadataProvider` interface and produces the same normalized candidate
shape, so the ingestion pipeline never knows which backend produced a
result and new providers (Crossref, PubMed, ...) can be added later
without touching callers.

Resolution order (see `fetch_metadata`):
    1. DOI found  -> provider lookup by DOI (OpenAlex by default)
    2. no DOI     -> provider title search + fuzzy match -> candidates
    3. anything fails / offline -> LocalMetadataProvider (existing
       deterministic extraction)

Providers are never authoritative on their own: every proposal is shown
to the user for Accept/Edit/Reject and stored with `metadata_source`,
`metadata_confidence` and `metadata_verified` so nothing silently
overwrites user-entered metadata.
"""

from core.metadata.providers import (  # noqa: F401
    MetadataProvider,
    OpenAlexProvider,
    LocalMetadataProvider,
    fetch_metadata,
    normalize_openalex_work,
    TITLE_MATCH_THRESHOLD,
)
