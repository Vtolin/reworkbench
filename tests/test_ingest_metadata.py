"""
Phase 0/1 storage tests: schema migration, bibliographic fields round-trip,
first-class sources entity, and the "never silently overwrite user-entered
metadata" constraint.

Run with:  python -m unittest discover -s tests -v
"""
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import storage.sqlite as storage
from core.library.documents import create_document, update_document, get_document


# The documents table as it existed before the Phase 0 refactor - used to
# verify init_db() migrates live databases additively.
OLD_DOCUMENTS_TABLE = """
CREATE TABLE documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    stored_path TEXT,
    file_hash TEXT UNIQUE,
    file_size INTEGER,
    mime_type TEXT,
    doi TEXT,
    year INTEGER,
    journal TEXT,
    jurisdiction TEXT,
    document_type TEXT,
    page_count INTEGER,
    abstract TEXT,
    ingestion_status TEXT DEFAULT 'pending',
    ingestion_error TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""


class TempDbTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmp.name) / "library.db"

    def tearDown(self):
        self._tmp.cleanup()


class TestMigration(TempDbTest):
    def test_init_db_migrates_old_schema_additively(self):
        # build a pre-refactor database
        conn = sqlite3.connect(str(self.db_path))
        conn.execute(OLD_DOCUMENTS_TABLE)
        conn.commit()
        conn.close()

        storage.init_db(self.db_path)

        conn = sqlite3.connect(str(self.db_path))
        try:
            cols = {r[1] for r in conn.execute("PRAGMA table_info(documents)")}
            for name in ("volume", "issue", "pages", "publisher", "citation_metadata",
                         "metadata_source", "metadata_fetched_at", "metadata_confidence",
                         "metadata_verified"):
                self.assertIn(name, cols, f"missing migrated column {name}")
            tables = {r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertIn("sources", tables)
            self.assertIn("claims", tables)
            self.assertIn("citations", tables)
        finally:
            conn.close()

    def test_init_db_idempotent(self):
        storage.init_db(self.db_path)
        storage.init_db(self.db_path)  # second run must not fail
        conn = sqlite3.connect(str(self.db_path))
        try:
            cols = {r[1] for r in conn.execute("PRAGMA table_info(documents)")}
            self.assertIn("volume", cols)
        finally:
            conn.close()


class TestDocumentBibliographicFields(TempDbTest):
    def _base_data(self, **overrides):
        data = {
            "title": "Proportionality in Indonesian Constitutional Review",
            "original_filename": "paper.pdf",
            "stored_path": "documents/ab/cd/hash.pdf",
            "file_hash": "hash123",
            "file_size": 1234,
            "mime_type": "application/pdf",
            "doi": "10.1234/example.1",
            "year": 2021,
            "journal": "Journal of Legal Studies",
            "jurisdiction": "Indonesia",
            "document_type": "legal",
            "page_count": 12,
            "abstract": "A study of proportionality.",
            "volume": "12",
            "issue": "3",
            "pages": "45-67",
            "publisher": "Example Publisher",
            "citation_metadata": {"openalex_id": "W123", "cited_by_count": 10},
            "metadata_source": "openalex",
            "metadata_fetched_at": "2026-09-02T00:00:00+00:00",
            "metadata_confidence": 0.97,
            "metadata_verified": 1,
            "ingestion_status": "ready",
            "authors_list": ["John Doe", "Jane Roe"],
        }
        data.update(overrides)
        return data

    def test_create_document_roundtrip_with_citation_metadata(self):
        storage.init_db(self.db_path)
        doc = create_document(self._base_data(), db_path=self.db_path)
        self.assertEqual(doc["volume"], "12")
        self.assertEqual(doc["issue"], "3")
        self.assertEqual(doc["pages"], "45-67")
        self.assertEqual(doc["publisher"], "Example Publisher")
        self.assertEqual(doc["metadata_source"], "openalex")
        self.assertEqual(doc["metadata_confidence"], 0.97)
        self.assertEqual(doc["metadata_verified"], 1)
        # JSON blob round-trips as a dict through dict_from_row
        self.assertIsInstance(doc["citation_metadata"], dict)
        self.assertEqual(doc["citation_metadata"]["openalex_id"], "W123")
        self.assertEqual(doc["authors"], ["John Doe", "Jane Roe"])

    def test_sources_entity_created_and_typed(self):
        storage.init_db(self.db_path)
        doc = create_document(self._base_data(), db_path=self.db_path)
        conn = storage.get_connection(self.db_path)
        try:
            row = conn.execute(
                "SELECT * FROM sources WHERE document_id=?", (doc["id"],)
            ).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(row["source_type"], "legal_case")
            self.assertEqual(row["doi"], "10.1234/example.1")
            self.assertEqual(row["volume"], "12")
            self.assertEqual(json.loads(row["authors_json"]), ["John Doe", "Jane Roe"])
        finally:
            conn.close()

    def test_update_document_never_overwrites_unpatched_fields(self):
        storage.init_db(self.db_path)
        doc = create_document(self._base_data(), db_path=self.db_path)
        updated = update_document(doc["id"], {"title": "New title only"}, db_path=self.db_path)
        self.assertEqual(updated["title"], "New title only")
        # untouched user-entered fields survive
        self.assertEqual(updated["doi"], "10.1234/example.1")
        self.assertEqual(updated["journal"], "Journal of Legal Studies")
        self.assertEqual(updated["metadata_source"], "openalex")

    def test_update_document_patch_applies_bibliographic_fields(self):
        storage.init_db(self.db_path)
        doc = create_document(self._base_data(), db_path=self.db_path)
        updated = update_document(
            doc["id"], {"volume": "13", "pages": "1-9", "citation_metadata": {"openalex_id": "W999"}},
            db_path=self.db_path,
        )
        self.assertEqual(updated["volume"], "13")
        self.assertEqual(updated["pages"], "1-9")
        self.assertEqual(updated["citation_metadata"]["openalex_id"], "W999")
        conn = storage.get_connection(self.db_path)
        try:
            row = conn.execute(
                "SELECT * FROM sources WHERE document_id=?", (doc["id"],)
            ).fetchone()
            self.assertEqual(row["volume"], "13")
        finally:
            conn.close()

    def test_local_metadata_still_stored(self):
        storage.init_db(self.db_path)
        doc = create_document(self._base_data(
            metadata_source="local",
            metadata_fetched_at=None,
            metadata_confidence=0.45,
            metadata_verified=0,
            citation_metadata={},
        ), db_path=self.db_path)
        self.assertEqual(doc["metadata_source"], "local")
        self.assertIsNone(doc["metadata_fetched_at"])
        self.assertEqual(doc["metadata_verified"], 0)


if __name__ == "__main__":
    unittest.main()
