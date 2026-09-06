"""
FastAPI backend for the Local Academic Research Workbench.
Wraps the existing RAG engine (hybrid retrieval, reranking, summarization,
comparison) and exposes a Library Application Layer over SQLite.
"""
import os
import re
import hashlib
import ipaddress
import mimetypes
import json
import socket
import tempfile
from pathlib import Path
from typing import Optional, List
from datetime import datetime, timezone
from urllib.parse import urlsplit

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Query, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse, Response
from fastapi.staticfiles import StaticFiles
import threading
from pydantic import BaseModel

# --- ensure storage init ---
from storage.sqlite import init_db, get_connection, get_db_path, dict_from_row
from storage.filesystem import compute_sha256_bytes, save_uploaded_file, resolve_stored_path, ensure_dirs
from core.library.documents import (
    list_documents, get_document, create_document, update_document, delete_document,
    set_document_collections, set_document_tags, get_document_by_hash
)
from core.library.collections import list_collections, create_collection, update_collection, delete_collection, get_collection
from core.library.tags import list_tags, create_tag, delete_tag, update_tag, get_tag
from core.ingestion.deduplication import check_duplicates, normalize_title, DOI_RE
from core.ingestion.classifier import classify_document_type, suggest_collection

# Conversation memory (research page "Memory" toggle) - reuses conversation.py.
# Per-session, NOT global: each chat/tab sends its own session_id (the
# frontend uses its chat id), so two chats never see each other's turns
# and one chat's on/off toggle can't flip another's. Sessions missing
# from a request fall back to "default", preserving single-user behavior
# for old clients (CLI, browser extension, smoke tests).
from conversation import ConversationMemory
from config import MAX_HISTORY_TURNS

_memory_lock = threading.Lock()
_memories: dict[str, ConversationMemory] = {}
_DEFAULT_SESSION = "default"
_MAX_SESSIONS = 50


def _sanitize_session_id(raw) -> str:
    """Keep session keys small and safe: alnum/dash/underscore, max 64
    chars. Anything else falls back to "default" so a malicious client
    can't grow the dict with unbounded distinct keys."""
    if not isinstance(raw, str) or not raw:
        return _DEFAULT_SESSION
    cleaned = re.sub(r"[^A-Za-z0-9_-]", "", raw.strip())[:64]
    return cleaned or _DEFAULT_SESSION


def _get_memory(session_id) -> ConversationMemory:
    """Return the memory for one session, creating it on first use.
    Evicts the oldest session past _MAX_SESSIONS (local app: bounds RAM
    if a client ever sends random ids per request)."""
    sid = _sanitize_session_id(session_id)
    with _memory_lock:
        mem = _memories.get(sid)
        if mem is None:
            if len(_memories) >= _MAX_SESSIONS:
                _memories.pop(next(iter(_memories)))
            mem = ConversationMemory(max_turns=MAX_HISTORY_TURNS)
            _memories[sid] = mem
        return mem

# Reuse existing engine where possible
try:
    from config import PERSIST_DIR, DOC_FOLDER, EMBED_MODEL, EMBED_PROVIDER, RAG_MODEL, RAG_PROVIDER, THINKING_AVAILABLE
    from ingestion import get_indexed_documents
    from retrieval import HybridIndex
    from llm_client import make_embeddings
    from langchain_chroma import Chroma
    HAS_ENGINE = True
except Exception as e:
    print(f"[server] engine import warning: {e}")
    HAS_ENGINE = False

PROJECT_ROOT = Path(__file__).resolve().parent
DATA_ROOT = PROJECT_ROOT / "research_workbench" / "data"

app = FastAPI(title="Academic Research Workbench", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    # Local-first: only the bundled Next.js dev server and the extension's
    # localhost origins are allowed. "*" + credentials is rejected by
    # browsers anyway; explicit origins keep it working AND scoped.
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# init DB on startup
init_db()
ensure_dirs()

# mount static file serving for stored documents (for PDF reader)
# Only the documents/ subtree is exposed - never DATA_ROOT itself, which
# also holds library.db, backups/, exports/ and cache/. (The frontend
# reads PDFs via /api/library/documents/{id}/file; /files/ only stays
# for any previously shared /files/ab/cd/<hash>.pdf links.)
if (DATA_ROOT / "documents").exists():
    try:
        app.mount("/files", StaticFiles(directory=str(DATA_ROOT / "documents")), name="files")
    except Exception:
        pass

# ------------------------------------------------------------------
# Models
# ------------------------------------------------------------------
class DocumentPatch(BaseModel):
    title: Optional[str] = None
    doi: Optional[str] = None
    year: Optional[int] = None
    journal: Optional[str] = None
    jurisdiction: Optional[str] = None
    document_type: Optional[str] = None
    abstract: Optional[str] = None
    authors: Optional[List[str]] = None
    metadata: Optional[dict] = None

class CollectionCreate(BaseModel):
    name: str
    description: str = ""
    color: str = "#6366f1"

class CollectionPatch(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = None

class TagCreate(BaseModel):
    name: str
    color: str = "#8b5cf6"

class TagPatch(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None

class AskRequest(BaseModel):
    query: str
    document_ids: Optional[List[int]] = None
    collection_id: Optional[int] = None
    project_id: Optional[int] = None
    broad: bool = False
    thinking: bool = False
    use_memory: bool = True
    clear_memory: bool = False
    hybrid_mode: str = "off"  # off | low | medium | high | maximum
    session_id: str = "default"  # chat/tab scope for conversation memory

class CompareRequest(BaseModel):
    query: str
    document_ids: List[int]

class SummarizeRequest(BaseModel):
    document_id: int
    mode: str = "auto"  # auto | extract | findings | limitations
    export_format: Optional[str] = None  # None | "pdf" | "html": render the SAME summary to a file, no second LLM run

class IngestConfirm(BaseModel):
    temp_id: str
    title: str
    authors: List[str] = []
    year: Optional[int] = None
    doi: Optional[str] = None
    journal: Optional[str] = None
    jurisdiction: Optional[str] = None
    document_type: Optional[str] = None
    abstract: Optional[str] = None
    volume: Optional[str] = None
    issue: Optional[str] = None
    pages: Optional[str] = None
    publisher: Optional[str] = None
    citation_metadata: Optional[dict] = None
    metadata_source: Optional[str] = None
    metadata_confidence: Optional[float] = None
    metadata_verified: bool = True
    collection_ids: List[int] = []
    tag_ids: List[int] = []
    action: str = "accept"  # accept | cancel

# in-memory temp store for preview -> confirm flow.
# Bounded: entries expire after _PREVIEW_TTL_S and the dict is capped at
# _PREVIEW_MAX_ENTRIES, so abandoned previews (user closes the tab
# mid-upload) can't pin raw file bytes in RAM forever.
_preview_store: dict[str, dict] = {}
_preview_lock = threading.Lock()
_MAX_UPLOAD_BYTES = 150 * 1024 * 1024
_UPLOAD_CHUNK = 1024 * 1024  # 1MB streaming reads
_PREVIEW_TTL_S = 30 * 60
_PREVIEW_MAX_ENTRIES = 20


async def _read_upload_capped(file: UploadFile) -> bytes:
    """Stream an upload in 1MB chunks, aborting as soon as it exceeds
    _MAX_UPLOAD_BYTES - the old `await file.read()` buffered the whole
    body (GBs included) BEFORE the size check ran."""
    chunks = []
    total = 0
    while True:
        piece = await file.read(_UPLOAD_CHUNK)
        if not piece:
            break
        total += len(piece)
        if total > _MAX_UPLOAD_BYTES:
            raise HTTPException(400, "File too large (max 150MB)")
        chunks.append(piece)
    return b"".join(chunks)


def _preview_put(temp_id: str, entry: dict):
    """Store one preview entry, evicting expired/oldest first. Must hold
    _preview_lock in the caller for check-then-insert atomicity - this
    helper assumes it."""
    now = datetime.now(timezone.utc).timestamp()
    expired = [k for k, v in _preview_store.items() if now - v.get("created_at", now) > _PREVIEW_TTL_S]
    for k in expired:
        _preview_store.pop(k, None)
    while len(_preview_store) >= _PREVIEW_MAX_ENTRIES:
        _preview_store.pop(next(iter(_preview_store)))
    entry["created_at"] = now
    _preview_store[temp_id] = entry


def _preview_pop(temp_id: str):
    """Take an entry, treating expired ones as missing."""
    with _preview_lock:
        entry = _preview_store.pop(temp_id, None)
    if entry is None:
        return None
    if datetime.now(timezone.utc).timestamp() - entry.get("created_at", 0) > _PREVIEW_TTL_S:
        return None
    return entry


def _sweep_expired_previews():
    with _preview_lock:
        now = datetime.now(timezone.utc).timestamp()
        for k in [k for k, v in _preview_store.items() if now - v.get("created_at", now) > _PREVIEW_TTL_S]:
            _preview_store.pop(k, None)

# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------
def _pdf_page_count(data: bytes):
    """Page count without touching disk (fitz opens from bytes) and
    without leaking the handle."""
    import pymupdf as fitz
    doc = None
    try:
        doc = fitz.open(stream=data, filetype="pdf")
        return len(doc)
    finally:
        if doc is not None:
            try:
                doc.close()
            except Exception:
                pass


def _pdf_head_text(data: bytes, max_pages: int):
    """Extract text from the first `max_pages` of PDF `data`. Never leaks
    the temp file or the fitz handle: both are released in finally blocks
    even when open()/get_text() raises."""
    import pymupdf as fitz
    tmp_path = None
    doc = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
            tmp.write(data)
            tmp_path = tmp.name
        doc = fitz.open(tmp_path)
        return "\n".join(page.get_text() for page in doc[:max_pages]) + "\n"
    finally:
        if doc is not None:
            try:
                doc.close()
            except Exception:
                pass
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass


def _extract_meta_from_bytes(filename: str, data: bytes) -> dict:
    """Cheap deterministic extraction: filename, DOI, year, jurisdiction."""
    meta = {}
    # Try to extract text snippet for classification (first 8000 chars)
    text_snippet = ""
    # For PDFs, try pymupdf; for others, decode
    ext = Path(filename).suffix.lower()
    if ext == ".pdf":
        try:
            text_snippet = _pdf_head_text(data, 2)
        except Exception:
            text_snippet = ""
    else:
        try:
            text_snippet = data[:8000].decode("utf-8", errors="ignore")
        except Exception:
            text_snippet = ""

    # Year
    try:
        from metadata_extraction import _extract_year_from_text
        year = _extract_year_from_text(text_snippet[:5000])
        meta["year"] = year
    except Exception:
        meta["year"] = None

    # Jurisdiction
    try:
        from jurisdiction_extraction import match_jurisdiction
        jur = match_jurisdiction(text_snippet[:5000])
        meta["jurisdiction"] = jur
    except Exception:
        meta["jurisdiction"] = None

    # DOI
    doi_match = DOI_RE.search(text_snippet) if text_snippet else None
    if doi_match:
        meta["doi"] = doi_match.group(0).lower()
    else:
        # also check filename?
        m2 = DOI_RE.search(filename)
        meta["doi"] = m2.group(0).lower() if m2 else None

    # page count heuristic
    if ext == ".pdf":
        try:
            meta["page_count"] = _pdf_page_count(data)
        except Exception:
            meta["page_count"] = None
    else:
        meta["page_count"] = 1

    # mime
    mime, _ = mimetypes.guess_type(filename)
    meta["mime_type"] = mime or "application/octet-stream"
    meta["text_snippet"] = text_snippet[:6000]
    return meta

# One lock for every Chroma read-modify-write and every direct write
# (ingest confirm, pfolder watch sync, reindex swap): Chroma-over-SQLite
# is not safe for concurrent writers, and the old code let the watch
# thread and request handlers write simultaneously. RLock (not Lock)
# because _get_vectorstore() also takes it and is called with it held.
_chroma_lock = threading.RLock()
_vs_singleton = None


def _get_vectorstore():
    """Return the shared Chroma client, creating it once on first use.

    Why shared: chromadb's PersistentClient holds its own SQLite handle
    and has no close() in v1.5, so a fresh client per request (health
    probes included) grew handles without bound and fed 'database is
    locked' under concurrent read+write. One process-wide client bounds
    that to a single handle.

    Locking discipline (learned the hard way): the cached-hit fast path
    below takes NO lock. An earlier version locked every call, which meant
    a minutes-long ingest (lock held across add_documents+embedding)
    stalled every read endpoint including /api/health. Creation alone is
    guarded (double-checked), and only writers (ingest confirm, watch
    sync) hold _chroma_lock across mutations."""
    global _vs_singleton
    if not HAS_ENGINE:
        return None
    vs = _vs_singleton
    if vs is not None:
        return vs
    with _chroma_lock:
        if _vs_singleton is not None:
            return _vs_singleton
        try:
            embeddings = make_embeddings(EMBED_MODEL, EMBED_PROVIDER)
            if not os.path.exists(PERSIST_DIR) or not os.listdir(PERSIST_DIR):
                return None
            _vs_singleton = Chroma(persist_directory=PERSIST_DIR, embedding_function=embeddings)
            return _vs_singleton
        except Exception as e:
            print(f"[server] vectorstore unavailable: {e}")
            return None


def _drop_vectorstore():
    """Forget the cached client so the next _get_vectorstore() rebuilds
    it. Called after writes that replace (rather than append to) the
    collection, so readers never sit on a stale handle."""
    global _vs_singleton
    with _chroma_lock:
        _vs_singleton = None


# ------------------------------------------------------------------
# Health & Stats
# ------------------------------------------------------------------


def _is_strict_offline() -> bool:
    """Read the strict_offline_mode setting; network metadata providers are
    skipped when it's on (the setting is meant to block all non-localhost
    requests)."""
    try:
        conn = get_connection()
        try:
            row = conn.execute("SELECT value FROM settings WHERE key='strict_offline_mode'").fetchone()
            return bool(row) and str(row["value"]).strip().lower() == "true"
        finally:
            conn.close()
    except Exception:
        return False

# ------------------------------------------------------------------
# Health & Stats
# ------------------------------------------------------------------
@app.get("/api/health")
def health():
    conn = get_connection()
    try:
        doc_count = conn.execute("SELECT COUNT(*) as c FROM documents").fetchone()["c"]
        col_count = conn.execute("SELECT COUNT(*) as c FROM collections").fetchone()["c"]
        tag_count = conn.execute("SELECT COUNT(*) as c FROM tags").fetchone()["c"]
    finally:
        conn.close()
    vs_status = "unavailable"
    chroma_count = 0
    if HAS_ENGINE:
        try:
            vs = _get_vectorstore()
            if vs:
                res = vs.get(include=["metadatas"])
                chroma_count = len(res.get("metadatas", []))
                vs_status = "ready"
            else:
                vs_status = "empty"
        except Exception as e:
            vs_status = f"error: {e}"
    return {
        "status": "ok",
        "documents": doc_count,
        "collections": col_count,
        "tags": tag_count,
        "chroma_chunks": chroma_count,
        "chroma_status": vs_status,
        "engine": HAS_ENGINE,
    }

@app.get("/api/config")
def api_config():
    """Effective chat (RAG) config — Ollama-only.

    Returns the model, context length and generation options that the
    Research > Ask chat is actually using (DB overrides merged with
    config.py defaults). `thinking_available` is always True on Ollama.
    """
    from config import get_chat_config

    chat_cfg = get_chat_config()
    return {
        "rag_provider": RAG_PROVIDER,
        "rag_model": chat_cfg["model"],
        "rag_model_default": RAG_MODEL,
        "thinking_available": bool(THINKING_AVAILABLE),
        "chat": chat_cfg,
    }


@app.put("/api/config")
def api_update_config(body: dict):
    """Update chat-related settings (Ollama 26B customizations).

    Accepted keys: chat_model, chat_num_ctx, chat_ctx_safety_margin,
    chat_temperature, chat_num_predict. Values are stored as strings in
    the `settings` table and take effect on the next chat request.
    """
    allowed = {"chat_model", "chat_num_ctx", "chat_ctx_safety_margin", "chat_temperature", "chat_num_predict"}
    # sanitize / validate
    updates: dict[str, str] = {}
    for k in allowed:
        if k in body:
            v = body[k]
            # Normalize to string; empty string clears the override
            if v is None:
                v = ""
            else:
                v = str(v).strip()
            # basic validation for numeric fields
            if k in ("chat_num_ctx", "chat_ctx_safety_margin", "chat_num_predict") and v != "":
                try:
                    iv = int(v)
                    if iv < 0 or iv > 200000:
                        raise ValueError
                except Exception:
                    raise HTTPException(400, f"Invalid value for {k}: {v!r} — expected integer")
            if k == "chat_temperature" and v != "":
                try:
                    fv = float(v)
                    if fv < 0 or fv > 2:
                        raise ValueError
                except Exception:
                    raise HTTPException(400, f"Invalid value for {k}: {v!r} — expected float 0..2")
            updates[k] = v

    if not updates:
        raise HTTPException(400, "No chat config keys provided")

    conn = get_connection()
    try:
        for k, v in updates.items():
            conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?,?)", (k, v))
        conn.commit()
    finally:
        conn.close()

    # return the new effective config
    from config import get_chat_config

    chat_cfg = get_chat_config()
    return {
        "rag_provider": RAG_PROVIDER,
        "rag_model": chat_cfg["model"],
        "thinking_available": bool(THINKING_AVAILABLE),
        "chat": chat_cfg,
        "updated": updates,
    }

@app.get("/api/library/stats")
def library_stats():
    conn = get_connection()
    try:
        docs = conn.execute("SELECT document_type, COUNT(*) as c FROM documents GROUP BY document_type").fetchall()
        by_type = {r["document_type"] or "unknown": r["c"] for r in docs}
        years = conn.execute("SELECT year, COUNT(*) as c FROM documents WHERE year IS NOT NULL GROUP BY year ORDER BY year").fetchall()
        by_year = [{"year": r["year"], "count": r["c"]} for r in years]
        total = conn.execute("SELECT COUNT(*) as c FROM documents").fetchone()["c"]
        recent = conn.execute("SELECT * FROM documents ORDER BY created_at DESC LIMIT 5").fetchall()
        recent_list = [dict_from_row(r) for r in recent]
    finally:
        conn.close()
    return {"total": total, "by_type": by_type, "by_year": by_year, "recent": recent_list}

# ------------------------------------------------------------------
# Documents
# ------------------------------------------------------------------
@app.get("/api/library/documents")
def api_list_documents(
    q: Optional[str] = Query(None),
    collection_id: Optional[int] = Query(None),
    tag_id: Optional[int] = Query(None),
    year: Optional[int] = Query(None),
    doc_type: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    docs, total = list_documents(q=q, collection_id=collection_id, tag_id=tag_id, year=year, doc_type=doc_type, limit=limit, offset=offset)
    return {"documents": docs, "total": total, "limit": limit, "offset": offset}

@app.get("/api/library/documents/{doc_id}")
def api_get_document(doc_id: int):
    doc = get_document(doc_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    return doc

@app.patch("/api/library/documents/{doc_id}")
def api_update_document(doc_id: int, patch: DocumentPatch):
    data = {k: v for k, v in patch.model_dump().items() if v is not None}
    doc = update_document(doc_id, data)
    if not doc:
        raise HTTPException(404, "Document not found")
    return doc

@app.delete("/api/library/documents/{doc_id}")
def api_delete_document(doc_id: int):
    ok = delete_document(doc_id)
    if not ok:
        raise HTTPException(404, "Document not found")
    return {"ok": True}

@app.post("/api/library/documents/{doc_id}/collections")
def api_set_collections(doc_id: int, body: dict):
    ids = body.get("collection_ids", [])
    if not get_document(doc_id):
        raise HTTPException(404, "Document not found")
    set_document_collections(doc_id, ids)
    return get_document(doc_id)

@app.post("/api/library/documents/{doc_id}/tags")
def api_set_tags(doc_id: int, body: dict):
    ids = body.get("tag_ids", [])
    if not get_document(doc_id):
        raise HTTPException(404, "Document not found")
    set_document_tags(doc_id, ids)
    return get_document(doc_id)

@app.get("/api/library/documents/{doc_id}/file")
def api_serve_file(doc_id: int):
    doc = get_document(doc_id)
    if not doc or not doc.get("stored_path"):
        raise HTTPException(404, "File not found")
    abs_path = resolve_stored_path(doc["stored_path"])
    if not abs_path.exists():
        raise HTTPException(404, "File missing on disk")
    return FileResponse(str(abs_path), filename=doc["original_filename"])

# ------------------------------------------------------------------
# Ingestion: preview + confirm (AI proposes, human confirms)
# ------------------------------------------------------------------
@app.post("/api/ingest/preview")
async def api_ingest_preview(file: UploadFile = File(...)):
    data = await _read_upload_capped(file)
    if not data:
        raise HTTPException(400, "Empty file")
    filename = file.filename or "upload.bin"
    ext = Path(filename).suffix.lower()
    # validation
    from config import SUPPORTED_DOC_EXTENSIONS
    if ext not in SUPPORTED_DOC_EXTENSIONS:
        raise HTTPException(400, f"Unsupported file type {ext}. Supported: {SUPPORTED_DOC_EXTENSIONS}")

    file_hash = compute_sha256_bytes(data)
    meta = _extract_meta_from_bytes(filename, data)

    # duplicate check against existing library
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM documents").fetchall()
        existing = []
        for r in rows:
            d = dict_from_row(r)
            # hydrate authors for dedup
            authors = conn.execute("SELECT a.name FROM authors a JOIN document_authors da ON da.author_id=a.id WHERE da.document_id=? ORDER BY da.author_order", (d["id"],)).fetchall()
            d["authors"] = [a["name"] for a in authors]
            existing.append(d)
        collections = [dict_from_row(r) for r in conn.execute("SELECT * FROM collections").fetchall()]
    finally:
        conn.close()

    proposed = {
        "file_hash": file_hash,
        "doi": meta.get("doi"),
        "title": Path(filename).stem.replace("_", " ").replace("-", " ").strip() or filename,
        "authors": [],
        "year": meta.get("year"),
    }
    duplicates = check_duplicates(proposed, existing)

    # classification (deterministic)
    doc_type, type_conf = classify_document_type(meta.get("text_snippet") or "", filename)
    suggested_col, coll_conf, coll_reason = suggest_collection(doc_type, meta.get("jurisdiction"), meta.get("year"), collections)

    # thresholds (configurable)
    conn2 = get_connection()
    try:
        th_high = float(conn2.execute("SELECT value FROM settings WHERE key='auto_organize_threshold_high'").fetchone()["value"])
        th_low = float(conn2.execute("SELECT value FROM settings WHERE key='auto_organize_threshold_low'").fetchone()["value"])
    except Exception:
        th_high, th_low = 0.85, 0.60
    finally:
        conn2.close()

    # decide auto-suggest vs ask
    if coll_conf >= th_high:
        decision = "auto_suggest"
    elif coll_conf >= th_low:
        decision = "confirm"
    else:
        decision = "create_new"

    # --- Automated metadata fetching (Phase 1) --------------------------
    # DOI -> OpenAlex lookup; otherwise title search + fuzzy candidates.
    # Strict offline mode skips all network providers. Any failure degrades
    # to the local deterministic extraction - ingestion never blocks on it.
    offline = _is_strict_offline()
    try:
        from core.metadata.providers import fetch_metadata

        meta_proposal, meta_candidates, meta_error = await fetch_metadata(
            doi=meta.get("doi"),
            title=proposed["title"],
            local_fields={
                "title": proposed["title"],
                "doi": meta.get("doi"),
                "year": meta.get("year"),
                "jurisdiction": meta.get("jurisdiction"),
                "document_type": doc_type,
            },
            offline=offline,
        )
    except Exception as e:
        meta_proposal, meta_candidates, meta_error = None, [], f"metadata provider error: {e}"

    temp_id = hashlib.sha256(f"{file_hash}{filename}{datetime.now(timezone.utc).isoformat()}".encode()).hexdigest()[:16]
    with _preview_lock:
        _preview_put(temp_id, {
            "filename": filename,
            "data": data,
            "file_hash": file_hash,
            "meta": meta,
            "proposed": proposed,
            "doc_type": doc_type,
            "type_conf": type_conf,
            "suggested_collection": suggested_col,
            "coll_conf": coll_conf,
            "coll_reason": coll_reason,
            "decision": decision,
            "metadata_proposal": meta_proposal,
            "metadata_candidates": meta_candidates,
            "metadata_error": meta_error,
            "offline": offline,
        })

    return {
        "temp_id": temp_id,
        "filename": filename,
        "file_hash": file_hash,
        "file_size": len(data),
        "mime_type": meta.get("mime_type"),
        "page_count": meta.get("page_count"),
        "extracted": {
            "title": proposed["title"],
            "doi": meta.get("doi"),
            "year": meta.get("year"),
            "jurisdiction": meta.get("jurisdiction"),
            "document_type": doc_type,
            "type_confidence": type_conf,
        },
        "metadata_proposal": meta_proposal,
        "metadata_candidates": meta_candidates or [],
        "metadata_error": meta_error,
        "offline": offline,
        "duplicates": [{"id": d["document"]["id"], "title": d["document"]["title"], "reason": d["reason"], "label": d["label"], "confidence": d["confidence"]} for d in duplicates],
        "is_duplicate": len([d for d in duplicates if d["confidence"] >= 0.92]) > 0,
        "suggested_collection": suggested_col,
        "collection_confidence": coll_conf,
        "collection_reason": coll_reason,
        "decision": decision,
        "thresholds": {"high": th_high, "low": th_low},
        "text_snippet": (meta.get("text_snippet") or "")[:1200],
    }

@app.post("/api/ingest/confirm")
def api_ingest_confirm(body: IngestConfirm):
    preview = _preview_pop(body.temp_id)
    if not preview:
        raise HTTPException(404, "Preview expired or not found. Re-upload the file.")
    if body.action == "cancel":
        return {"ok": True, "cancelled": True}

    # duplicate block: if exact hash duplicate already exists, reject unless forced.
    # NOTE check-then-insert race: two concurrent confirms can both pass this
    # check. The backstop is the UNIQUE(file_hash) schema constraint - the
    # loser gets an IntegrityError from create_document below, surfaced as
    # 409 rather than a duplicate row.
    existing = get_document_by_hash(preview["file_hash"])
    if existing:
        raise HTTPException(409, f"Duplicate file already exists as document #{existing['id']} ({existing['title']})")

    # persist file to content-addressed storage
    dest, file_hash, rel = save_uploaded_file(preview["data"], preview["filename"], preview["file_hash"])

    # Build doc record
    meta = preview["meta"]
    # page count from meta
    # Metadata provenance: the user has just explicitly confirmed (or
    # edited) this metadata, so record where it came from. A rejected
    # proposal falls back to local extraction (source "local").
    metadata_source = (body.metadata_source or "local").strip() or "local"
    doc_data = {
        "title": body.title.strip() or preview["proposed"]["title"],
        "original_filename": preview["filename"],
        "stored_path": rel,
        "file_hash": file_hash,
        "file_size": len(preview["data"]),
        "mime_type": meta.get("mime_type"),
        "doi": body.doi or meta.get("doi"),
        "year": body.year if body.year is not None else meta.get("year"),
        "journal": body.journal,
        "jurisdiction": body.jurisdiction or meta.get("jurisdiction"),
        "document_type": body.document_type or preview["doc_type"],
        "page_count": meta.get("page_count"),
        "abstract": body.abstract,
        "volume": body.volume,
        "issue": body.issue,
        "pages": body.pages,
        "publisher": body.publisher,
        "citation_metadata": body.citation_metadata or {},
        "metadata_source": metadata_source,
        "metadata_fetched_at": (
            datetime.now(timezone.utc).isoformat() if metadata_source != "local" else None
        ),
        "metadata_confidence": body.metadata_confidence,
        "metadata_verified": 1 if body.metadata_verified else 0,
        "ingestion_status": "ready",
        "metadata_json": json.dumps({"text_snippet": meta.get("text_snippet","")[:2000]}),
        "authors_list": body.authors,
    }
    try:
        doc = create_document(doc_data)
    except Exception as e:
        if "UNIQUE" in str(e) and "file_hash" in str(e):
            raise HTTPException(409, "Duplicate file was just imported by a concurrent request.")
        raise
    if body.collection_ids:
        set_document_collections(doc["id"], body.collection_ids)
    if body.tag_ids:
        set_document_tags(doc["id"], body.tag_ids)

    # embed + index into Chroma (best-effort, non-blocking)
    indexing_error = None
    if HAS_ENGINE:
        try:
            # reuse ingestion._load_document logic for this single file
            from ingestion import _load_document, _sanitize_text
            from langchain_text_splitters import RecursiveCharacterTextSplitter
            from pinpoint_detection import tag_chunks_with_pinpoints
            from config import CHUNK_SIZE, CHUNK_OVERLAP
            import tempfile, os
            # _load_document expects a path; write temp
            with tempfile.NamedTemporaryFile(delete=False, suffix=Path(preview["filename"]).suffix) as tmp:
                tmp.write(preview["data"])
                tmp_path = tmp.name
            try:
                docs = _load_document(tmp_path)
                # fix source to be stored path (so retrieval maps back)
                stored_abs = str(resolve_stored_path(rel))
                for d in docs:
                    d.metadata["source"] = stored_abs
                if docs:
                    splitter = RecursiveCharacterTextSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP)
                    splits = splitter.split_documents(docs)
                    tag_chunks_with_pinpoints(splits)
                    # Serialized with the pfolder watch sync: Chroma/SQLite
                    # can't take concurrent writers, and the chunk_index
                    # offset below is a read-modify-write that two racing
                    # confirms would compute identically.
                    global _vs_singleton
                    with _chroma_lock:
                        vs = _get_vectorstore()
                        if vs is None:
                            # need to create new store
                            for i, ch in enumerate(splits):
                                ch.metadata["chunk_index"] = i
                            embeddings = make_embeddings(EMBED_MODEL, EMBED_PROVIDER)
                            from langchain_chroma import Chroma
                            vs = Chroma.from_documents(documents=splits, embedding=embeddings, persist_directory=PERSIST_DIR)
                            _vs_singleton = vs
                        else:
                            # continue chunk_index from the highest one
                            # already in the store (see ingestion.sync_new_files)
                            try:
                                existing_meta = (vs.get(include=["metadatas"]) or {}).get("metadatas") or []
                                nxt = max((m.get("chunk_index", -1) for m in existing_meta if m), default=-1) + 1
                            except Exception:
                                nxt = 0
                            for i, ch in enumerate(splits):
                                ch.metadata["chunk_index"] = nxt + i
                            vs.add_documents(splits)
                conn = get_connection()
                try:
                    conn.execute("UPDATE documents SET ingestion_status='ready', ingestion_error=NULL WHERE id=?", (doc["id"],))
                    conn.commit()
                finally:
                    conn.close()
            finally:
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass
        except Exception as e:
            indexing_error = str(e)
            conn = get_connection()
            try:
                conn.execute("UPDATE documents SET ingestion_status='error', ingestion_error=? WHERE id=?", (indexing_error[:2000], doc["id"]))
                conn.commit()
            finally:
                conn.close()

    with _preview_lock:
        _preview_store.pop(body.temp_id, None)
    fresh = get_document(doc["id"])
    return {"document": fresh, "indexing_error": indexing_error}

@app.post("/api/library/documents/upload")
async def api_upload_direct(file: UploadFile = File(...), title: str = Form(None), collection_ids: str = Form(""), tag_ids: str = Form("")):
    """Simple direct upload (legacy compat) — wraps preview+confirm with defaults."""
    import asyncio
    preview_resp = await api_ingest_preview(file)
    # auto-confirm with defaults
    coll_ids = [int(x) for x in collection_ids.split(",") if x.strip().isdigit()] if collection_ids else []
    if preview_resp.get("suggested_collection") and not coll_ids:
        coll_ids = [preview_resp["suggested_collection"]["id"]]
    t_ids = [int(x) for x in tag_ids.split(",") if x.strip().isdigit()] if tag_ids else []
    confirm = IngestConfirm(
        temp_id=preview_resp["temp_id"],
        title=title or preview_resp["extracted"]["title"],
        year=preview_resp["extracted"]["year"],
        doi=preview_resp["extracted"]["doi"],
        jurisdiction=preview_resp["extracted"]["jurisdiction"],
        document_type=preview_resp["extracted"]["document_type"],
        collection_ids=coll_ids,
        tag_ids=t_ids,
        action="accept"
    )
    # confirm is sync (embedding + Chroma take minutes): run it in a worker
    # thread so the event loop stays responsive. The old code called it
    # inline, freezing every other request until indexing finished.
    return await asyncio.to_thread(api_ingest_confirm, confirm)

# ------------------------------------------------------------------
# Collections & Tags
# ------------------------------------------------------------------
@app.get("/api/library/collections")
def api_list_collections():
    return list_collections()

@app.post("/api/library/collections")
def api_create_collection(body: CollectionCreate):
    if not body.name.strip():
        raise HTTPException(400, "Name required")
    try:
        return create_collection(body.name, body.description, body.color)
    except Exception as e:
        if "UNIQUE" in str(e):
            raise HTTPException(409, "Collection already exists")
        raise

@app.patch("/api/library/collections/{cid}")
def api_patch_collection(cid: int, body: CollectionPatch):
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    doc = update_collection(cid, patch)
    if not doc:
        raise HTTPException(404, "Not found")
    return doc

@app.delete("/api/library/collections/{cid}")
def api_delete_collection(cid: int):
    ok = delete_collection(cid)
    if not ok:
        raise HTTPException(404, "Not found")
    return {"ok": True}

@app.get("/api/library/tags")
def api_list_tags():
    return list_tags()

@app.post("/api/library/tags")
def api_create_tag(body: TagCreate):
    if not body.name.strip():
        raise HTTPException(400, "Name required")
    try:
        return create_tag(body.name, body.color)
    except Exception as e:
        if "UNIQUE" in str(e):
            raise HTTPException(409, "Tag already exists")
        raise

@app.patch("/api/library/tags/{tid}")
def api_patch_tag(tid: int, body: TagPatch):
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    doc = update_tag(tid, patch)
    if not doc:
        raise HTTPException(404, "Not found")
    return doc

@app.delete("/api/library/tags/{tid}")
def api_delete_tag(tid: int):
    ok = delete_tag(tid)
    if not ok:
        raise HTTPException(404, "Not found")
    return {"ok": True}

# ------------------------------------------------------------------
# Search (global search spec: Documents / Passages / Authors / Collections / Tags)
# ------------------------------------------------------------------
@app.get("/api/search")
def api_search(q: str = Query(..., min_length=1), limit: int = Query(20, ge=1, le=100)):
    """
    Single search box, results grouped into Documents / Passages / Authors / Collections / Tags.
    Supports structured filters: author:"John Smith", year:2024, tag:constitutional-law, collection:"Legal Theory"
    """
    original_q = q
    # parse structured filters
    filters = {}
    # author:"..."
    for m in re.finditer(r'author:\s*"([^"]+)"', q):
        filters["author"] = m.group(1)
    for m in re.finditer(r'author:\s*([^\s"]+)', q):
        if "author" not in filters:
            filters["author"] = m.group(1)
    year_m = re.search(r'year:\s*(\d{4})', q)
    if year_m:
        filters["year"] = int(year_m.group(1))
    tag_m = re.search(r'tag:\s*"([^"]+)"', q)
    if tag_m:
        filters["tag"] = tag_m.group(1)
    else:
        tag_m2 = re.search(r'tag:\s*([^\s"]+)', q)
        if tag_m2:
            filters["tag"] = tag_m2.group(1)
    col_m = re.search(r'collection:\s*"([^"]+)"', q)
    if col_m:
        filters["collection"] = col_m.group(1)
    else:
        col_m2 = re.search(r'collection:\s*([^\s"]+)', q)
        if col_m2:
            filters["collection"] = col_m2.group(1)
    # strip filters from query to get free text
    clean_q = re.sub(r'(author|year|tag|collection):\s*("[^"]+"|[^\s"]+)', '', q).strip()
    if not clean_q:
        clean_q = q  # fallback

    conn = get_connection()
    try:
        # Documents
        doc_sql = "SELECT * FROM documents WHERE 1=1"
        doc_params = []
        if clean_q and clean_q != original_q or not filters:
            # free text search on title/filename/journal
            doc_sql += " AND (title LIKE ? OR original_filename LIKE ? OR journal LIKE ? OR jurisdiction LIKE ?)"
            like = f"%{clean_q}%"
            doc_params.extend([like, like, like, like])
        if filters.get("year"):
            doc_sql += " AND year=?"
            doc_params.append(filters["year"])
        if filters.get("collection"):
            # filter by collection name
            doc_sql = "SELECT d.* FROM documents d JOIN document_collections dc ON dc.document_id=d.id JOIN collections c ON c.id=dc.collection_id WHERE c.name LIKE ?"
            doc_params = [f"%{filters['collection']}%"]
            if clean_q:
                doc_sql += " AND (d.title LIKE ? OR d.original_filename LIKE ?)"
                like = f"%{clean_q}%"
                doc_params.extend([like, like])
        # tag filter
        if filters.get("tag"):
            # need join
            tag_rows = conn.execute("SELECT id FROM tags WHERE name LIKE ?", (f"%{filters['tag']}%",)).fetchall()
            tag_ids = [r["id"] for r in tag_rows]
            if tag_ids:
                placeholders = ",".join("?" for _ in tag_ids)
                # intersect with doc_sql if already filtered
                # simpler: do separate query for tag-filtered docs
                tag_docs = conn.execute(f"SELECT d.* FROM documents d JOIN document_tags dt ON dt.document_id=d.id WHERE dt.tag_id IN ({placeholders})", tag_ids).fetchall()
                tag_doc_ids = {r["id"] for r in tag_docs}
                # filter doc results to those in tag_doc_ids
                # fetch doc results first then filter
                pass

        doc_rows = conn.execute(doc_sql + " ORDER BY updated_at DESC LIMIT ?", doc_params + [limit]).fetchall()
        documents = [dict_from_row(r) for r in doc_rows]
        # hydrate authors for docs
        for d in documents:
            authors = conn.execute("SELECT a.name FROM authors a JOIN document_authors da ON da.author_id=a.id WHERE da.document_id=? ORDER BY da.author_order", (d["id"],)).fetchall()
            d["authors"] = [a["name"] for a in authors]
            # tags/collections quick
            tags = conn.execute("SELECT t.name FROM tags t JOIN document_tags dt ON dt.tag_id=t.id WHERE dt.document_id=?", (d["id"],)).fetchall()
            d["tag_names"] = [t["name"] for t in tags]
            cols = conn.execute("SELECT c.name FROM collections c JOIN document_collections dc ON dc.collection_id=c.id WHERE dc.document_id=?", (d["id"],)).fetchall()
            d["collection_names"] = [c["name"] for c in cols]

        # Authors
        author_like = f"%{clean_q}%"
        author_rows = conn.execute("SELECT * FROM authors WHERE name LIKE ? LIMIT ?", (author_like, limit)).fetchall()
        authors_out = [dict_from_row(r) for r in author_rows]

        # Collections
        col_rows = conn.execute("SELECT * FROM collections WHERE name LIKE ? LIMIT ?", (author_like, limit)).fetchall()
        collections_out = []
        for r in col_rows:
            d = dict_from_row(r)
            cnt = conn.execute("SELECT COUNT(*) as c FROM document_collections WHERE collection_id=?", (d["id"],)).fetchone()["c"]
            d["document_count"] = cnt
            collections_out.append(d)

        # Tags
        tag_rows2 = conn.execute("SELECT * FROM tags WHERE name LIKE ? LIMIT ?", (author_like, limit)).fetchall()
        tags_out = []
        for r in tag_rows2:
            d = dict_from_row(r)
            cnt = conn.execute("SELECT COUNT(*) as c FROM document_tags WHERE tag_id=?", (d["id"],)).fetchone()["c"]
            d["document_count"] = cnt
            tags_out.append(d)

    finally:
        conn.close()

    # Passages: hybrid retrieval if engine available
    passages = []
    if HAS_ENGINE and clean_q and len(clean_q) >= 2:
        try:
            vs = _get_vectorstore()
            if vs:
                hybrid = HybridIndex(vs)
                hybrid.refresh_bm25()
                fused = hybrid.hybrid_retrieve(clean_q, source_filter=None, broad=False)
                reranked = hybrid.rerank(clean_q, fused, top_n=8)
                for doc in reranked[:8]:
                    passages.append({
                        "text": doc.page_content[:600],
                        "source": doc.metadata.get("source"),
                        "page": doc.metadata.get("page", 0) + 1,
                        "section": doc.metadata.get("section"),
                        "score": None,
                    })
        except Exception as e:
            print(f"[search] passage retrieval failed: {e}")

    return {
        "query": original_q,
        "clean_query": clean_q,
        "filters": filters,
        "results": {
            "documents": documents,
            "passages": passages,
            "authors": authors_out,
            "collections": collections_out,
            "tags": tags_out,
        },
        "counts": {
            "documents": len(documents),
            "passages": len(passages),
            "authors": len(authors_out),
            "collections": len(collections_out),
            "tags": len(tags_out),
        }
    }

# ------------------------------------------------------------------
# Research: Ask / Summarize / Compare
# ------------------------------------------------------------------
@app.post("/api/research/ask")
def api_research_ask(body: AskRequest):
    if not body.query.strip():
        raise HTTPException(400, "Query required")
    if not HAS_ENGINE:
        raise HTTPException(503, "RAG engine not available (missing dependencies)")

    vs = _get_vectorstore()
    if not vs:
        raise HTTPException(503, "Vector store empty — upload and index documents first")

    from query_understanding import parse_query, Intent
    from filters import resolve_filter, build_source_filter
    from retrieval import HybridIndex, get_chunks_by_pages, sort_docs
    from generation import format_docs, format_compare_docs, generate_answer
    from conversation import ConversationMemory  # not needed persistently
    from research_trail import ResearchTrail, format_citation

    # Build a temporary doc_map from SQLite stored paths + legacy pfolder
    # For hybrid retrieval we need to use the Chroma store's metadata sources.
    # The DB stored_path resolves to absolute path which matches Chroma's source.
    # So we can just use Chroma's own doc_map.
    from ingestion import get_indexed_documents as legacy_get_docs, get_indexed_years, get_indexed_jurisdictions
    doc_map = get_indexed_documents(vs)
    doc_years = get_indexed_years(vs)
    doc_jurisdictions = get_indexed_jurisdictions(vs)

    # If project or collection filter, build source filter from selected doc_ids
    source_filter = None
    if body.document_ids:
        # map ids -> stored paths
        paths = []
        for did in body.document_ids:
            doc = get_document(did)
            if doc and doc.get("stored_path"):
                abs_p = str(resolve_stored_path(doc["stored_path"]))
                # also try legacy path if not in chroma yet (fallback to SQLite search)
                paths.append(abs_p)
                # also include the indexed path variant if different
                # Chroma may have stored legacy pfolder paths; include both
        # Find which paths actually exist in Chroma
        matched_sources = [p for p in paths if p in doc_map.values()]
        # if none matched (new docs not yet in Chroma via legacy), try to match by basename
        if not matched_sources:
            # fallback: try to find by filename
            for did in body.document_ids:
                doc = get_document(did)
                if not doc:
                    continue
                fname = doc["original_filename"]
                for rel, full in doc_map.items():
                    if fname.lower() in rel.lower() or fname.lower() in full.lower():
                        matched_sources.append(full)
            matched_sources = list(dict.fromkeys(matched_sources))
        if matched_sources:
            if len(matched_sources) == 1:
                source_filter = {"source": matched_sources[0]}
            else:
                source_filter = {"source": {"$in": matched_sources}}
    elif body.collection_id:
        conn = get_connection()
        try:
            rows = conn.execute("SELECT d.stored_path, d.original_filename FROM documents d JOIN document_collections dc ON dc.document_id=d.id WHERE dc.collection_id=?", (body.collection_id,)).fetchall()
            paths = [str(resolve_stored_path(r["stored_path"])) for r in rows if r["stored_path"]]
        finally:
            conn.close()
        matched = [p for p in paths if p in doc_map.values()]
        if matched:
            source_filter = {"source": {"$in": matched}} if len(matched) > 1 else {"source": matched[0]}

    # Parse query to detect intent, but for "Ask this doc/library" we force factual/broad
    try:
        plan = parse_query(body.query)
    except ValueError as e:
        raise HTTPException(400, str(e))

    hybrid = HybridIndex(vs)
    hybrid.refresh_bm25()

    # If project filter gave us source_filter, use it; otherwise use plan's filter resolution
    # We prioritize explicit source_filter from body over auto-detect
    if source_filter is not None:
        # use hybrid retrieval with that filter
        broad = body.broad or plan.intent == Intent.BROAD
        from config import HYBRID_TOP_N, BROAD_TOP_N, COMPARE_TOP_N_PER_SOURCE
        if plan.intent == Intent.PAGE_SPECIFIC and plan.page_numbers:
            retrieved = get_chunks_by_pages(vs, plan.page_numbers, source_filter)
            retrieved = hybrid.rerank(body.query, retrieved, top_n=None)
        else:
            # Multi-source (e.g. project with 6 journals): retrieve per-source
            # so every journal contributes. Single-source keeps the fast
            # global path. This is slower but guarantees coverage.
            sources = []
            v = source_filter.get("source")
            if isinstance(v, dict) and "$in" in v:
                sources = v["$in"]
            elif isinstance(v, str):
                sources = [v]
            if len(sources) > 1:
                per_n = COMPARE_TOP_N_PER_SOURCE if not broad else min(7, COMPARE_TOP_N_PER_SOURCE + 2)
                all_docs = []
                for src in sources:
                    f = hybrid.hybrid_retrieve(body.query, source_filter={"source": src}, broad=broad)
                    r = hybrid.rerank(body.query, f, top_n=per_n)
                    all_docs.extend(r)
                retrieved = sort_docs(all_docs)
                max_total = BROAD_TOP_N * 2 if broad else HYBRID_TOP_N * 3
                if len(retrieved) > max_total:
                    retrieved = hybrid.rerank(body.query, retrieved, top_n=max_total)
                    retrieved = sort_docs(retrieved)
            else:
                fused = hybrid.hybrid_retrieve(body.query, source_filter=source_filter, broad=broad)
                top_n = BROAD_TOP_N if broad else HYBRID_TOP_N
                retrieved = sort_docs(hybrid.rerank(body.query, fused, top_n=top_n))
    else:
        # use resolver (includes auto-detect of filenames/years)
        doc_count = len(doc_map)
        # need to handle page-specific branching like main.py
        from retrieval import HybridIndex as HI2
        if plan.intent == Intent.PAGE_SPECIFIC:
            source_filter2, matched, err = resolve_filter(plan, doc_map, doc_years, doc_jurisdictions)
            if err:
                raise HTTPException(404, err)
            if not source_filter2 and doc_count > 1:
                raise HTTPException(400, "Ambiguous page request — specify a document filter")
            retrieved = get_chunks_by_pages(vs, plan.page_numbers, source_filter2)
            retrieved = hybrid.rerank(body.query, retrieved, top_n=None)
        else:
            source_filter2, matched, err = resolve_filter(plan, doc_map, doc_years, doc_jurisdictions)
            if err:
                raise HTTPException(404, err)
            broad = body.broad or plan.intent == Intent.BROAD
            from config import HYBRID_TOP_N, BROAD_TOP_N
            fused = hybrid.hybrid_retrieve(body.query, source_filter=source_filter2, broad=broad)
            top_n = BROAD_TOP_N if broad else HYBRID_TOP_N
            retrieved = sort_docs(hybrid.rerank(body.query, fused, top_n=top_n))

    if not retrieved:
        return {"answer": "I couldn't find any relevant text in the documents to answer that.", "thinking": None, "sources": [], "retrieved": []}

    # conversation memory: clear on request, toggle on/off, thread history into generation.
    # Scoped to this chat session - never the global store the old code used.
    mem = _get_memory(body.session_id)
    if body.clear_memory:
        mem.clear()
    mem.enabled = bool(body.use_memory)
    history = mem.as_messages()

    formatted = format_docs(retrieved)
    intent_used = plan.intent if plan.intent != Intent.PAGE_SPECIFIC else Intent.FACTUAL
    try:
        # Thinking is always available on Ollama; keep the guard for safety.
        effective_thinking = body.thinking and THINKING_AVAILABLE
        if effective_thinking:
            answer, thinking = generate_answer(body.query, formatted, intent_used, history_messages=history or None, thinking=True, hybrid_mode=body.hybrid_mode)
        else:
            answer = generate_answer(body.query, formatted, intent_used, history_messages=history or None, thinking=False, hybrid_mode=body.hybrid_mode)
            thinking = None
    except Exception as e:
        raise HTTPException(502, f"LLM generation failed: {e}")

    # only record new turns while memory is enabled
    if body.use_memory:
        mem.add(body.query, answer)

    # citations
    from research_trail import format_citation
    sources = []
    seen = set()
    for doc in retrieved:
        cit = format_citation(doc.metadata)
        if cit not in seen:
            seen.add(cit)
            sources.append({"citation": cit, "metadata": dict(doc.metadata), "snippet": doc.page_content[:400]})

    # log to trail (also persist to file) — include thinking if present
    try:
        trail = ResearchTrail("./research_trail.md")
        trail_answer = answer + (f"\n\n[thinking]\n{thinking}\n[/thinking]" if thinking else "")
        trail.log("ask", body.query, trail_answer, retrieved)
    except Exception:
        pass

    # also save to SQLite research_queries if project_id given
    if body.project_id:
        conn = get_connection()
        try:
            stored = json.dumps({"answer": answer, "thinking": thinking, "sources": sources})
            # keep answer column for backwards compat, but also store thinking in sources_json
            conn.execute("INSERT INTO research_queries(project_id, query, answer, retrieval_mode, sources_json, created_at) VALUES (?,?,?,?,?,?)",
                         (body.project_id, body.query, answer, "hybrid+thinking" if thinking else "hybrid", stored, datetime.now(timezone.utc).isoformat()))
            conn.commit()
        finally:
            conn.close()

    return {"answer": answer, "thinking": thinking, "sources": sources, "memory": {"enabled": mem.enabled, "turns": len(mem)}, "retrieved": [{"page": getattr(d, 'metadata', {}).get("page",0)+1, "section": d.metadata.get("section"), "text": d.page_content[:800]} for d in retrieved]}


@app.post("/api/research/ask/stream")
async def api_research_ask_stream(body: AskRequest):
    """Streaming variant — emits SSE: status, meta, thinking/token deltas, done.

    Status events let the UI show what is happening before the first token
    arrives (retrieval, reranking, model loading, prompt processing) - the
    phases that would otherwise be an opaque wait between pressing Ask and
    seeing the answer start.
    """
    if not body.query.strip():
        raise HTTPException(400, "Query required")
    if not HAS_ENGINE:
        raise HTTPException(503, "RAG engine not available (missing dependencies)")

    vs = _get_vectorstore()
    if not vs:
        raise HTTPException(503, "Vector store empty — upload and index documents first")

    from query_understanding import parse_query, Intent
    from ingestion import get_indexed_documents, get_indexed_years, get_indexed_jurisdictions

    doc_map = get_indexed_documents(vs)
    doc_years = get_indexed_years(vs)
    doc_jurisdictions = get_indexed_jurisdictions(vs)

    source_filter = None
    if body.document_ids:
        paths = []
        for did in body.document_ids:
            doc = get_document(did)
            if doc and doc.get("stored_path"):
                abs_p = str(resolve_stored_path(doc["stored_path"]))
                paths.append(abs_p)
        matched_sources = [p for p in paths if p in doc_map.values()]
        if not matched_sources:
            for did in body.document_ids:
                doc = get_document(did)
                if not doc:
                    continue
                fname = doc["original_filename"]
                for rel, full in doc_map.items():
                    if fname.lower() in rel.lower() or fname.lower() in full.lower():
                        matched_sources.append(full)
            matched_sources = list(dict.fromkeys(matched_sources))
        if matched_sources:
            if len(matched_sources) == 1:
                source_filter = {"source": matched_sources[0]}
            else:
                source_filter = {"source": {"$in": matched_sources}}
    elif body.collection_id:
        conn = get_connection()
        try:
            rows = conn.execute("SELECT d.stored_path, d.original_filename FROM documents d JOIN document_collections dc ON dc.document_id=d.id WHERE dc.collection_id=?", (body.collection_id,)).fetchall()
            paths = [str(resolve_stored_path(r["stored_path"])) for r in rows if r["stored_path"]]
        finally:
            conn.close()
        matched = [p for p in paths if p in doc_map.values()]
        if matched:
            source_filter = {"source": {"$in": matched}} if len(matched) > 1 else {"source": matched[0]}

    try:
        plan = parse_query(body.query)
    except ValueError as e:
        raise HTTPException(400, str(e))

    mem = _get_memory(body.session_id)
    if body.clear_memory:
        mem.clear()
    mem.enabled = bool(body.use_memory)
    history = mem.as_messages()

    # Thinking is always available on Ollama.
    effective_thinking = body.thinking and THINKING_AVAILABLE

    # ---------------------------------------------------------------
    # SSE helpers
    # ---------------------------------------------------------------
    def sse(obj: dict) -> str:
        return f"data: {json.dumps(obj)}\n\n"

    def status_event(stage: str, detail=None) -> str:
        payload = {"type": "status", "stage": stage}
        if detail is not None:
            payload["detail"] = detail
        return sse(payload)

    THINK_OPEN_RE = re.compile(r"<think>", re.IGNORECASE)
    THINK_CLOSE_RE = re.compile(r"</think>", re.IGNORECASE)

    def event_generator():
        from retrieval import HybridIndex, get_chunks_by_pages, sort_docs
        from generation import format_docs, generate_answer_stream, strip_thinking
        from output_cleanup import sanitize_model_output
        from research_trail import ResearchTrail, format_citation

        try:
            yield status_event("retrieving", "building hybrid index")
            hybrid = HybridIndex(vs)
            hybrid.refresh_bm25()

            yield status_event("retrieving")
            if source_filter is not None:
                broad = body.broad or plan.intent == Intent.BROAD
                from config import HYBRID_TOP_N, BROAD_TOP_N, COMPARE_TOP_N_PER_SOURCE
                if plan.intent == Intent.PAGE_SPECIFIC and plan.page_numbers:
                    retrieved = get_chunks_by_pages(vs, plan.page_numbers, source_filter)
                    yield status_event("reranking")
                    retrieved = hybrid.rerank(body.query, retrieved, top_n=None)
                else:
                    sources = []
                    v = source_filter.get("source")
                    if isinstance(v, dict) and "$in" in v:
                        sources = v["$in"]
                    elif isinstance(v, str):
                        sources = [v]
                    if len(sources) > 1:
                        per_n = COMPARE_TOP_N_PER_SOURCE if not broad else min(7, COMPARE_TOP_N_PER_SOURCE + 2)
                        all_docs = []
                        for src in sources:
                            f = hybrid.hybrid_retrieve(body.query, source_filter={"source": src}, broad=broad)
                            r = hybrid.rerank(body.query, f, top_n=per_n)
                            all_docs.extend(r)
                        yield status_event("reranking")
                        retrieved = sort_docs(all_docs)
                        max_total = BROAD_TOP_N * 2 if broad else HYBRID_TOP_N * 3
                        if len(retrieved) > max_total:
                            retrieved = hybrid.rerank(body.query, retrieved, top_n=max_total)
                            retrieved = sort_docs(retrieved)
                    else:
                        fused = hybrid.hybrid_retrieve(body.query, source_filter=source_filter, broad=broad)
                        top_n = BROAD_TOP_N if broad else HYBRID_TOP_N
                        yield status_event("reranking")
                        retrieved = sort_docs(hybrid.rerank(body.query, fused, top_n=top_n))
            else:
                doc_count = len(doc_map)
                from filters import resolve_filter
                if plan.intent == Intent.PAGE_SPECIFIC:
                    source_filter2, matched, err = resolve_filter(plan, doc_map, doc_years, doc_jurisdictions)
                    if err:
                        yield sse({"type": "error", "error": err})
                        return
                    if not source_filter2 and doc_count > 1:
                        yield sse({"type": "error", "error": "Ambiguous page request — specify a document filter"})
                        return
                    retrieved = get_chunks_by_pages(vs, plan.page_numbers, source_filter2)
                    yield status_event("reranking")
                    retrieved = hybrid.rerank(body.query, retrieved, top_n=None)
                else:
                    source_filter2, matched, err = resolve_filter(plan, doc_map, doc_years, doc_jurisdictions)
                    if err:
                        yield sse({"type": "error", "error": err})
                        return
                    broad = body.broad or plan.intent == Intent.BROAD
                    from config import HYBRID_TOP_N, BROAD_TOP_N
                    fused = hybrid.hybrid_retrieve(body.query, source_filter=source_filter2, broad=broad)
                    top_n = BROAD_TOP_N if broad else HYBRID_TOP_N
                    yield status_event("reranking")
                    retrieved = sort_docs(hybrid.rerank(body.query, fused, top_n=top_n))

            if not retrieved:
                # stream a single answer for empty retrieval
                sources = []
                retrieved_meta = []
                yield sse({"type": "meta", "sources": sources, "retrieved": retrieved_meta})
                msg = "I could not find any relevant text in the documents to answer that."
                yield sse({"type": "token", "delta": msg})
                yield sse({"type": "done", "answer": msg, "thinking": None, "sources": sources})
                return

            sources = []
            seen = set()
            for doc in retrieved:
                cit = format_citation(doc.metadata)
                if cit not in seen:
                    seen.add(cit)
                    sources.append({"citation": cit, "metadata": dict(doc.metadata), "snippet": doc.page_content[:400]})
            retrieved_meta = [{"page": getattr(d, 'metadata', {}).get("page", 0) + 1, "section": d.metadata.get("section"), "text": d.page_content[:800]} for d in retrieved]

            # meta first so UI can show sources placeholder (collapsible, not yet expanded)
            yield sse({"type": "meta", "sources": sources, "retrieved": retrieved_meta})

            yield status_event("preparing", "assembling context")
            formatted = format_docs(retrieved)
            intent_used = plan.intent if plan.intent != Intent.PAGE_SPECIFIC else Intent.FACTUAL

            # -------------------------------------------------------
            # generation: split the raw tag-wrapped stream into explicit
            # thinking/token SSE events, so the UI never has to guess
            # where reasoning ends and the answer begins.
            # -------------------------------------------------------
            status_queue = []

            def on_status(stage, detail=None):
                status_queue.append((stage, detail))

            answer_buf = ""
            thinking_buf = ""
            in_think = False

            def process(delta):
                nonlocal in_think
                thinking_parts = []
                content_parts = []
                rest = delta
                while rest:
                    if not in_think:
                        m = THINK_OPEN_RE.search(rest)
                        if not m:
                            content_parts.append(rest)
                            break
                        if m.start():
                            content_parts.append(rest[:m.start()])
                        in_think = True
                        rest = rest[m.end():]
                    else:
                        m = THINK_CLOSE_RE.search(rest)
                        if not m:
                            thinking_parts.append(rest)
                            break
                        thinking_parts.append(rest[:m.start()])
                        in_think = False
                        rest = rest[m.end():]
                return "".join(thinking_parts), "".join(content_parts)

            for delta in generate_answer_stream(body.query, formatted, intent_used, history_messages=history or None, thinking=effective_thinking, hybrid_mode=body.hybrid_mode, on_status=on_status):
                while status_queue:
                    stage, detail = status_queue.pop(0)
                    yield status_event(stage, detail)
                think_part, content_part = process(delta)
                if think_part and effective_thinking:
                    thinking_buf += think_part
                    yield sse({"type": "thinking", "delta": think_part})
                if content_part:
                    answer_buf += content_part
                    yield sse({"type": "token", "delta": content_part})
            while status_queue:
                stage, detail = status_queue.pop(0)
                yield status_event(stage, detail)

            # finalize: sanitize and persist
            if effective_thinking:
                answer = sanitize_model_output(answer_buf) if answer_buf else ""
                thinking = sanitize_model_output(thinking_buf) if thinking_buf else None
            else:
                answer = sanitize_model_output(strip_thinking(answer_buf))
                thinking = None
            if body.use_memory:
                mem.add(body.query, answer)
            # trail
            try:
                trail = ResearchTrail("./research_trail.md")
                trail_answer = answer + (f"\n\n[thinking]\n{thinking}\n[/thinking]" if thinking else "")
                trail.log("ask", body.query, trail_answer, retrieved)
            except Exception:
                pass
            if body.project_id:
                conn = get_connection()
                try:
                    stored = json.dumps({"answer": answer, "thinking": thinking, "sources": sources})
                    conn.execute("INSERT INTO research_queries(project_id, query, answer, retrieval_mode, sources_json, created_at) VALUES (?,?,?,?,?,?)",
                                 (body.project_id, body.query, answer, "hybrid+thinking" if thinking else "hybrid", stored, datetime.now(timezone.utc).isoformat()))
                    conn.commit()
                finally:
                    conn.close()
            yield sse({"type": "done", "answer": answer, "thinking": thinking, "sources": sources, "retrieved": retrieved_meta})
        except Exception as e:
            yield sse({"type": "error", "error": str(e)})

    return StreamingResponse(event_generator(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"})

@app.get("/api/research/memory")
def api_memory_status(session_id: str = Query("default")):
    mem = _get_memory(session_id)
    return {"enabled": mem.enabled, "turns": len(mem)}

@app.post("/api/research/memory/clear")
def api_clear_memory(session_id: str = Query("default")):
    # Scoped: clearing one chat's session leaves every other chat's
    # history untouched (the old global clear wiped everyone).
    _get_memory(session_id).clear()
    return {"ok": True, "turns": 0}

_EXPORT_MIN_BYTES = 500  # rendered reports below this are empty/corrupt shells


def _verify_export_file(path) -> tuple[bool, str]:
    """Check a rendered export is real: exists, is a file, non-trivial size.
    Returns (ok, reason)."""
    if not path:
        return False, "renderer returned no path"
    try:
        p = Path(path)
    except Exception:
        return False, "invalid path"
    if not p.exists() or not p.is_file():
        return False, "file missing after render"
    try:
        size = p.stat().st_size
    except OSError as e:
        return False, f"unreadable ({e})"
    if size < _EXPORT_MIN_BYTES:
        return False, f"only {size} bytes (minimum {_EXPORT_MIN_BYTES})"
    return True, f"{size} bytes"


def _resolve_full_source(vs, doc):
    """Map a library document to its Chroma `source` value (absolute path
    as stored at ingestion). Shared by summarize + export so both resolve
    identically. Returns None when the doc has no indexed chunks."""
    from ingestion import get_indexed_documents
    doc_map = get_indexed_documents(vs)
    if doc.get("stored_path"):
        abs_p = str(resolve_stored_path(doc["stored_path"]))
        for rel, full in doc_map.items():
            if full == abs_p or doc["original_filename"].lower() in rel.lower():
                return full
        if abs_p in doc_map.values():
            return abs_p
    fname = doc["original_filename"]
    for rel, full in doc_map.items():
        if fname.lower() == Path(rel).name.lower() or fname.lower() == Path(full).name.lower():
            return full
    return None


def _build_summary_export(display_name, summary, stats, fmt):
    """Render an already-computed summary to PDF/HTML. Returns
    (export_dict|None, content_b64|None, error|None). Never raises -
    export must not fail a summarize that already succeeded."""
    try:
        from summary_export import export_summary_html, export_summary_pdf
        import base64
        path = export_summary_pdf(display_name, summary, stats) if fmt == "pdf" else export_summary_html(display_name, summary, stats)
        ok, reason = _verify_export_file(path)
        if not ok:
            return None, None, f"PDF render failed verification ({reason})"
        with open(path, "rb") as f:
            blob = f.read()
        return {"format": fmt, "filename": Path(path).name, "size_bytes": len(blob)}, base64.b64encode(blob).decode("ascii"), None
    except Exception as e:
        return None, None, f"export failed: {e}"


_BATCH_RE = re.compile(r"batch\s+(\d+)\s*/\s*(\d+)", re.IGNORECASE)


def _summarize_progress_event(msg: str) -> dict:
    """Translate one summarization.py progress line into an SSE status
    event, so the UI can show mapping / reducing / synthesizing live
    instead of one opaque wait."""
    m = _BATCH_RE.search(msg or "")
    if m:
        return {"type": "status", "stage": "mapping",
                "detail": msg.strip(),
                "current": int(m.group(1)), "total": int(m.group(2))}
    low = (msg or "").lower()
    if "classifying" in low:
        stage = "classifying"
    elif "extracting facts in batches" in low:
        stage = "mapping"
    elif "consolidating" in low:
        stage = "reducing"
    elif "consolidated to" in low or "synthesizing" in low or "single pass" in low:
        stage = "synthesizing"
    else:
        stage = "working"
    return {"type": "status", "stage": stage, "detail": (msg or '').strip() or None}


@app.post("/api/research/summarize")
def api_research_summarize(body: SummarizeRequest):
    if not HAS_ENGINE:
        raise HTTPException(503, "Engine not available")
    doc = get_document(body.document_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    vs = _get_vectorstore()
    if not vs:
        raise HTTPException(503, "Vector store empty")

    # map stored_path to Chroma source
    full_source = _resolve_full_source(vs, doc)
    if not full_source:
        raise HTTPException(404, "Document not indexed yet — ingestion may still be pending or failed. Try re-uploading.")

    from summarization import summarize_document
    display_name = doc["original_filename"]
    # progress no-op
    summary, stats = summarize_document(vs, full_source, display_name, progress=lambda x: None)
    if summary is None:
        raise HTTPException(404, "No indexed content for that document")
    resp = {"summary": summary, "stats": stats, "document": doc}
    # Optional inline export: render the just-computed summary straight to
    # PDF/HTML (no second summarization run - the old flow made Export
    # buttons re-run map->reduce->synthesis from scratch). The file bytes
    # ride along base64 so the UI can download immediately; failures are
    # reported as export_error and never fail the summarize itself.
    fmt = (body.export_format or "").lower() or None
    if fmt is not None:
        if fmt not in ("pdf", "html"):
            resp["export_error"] = "export_format must be pdf or html"
        else:
            export, content, err = _build_summary_export(display_name, summary, stats, fmt)
            if err:
                resp["export_error"] = err
            else:
                resp["export"] = export
                resp["export_content"] = content
    return resp


@app.post("/api/research/summarize/stream")
async def api_research_summarize_stream(body: SummarizeRequest):
    """Streaming variant of summarize: emits the pipeline's own progress
    lines as SSE status events (classifying -> mapping batch i/N ->
    reducing -> synthesizing -> exporting) so long map-reduce runs are
    observable, then a done event with the same payload as the plain
    endpoint (summary, stats, document, optional export)."""
    if not HAS_ENGINE:
        raise HTTPException(503, "Engine not available")
    doc = get_document(body.document_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    vs = _get_vectorstore()
    if not vs:
        raise HTTPException(503, "Vector store empty")
    full_source = _resolve_full_source(vs, doc)
    if not full_source:
        raise HTTPException(404, "Document not indexed yet — ingestion may still be pending or failed. Try re-uploading.")
    fmt = (body.export_format or "").lower() or None
    if fmt is not None and fmt not in ("pdf", "html"):
        raise HTTPException(400, "export_format must be pdf or html")
    display_name = doc["original_filename"]

    def sse(obj: dict) -> str:
        return f"data: {json.dumps(obj, default=str)}\n\n"

    def event_generator():
        import threading
        import time as _time
        from summarization import summarize_document
        # summarize_document is synchronous and long (minutes for a book),
        # so it runs on a worker thread while this generator drains the
        # progress queue into SSE events as they arrive - otherwise every
        # status line would flush only at the very end, defeating the point.
        lock = threading.Lock()
        queued: list = []
        result: dict = {}

        def on_progress(msg):
            with lock:
                queued.append(_summarize_progress_event(msg))

        def work():
            try:
                summary, stats = summarize_document(vs, full_source, display_name, progress=on_progress)
                result["ok"] = (summary, stats)
            except Exception as e:  # noqa: BLE001 - surfaced as SSE error event
                result["error"] = str(e)

        try:
            yield sse({"type": "status", "stage": "starting", "detail": f"Summarizing {display_name}"})
            worker = threading.Thread(target=work, daemon=True, name="summarize-worker")
            worker.start()
            while worker.is_alive():
                with lock:
                    batch, queued[:] = queued[:], []
                for ev in batch:
                    yield sse(ev)
                _time.sleep(0.5)
            worker.join()
            with lock:
                batch, queued[:] = queued[:], []
            for ev in batch:
                yield sse(ev)
            if "error" in result:
                yield sse({"type": "error", "error": result["error"]})
                return
            summary, stats = result.get("ok", (None, None))
            if summary is None:
                yield sse({"type": "error", "error": "No indexed content for that document"})
                return
            done = {"type": "done", "summary": summary, "stats": stats,
                    "document": {"id": doc["id"], "title": doc.get("title"),
                                 "original_filename": doc.get("original_filename")}}
            if fmt is not None:
                yield sse({"type": "status", "stage": "exporting", "detail": f"Rendering {fmt.upper()}…"})
                export, content, err = _build_summary_export(display_name, summary, stats, fmt)
                if err:
                    done["export_error"] = err
                else:
                    done["export"] = export
                    done["export_content"] = content
            yield sse(done)
        except Exception as e:
            yield sse({"type": "error", "error": str(e)})

    return StreamingResponse(event_generator(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"})

@app.post("/api/research/compare")
def api_research_compare(body: CompareRequest):
    if len(body.document_ids) < 2:
        raise HTTPException(400, "Need at least 2 documents to compare")
    if not HAS_ENGINE:
        raise HTTPException(503, "Engine not available")
    vs = _get_vectorstore()
    if not vs:
        raise HTTPException(503, "Vector store empty")
    from ingestion import get_indexed_documents
    from retrieval import HybridIndex, sort_docs
    from generation import format_compare_docs, generate_answer
    from query_understanding import Intent
    from research_trail import format_citation

    doc_map = get_indexed_documents(vs)
    # resolve doc_ids -> full_source + display_name
    resolved = {}
    for did in body.document_ids:
        doc = get_document(did)
        if not doc:
            raise HTTPException(404, f"Document {did} not found")
        # find full source
        abs_p = str(resolve_stored_path(doc["stored_path"])) if doc.get("stored_path") else None
        full = None
        for rel, f in doc_map.items():
            if f == abs_p or doc["original_filename"].lower() in rel.lower():
                full = f
                break
        if not full:
            raise HTTPException(404, f"Document {doc['original_filename']} not indexed")
        resolved[doc["original_filename"]] = full

    hybrid = HybridIndex(vs)
    hybrid.refresh_bm25()
    from config import COMPARE_TOP_N_PER_SOURCE
    docs_by_source = {}
    for display_name, full_source in resolved.items():
        source_filter = {"source": full_source}
        fused = hybrid.hybrid_retrieve(body.query, source_filter=source_filter, broad=False)
        docs_by_source[display_name] = sort_docs(hybrid.rerank(body.query, fused, top_n=COMPARE_TOP_N_PER_SOURCE))

    formatted = format_compare_docs(docs_by_source)
    try:
        answer = generate_answer(body.query, formatted, Intent.COMPARE)
    except Exception as e:
        raise HTTPException(502, f"LLM failed: {e}")

    # sources
    sources = {}
    for name, docs in docs_by_source.items():
        sources[name] = [{"citation": format_citation(d.metadata), "snippet": d.page_content[:400]} for d in docs]

    return {"answer": answer, "sources": sources, "docs_by_source": {k: [{"page": d.metadata.get("page",0)+1, "text": d.page_content[:600]} for d in v] for k, v in docs_by_source.items()}}

# ------------------------------------------------------------------
# Annotations & Notes
# ------------------------------------------------------------------
@app.get("/api/library/documents/{doc_id}/annotations")
def api_list_annotations(doc_id: int):
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM annotations WHERE document_id=? ORDER BY page, id", (doc_id,)).fetchall()
        out = []
        for r in rows:
            d = dict_from_row(r)
            try:
                d["tags"] = json.loads(d.pop("tags_json") or "[]")
            except Exception:
                d["tags"] = []
            out.append(d)
        return out
    finally:
        conn.close()

class AnnotationCreate(BaseModel):
    page: int
    start_offset: Optional[int] = None
    end_offset: Optional[int] = None
    selected_text: Optional[str] = None
    note: Optional[str] = None
    color: str = "#facc15"
    category: str = "highlight"

@app.post("/api/library/documents/{doc_id}/annotations")
def api_create_annotation(doc_id: int, body: AnnotationCreate):
    if not get_document(doc_id):
        raise HTTPException(404, "Document not found")
    conn = get_connection()
    try:
        now = datetime.now(timezone.utc).isoformat()
        cur = conn.execute("INSERT INTO annotations(document_id, page, start_offset, end_offset, selected_text, note, color, category, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                           (doc_id, body.page, body.start_offset, body.end_offset, body.selected_text, body.note, body.color, body.category, now, now))
        conn.commit()
        row = conn.execute("SELECT * FROM annotations WHERE id=?", (cur.lastrowid,)).fetchone()
        return dict_from_row(row)
    finally:
        conn.close()

@app.delete("/api/library/annotations/{ann_id}")
def api_delete_annotation(ann_id: int):
    conn = get_connection()
    try:
        cur = conn.execute("DELETE FROM annotations WHERE id=?", (ann_id,))
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(404, "Not found")
        return {"ok": True}
    finally:
        conn.close()

@app.get("/api/library/notes")
def api_list_notes(document_id: Optional[int] = Query(None)):
    conn = get_connection()
    try:
        if document_id is not None:
            rows = conn.execute("SELECT * FROM notes WHERE document_id=? ORDER BY updated_at DESC", (document_id,)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM notes ORDER BY updated_at DESC LIMIT 100").fetchall()
        return [dict_from_row(r) for r in rows]
    finally:
        conn.close()

class NoteCreate(BaseModel):
    document_id: Optional[int] = None
    title: Optional[str] = None
    content: str = ""

@app.post("/api/library/notes")
def api_create_note(body: NoteCreate):
    conn = get_connection()
    try:
        now = datetime.now(timezone.utc).isoformat()
        cur = conn.execute("INSERT INTO notes(document_id, title, content, created_at, updated_at) VALUES (?,?,?,?,?)",
                           (body.document_id, body.title, body.content, now, now))
        conn.commit()
        row = conn.execute("SELECT * FROM notes WHERE id=?", (cur.lastrowid,)).fetchone()
        return dict_from_row(row)
    finally:
        conn.close()

@app.patch("/api/library/notes/{nid}")
def api_patch_note(nid: int, body: NoteCreate):
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM notes WHERE id=?", (nid,)).fetchone()
        if not row:
            raise HTTPException(404, "Not found")
        now = datetime.now(timezone.utc).isoformat()
        conn.execute("UPDATE notes SET title=?, content=?, updated_at=? WHERE id=?", (body.title, body.content, now, nid))
        if body.document_id is not None:
            conn.execute("UPDATE notes SET document_id=? WHERE id=?", (body.document_id, nid))
        conn.commit()
        row = conn.execute("SELECT * FROM notes WHERE id=?", (nid,)).fetchone()
        return dict_from_row(row)
    finally:
        conn.close()

@app.delete("/api/library/notes/{nid}")
def api_delete_note(nid: int):
    conn = get_connection()
    try:
        cur = conn.execute("DELETE FROM notes WHERE id=?", (nid,))
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(404, "Not found")
        return {"ok": True}
    finally:
        conn.close()

# ------------------------------------------------------------------
# Research projects
# ------------------------------------------------------------------
@app.get("/api/research/projects")
def api_list_projects():
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM research_projects ORDER BY updated_at DESC").fetchall()
        out = []
        for r in rows:
            d = dict_from_row(r)
            cnt = conn.execute("SELECT COUNT(*) as c FROM research_project_documents WHERE project_id=?", (d["id"],)).fetchone()["c"]
            d["document_count"] = cnt
            out.append(d)
        return out
    finally:
        conn.close()

class ProjectCreate(BaseModel):
    name: str
    description: str = ""
    document_ids: List[int] = []

@app.post("/api/research/projects")
def api_create_project(body: ProjectCreate):
    if not body.name.strip():
        raise HTTPException(400, "Name required")
    conn = get_connection()
    try:
        now = datetime.now(timezone.utc).isoformat()
        cur = conn.execute("INSERT INTO research_projects(name, description, created_at, updated_at) VALUES (?,?,?,?)",
                           (body.name.strip(), body.description, now, now))
        pid = cur.lastrowid
        for did in body.document_ids:
            conn.execute("INSERT OR IGNORE INTO research_project_documents(project_id, document_id) VALUES (?,?)", (pid, did))
        conn.commit()
        row = conn.execute("SELECT * FROM research_projects WHERE id=?", (pid,)).fetchone()
        return dict_from_row(row)
    finally:
        conn.close()

@app.get("/api/research/projects/{pid}")
def api_get_project(pid: int):
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM research_projects WHERE id=?", (pid,)).fetchone()
        if not row:
            raise HTTPException(404, "Not found")
        proj = dict_from_row(row)
        docs = conn.execute("""
            SELECT d.* FROM documents d
            JOIN research_project_documents rpd ON rpd.document_id=d.id
            WHERE rpd.project_id=? ORDER BY d.title
        """, (pid,)).fetchall()
        proj["documents"] = [dict_from_row(r) for r in docs]
        queries = conn.execute("SELECT * FROM research_queries WHERE project_id=? ORDER BY created_at DESC LIMIT 50", (pid,)).fetchall()
        proj["queries"] = [dict_from_row(r) for r in queries]
        evidence = conn.execute("SELECT * FROM evidence_items WHERE project_id=? ORDER BY created_at DESC", (pid,)).fetchall()
        proj["evidence"] = [dict_from_row(r) for r in evidence]
        return proj
    finally:
        conn.close()

@app.post("/api/research/projects/{pid}/documents")
def api_add_project_docs(pid: int, body: dict):
    ids = body.get("document_ids", [])
    conn = get_connection()
    try:
        if not conn.execute("SELECT 1 FROM research_projects WHERE id=?", (pid,)).fetchone():
            raise HTTPException(404, "Project not found")
        for did in ids:
            conn.execute("INSERT OR IGNORE INTO research_project_documents(project_id, document_id) VALUES (?,?)", (pid, did))
        conn.execute("UPDATE research_projects SET updated_at=? WHERE id=?", (datetime.now(timezone.utc).isoformat(), pid))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()

@app.delete("/api/research/projects/{pid}")
def api_delete_project(pid: int):
    conn = get_connection()
    try:
        cur = conn.execute("DELETE FROM research_projects WHERE id=?", (pid,))
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(404, "Not found")
        return {"ok": True}
    finally:
        conn.close()

# evidence
class EvidenceCreate(BaseModel):
    document_id: Optional[int] = None
    claim: str
    quoted_evidence: str
    page: Optional[int] = None
    location: Optional[str] = None
    note: Optional[str] = None

@app.post("/api/research/projects/{pid}/evidence")
def api_create_evidence(pid: int, body: EvidenceCreate):
    conn = get_connection()
    try:
        if not conn.execute("SELECT 1 FROM research_projects WHERE id=?", (pid,)).fetchone():
            raise HTTPException(404, "Project not found")
        now = datetime.now(timezone.utc).isoformat()
        cur = conn.execute("INSERT INTO evidence_items(project_id, document_id, claim, quoted_evidence, page, location, note, created_at) VALUES (?,?,?,?,?,?,?,?)",
                           (pid, body.document_id, body.claim, body.quoted_evidence, body.page, body.location, body.note, now))
        conn.commit()
        row = conn.execute("SELECT * FROM evidence_items WHERE id=?", (cur.lastrowid,)).fetchone()
        return dict_from_row(row)
    finally:
        conn.close()

# ------------------------------------------------------------------
# Research trail
# ------------------------------------------------------------------
@app.get("/api/research/trail")
def api_trail(limit: int = Query(50, ge=1, le=200)):
    path = PROJECT_ROOT / "research_trail.md"
    if not path.exists():
        return {"entries": [], "raw": ""}
    text = path.read_text(encoding="utf-8", errors="ignore")
    # simple split by ---
    entries = [e.strip() for e in text.split("---") if e.strip()]
    entries = entries[-limit:]
    return {"entries": entries, "count": len(entries), "raw": text[-20000:]}

# ------------------------------------------------------------------
# Settings & citations
# ------------------------------------------------------------------
@app.get("/api/settings")
def api_get_settings():
    conn = get_connection()
    try:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        return {r["key"]: r["value"] for r in rows}
    finally:
        conn.close()

@app.put("/api/settings")
def api_put_settings(body: dict):
    conn = get_connection()
    try:
        for k, v in body.items():
            conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?,?)", (k, str(v)))
        conn.commit()
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        return {r["key"]: r["value"] for r in rows}
    finally:
        conn.close()

@app.get("/api/citations/styles")
def api_citation_styles():
    """Available CSL styles + the current default (Settings -> Citation)."""
    from core.citations import engine
    conn = get_connection()
    try:
        row = conn.execute("SELECT value FROM settings WHERE key='citation_style'").fetchone()
        default = row["value"] if row else engine.DEFAULT_STYLE
    finally:
        conn.close()
    return {"styles": engine.list_styles(), "default": default}


@app.put("/api/citations/styles/default")
def api_citation_style_default(body: dict):
    from core.citations import engine
    style_id = (body.get("style") or "").strip()
    if not engine._style_path(style_id):
        raise HTTPException(404, f"Unknown style {style_id!r}")
    conn = get_connection()
    try:
        conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES ('citation_style', ?)", (style_id,))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "default": style_id}


@app.post("/api/citations/styles/custom")
def api_citation_style_custom(body: dict):
    """Add a user-supplied CSL style (raw XML)."""
    from core.citations import engine
    if not engine.save_custom_style(body.get("xml") or ""):
        raise HTTPException(400, "Invalid CSL XML (missing <style> element)")
    return {"ok": True, "styles": engine.list_styles()}


@app.post("/api/citations/styles/fetch")
def api_citation_style_fetch(body: dict):
    """Fetch any style from the official CSL repository by id and cache it."""
    from core.citations import engine
    fetched = engine.fetch_style(body.get("name") or "")
    if not fetched:
        raise HTTPException(404, "Style not found in the CSL repository")
    return {"ok": True, "style": fetched, "styles": engine.list_styles()}


@app.get("/api/citations/{doc_id}")
def api_citations(doc_id: int, style: str = Query("apa")):
    doc = get_document(doc_id)
    if not doc:
        raise HTTPException(404, "Not found")
    from research_trail import format_citation
    from core.citations import engine
    meta = {
        "source": doc.get("stored_path") or doc.get("original_filename"),
        "page": 0,
        "section": doc.get("journal") or "",
        "year": doc.get("year"),
        "jurisdiction": doc.get("jurisdiction"),
    }
    item = engine.doc_to_csl_item(doc)
    try:
        citation = engine.render_citation(item, style)
    except Exception:
        citation = engine.render_citation(item, engine.DEFAULT_STYLE)
        style = engine.DEFAULT_STYLE
    return {
        "plain": format_citation(meta, style="plain"),
        "style": style,
        "citation": citation,
        "bibtex": engine.bibtex_entry(doc),
        "ris": engine.ris_entry(doc),
        "csl_json": item,
    }


def _library_docs_hydrated(ids: str | None = None) -> list[dict]:
    """All documents (or a subset by comma-separated ids), authors hydrated."""
    conn = get_connection()
    try:
        if ids:
            id_list = [int(x) for x in ids.split(",") if x.strip().isdigit()]
            if not id_list:
                return []
            placeholders = ",".join("?" for _ in id_list)
            rows = conn.execute(
                f"SELECT * FROM documents WHERE id IN ({placeholders}) ORDER BY title", id_list
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM documents ORDER BY title").fetchall()
        docs = []
        for r in rows:
            d = dict_from_row(r)
            d["authors"] = [a["name"] for a in conn.execute(
                "SELECT a.name FROM authors a JOIN document_authors da ON da.author_id=a.id "
                "WHERE da.document_id=? ORDER BY da.author_order", (d["id"],)).fetchall()]
            docs.append(d)
        return docs
    finally:
        conn.close()


@app.get("/api/export/bibtex")
def api_export_bibtex(ids: str = Query("")):
    from core.citations import engine
    docs = _library_docs_hydrated(ids)
    return {"bibtex": "\n\n".join(engine.bibtex_entry(d) for d in docs), "count": len(docs)}


@app.get("/api/export/refs")
def api_export_refs(format: str = Query("bibtex"), ids: str = Query("")):
    """Export the library (or selected docs) as BibTeX / RIS / CSL-JSON."""
    from core.importing import parsers
    docs = _library_docs_hydrated(ids)
    fmt = format.lower()
    if fmt == "ris":
        data = parsers.docs_to_ris(docs)
    elif fmt == "csl-json":
        data = parsers.docs_to_csl_json(docs)
    elif fmt in ("bibtex", "biblatex"):
        data = parsers.docs_to_bibtex(docs)
    else:
        raise HTTPException(400, "format must be bibtex | ris | csl-json")
    return {"format": fmt, "count": len(docs), "data": data}


@app.get("/api/export/bibliography")
def api_export_bibliography(style: str = Query("apa"), ids: str = Query("")):
    """Plain-text bibliography rendered through the CSL engine."""
    from core.citations import engine
    docs = _library_docs_hydrated(ids)
    items = [engine.doc_to_csl_item(d) for d in docs]
    try:
        bibliography = engine.render_bibliography(items, style)
    except Exception:
        bibliography = engine.render_bibliography(items, engine.DEFAULT_STYLE)
        style = engine.DEFAULT_STYLE
    return {"style": style, "count": len(bibliography), "bibliography": bibliography}


class ImportRefsRequest(BaseModel):
    text: str
    format: Optional[str] = None


@app.post("/api/import/refs")
def api_import_refs(body: ImportRefsRequest):
    """Import references from BibTeX / RIS / EndNote XML / CSL-JSON.

    Creates metadata-only documents (no file) and preserves collection
    structures found in the import (BibTeX groups/keywords, RIS KW/DB,
    CSL collection-title). Skips duplicates by DOI or exact normalized title.
    """
    from core.importing import parsers
    from core.library.collections import create_collection

    fmt = (body.format or parsers.detect_format(body.text)).lower()
    records = parsers.parse_references(body.text, fmt)
    if not records:
        raise HTTPException(400, "No recognizable references found in the input")
    imported, skipped = [], []
    conn = get_connection()
    try:
        for rec in records:
            dup = None
            if rec.get("doi"):
                dup = conn.execute("SELECT id FROM documents WHERE lower(doi)=lower(?)", (rec["doi"],)).fetchone()
            if not dup and rec.get("title"):
                dup = conn.execute("SELECT id FROM documents WHERE lower(title)=lower(?)", (rec["title"],)).fetchone()
            if dup:
                skipped.append({"title": rec.get("title"), "reason": "duplicate"})
                continue
            doc = create_document({
                "title": rec.get("title") or "Untitled",
                "original_filename": f"{(rec.get('title') or 'imported')[:120]}.ref",
                "stored_path": None,
                "file_hash": None,
                "doi": rec.get("doi"),
                "year": rec.get("year"),
                "journal": rec.get("journal"),
                "volume": rec.get("volume"),
                "issue": rec.get("issue"),
                "pages": rec.get("pages"),
                "publisher": rec.get("publisher"),
                "abstract": rec.get("abstract"),
                "ingestion_status": "metadata_only",
                "metadata_source": f"import:{fmt}",
                "metadata_verified": 1,
                "authors_list": rec.get("authors") or [],
                "citation_metadata": {"import_key": rec.get("raw_key")},
            })
            # Preserve collection structures — create collections on demand
            # and link the imported document, so Zotero/Mendeley folder
            # hierarchies survive the migration without manual re-creation.
            for coll_name in rec.get("collections") or []:
                coll_name = coll_name.strip()
                if not coll_name:
                    continue
                row = conn.execute("SELECT id FROM collections WHERE lower(name)=lower(?)", (coll_name,)).fetchone()
                if row:
                    coll_id = row["id"]
                else:
                    try:
                        new_coll = create_collection(coll_name, "", "#6366f1")
                        coll_id = new_coll["id"]
                    except Exception:
                        continue
                # link (ignore if already linked)
                conn.execute("INSERT OR IGNORE INTO document_collections(document_id, collection_id) VALUES (?,?)",
                             (doc["id"], coll_id))
                conn.commit()
            imported.append(doc)
    finally:
        conn.close()
    return {"imported": len(imported), "skipped": len(skipped),
            "documents": [{"id": d["id"], "title": d["title"]} for d in imported]}


@app.post("/api/import/file")
async def api_import_file(file: UploadFile = File(...)):
    """One-Click Importer: upload a BibTeX/RIS/EndNote/CSL-JSON file directly.

    Accepts the same formats as POST /api/import/refs but via file upload,
    so users can export from Zotero/Mendeley (File → Export Library) and
    drop the file here without copy-pasting. Collection structures are
    preserved and ingested documents are written to the content-addressed
    store; linked PDFs referenced via BibTeX `file` fields are copied into
    pfolder when found on disk.
    """
    data = await _read_upload_capped(file)
    if not data:
        raise HTTPException(400, "Empty file")
    filename = file.filename or "import.ref"
    ext = Path(filename).suffix.lower()
    # Detect format from extension or content
    fmt_map = {".bib": "bibtex", ".bibtex": "bibtex", ".ris": "ris",
               ".xml": "endnote-xml", ".json": "csl-json"}
    hint = fmt_map.get(ext)
    text = data.decode("utf-8", errors="ignore")
    # Delegate to the text importer (preserves collections)
    return api_import_refs(ImportRefsRequest(text=text, format=hint))


class CaptureRequest(BaseModel):
    url: Optional[str] = None
    doi: Optional[str] = None
    title: Optional[str] = None


_CAPTURE_MAX_BYTES = 150 * 1024 * 1024
# Link-local (cloud metadata endpoints like 169.254.169.254 live here) is
# never a legitimate PDF host for capture. Note this is a best-effort
# pre-check, not a bulletproof sandbox: DNS can change between this lookup
# and connect (TOCTOU). For a local single-user app where the operator
# pastes the URL themselves, that tradeoff is acceptable; intranet hosts
# (192.168.x etc.) stay allowed on purpose.
_BLOCKED_CAPTURE_NETS = [ipaddress.ip_network("169.254.0.0/16")]
_PDF_CONTENT_TYPES = {"application/pdf", "application/octet-stream", "binary/octet-stream"}


def _capture_url_allowed(url: str):
    """Return None if `url` may be fetched, else a short reason string."""
    try:
        parts = urlsplit(url)
    except Exception:
        return "unparseable URL"
    if parts.scheme.lower() not in ("http", "https"):
        return "only http(s) URLs can be captured"
    if not parts.hostname:
        return "URL has no host"
    try:
        infos = socket.getaddrinfo(parts.hostname, None)
    except OSError:
        return "host does not resolve"
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        if any(ip in net for net in _BLOCKED_CAPTURE_NETS):
            return "host resolves to a blocked link-local address"
    return None


async def _download_pdf_capped(url: str):
    """Stream a PDF with a hard byte cap. Returns bytes, or None when the
    response isn't a PDF / is too large / errors. Never buffers past the
    cap: the old code downloaded the entire body via resp.content and only
    THEN compared its length."""
    import httpx as _httpx
    timeout = _httpx.Timeout(60.0, connect=10.0)
    async with _httpx.AsyncClient(timeout=timeout, follow_redirects=True, max_redirects=3) as client:
        async with client.stream("GET", url) as resp:
            if resp.status_code != 200:
                return None
            ctype = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
            if ctype and ctype not in _PDF_CONTENT_TYPES:
                return None
            buf = bytearray()
            async for piece in resp.aiter_bytes(1024 * 1024):
                buf += piece
                if len(buf) > _CAPTURE_MAX_BYTES:
                    return None
            if not buf:
                return None
            return bytes(buf)


@app.post("/api/capture")
async def api_capture(body: CaptureRequest):
    """Browser-extension capture endpoint (Phase 4).

    Resolves metadata via the provider chain; when `url` points directly at
    a PDF, downloads and stores the file; otherwise creates a metadata-only
    record. Best-effort on every step.
    """
    if not (body.url or body.doi or body.title):
        raise HTTPException(400, "url, doi or title required")
    from core.metadata.providers import fetch_metadata

    offline = _is_strict_offline()
    proposal, _, _ = await fetch_metadata(
        doi=body.doi, title=body.title,
        local_fields={"title": body.title or body.url},
        offline=offline,
    )
    stored_path, original_filename, file_bytes = None, None, None
    if body.url and body.url.lower().split("?")[0].endswith(".pdf"):
        err = _capture_url_allowed(body.url)
        if err is None:
            try:
                file_bytes = await _download_pdf_capped(body.url)
                original_filename = urlsplit(body.url).path.rstrip("/").split("/")[-1] or "captured.pdf"
            except Exception:
                file_bytes = None
    if file_bytes:
        file_hash = compute_sha256_bytes(file_bytes)
        _, _, stored_path = save_uploaded_file(file_bytes, original_filename or "captured.pdf", file_hash)
    else:
        file_hash = None
    extras = dict(proposal.get("extras") or {}) if proposal else {}
    if body.url:
        extras["url"] = body.url
    doc = create_document({
        "title": (proposal or {}).get("title") or body.title or (body.url or "Captured reference"),
        "original_filename": original_filename or f"{(body.title or 'captured')[:120]}.ref",
        "stored_path": stored_path,
        "file_hash": file_hash,
        "file_size": len(file_bytes) if file_bytes else None,
        "mime_type": "application/pdf" if file_bytes else None,
        "doi": (proposal or {}).get("doi") or body.doi,
        "year": (proposal or {}).get("year"),
        "journal": (proposal or {}).get("journal"),
        "volume": (proposal or {}).get("volume"),
        "issue": (proposal or {}).get("issue"),
        "pages": (proposal or {}).get("pages"),
        "publisher": (proposal or {}).get("publisher"),
        "abstract": (proposal or {}).get("abstract"),
        "ingestion_status": "ready" if file_bytes else "metadata_only",
        "metadata_source": (proposal or {}).get("source") or "local",
        "metadata_confidence": (proposal or {}).get("confidence"),
        "metadata_verified": 0,
        "authors_list": (proposal or {}).get("authors") or [],
        "citation_metadata": extras,
    })
    return {"document": doc, "downloaded_pdf": bool(file_bytes), "offline": offline}


class MatrixRequest(BaseModel):
    document_ids: List[int]


@app.post("/api/research/matrix")
def api_research_matrix(body: MatrixRequest):
    """Literature matrix: one row per document (method/dataset/findings/limitations)."""
    docs = [d for d in (get_document(i) for i in body.document_ids) if d]
    if not docs:
        raise HTTPException(400, "No valid documents selected")
    vs = _get_vectorstore()
    if not vs:
        raise HTTPException(503, "Vector store empty — upload and index documents first")
    from core.research import analysis
    return {"rows": analysis.literature_matrix(vs, docs)}


@app.post("/api/research/matrix/export")
def api_research_matrix_export(body: dict):
    rows = body.get("rows") or []
    fmt = (body.get("format") or "csv").lower()
    headers = ["paper", "year", "method", "dataset", "findings", "limitations"]
    import io
    if fmt == "csv":
        import csv as _csv
        out = io.StringIO()
        w = _csv.DictWriter(out, fieldnames=headers, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
        return Response(
            content=out.getvalue(), media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=literature_matrix.csv"},
        )
    if fmt == "md":
        lines = ["| Paper | Year | Method | Dataset | Findings | Limitations |",
                 "|---|---|---|---|---|---|"]
        for r in rows:
            cells = [str(r.get(k, "")).replace("|", "\\|").replace("\n", " ") for k in headers]
            lines.append("| " + " | ".join(cells) + " |")
        return {"markdown": "\n".join(lines), "count": len(rows)}
    if fmt == "xlsx":
        from openpyxl import Workbook
        wb = Workbook()
        ws = wb.active
        ws.title = "Literature Matrix"
        ws.append(headers)
        for r in rows:
            ws.append([r.get(k, "") for k in headers])
        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        return Response(
            content=buf.getvalue(),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": "attachment; filename=literature_matrix.xlsx"},
        )
    raise HTTPException(400, "format must be csv | md | xlsx")


# ------------------------------------------------------------------
# Saved searches (Phase 5)
# ------------------------------------------------------------------
@app.get("/api/searches")
def api_list_searches():
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM saved_searches ORDER BY updated_at DESC").fetchall()
        out = []
        for r in rows:
            d = dict_from_row(r)
            try:
                d["filters"] = json.loads(d.pop("filters_json") or "{}")
            except Exception:
                d["filters"] = {}
            out.append(d)
        return out
    finally:
        conn.close()


@app.post("/api/searches")
def api_create_search(body: dict):
    name = (body.get("name") or "").strip()
    query = (body.get("query") or "").strip()
    if not name or not query:
        raise HTTPException(400, "name and query required")
    conn = get_connection()
    try:
        now = datetime.now(timezone.utc).isoformat()
        cur = conn.execute(
            "INSERT INTO saved_searches(name, query, filters_json, created_at, updated_at) VALUES (?,?,?,?,?)",
            (name, query, json.dumps(body.get("filters") or {}), now, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM saved_searches WHERE id=?", (cur.lastrowid,)).fetchone()
        return dict_from_row(row)
    finally:
        conn.close()


@app.delete("/api/searches/{sid}")
def api_delete_search(sid: int):
    conn = get_connection()
    try:
        conn.execute("DELETE FROM saved_searches WHERE id=?", (sid,))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@app.post("/api/searches/{sid}/run")
def api_run_search(sid: int):
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM saved_searches WHERE id=?", (sid,)).fetchone()
        if not row:
            raise HTTPException(404, "Saved search not found")
        q = row["query"]
        try:
            filters = json.loads(row["filters_json"] or "{}")
        except Exception:
            filters = {}
        for token in (f"year:{filters['year']}" if filters.get("year") else None,
                      f"tag:\"{filters['tag']}\"" if filters.get("tag") else None,
                      f"collection:\"{filters['collection']}\"" if filters.get("collection") else None,
                      f"author:\"{filters['author']}\"" if filters.get("author") else None):
            if token:
                q = f"{q} {token}"
        # refresh timestamp (this is a "saved query you come back to")
        conn.execute("UPDATE saved_searches SET updated_at=? WHERE id=?", (datetime.now(timezone.utc).isoformat(), sid))
        conn.commit()
    finally:
        conn.close()
    # call with explicit limit - internal calls don't get FastAPI's Query defaults
    return api_search(q=q, limit=20)


# ------------------------------------------------------------------
# Related documents (Phase 5) - labeled relationship types
# ------------------------------------------------------------------
@app.get("/api/library/documents/{doc_id}/related")
def api_related_documents(doc_id: int):
    doc = get_document(doc_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    out = {"semantic": [], "shared_authors": [], "shared_topics": [], "citations": []}
    seen: set[int] = set()

    def push(kind, related_doc, label):
        if related_doc and related_doc["id"] != doc_id and related_doc["id"] not in seen:
            seen.add(related_doc["id"])
            out[kind].append({"id": related_doc["id"], "title": related_doc["title"],
                              "reason": label})

    # 1. Semantic similarity (embeddings) - labeled as such, not as a
    #    confirmed scholarly relationship.
    if HAS_ENGINE:
        try:
            vs = _get_vectorstore()
            src = doc.get("stored_path")
            # Chroma stores the absolute path; documents.stored_path is
            # relative, so resolve before querying Chroma.
            src_abs = str(resolve_stored_path(src)) if src else None
            if vs and src_abs:
                own = vs.get(where={"source": src_abs}, include=["embeddings"])
                embeds = own.get("embeddings") or []
                if embeds:
                    vec = [sum(col) / len(col) for col in zip(*embeds)]
                    hits = vs.similarity_search_by_vector(vec, k=30)
                    ordered: list[tuple] = []
                    for h in hits:
                        s = h.metadata.get("source")
                        if s and s != src_abs and not any(o[0] == s for o in ordered):
                            ordered.append((s, 1))
                        if len(ordered) >= 8:
                            break
                    for s, _ in ordered:
                        match = _doc_by_source(s)
                        if match:
                            push("semantic", match, "semantic similarity (embeddings)")
        except Exception as e:
            print(f"[related] semantic failed: {e}")

    # 2. Shared authors - an objective bibliographic fact.
    my_authors = set(doc.get("authors") or [])
    if my_authors:
        conn = get_connection()
        try:
            rows = conn.execute(
                "SELECT d.id, d.title, COUNT(*) as overlap FROM documents d "
                "JOIN document_authors da ON da.document_id=d.id "
                "JOIN authors a ON a.id=da.author_id "
                "WHERE a.name IN ({}) AND d.id != ? "
                "GROUP BY d.id ORDER BY overlap DESC LIMIT 8".format(",".join("?" for _ in my_authors)),
                list(my_authors) + [doc_id],
            ).fetchall()
        finally:
            conn.close()
        for r in rows:
            push("shared_authors", {"id": r["id"], "title": r["title"]},
                 f"shared author(s) ({r['overlap']})")

    # 3. Shared topics = shared tags/collections (explicit, user-curated).
    my_tags = {t["id"] for t in doc.get("tags") or []}
    my_cols = {c["id"] for c in doc.get("collections") or []}
    if my_tags or my_cols:
        conn = get_connection()
        try:
            rows = conn.execute("SELECT id, title FROM documents WHERE id != ?", (doc_id,)).fetchall()
            for r in rows:
                other = get_document(r["id"])
                if not other:
                    continue
                shared = [t["name"] for t in other.get("tags") or [] if t["id"] in my_tags]
                shared += [c["name"] for c in other.get("collections") or [] if c["id"] in my_cols]
                if shared:
                    push("shared_topics", other, f"shared topics: {', '.join(shared[:3])}")
        finally:
            conn.close()

    # 4. Citation relationships - only what the citation graph actually
    #    extracted (Phase 8); never inferred from similarity.
    conn = get_connection()
    try:
        my_source = conn.execute("SELECT id, case_number FROM sources WHERE document_id=?", (doc_id,)).fetchone()
        if my_source:
            cited_rows = conn.execute(
                "SELECT s2.document_id, sc.cited_identifier FROM source_citations sc "
                "JOIN sources s2 ON s2.id=sc.cited_source_id WHERE sc.source_id=? LIMIT 10",
                (my_source["id"],)).fetchall()
            for r in cited_rows:
                if r["document_id"]:
                    push("citations", get_document(r["document_id"]),
                         f"cited here: {r['cited_identifier']}")
            if my_source["case_number"]:
                citing_rows = conn.execute(
                    "SELECT s.document_id FROM source_citations sc "
                    "JOIN sources s ON s.id=sc.source_id "
                    "WHERE sc.cited_identifier=? AND s.document_id IS NOT NULL LIMIT 10",
                    (my_source["case_number"],)).fetchall()
                for r in citing_rows:
                    push("citations", get_document(r["document_id"]),
                         "cites this case")
    finally:
        conn.close()
    return out


def _doc_by_source(source_path: str) -> dict | None:
    # Chroma stores absolute paths; documents.stored_path is relative.
    # Try both absolute and relative lookups for robustness.
    conn = get_connection()
    try:
        row = conn.execute("SELECT id, title FROM documents WHERE stored_path=?", (source_path,)).fetchone()
        if row:
            return dict(row)
        # If the Chroma source was absolute, the relative lookup fails; try
        # resolving the stored absolute back to a relative key via filesystem.
        # As a fallback, match by basename.
        basename = source_path.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
        row = conn.execute("SELECT id, title FROM documents WHERE original_filename=?", (basename,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()

# ------------------------------------------------------------------
# Claim -> Evidence graph (Phase 6 P2)
# ------------------------------------------------------------------
class ClaimCreate(BaseModel):
    project_id: Optional[int] = None
    text: str


class ClaimCitationCreate(BaseModel):
    document_id: Optional[int] = None
    support: str = "supports"  # supports | contradicts | mentions
    locator: Optional[str] = None


@app.get("/api/projects/{pid}/claims")
def api_project_claims(pid: int):
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM claims WHERE project_id=? ORDER BY created_at DESC", (pid,)).fetchall()
        return [dict_from_row(r) for r in rows]
    finally:
        conn.close()


@app.post("/api/claims")
def api_create_claim(body: ClaimCreate):
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "Claim text required")
    conn = get_connection()
    try:
        if body.project_id is not None:
            if not conn.execute("SELECT 1 FROM research_projects WHERE id=?", (body.project_id,)).fetchone():
                raise HTTPException(404, "Project not found")
        now = datetime.now(timezone.utc).isoformat()
        cur = conn.execute(
            "INSERT INTO claims(project_id, text, status, created_at, updated_at) VALUES (?,?,?,?,?)",
            (body.project_id, text, "open", now, now),
        )
        conn.commit()
        claim_id = cur.lastrowid
    finally:
        conn.close()
    return get_claim_with_evidence(claim_id)


@app.delete("/api/claims/{cid}")
def api_delete_claim(cid: int):
    conn = get_connection()
    try:
        conn.execute("DELETE FROM claims WHERE id=?", (cid,))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@app.post("/api/claims/{cid}/citations")
def api_claim_add_citation(cid: int, body: ClaimCitationCreate):
    conn = get_connection()
    try:
        claim = conn.execute("SELECT id FROM claims WHERE id=?", (cid,)).fetchone()
        if not claim:
            raise HTTPException(404, "Claim not found")
        support = body.support if body.support in ("supports", "contradicts", "mentions") else "supports"
        source_id = None
        if body.document_id:
            src = conn.execute("SELECT id FROM sources WHERE document_id=?", (body.document_id,)).fetchone()
            source_id = src["id"] if src else None
        if source_id is None:
            raise HTTPException(404, "Document has no bibliographic source record")
        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "INSERT INTO citations(source_id, claim_id, support, locator, created_at) VALUES (?,?,?,?,?)",
            (source_id, cid, support, body.locator, now),
        )
        conn.execute("UPDATE claims SET updated_at=? WHERE id=?", (now, cid))
        conn.commit()
    finally:
        conn.close()
    return get_claim_with_evidence(cid)


def get_claim_with_evidence(cid: int) -> dict | None:
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM claims WHERE id=?", (cid,)).fetchone()
        if not row:
            return None
        claim = dict_from_row(row)
        evidence_rows = conn.execute(
            "SELECT c.support, c.locator, s.document_id, s.title, s.doi, s.case_number "
            "FROM citations c JOIN sources s ON s.id=c.source_id WHERE c.claim_id=? ORDER BY c.id",
            (cid,)).fetchall()
        evidence = {k: [] for k in ("supports", "contradicts", "mentions")}
        for e in evidence_rows:
            evidence[e["support"]].append({
                "support": e["support"], "locator": e["locator"],
                "document_id": e["document_id"], "title": e["title"],
                "doi": e["doi"], "case_number": e["case_number"],
            })
        claim["evidence"] = evidence
        return claim
    finally:
        conn.close()


# ------------------------------------------------------------------
# Annotations upgrade (Phase 7): tags + project/claim links
# ------------------------------------------------------------------
@app.patch("/api/library/documents/{doc_id}/annotations/{aid}")
def api_patch_annotation(doc_id: int, aid: int, body: dict):
    allowed = {"note", "color", "category", "page", "tags", "project_id", "claim_id"}
    sets, params = [], []
    for k in allowed:
        if k in body:
            if k == "tags":
                sets.append("tags_json=?")
                params.append(json.dumps(body[k] or []))
            else:
                sets.append(f"{k}=?")
                params.append(body[k])
    if not sets:
        raise HTTPException(400, "No patch fields provided")
    sets.append("updated_at=?")
    params.append(datetime.now(timezone.utc).isoformat())
    params.extend([doc_id, aid])
    conn = get_connection()
    try:
        cur = conn.execute(
            f"UPDATE annotations SET {', '.join(sets)} WHERE document_id=? AND id=?",
            params,
        )
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(404, "Annotation not found")
        row = conn.execute("SELECT * FROM annotations WHERE id=?", (aid,)).fetchone()
        d = dict_from_row(row)
        try:
            d["tags"] = json.loads(d.pop("tags_json") or "[]")
        except Exception:
            d["tags"] = []
        return d
    finally:
        conn.close()


# ------------------------------------------------------------------
# Citation-aware reader (Phase 7): reference list resolution
# ------------------------------------------------------------------
_REF_LINE_RE = re.compile(r"^\s*[\[(]?(\d{1,3})[\])]\s*[.:]?\s+(.+)$")


@app.get("/api/library/documents/{doc_id}/references")
def api_document_references(doc_id: int, resolve: bool = Query(False)):
    doc = get_document(doc_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    text = ""
    if HAS_ENGINE:
        try:
            vs = _get_vectorstore()
            if vs and doc.get("stored_path"):
                from retrieval import get_chunks_by_source, sort_docs
                chunks = sort_docs(get_chunks_by_source(vs, doc["stored_path"]))
                text = "\n".join(c.page_content for c in chunks[:80])
        except Exception:
            text = ""
    if not text:
        snippet = (doc.get("metadata") or {}).get("text_snippet") or ""
        text = snippet
    entries = []
    for line in text.splitlines():
        m = _REF_LINE_RE.match(line.strip())
        if m:
            entries.append({"number": int(m.group(1)), "text": m.group(2).strip()[:300]})
    entries = sorted(entries, key=lambda e: e["number"])
    if resolve and entries:
        from core.ingestion.deduplication import title_fuzzy_score
        library = _library_docs_hydrated()
        for entry in entries:
            best, best_score = None, 0.0
            for other in library:
                score = title_fuzzy_score(entry["text"], other.get("title") or "")
                if score > best_score:
                    best_score, best = score, other
            if best and best_score >= 0.55:
                entry["match"] = {"id": best["id"], "title": best["title"], "score": round(best_score, 2)}
            else:
                entry["match"] = None
    return {"document_id": doc_id, "references": entries}


# ------------------------------------------------------------------
# Legal intelligence (Phase 8 P3)
# ------------------------------------------------------------------
@app.post("/api/library/documents/{doc_id}/legal/refresh")
def api_legal_refresh(doc_id: int):
    """Deterministic legal extraction: case metadata + citation graph.

    Reads the document text, updates the sources row (court, case_number,
    parties, judges) and rebuilds source_citations edges. No LLM involved -
    identifiers are guaranteed exact.
    """
    doc = get_document(doc_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    text = ""
    if HAS_ENGINE:
        try:
            vs = _get_vectorstore()
            if vs and doc.get("stored_path"):
                from retrieval import get_chunks_by_source, sort_docs
                chunks = sort_docs(get_chunks_by_source(vs, doc["stored_path"]))
                text = "\n".join(c.page_content for c in chunks)
        except Exception:
            text = ""
    if not text:
        text = (doc.get("metadata") or {}).get("text_snippet") or ""
    if not text:
        raise HTTPException(400, "No document text available")

    from core.legal.extraction import extract_case_metadata, extract_cited_identifiers
    meta = extract_case_metadata(text)
    refs = extract_cited_identifiers(text)

    conn = get_connection()
    try:
        source_row = conn.execute("SELECT id FROM sources WHERE document_id=?", (doc_id,)).fetchone()
        source_id = source_row["id"] if source_row else None
        if source_id is None:
            from core.library.sources import sync_source_from_document
            sync_source_from_document(conn, doc_id, {
                "doi": doc.get("doi"), "title": doc.get("title"),
                "journal": doc.get("journal"), "year": doc.get("year"),
                "document_type": doc.get("document_type"), "authors": doc.get("authors") or [],
            })
            source_row = conn.execute("SELECT id FROM sources WHERE document_id=?", (doc_id,)).fetchone()
            source_id = source_row["id"]
        conn.execute(
            "UPDATE sources SET court=?, case_number=?, decision_date=?, parties_json=?, judges_json=?, updated_at=? WHERE id=?",
            (meta.get("court"), meta.get("case_number"), meta.get("decision_date"),
             json.dumps(meta.get("parties") or []), json.dumps([]),
             datetime.now(timezone.utc).isoformat(), source_id),
        )
        conn.execute("DELETE FROM source_citations WHERE source_id=?", (source_id,))
        for ref in refs:
            cited_source = conn.execute(
                "SELECT id FROM sources WHERE case_number=? LIMIT 1", (ref["identifier"],)
            ).fetchone()
            conn.execute(
                "INSERT INTO source_citations(source_id, cited_identifier, cited_source_id, kind, locator, created_at) "
                "VALUES (?,?,?,?,?,?)",
                (source_id, ref["identifier"], cited_source["id"] if cited_source else None,
                 ref["kind"], ref.get("locator"), datetime.now(timezone.utc).isoformat()),
            )
        # keep case metadata visible on the document too
        cit_md = dict(doc.get("citation_metadata") or {})
        cit_md.update({k: v for k, v in meta.items() if v})
        conn.execute("UPDATE documents SET citation_metadata=? WHERE id=?",
                     (json.dumps(cit_md), doc_id))
        conn.commit()
    finally:
        conn.close()
    return {"legal_metadata": meta, "cited_references": refs}


@app.get("/api/library/documents/{doc_id}/cited-cases")
def api_document_cited_cases(doc_id: int):
    conn = get_connection()
    try:
        source_row = conn.execute("SELECT id FROM sources WHERE document_id=?", (doc_id,)).fetchone()
        if not source_row:
            return {"document_id": doc_id, "cited": [], "citing": []}
        cited = [dict(r) for r in conn.execute(
            "SELECT sc.*, s2.title as resolved_title, s2.document_id as resolved_document_id "
            "FROM source_citations sc LEFT JOIN sources s2 ON s2.id=sc.cited_source_id "
            "WHERE sc.source_id=? ORDER BY sc.id", (source_row["id"],)).fetchall()]
        case_number = conn.execute("SELECT case_number FROM sources WHERE id=?", (source_row["id"],)).fetchone()["case_number"]
        citing = []
        if case_number:
            citing = [{"document_id": r["document_id"], "title": r["title"]} for r in conn.execute(
                "SELECT s.document_id, s.title FROM source_citations sc JOIN sources s ON s.id=sc.source_id "
                "WHERE sc.cited_identifier=? AND s.document_id IS NOT NULL", (case_number,)).fetchall()]
        return {"document_id": doc_id, "cited": cited, "citing": citing}
    finally:
        conn.close()


@app.get("/api/cases/citing")
def api_cases_citing(case_number: str = Query(...)):
    """'Show decisions citing this case' - the legal citation graph query."""
    from core.legal.extraction import normalize_case_number
    ident = normalize_case_number(case_number)
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT DISTINCT s.document_id, s.title, s.case_number FROM source_citations sc "
            "JOIN sources s ON s.id=sc.source_id "
            "WHERE sc.cited_identifier=? AND s.document_id IS NOT NULL",
            (ident,)).fetchall()
        return {"case_number": ident, "cited_by": [dict(r) for r in rows]}
    finally:
        conn.close()


class LegalAnalysisRequest(BaseModel):
    document_id: int


@app.post("/api/research/legal-analysis")
def api_research_legal_analysis(body: LegalAnalysisRequest):
    doc = get_document(body.document_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    vs = _get_vectorstore()
    if not vs:
        raise HTTPException(503, "Vector store empty")
    from core.research import analysis
    return analysis.legal_analysis(vs, doc)


# ------------------------------------------------------------------
# Structured extraction + cross-paper synthesis (Phase 9 P2)
# ------------------------------------------------------------------
class ExtractRequest(BaseModel):
    document_id: int
    schema: str = "paper"  # paper | legal


class SynthesisRequest(BaseModel):
    document_ids: List[int]
    question: str


@app.post("/api/research/extract")
def api_research_extract(body: ExtractRequest):
    doc = get_document(body.document_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    vs = _get_vectorstore()
    if not vs:
        raise HTTPException(503, "Vector store empty")
    from core.research import analysis
    return analysis.structured_extract(vs, doc, schema=body.schema)


@app.post("/api/research/synthesis")
def api_research_synthesis(body: SynthesisRequest):
    if not body.question.strip():
        raise HTTPException(400, "Question required")
    docs = [d for d in (get_document(i) for i in body.document_ids) if d]
    if len(docs) < 2:
        raise HTTPException(400, "Select at least two documents")
    vs = _get_vectorstore()
    if not vs:
        raise HTTPException(503, "Vector store empty")
    from core.research import analysis
    answer = analysis.cross_paper_synthesis(vs, docs, body.question)
    return {"answer": answer, "documents": [{"id": d["id"], "title": d["title"]} for d in docs]}


# ------------------------------------------------------------------
# Summarization PDF/HTML export (one-click button for Research → Summarize)
# ------------------------------------------------------------------
@app.post("/api/research/summarize/export")
def api_summarize_export(body: dict):
    """Export a whole-document summary as styled PDF or HTML.

    Body: {document_id: int, format: "pdf" | "html"}. Runs the same
    summarization pipeline as POST /api/research/summarize, then renders
    via summary_export.py and returns the file as a download.
    """
    document_id = body.get("document_id")
    fmt = (body.get("format") or "pdf").lower()
    if fmt not in ("pdf", "html"):
        raise HTTPException(400, "format must be pdf or html")
    doc = get_document(document_id) if document_id else None
    if not doc:
        raise HTTPException(404, "Document not found")
    if not HAS_ENGINE:
        raise HTTPException(503, "Engine not available")
    vs = _get_vectorstore()
    if not vs:
        raise HTTPException(503, "Vector store empty")
    full_source = _resolve_full_source(vs, doc)
    if not full_source:
        raise HTTPException(404, "Document not indexed yet")
    from summarization import summarize_document
    from summary_export import export_summary_html, export_summary_pdf
    display_name = doc["original_filename"]
    summary, stats = summarize_document(vs, full_source, display_name, progress=lambda x: None)
    if summary is None:
        raise HTTPException(404, "No indexed content for that document")
    if fmt == "html":
        path = export_summary_html(display_name, summary, stats)
        media = "text/html"
    else:
        path = export_summary_pdf(display_name, summary, stats)
        media = "application/pdf"
    ok, reason = _verify_export_file(path)
    if not ok:
        raise HTTPException(500, f"Failed to generate {fmt.upper()} ({reason})")
    return FileResponse(path, media_type=media, filename=Path(path).name)


# ------------------------------------------------------------------
# Watch-Folder Automation (pfolder polling)
# ------------------------------------------------------------------
_watch_thread: Optional[threading.Thread] = None
_watch_stop = threading.Event()
_watch_enabled = True  # default on; can be toggled via settings if needed


def _watch_pfolder_loop():
    """Poll pfolder every 30s and auto-index new files (no restart needed).

    Chroma writes run under _chroma_lock, serialized with ingest-confirm
    writes - the old code let this thread and request handlers write
    simultaneously ('database is locked', duplicate chunk_index). Expired
    preview entries are swept on the same tick so no second thread is needed.
    """
    from config import DOC_FOLDER
    import time as _time
    while not _watch_stop.is_set():
        try:
            _sweep_expired_previews()
            if _watch_enabled and Path(DOC_FOLDER).exists():
                with _chroma_lock:
                    vs = _get_vectorstore()
                    if vs:
                        from ingestion import get_indexed_documents
                        try:
                            doc_map = get_indexed_documents(vs)
                            from ingestion import sync_new_files
                            if sync_new_files(vs, doc_map):
                                print("[watch-folder] auto-synced new file(s) from pfolder")
                        except Exception as e:
                            print(f"[watch-folder] sync error: {e}")
        except Exception as e:
            print(f"[watch-folder] loop error: {e}")
        _watch_stop.wait(30)


from contextlib import asynccontextmanager


@asynccontextmanager
async def _lifespan(app: FastAPI):
    global _watch_thread
    if not (_watch_thread and _watch_thread.is_alive()):
        _watch_stop.clear()
        _watch_thread = threading.Thread(target=_watch_pfolder_loop, daemon=True, name="pfolder-watch")
        _watch_thread.start()
        print("[watch-folder] started (polling pfolder every 30s)")
    yield
    _watch_stop.set()
    print("[watch-folder] stopped")
    _drop_vectorstore()


app.router.lifespan_context = _lifespan


@app.get("/api/watch/status")
def api_watch_status():
    from config import DOC_FOLDER
    return {
        "enabled": _watch_enabled,
        "watching": DOC_FOLDER,
        "alive": bool(_watch_thread and _watch_thread.is_alive()),
    }


@app.post("/api/watch/toggle")
def api_watch_toggle(body: dict):
    global _watch_enabled
    enabled = body.get("enabled")
    if enabled is not None:
        _watch_enabled = bool(enabled)
    else:
        _watch_enabled = not _watch_enabled
    return {"enabled": _watch_enabled}


# ------------------------------------------------------------------
# Backup / restore
# ------------------------------------------------------------------
@app.post("/api/backup")
def api_backup():
    """Online backup via SQLite's backup API (crash-safe on a live DB -
    the old shutil.copy2 could capture a torn page image mid-checkpoint).
    Keeps the 10 newest backups; returns the new file info."""
    import datetime as dt
    import sqlite3
    ts = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    src = get_db_path()
    dest_dir = DATA_ROOT / "backups"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"library_{ts}.db"
    src_conn = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    try:
        dst_conn = sqlite3.connect(str(dest))
        try:
            src_conn.backup(dst_conn)
        finally:
            dst_conn.close()
    finally:
        src_conn.close()
    # retention: newest 10 win, older pruned (backups otherwise grow forever)
    kept = sorted(dest_dir.glob("library_*.db"), key=lambda p: p.name, reverse=True)
    for stale in kept[10:]:
        try:
            stale.unlink()
        except OSError:
            pass
    return {"path": str(dest), "filename": dest.name}

# ------------------------------------------------------------------
# Serve frontend if built (optional)
# ------------------------------------------------------------------
# Allow running without frontend build — API only is fine.

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
