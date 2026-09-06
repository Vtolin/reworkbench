import sqlite3
from storage.sqlite import get_connection, dict_from_row

def list_tags(db_path=None):
    conn = get_connection(db_path)
    try:
        rows = conn.execute("SELECT * FROM tags ORDER BY name").fetchall()
        out=[]
        for r in rows:
            d=dict_from_row(r)
            cnt=conn.execute("SELECT COUNT(*) as c FROM document_tags WHERE tag_id=?",(d["id"],)).fetchone()["c"]
            d["document_count"]=cnt
            out.append(d)
        return out
    finally:
        conn.close()

def get_tag(tid:int, db_path=None):
    conn=get_connection(db_path)
    try:
        row=conn.execute("SELECT * FROM tags WHERE id=?",(tid,)).fetchone()
        return dict_from_row(row) if row else None
    finally:
        conn.close()

def create_tag(name:str, color:str="#8b5cf6", db_path=None):
    conn=get_connection(db_path)
    try:
        cur=conn.execute("INSERT INTO tags(name,color) VALUES (?,?)",(name.strip(), color))
        conn.commit()
        return get_tag(cur.lastrowid, db_path)
    finally:
        conn.close()

def delete_tag(tid:int, db_path=None)->bool:
    conn=get_connection(db_path)
    try:
        cur=conn.execute("DELETE FROM tags WHERE id=?",(tid,))
        conn.commit()
        return cur.rowcount>0
    finally:
        conn.close()

def update_tag(tid:int, patch:dict, db_path=None):
    conn=get_connection(db_path)
    try:
        sets=[]
        params=[]
        for k in ("name","color"):
            if k in patch:
                sets.append(f"{k}=?")
                params.append(patch[k])
        if not sets:
            return get_tag(tid, db_path)
        params.append(tid)
        conn.execute(f"UPDATE tags SET {', '.join(sets)} WHERE id=?", params)
        conn.commit()
        return get_tag(tid, db_path)
    finally:
        conn.close()
