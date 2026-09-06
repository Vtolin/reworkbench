"""
Phase 1 metadata provider tests - happy paths + edge cases, no network.

Uses httpx.MockTransport so no request ever leaves the machine.
Run with:  python -m unittest discover -s tests -v
"""
import json
import unittest

import httpx

from core.metadata.providers import (
    OpenAlexProvider,
    LocalMetadataProvider,
    fetch_metadata,
    normalize_openalex_work,
    TITLE_MATCH_THRESHOLD,
)

SAMPLE_WORK = {
    "id": "https://openalex.org/W123",
    "title": "Proportionality in Indonesian Constitutional Review",
    "authorships": [
        {"author": {"display_name": "John Doe"}},
        {"author": {"display_name": "Jane Roe"}},
    ],
    "publication_year": 2021,
    "ids": {"doi": "https://doi.org/10.1234/example.1"},
    "primary_location": {
        "source": {
            "display_name": "Journal of Legal Studies",
            "host_organization_name": "Example Publisher",
        }
    },
    "biblio": {"volume": "12", "issue": "3", "first_page": "45", "last_page": "67"},
    "type": "article",
    "cited_by_count": 10,
    "open_access": {"is_oa": True},
    "abstract_inverted_index": {"This": [0], "study": [1], "tests": [2], "X": [3]},
}


def _client_with(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


class TestOpenAlexProvider(unittest.IsolatedAsyncioTestCase):
    async def test_fetch_by_doi_happy_path(self):
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            return httpx.Response(200, json=SAMPLE_WORK)

        provider = OpenAlexProvider(client=_client_with(handler))
        cand = await provider.fetch_by_doi("10.1234/example.1")
        self.assertIsNotNone(cand)
        self.assertEqual(cand["title"], "Proportionality in Indonesian Constitutional Review")
        self.assertEqual(cand["authors"], ["John Doe", "Jane Roe"])
        self.assertEqual(cand["year"], 2021)
        self.assertEqual(cand["doi"], "10.1234/example.1")
        self.assertEqual(cand["journal"], "Journal of Legal Studies")
        self.assertEqual(cand["volume"], "12")
        self.assertEqual(cand["issue"], "3")
        self.assertEqual(cand["pages"], "45-67")
        self.assertEqual(cand["publisher"], "Example Publisher")
        self.assertEqual(cand["abstract"], "This study tests X")
        self.assertEqual(cand["confidence"], 0.97)
        self.assertEqual(cand["extras"]["openalex_id"], "https://openalex.org/W123")
        self.assertIn("doi.org/10.1234/example.1", seen["url"])

    async def test_fetch_by_doi_404_returns_none(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, json={"error": "not found"})

        provider = OpenAlexProvider(client=_client_with(handler))
        self.assertIsNone(await provider.fetch_by_doi("10.9999/does.not.exist"))

    async def test_fetch_by_doi_strips_trailing_punctuation(self):
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            return httpx.Response(200, json=SAMPLE_WORK)

        provider = OpenAlexProvider(client=_client_with(handler))
        cand = await provider.fetch_by_doi("10.1234/example.1,")
        self.assertIsNotNone(cand)
        self.assertNotIn("example.1%2C", seen["url"])

    async def test_search_by_title_orders_by_confidence_with_author_bonus(self):
        def handler(request: httpx.Request) -> httpx.Response:
            near = {**SAMPLE_WORK, "id": "https://openalex.org/W1",
                    "title": "Proportionality in Indonesian Constitutional Review"}
            far = {**SAMPLE_WORK, "id": "https://openalex.org/W2",
                   "title": "Quantum Computing Architectures",
                   "authorships": [{"author": {"display_name": "Ada Lovelace"}}]}
            return httpx.Response(200, json={"results": [far, near]})

        provider = OpenAlexProvider(client=_client_with(handler))
        candidates = await provider.search_by_title(
            "Proportionality in Indonesian Constitutional Review",
            authors=["John Doe"],
        )
        self.assertEqual(len(candidates), 2)
        self.assertEqual(candidates[0]["title"], "Proportionality in Indonesian Constitutional Review")
        self.assertGreater(candidates[0]["confidence"], candidates[1]["confidence"])


class TestNormalization(unittest.TestCase):
    def test_normalize_openalex_work_minimal(self):
        cand = normalize_openalex_work(
            {"title": "", "publication_year": None, "ids": {}, "authorships": [],
             "primary_location": {}, "biblio": {}, "type": "book"},
            confidence=None,
        )
        self.assertEqual(cand["source"], "openalex")
        self.assertIsNone(cand["title"])
        self.assertEqual(cand["authors"], [])
        self.assertEqual(cand["confidence"], 0.0)
        self.assertEqual(cand["extras"]["openalex_type"], "book")

    def test_normalize_openalex_work_review_maps_to_survey(self):
        cand = normalize_openalex_work({**SAMPLE_WORK, "type": "review"})
        self.assertEqual(cand["document_type"], "survey")

    def test_pages_single_page(self):
        from core.metadata.providers import _format_pages
        self.assertEqual(_format_pages("7", None), "7")
        self.assertIsNone(_format_pages(None, None))


class TestFetchMetadata(unittest.IsolatedAsyncioTestCase):
    async def test_doi_hit_short_circuits(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=SAMPLE_WORK)

        proposal, candidates, error = await fetch_metadata(
            doi="10.1234/example.1",
            title="irrelevant",
            local_fields={"title": "local title"},
            providers=[OpenAlexProvider(client=_client_with(handler))],
        )
        self.assertEqual(proposal["source"], "openalex")
        self.assertEqual(candidates, [])
        self.assertIsNone(error)

    async def test_no_doi_and_no_match_falls_back_to_local(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"results": []})

        proposal, candidates, error = await fetch_metadata(
            doi=None,
            title="Some thesis about courts",
            local_fields={"title": "Some thesis about courts", "year": 2020,
                          "jurisdiction": "Indonesia", "document_type": "legal"},
            providers=[OpenAlexProvider(client=_client_with(handler))],
        )
        self.assertEqual(proposal["source"], "local")
        self.assertEqual(proposal["title"], "Some thesis about courts")
        self.assertEqual(proposal["year"], 2020)
        self.assertEqual(proposal["extras"]["jurisdiction"], "Indonesia")
        self.assertEqual(candidates, [])
        self.assertIsNone(error)

    async def test_ambiguous_title_returns_candidates_for_user_choice(self):
        def handler(request: httpx.Request) -> httpx.Response:
            works = [
                {**SAMPLE_WORK, "id": "https://openalex.org/W1", "title": "Grading with LLMs"},
                {**SAMPLE_WORK, "id": "https://openalex.org/W2", "title": "Also Grading with LLMs"},
            ]
            return httpx.Response(200, json={"results": works})

        proposal, candidates, error = await fetch_metadata(
            doi=None, title="Grading with LLMs",
            local_fields={"title": "Grading with LLMs"},
            providers=[OpenAlexProvider(client=_client_with(handler))],
        )
        self.assertEqual(proposal["source"], "openalex")
        self.assertEqual(len(candidates), 2)
        # best match may be below threshold - still returned, confidence visible
        self.assertIsInstance(proposal["confidence"], float)

    async def test_offline_skips_network_providers(self):
        calls = []

        class RecordingProvider:
            name = "recording"

            async def fetch_by_doi(self, doi):
                calls.append("fetch_by_doi")
                return {"source": "recording"}

            async def search_by_title(self, title, authors=None):
                calls.append("search_by_title")
                return []

        proposal, candidates, error = await fetch_metadata(
            doi="10.1234/example.1", title="t",
            local_fields={"title": "t"}, offline=True,
            providers=[RecordingProvider()],
        )
        self.assertEqual(calls, [])
        self.assertEqual(proposal["source"], "local")

    async def test_provider_error_degrades_to_local(self):
        class BrokenProvider:
            name = "broken"

            async def fetch_by_doi(self, doi):
                raise RuntimeError("boom")

            async def search_by_title(self, title, authors=None):
                raise RuntimeError("boom")

        proposal, candidates, error = await fetch_metadata(
            doi="10.1234/example.1", title="t",
            local_fields={"title": "t"},
            providers=[BrokenProvider()],
        )
        self.assertEqual(proposal["source"], "local")
        self.assertIn("boom", error)


class TestLocalProvider(unittest.TestCase):
    def test_build(self):
        cand = LocalMetadataProvider().build(
            {"title": "T", "year": 2019, "jurisdiction": "Indonesia",
             "document_type": "legal"},
            doi="10.1/x",
        )
        self.assertEqual(cand["source"], "local")
        self.assertEqual(cand["doi"], "10.1/x")
        self.assertEqual(cand["extras"]["jurisdiction"], "Indonesia")
        self.assertEqual(cand["confidence"], 0.45)


if __name__ == "__main__":
    unittest.main()
