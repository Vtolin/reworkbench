"""
First-class `sources` entity: the bibliographic record linked to a
document. Kept separate from the documents table so citation rendering
(CSL), citation graphs and legal relationships target a stable entity
instead of growing Document into a god object.

Populated at ingestion time from whatever the user confirmed
(Accept/Edit/Reject of a metadata proposal). Never silently overwritten:
`sync_source_from_document` only writes fields that were actually passed.
"""
import json
import sqlite3
from datetime import datetime, timezone

_SOURCE_TYPE_BY_DOC_TYPE = {
    "legal": "legal_case",
    "thesis": "thesis",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _source_type(document_type) -> str:
    return _SOURCE_TYPE_BY_DOC_TYPE.get(document_type or "", "journal")


def sync_source_from_document(conn: sqlite3.Connection, doc_id: int, data: dict) -> None:
    """Insert or refresh the `sources` row for a document.

    `data` may carry: doi, title, journal, volume, issue, pages, publisher,
    year, document_type, authors_list (or authors). Only present values
    are written; a document with no bibliographic data gets no source row.
    On update, absent keys preserve the stored value instead of wiping it.
    """
    present = {k for k in ("doi", "title", "journal", "volume", "issue",
                           "pages", "publisher", "year") if k in data}
    biblio = {k: data.get(k) for k in present}
    has_biblio = any(v not in (None, "") for v in biblio.values())
    # An explicit document_type change alone still warrants a row update
    # (source_type derivation), even with no other biblio keys present.
    type_changed = "document_type" in data
    if not has_biblio and not type_changed:
        return

    has_authors_key = "authors_list" in data or "authors" in data
    authors = data.get("authors_list") or data.get("authors") or []
    authors_json = json.dumps([a for a in authors if a]) if has_authors_key else None
    now = _now()
    source_type = _source_type(data.get("document_type")) if type_changed else None

    existing = conn.execute(
        "SELECT * FROM sources WHERE document_id=?", (doc_id,)
    ).fetchone()
    if existing:
        sets, params = [], []
        if source_type is not None:
            sets.append("source_type=?")
            params.append(source_type)
        for k in ("doi", "title", "journal", "volume", "issue",
                  "pages", "publisher", "year"):
            if k in present:
                sets.append(f"{k}=?")
                params.append(data.get(k))
        if authors_json is not None:
            sets.append("authors_json=?")
            params.append(authors_json)
        if not sets:
            return
        sets.append("updated_at=?")
        params.append(now)
        params.append(existing["id"])
        conn.execute(
            f"UPDATE sources SET {', '.join(sets)} WHERE id=?",
            params,
        )
    else:
        conn.execute(
            """INSERT INTO sources(document_id, source_type, doi, title, journal,
               volume, issue, pages, publisher, year, authors_json, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (doc_id, source_type or _source_type(data.get("document_type")),
             biblio.get("doi"), biblio.get("title"), biblio.get("journal"),
             biblio.get("volume"), biblio.get("issue"), biblio.get("pages"),
             biblio.get("publisher"), biblio.get("year"),
             authors_json if authors_json is not None else json.dumps([a for a in authors if a]),
             now, now),
        )


def get_source_for_document(doc_id: int, db_path=None) -> dict | None:
    from storage.sqlite import get_connection, dict_from_row

    conn = get_connection(db_path)
    try:
        row = conn.execute(
            "SELECT * FROM sources WHERE document_id=?", (doc_id,)
        ).fetchone()
        if not row:
            return None
        s = dict_from_row(row)
        try:
            s["authors"] = json.loads(s.get("authors_json") or "[]")
        except Exception:
            s["authors"] = []
        return s
    finally:
        conn.close()
