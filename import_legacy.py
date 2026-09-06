"""
One-time import: pfolder files -> SQLite library.db
Does NOT re-embed; just creates DB records so Library UI shows existing corpus.
Chroma already indexed these files, so retrieval will work after import
(the stored_path must match Chroma's source metadata for ask to work).
"""
import os
from pathlib import Path
from storage.sqlite import init_db, get_connection
from storage.filesystem import compute_sha256
from core.library.documents import create_document

PROJECT_ROOT = Path(__file__).resolve().parent
PFOLDER = PROJECT_ROOT / "pfolder"
DATA_ROOT = PROJECT_ROOT / "research_workbench" / "data"


def main():
    from config import SUPPORTED_DOC_EXTENSIONS

    init_db()

    def supported(f): return Path(f).suffix.lower() in SUPPORTED_DOC_EXTENSIONS

    files = []
    for root, _, fs in os.walk(PFOLDER):
        for f in fs:
            if supported(f):
                files.append(Path(root)/f)

    print(f"Found {len(files)} files in pfolder")

    # deduplicate by checking existing hash
    conn = get_connection()
    try:
        existing_hashes = {r["file_hash"] for r in conn.execute("SELECT file_hash FROM documents WHERE file_hash IS NOT NULL").fetchall()}
    finally:
        conn.close()

    import mimetypes, json

    for p in files:
        try:
            h = compute_sha256(p)
            if h in existing_hashes:
                print(f"skip {p.name} already imported")
                continue
            # extract meta deterministically
            meta = {}
            # year / jurisdiction via existing extractors
            try:
                from metadata_extraction import extract_year
                year = extract_year(str(p))
            except Exception:
                year = None
            try:
                from jurisdiction_extraction import extract_jurisdiction
                jur = extract_jurisdiction(str(p))
            except Exception:
                jur = None
            # doc type, page count
            page_count = None
            if p.suffix.lower()==".pdf":
                doc = None
                try:
                    import pymupdf as fitz
                    doc = fitz.open(str(p))
                    page_count = len(doc)
                except Exception:
                    page_count = None
                finally:
                    if doc is not None:
                        try:
                            doc.close()
                        except Exception:
                            pass
            else:
                page_count = 1
            mime,_ = mimetypes.guess_type(str(p))
            # title from filename
            title = p.stem.replace("_"," ").replace("-"," ").strip() or p.name
            # Use Chroma source path convention: the ingestion.py used full absolute path as source (os.path.join DOC_FOLDER, rel)
            # For legacy docs, source in Chroma is like "pfolder\\journal1.pdf" on Windows or "C:\\...\\pfolder\\journal1.pdf"? Let's check get_indexed_documents.
            # Safer to store relative path as "pfolder/<rel>" and also keep absolute.
            # For library DB, stored_path should be relative to DATA_ROOT/documents but for legacy we keep original pfolder path as stored_path placeholder
            # We'll store stored_path = pfolder/<rel> and also ensure ask flow can resolve it.
            # Actually server's ask tries to match stored_path absolute -> doc_map values (which are original pfolder paths). So storing original relative will allow matching by filename.
            rel_to_pfolder = p.relative_to(PFOLDER).as_posix()
            stored_placeholder = f"pfolder/{rel_to_pfolder}"
            # Check duplicate via hash already done
            doc_data = {
                "title": title,
                "original_filename": p.name,
                "stored_path": stored_placeholder,
                "file_hash": h,
                "file_size": p.stat().st_size,
                "mime_type": mime or "application/octet-stream",
                "doi": None,
                "year": year,
                "journal": None,
                "jurisdiction": jur,
                "document_type": "general",
                "page_count": page_count,
                "abstract": None,
                "ingestion_status": "ready",
                "metadata_json": json.dumps({}),
                "authors_list": [],
            }
            created = create_document(doc_data)
            print(f"imported #{created['id']} {p.name} -> hash {h[:8]} year={year} jur={jur} pages={page_count}")
            existing_hashes.add(h)
        except Exception as e:
            print(f"failed {p}: {e}")

    print("done")


if __name__ == "__main__":
    main()
