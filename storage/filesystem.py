"""
Filesystem organization layer: DB tracks paths, files live under
research_workbench/data/documents/
"""
import os
import shutil
import hashlib
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_ROOT = PROJECT_ROOT / "research_workbench" / "data"
DOCUMENTS_DIR = DATA_ROOT / "documents"


def ensure_dirs():
    for p in [DATA_ROOT / "documents", DATA_ROOT / "attachments", DATA_ROOT / "thumbnails",
              DATA_ROOT / "chroma", DATA_ROOT / "indexes", DATA_ROOT / "exports",
              DATA_ROOT / "backups", DATA_ROOT / "cache"]:
        p.mkdir(parents=True, exist_ok=True)


def compute_sha256(file_path: str | Path) -> str:
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def compute_sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def stored_path_for(hash_hex: str, original_filename: str) -> Path:
    """
    Content-addressed storage: documents/ab/cd/<hash>.<ext>
    Avoids collisions and keeps directory listings manageable.
    """
    ensure_dirs()
    ext = Path(original_filename).suffix.lower() or ".bin"
    sub = DOCUMENTS_DIR / hash_hex[:2] / hash_hex[2:4]
    sub.mkdir(parents=True, exist_ok=True)
    return sub / f"{hash_hex}{ext}"


def save_uploaded_file(file_bytes: bytes, original_filename: str, file_hash: str | None = None) -> tuple[Path, str]:
    """
    Persist uploaded bytes to content-addressed path.
    Returns (stored_path, hash).
    """
    if file_hash is None:
        file_hash = compute_sha256_bytes(file_bytes)
    dest = stored_path_for(file_hash, original_filename)
    if not dest.exists():
        dest.write_bytes(file_bytes)
    # return path relative to DATA_ROOT for DB storage
    rel = dest.relative_to(DATA_ROOT)
    return dest, file_hash, str(rel).replace(os.sep, "/")


def resolve_stored_path(stored_rel: str) -> Path:
    """Turn DB stored_path (relative) back into absolute Path."""
    return DATA_ROOT / stored_rel


def delete_stored_file(stored_rel: str):
    try:
        p = resolve_stored_path(stored_rel)
        if p.exists():
            p.unlink()
            # cleanup empty parent dirs (up to documents/)
            for parent in [p.parent, p.parent.parent]:
                try:
                    if parent.exists() and not any(parent.iterdir()):
                        parent.rmdir()
                    else:
                        break
                except OSError:
                    break
    except Exception:
        pass
