"""
SQLite is the source of truth — see spec.
Creates research_workbench/data/library.db with full schema.
Idempotent: safe to call get_db() repeatedly.
"""
import os
import sqlite3
import json
from pathlib import Path
from datetime import datetime, timezone

# Resolve data dir relative to project root (mlra/)
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = PROJECT_ROOT / "research_workbench" / "data" / "library.db"

SCHEMA_SQL = r"""
-- Documents: core library record
CREATE TABLE IF NOT EXISTS documents (
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
    updated_at TEXT NOT NULL,
    -- Bibliographic normalization (Phase 1 metadata fetching)
    volume TEXT,
    issue TEXT,
    pages TEXT,
    publisher TEXT,
    -- Provider-specific extras (CSL-JSON-ish); normalized fields live in
    -- the typed columns above, never duplicated into this blob.
    citation_metadata TEXT,
    -- "AI proposes -> human confirms" tracking
    metadata_source TEXT,
    metadata_fetched_at TEXT,
    metadata_confidence REAL,
    metadata_verified INTEGER NOT NULL DEFAULT 0
);

-- Collections
CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT DEFAULT '',
    color TEXT DEFAULT '#6366f1',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_collections (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    PRIMARY KEY (document_id, collection_id)
);

-- Authors (normalized)
CREATE TABLE IF NOT EXISTS authors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS document_authors (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    author_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (document_id, author_id)
);

-- Tags
CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT DEFAULT '#8b5cf6'
);

CREATE TABLE IF NOT EXISTS document_tags (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (document_id, tag_id)
);

-- Annotations (highlights + notes attached to highlights)
CREATE TABLE IF NOT EXISTS annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page INTEGER NOT NULL,
    start_offset INTEGER,
    end_offset INTEGER,
    selected_text TEXT,
    note TEXT,
    color TEXT DEFAULT '#facc15',
    category TEXT DEFAULT 'highlight',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- Phase 7: structured annotation record (first-class links, not just text)
    tags_json TEXT,
    project_id INTEGER REFERENCES research_projects(id) ON DELETE SET NULL,
    claim_id INTEGER REFERENCES claims(id) ON DELETE SET NULL,
    evidence_item_id INTEGER REFERENCES evidence_items(id) ON DELETE SET NULL
);

-- Notes (standalone markdown notes)
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    title TEXT,
    content TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Research projects / workspaces
CREATE TABLE IF NOT EXISTS research_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_project_documents (
    project_id INTEGER NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, document_id)
);

CREATE TABLE IF NOT EXISTS research_queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES research_projects(id) ON DELETE SET NULL,
    query TEXT NOT NULL,
    answer TEXT,
    retrieval_mode TEXT,
    model_used TEXT,
    sources_json TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES research_projects(id) ON DELETE CASCADE,
    document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    claim TEXT,
    quoted_evidence TEXT,
    page INTEGER,
    location TEXT,
    note TEXT,
    created_at TEXT NOT NULL
);

-- Settings KV (for offline mode, thresholds, etc.)
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- First-class bibliographic entity, kept separate from documents so the
-- citation engine (CSL), citation graph and legal relationships have a
-- stable target instead of growing the documents table into a god object.
CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL DEFAULT 'journal',  -- journal | legal_case | thesis | report | book | web | other
    doi TEXT,
    title TEXT,
    journal TEXT,
    volume TEXT,
    issue TEXT,
    pages TEXT,
    publisher TEXT,
    year INTEGER,
    authors_json TEXT,
    venue TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- Phase 8: legal case metadata (court, case number, parties, judges)
    court TEXT,
    case_number TEXT,
    decision_date TEXT,
    parties_json TEXT,
    judges_json TEXT
);

-- Legal citation graph: which source cites which case/statute/article.
-- `cited_identifier` is the normalized string extracted from the text
-- (case number, "UU 11/2008", "Pasal 28D") and may not resolve to a
-- library document - resolution happens at query time.
CREATE TABLE IF NOT EXISTS source_citations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    cited_identifier TEXT NOT NULL,
    cited_source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'case',  -- case | statute | article
    locator TEXT,
    created_at TEXT NOT NULL
);

-- Saved searches (Phase 5): named query + filters, re-runnable as the
-- library grows.
CREATE TABLE IF NOT EXISTS saved_searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    query TEXT NOT NULL,
    filters_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- First-class claims (populated by the Phase 6 evidence system; the table
-- exists now so the model never has to be retrofitted).
CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES research_projects(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',  -- open | supported | disputed
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Claim <-> Source edges with an explicit relationship type.
CREATE TABLE IF NOT EXISTS citations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE,
    claim_id INTEGER REFERENCES claims(id) ON DELETE CASCADE,
    support TEXT NOT NULL DEFAULT 'supports',  -- supports | contradicts | mentions
    locator TEXT,
    created_at TEXT NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(file_hash);
CREATE INDEX IF NOT EXISTS idx_documents_doi ON documents(doi);
CREATE INDEX IF NOT EXISTS idx_documents_year ON documents(year);
CREATE INDEX IF NOT EXISTS idx_documents_title ON documents(title);
CREATE INDEX IF NOT EXISTS idx_annotations_doc ON annotations(document_id);
CREATE INDEX IF NOT EXISTS idx_sources_doc ON sources(document_id);
CREATE INDEX IF NOT EXISTS idx_sources_doi ON sources(doi);
CREATE INDEX IF NOT EXISTS idx_sources_case_number ON sources(case_number);
CREATE INDEX IF NOT EXISTS idx_claims_project ON claims(project_id);
CREATE INDEX IF NOT EXISTS idx_citations_claim ON citations(claim_id);
CREATE INDEX IF NOT EXISTS idx_source_citations_source ON source_citations(source_id);
CREATE INDEX IF NOT EXISTS idx_source_citations_identifier ON source_citations(cited_identifier);
"""

DEFAULT_SETTINGS = {
    "strict_offline_mode": "false",
    "auto_organize_threshold_high": "0.85",
    "auto_organize_threshold_low": "0.60",
    "embedding_provider": "ollama",
    "embedding_model": "nomic-embed-text",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# Columns added after the original schema shipped. ALTER TABLE ADD COLUMN
# is additive and safe on live databases (CREATE TABLE IF NOT EXISTS will
# NOT add columns to an existing table, so this is the only way pre-refactor
# databases pick up the new fields).
_MIGRATED_DOCUMENT_COLUMNS = {
    "volume": "TEXT",
    "issue": "TEXT",
    "pages": "TEXT",
    "publisher": "TEXT",
    "citation_metadata": "TEXT",
    "metadata_source": "TEXT",
    "metadata_fetched_at": "TEXT",
    "metadata_confidence": "REAL",
    "metadata_verified": "INTEGER NOT NULL DEFAULT 0",
}

_MIGRATED_TABLE_COLUMNS = {
    "annotations": {
        "tags_json": "TEXT",
        "project_id": "INTEGER",
        "claim_id": "INTEGER",
        "evidence_item_id": "INTEGER",
    },
    "sources": {
        "court": "TEXT",
        "case_number": "TEXT",
        "decision_date": "TEXT",
        "parties_json": "TEXT",
        "judges_json": "TEXT",
    },
}


def _migrate_document_columns(conn: sqlite3.Connection) -> None:
    existing = {r["name"] for r in conn.execute("PRAGMA table_info(documents)").fetchall()}
    for name, ddl in _MIGRATED_DOCUMENT_COLUMNS.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE documents ADD COLUMN {name} {ddl}")
    for table, columns in _MIGRATED_TABLE_COLUMNS.items():
        existing_cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        for name, ddl in columns.items():
            if name not in existing_cols:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")


def get_db_path(custom: str | Path | None = None) -> Path:
    if custom:
        return Path(custom)
    return DEFAULT_DB_PATH


def get_connection(db_path: str | Path | None = None) -> sqlite3.Connection:
    path = get_db_path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA journal_mode = WAL;")
    # Wait (don't instantly fail) when another thread holds the write lock:
    # without this, a confirm racing a PATCH/backup dies with
    # "database is locked" instead of waiting its turn. Server-side Python
    # locks serialize Chroma writes, but SQLite rows are written from many
    # endpoints, so the DB needs its own contention policy.
    conn.execute("PRAGMA busy_timeout = 5000;")
    return conn


def init_db(db_path: str | Path | None = None) -> Path:
    path = get_db_path(db_path)
    conn = get_connection(path)
    try:
        conn.executescript(SCHEMA_SQL)
        _migrate_document_columns(conn)
        # seed default settings if missing
        for k, v in DEFAULT_SETTINGS.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (k, v)
            )
        conn.commit()
    finally:
        conn.close()
    return path


def dict_from_row(row: sqlite3.Row) -> dict:
    if row is None:
        return None
    d = dict(row)
    # parse metadata_json if present
    if "metadata_json" in d and d["metadata_json"]:
        try:
            d["metadata"] = json.loads(d["metadata_json"])
        except Exception:
            d["metadata"] = {}
    else:
        d["metadata"] = d.get("metadata") or {}
    # parse citation_metadata if present
    if "citation_metadata" in d and d["citation_metadata"]:
        try:
            d["citation_metadata"] = json.loads(d["citation_metadata"])
        except Exception:
            d["citation_metadata"] = {}
    else:
        d["citation_metadata"] = d.get("citation_metadata") or {}
    return d
