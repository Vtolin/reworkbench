import sqlite3
from datetime import datetime, timezone
from storage.sqlite import get_connection, dict_from_row

def _now():
    return datetime.now(timezone.utc).isoformat()

def list_collections(db_path=None):
    conn = get_connection(db_path)
    try:
        rows = conn.execute("SELECT * FROM collections ORDER BY name").fetchall()
        out = []
        for r in rows:
            d = dict_from_row(r)
            cnt = conn.execute("SELECT COUNT(*) as c FROM document_collections WHERE collection_id=?", (d["id"],)).fetchone()["c"]
            d["document_count"] = cnt
            out.append(d)
        return out
    finally:
        conn.close()

def get_collection(cid: int, db_path=None):
    conn = get_connection(db_path)
    try:
        row = conn.execute("SELECT * FROM collections WHERE id=?", (cid,)).fetchone()
        return dict_from_row(row) if row else None
    finally:
        conn.close()

def create_collection(name: str, description: str = "", color: str = "#6366f1", db_path=None):
    conn = get_connection(db_path)
    try:
        now = _now()
        cur = conn.execute("INSERT INTO collections(name, description, color, created_at, updated_at) VALUES (?,?,?,?,?)",
                           (name.strip(), description, color, now, now))
        conn.commit()
        return get_collection(cur.lastrowid, db_path)
    finally:
        conn.close()

def update_collection(cid: int, patch: dict, db_path=None):
    conn = get_connection(db_path)
    try:
        sets = []
        params = []
        for k in ("name","description","color"):
            if k in patch:
                sets.append(f"{k}=?")
                params.append(patch[k])
        if not sets:
            return get_collection(cid, db_path)
        sets.append("updated_at=?")
        params.append(_now())
        params.append(cid)
        conn.execute(f"UPDATE collections SET {', '.join(sets)} WHERE id=?", params)
        conn.commit()
        return get_collection(cid, db_path)
    finally:
        conn.close()

def delete_collection(cid: int, db_path=None) -> bool:
    conn = get_connection(db_path)
    try:
        cur = conn.execute("DELETE FROM collections WHERE id=?", (cid,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()
