"""
Document CRUD over SQLite. Enriches rows with collections/tags/authors.
"""
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from storage.sqlite import get_connection, dict_from_row

def _now():
    return datetime.now(timezone.utc).isoformat()

def _hydrate(conn: sqlite3.Connection, doc: dict) -> dict:
    doc_id = doc["id"]
    # collections
    cols = conn.execute("""
        SELECT c.* FROM collections c
        JOIN document_collections dc ON dc.collection_id=c.id
        WHERE dc.document_id=?
        ORDER BY c.name
    """, (doc_id,)).fetchall()
    doc["collections"] = [dict_from_row(r) for r in cols]
    # tags
    tags = conn.execute("""
        SELECT t.* FROM tags t
        JOIN document_tags dt ON dt.tag_id=t.id
        WHERE dt.document_id=?
        ORDER BY t.name
    """, (doc_id,)).fetchall()
    doc["tags"] = [dict_from_row(r) for r in tags]
    # authors
    authors = conn.execute("""
        SELECT a.name, da.author_order FROM authors a
        JOIN document_authors da ON da.author_id=a.id
        WHERE da.document_id=?
        ORDER BY da.author_order
    """, (doc_id,)).fetchall()
    doc["authors"] = [r["name"] for r in authors]
    # annotations count
    cnt = conn.execute("SELECT COUNT(*) as c FROM annotations WHERE document_id=?", (doc_id,)).fetchone()
    doc["annotation_count"] = cnt["c"] if cnt else 0
    return doc

def list_documents(db_path=None, q: str | None = None, collection_id: int | None = None,
                   tag_id: int | None = None, year: int | None = None,
                   doc_type: str | None = None, limit=100, offset=0) -> list[dict]:
    conn = get_connection(db_path)
    try:
        where = []
        params = []
        join = ""
        if collection_id is not None:
            join += " JOIN document_collections dc ON dc.document_id=d.id"
            where.append("dc.collection_id=?")
            params.append(collection_id)
        if tag_id is not None:
            join += " JOIN document_tags dt ON dt.document_id=d.id"
            where.append("dt.tag_id=?")
            params.append(tag_id)
        if q:
            where.append("(d.title LIKE ? OR d.original_filename LIKE ? OR d.doi LIKE ? OR d.journal LIKE ?)")
            like = f"%{q}%"
            params.extend([like, like, like, like])
        if year is not None:
            where.append("d.year=?")
            params.append(year)
        if doc_type:
            where.append("d.document_type=?")
            params.append(doc_type)
        sql = f"SELECT d.* FROM documents d {join}"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY d.updated_at DESC LIMIT ? OFFSET ?"
        filter_params = list(params)
        params.extend([limit, offset])
        rows = conn.execute(sql, params).fetchall()
        docs = []
        for r in rows:
            d = dict_from_row(r)
            docs.append(_hydrate(conn, d))
        # total count — same joins/filters as the page query, so filtered
        # pagination totals match what the UI actually displays.
        count_sql = f"SELECT COUNT(DISTINCT d.id) as c FROM documents d {join}"
        if where:
            count_sql += " WHERE " + " AND ".join(where)
        total = conn.execute(count_sql, filter_params).fetchone()["c"]
        return docs, total
    finally:
        conn.close()

def get_document(doc_id: int, db_path=None) -> dict | None:
    conn = get_connection(db_path)
    try:
        row = conn.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
        if not row:
            return None
        return _hydrate(conn, dict_from_row(row))
    finally:
        conn.close()

def get_document_by_hash(file_hash: str, db_path=None) -> dict | None:
    conn = get_connection(db_path)
    try:
        row = conn.execute("SELECT * FROM documents WHERE file_hash=?", (file_hash,)).fetchone()
        if not row:
            return None
        return _hydrate(conn, dict_from_row(row))
    finally:
        conn.close()

def create_document(data: dict, db_path=None) -> dict:
    conn = get_connection(db_path)
    try:
        now = _now()
        data = {**data}
        data.setdefault("created_at", now)
        data.setdefault("updated_at", now)
        # handle metadata_json
        if "metadata" in data:
            data["metadata_json"] = json.dumps(data.pop("metadata"))
        elif "metadata_json" not in data:
            data["metadata_json"] = json.dumps({})
        # handle citation_metadata JSON
        if "citation_metadata" in data and isinstance(data["citation_metadata"], dict):
            data["citation_metadata"] = json.dumps(data["citation_metadata"])
        if data.get("metadata_verified") is None:
            data["metadata_verified"] = 0
        if data.get("ingestion_status") is None:
            data["ingestion_status"] = "pending"
        fields = ["title","original_filename","stored_path","file_hash","file_size","mime_type",
                  "doi","year","journal","jurisdiction","document_type","page_count","abstract",
                  "volume","issue","pages","publisher","citation_metadata",
                  "metadata_source","metadata_fetched_at","metadata_confidence","metadata_verified",
                  "ingestion_status","ingestion_error","metadata_json","created_at","updated_at"]
        vals = [data.get(f) for f in fields]
        cur = conn.execute(f"INSERT INTO documents ({','.join(fields)}) VALUES ({','.join('?' for _ in fields)})", vals)
        doc_id = cur.lastrowid
        # authors
        for idx, name in enumerate(data.get("authors_list") or []):
            name = name.strip()
            if not name:
                continue
            conn.execute("INSERT OR IGNORE INTO authors(name) VALUES (?)", (name,))
            aid = conn.execute("SELECT id FROM authors WHERE name=?", (name,)).fetchone()["id"]
            conn.execute("INSERT OR IGNORE INTO document_authors(document_id, author_id, author_order) VALUES (?,?,?)",
                         (doc_id, aid, idx))
        # first-class bibliographic source entity (never overwrites - only
        # writes fields that are actually present)
        from core.library.sources import sync_source_from_document
        sync_source_from_document(conn, doc_id, data)
        conn.commit()
        return get_document(doc_id, db_path)
    finally:
        conn.close()

def update_document(doc_id: int, patch: dict, db_path=None) -> dict | None:
    conn = get_connection(db_path)
    try:
        row = conn.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
        if not row:
            return None
        now = _now()
        # scalar fields - only keys explicitly present in `patch` are applied,
        # so automated metadata can never silently overwrite user-entered values.
        allowed = {"title","doi","year","journal","jurisdiction","document_type","abstract","page_count",
                   "volume","issue","pages","publisher",
                   "metadata_source","metadata_fetched_at","metadata_confidence","metadata_verified",
                   "ingestion_status","ingestion_error","mime_type"}
        sets = []
        params = []
        for k in allowed:
            if k in patch:
                sets.append(f"{k}=?")
                params.append(patch[k])
        if "metadata" in patch:
            sets.append("metadata_json=?")
            params.append(json.dumps(patch["metadata"]))
        if "citation_metadata" in patch:
            value = patch["citation_metadata"]
            sets.append("citation_metadata=?")
            params.append(json.dumps(value) if isinstance(value, dict) else value)
        if sets:
            sets.append("updated_at=?")
            params.append(now)
            params.append(doc_id)
            conn.execute(f"UPDATE documents SET {', '.join(sets)} WHERE id=?", params)
        # authors replacement if provided
        if "authors" in patch:
            conn.execute("DELETE FROM document_authors WHERE document_id=?", (doc_id,))
            for idx, name in enumerate(patch["authors"] or []):
                name = name.strip()
                if not name:
                    continue
                conn.execute("INSERT OR IGNORE INTO authors(name) VALUES (?)", (name,))
                aid = conn.execute("SELECT id FROM authors WHERE name=?", (name,)).fetchone()["id"]
                conn.execute("INSERT OR IGNORE INTO document_authors(document_id, author_id, author_order) VALUES (?,?,?)",
                             (doc_id, aid, idx))
        # refresh the linked source entity from whatever was patched
        source_fields = {k: patch[k] for k in ("doi","title","journal","volume","issue","pages","publisher","year","document_type") if k in patch}
        if source_fields or "authors" in patch:
            merged = dict(source_fields)
            merged["authors"] = patch.get("authors", [r["name"] for r in conn.execute(
                "SELECT a.name FROM authors a JOIN document_authors da ON da.author_id=a.id WHERE da.document_id=? ORDER BY da.author_order",
                (doc_id,)).fetchall()])
            from core.library.sources import sync_source_from_document
            sync_source_from_document(conn, doc_id, merged)
        conn.commit()
        return get_document(doc_id, db_path)
    finally:
        conn.close()

def delete_document(doc_id: int, db_path=None) -> bool:
    from storage.filesystem import delete_stored_file
    conn = get_connection(db_path)
    try:
        row = conn.execute("SELECT stored_path FROM documents WHERE id=?", (doc_id,)).fetchone()
        if not row:
            return False
        stored = row["stored_path"]
        conn.execute("DELETE FROM documents WHERE id=?", (doc_id,))
        conn.commit()
        if stored:
            delete_stored_file(stored)
        return True
    finally:
        conn.close()

def set_document_collections(doc_id: int, collection_ids: list[int], db_path=None):
    conn = get_connection(db_path)
    try:
        conn.execute("DELETE FROM document_collections WHERE document_id=?", (doc_id,))
        for cid in collection_ids:
            conn.execute("INSERT OR IGNORE INTO document_collections(document_id, collection_id) VALUES (?,?)", (doc_id, cid))
        conn.commit()
    finally:
        conn.close()

def set_document_tags(doc_id: int, tag_ids: list[int], db_path=None):
    conn = get_connection(db_path)
    try:
        conn.execute("DELETE FROM document_tags WHERE document_id=?", (doc_id,))
        for tid in tag_ids:
            conn.execute("INSERT OR IGNORE INTO document_tags(document_id, tag_id) VALUES (?,?)", (doc_id, tid))
        conn.commit()
    finally:
        conn.close()
