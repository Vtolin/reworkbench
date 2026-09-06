"""
Ingestion: loading documents from disk, chunking, and building/syncing the
persistent Chroma vector store.

Per-format loading is routed through document_loaders.load_document_pages
(PDFs go to heading_detection.py's PyMuPDF pipeline; docx/xlsx/pptx/txt/md
etc. go to their own loaders there). Every loader returns the same
{page: [(section, text)]} shape, so the chunking/metadata machinery below
is format-agnostic - every chunk carries a real 'section' tag alongside
its page number (pseudo-page for non-PDF formats).
"""
import os

from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_chroma import Chroma

from config import (
    DOC_FOLDER, PERSIST_DIR, CHUNK_SIZE, CHUNK_OVERLAP,
    PAGE_GARBAGE_THRESHOLD, DOC_GARBAGE_RATIO, EMBED_FAILURE_BREAKER,
)
from document_loaders import load_document_pages, supported_extension
from metadata_extraction import extract_year
from jurisdiction_extraction import extract_jurisdiction
from pinpoint_detection import tag_chunks_with_pinpoints
from text_quality import assess_text_quality


def _sanitize_text(text):
    """
    Strip characters that can make a chunk's text fail to round-trip as
    valid JSON/UTF-8 when sent to the embedding endpoint.

    PDFs with malformed or custom-mapped embedded fonts (common in
    scanned or oddly-produced legal documents) occasionally yield NUL
    bytes or lone/unpaired UTF-16 surrogate codepoints when their text is
    extracted. Both are valid Python str characters - they survive
    silently through chunking and storage - but neither is valid UTF-8,
    so a single one of these anywhere in a large batched embedding
    request is enough to make the *entire* request fail. The failure then
    surfaces far from its actual cause (a generic connection/HTTP error
    from the embedding client), which is exactly what made this bug hard
    to track down. Sanitizing here, at first extraction, is cheap and
    removes the failure mode at its source rather than downstream.
    """
    if not text:
        return text
    text = text.replace("\x00", "")
    return "".join(
        ch if not (0xD800 <= ord(ch) <= 0xDFFF) else "\ufffd"
        for ch in text
    )


def _relative_source(full_path):
    """Path relative to DOC_FOLDER, normalized to forward slashes so
    matching and display are consistent across Windows/Linux/Mac."""
    if not full_path or not isinstance(full_path, str):
        return ""
    try:
        rel = os.path.relpath(full_path, DOC_FOLDER)
    except ValueError:
        rel = os.path.basename(full_path)
    return rel.replace(os.sep, "/")


def _safe_page_label(metadata):
    """1-indexed page label that never raises on None/str page values."""
    try:
        return int((metadata or {}).get("page", 0)) + 1
    except (TypeError, ValueError):
        return "?"


def get_indexed_documents(vectorstore):
    """
    Return {relative_path: full_source_path} for every unique file in the
    index. Keyed by path relative to pfolder (not bare basename) so that
    two same-named files in different subfolders don't silently collide.
    """
    try:
        results = vectorstore.get(include=["metadatas"])
    except Exception as e:
        print(f"[warning] could not read index metadata: {e}")
        return {}

    doc_map = {}
    for metadata in (results or {}).get("metadatas", []) or []:
        if metadata and "source" in metadata:
            full = metadata["source"]
            if not full or not isinstance(full, str):
                continue
            doc_map[_relative_source(full)] = full
    return doc_map


def get_indexed_years(vectorstore):
    """
    Return {relative_path: year_or_None} for every unique file in the
    index, reading the 'year' metadata tag attached at ingestion time (see
    metadata_extraction.extract_year). A document with no detected year
    maps to None rather than being omitted, so callers can distinguish
    "not indexed" from "indexed but year unknown".
    """
    try:
        results = vectorstore.get(include=["metadatas"])
    except Exception as e:
        print(f"[warning] could not read index metadata: {e}")
        return {}

    doc_years = {}
    for metadata in (results or {}).get("metadatas", []) or []:
        if metadata and "source" in metadata:
            if not metadata["source"] or not isinstance(metadata["source"], str):
                continue
            rel = _relative_source(metadata["source"])
            if rel not in doc_years or doc_years[rel] is None:
                doc_years[rel] = metadata.get("year")
    return doc_years


def get_indexed_jurisdictions(vectorstore):
    """
    Return {relative_path: jurisdiction_or_None} for every unique file in
    the index, mirroring get_indexed_years - see
    jurisdiction_extraction.extract_jurisdiction for how the value is
    determined and its limits (best-effort keyword matching, not real
    entity recognition).
    """
    try:
        results = vectorstore.get(include=["metadatas"])
    except Exception as e:
        print(f"[warning] could not read index metadata: {e}")
        return {}

    doc_jurisdictions = {}
    for metadata in (results or {}).get("metadatas", []) or []:
        if metadata and "source" in metadata:
            if not metadata["source"] or not isinstance(metadata["source"], str):
                continue
            rel = _relative_source(metadata["source"])
            if rel not in doc_jurisdictions or doc_jurisdictions[rel] is None:
                doc_jurisdictions[rel] = metadata.get("jurisdiction")
    return doc_jurisdictions


def _load_document(path):
    """
    Load one document (any supported format) into a list of Documents -
    one per (page, detected section) segment. PDFs get layout-aware
    heading detection from heading_detection.py; docx/xlsx/pptx/text
    files get their format's own loader from document_loaders.py. If a
    format has no structural signals (e.g. plain txt), this degrades to
    one segment per pseudo-page with a "General Section" label, which is
    no worse than the original flat page-blob extraction.

    Also runs best-effort publication-year and jurisdiction extraction
    once per file (not once per segment) and stamps every segment from
    this file with the same values, so year/jurisdiction filtering work
    at the document level regardless of which chunk ends up matching a
    query. Non-PDF formats pass their already-extracted front text to
    those extractors, since they have no PDF layer to re-open.
    """
    try:
        pages = load_document_pages(path)
    except Exception as e:
        print(f"[warning] could not load {os.path.basename(path)}: {e}")
        return []

    # --- Quality gate (circuit breaker) ---
    # A corrupted PDF can open fine while its extracted text is garbage
    # (broken font maps, undecodable streams). Score every page and drop
    # the garbage ones; if most of the document is garbage, skip the whole
    # document rather than embedding noise that would later pollute
    # retrieval and feed junk to the map model.
    if pages:
        total = len(pages)
        garbage_pages = []
        for page in sorted(pages):
            combined = "\n".join(text for _, text in pages[page])
            if assess_text_quality(combined) < PAGE_GARBAGE_THRESHOLD:
                garbage_pages.append(page)
        for page in garbage_pages:
            del pages[page]
        if garbage_pages:
            print(
                f"[quality] {os.path.basename(path)}: dropped {len(garbage_pages)}/"
                f"{total} page(s) that scored as unreadable/garbage "
                f"(pages {', '.join(str(p + 1) for p in garbage_pages[:10])}"
                f"{'...' if len(garbage_pages) > 10 else ''})."
            )
        if not pages or len(garbage_pages) / total > DOC_GARBAGE_RATIO:
            print(
                f"[quality] {os.path.basename(path)}: skipped entirely - "
                f"{(len(garbage_pages) / total * 100):.0f}% of its pages are garbage "
                f"(possibly a corrupt or scanned PDF)."
            )
            return []

    first_text = ""
    if pages:
        # Metadata extractors scan front matter: two pseudo-pages' worth,
        # matching the PDF pipeline's original two-page scan.
        first_text = "\n".join(
            text for p in sorted(pages)[:2] for _, text in pages[p]
        )
    year = extract_year(path, first_page_text=first_text)
    jurisdiction = extract_jurisdiction(path, first_page_text=first_text)

    docs = []
    for page_num in sorted(pages):
        for section, text in pages[page_num]:
            text = _sanitize_text(text)
            if not text or not text.strip():
                continue
            docs.append(Document(
                page_content=text,
                metadata={
                    "source": path, "page": page_num, "section": _sanitize_text(section),
                    "year": year, "jurisdiction": jurisdiction,
                },
            ))
    return docs


def split_and_load(paths):
    docs = []
    for p in paths:
        docs.extend(_load_document(p))
    return docs


def _discover_documents():
    """Every supported file under DOC_FOLDER, including subfolders."""
    paths = []
    for root, _, files in os.walk(DOC_FOLDER):
        for f in files:
            if supported_extension(f):
                paths.append(os.path.join(root, f))
    return sorted(paths)


# How many chunks go into a single embedding API call. Bounds the blast
# radius of a bad chunk (see _sanitize_text) - if this were "every chunk
# in one call" (the original behavior), one rejected chunk out of
# thousands would fail the entire index build with no indication of
# which one was responsible.
_EMBED_BATCH_SIZE = 200


def _add_batch(vectorstore, docs, embeddings, persist_dir):
    """Embed and store one batch, creating the Chroma collection on the
    first successful batch and appending to it afterward."""
    if vectorstore is None:
        return Chroma.from_documents(documents=docs, embedding=embeddings, persist_directory=persist_dir)
    vectorstore.add_documents(docs)
    return vectorstore


def _embed_with_isolation(splits, embeddings, persist_dir):
    """
    Build/extend a Chroma index in fixed-size batches rather than one
    call covering every chunk, and isolate failures down to the
    individual chunk responsible.

    If a batch fails (most likely one rejected chunk - see
    _sanitize_text's docstring for the common cause even after
    sanitization, e.g. a chunk so degenerate the embedding model itself
    rejects it), that batch is retried one document at a time so the
    specific bad chunk(s) can be identified, reported by source/page, and
    skipped - every other chunk, in that batch and every other batch,
    still gets indexed. Only raises if EVERY chunk fails (nothing at all
    could be indexed), since that's the "embedding backend is actually
    unreachable" case main.py needs to detect and report distinctly.
    """
    vectorstore = None
    skipped = []
    broken_sources = set()       # tripped circuit breakers, by full source path
    source_failures = {}         # consecutive failure count, by full source path
    for i in range(0, len(splits), _EMBED_BATCH_SIZE):
        batch = splits[i:i + _EMBED_BATCH_SIZE]
        try:
            vectorstore = _add_batch(vectorstore, batch, embeddings, persist_dir)
        except Exception:
            for doc in batch:
                src = doc.metadata.get("source", "?")
                if src in broken_sources:
                    # Circuit breaker already tripped for this document -
                    # don't keep hammering the embedding backend with its
                    # remaining chunks.
                    continue
                try:
                    vectorstore = _add_batch(vectorstore, [doc], embeddings, persist_dir)
                    source_failures[src] = 0
                except Exception as e:
                    source_failures[src] = source_failures.get(src, 0) + 1
                    page = _safe_page_label(doc.metadata)
                    skipped.append((os.path.basename(src) if isinstance(src, str) else "?", page, str(e)))
                    if source_failures[src] >= EMBED_FAILURE_BREAKER:
                        broken_sources.add(src)
                        skipped.append((
                            os.path.basename(src) if isinstance(src, str) else "?", "-",
                            f"circuit breaker tripped after {source_failures[src]} failed chunks - "
                            "skipping the rest of this document",
                        ))

    if broken_sources:
        print(
            f"\n[quality] {len(broken_sources)} document(s) tripped the embed-failure "
            f"circuit breaker and were only partially indexed: "
            f"{', '.join(os.path.basename(s) if isinstance(s, str) else '?' for s in broken_sources)}"
        )

    if skipped:
        print(f"\n[warning] {len(skipped)} chunk(s) were rejected by the embedding backend and skipped:")
        for src, page, err in skipped[:10]:
            print(f"  - {src}, page {page}: {err}")
        if len(skipped) > 10:
            print(f"  ...and {len(skipped) - 10} more (see research_trail/logs for the full run).")

    if vectorstore is None:
        raise RuntimeError(
            f"Every one of {len(splits)} chunk(s) was rejected by the embedding backend - "
            "this points to the backend itself being unreachable/broken, not a bad chunk."
        )
    return vectorstore


def index_folder(embeddings, persist_dir=None):
    """
    persist_dir defaults to config.PERSIST_DIR, but callers (see main.py's
    'reindex' handling) can point this at a temporary directory instead,
    so a rebuild can be attempted WITHOUT first destroying the existing,
    working index. Only swap the temp directory into place once this
    returns a real vectorstore - if it raises or returns None, the caller
    still has the old index untouched.
    """
    persist_dir = persist_dir or PERSIST_DIR
    print(f"\n[1/3] Loading documents from '{DOC_FOLDER}'...")
    doc_paths = _discover_documents()
    if not doc_paths:
        return None

    docs = []
    for i, p in enumerate(doc_paths, 1):
        print(f"  [{i}/{len(doc_paths)}] {os.path.basename(p)}")
        docs.extend(_load_document(p))
    if not docs:
        return None
    print(f"Loaded {len(docs)} page/section segment(s) from {len(doc_paths)} file(s).")

    print("\n[2/3] Splitting documents into chunks...")
    splitter = RecursiveCharacterTextSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP)
    splits = splitter.split_documents(docs)
    for i, chunk in enumerate(splits):
        chunk.metadata["chunk_index"] = i
    tag_chunks_with_pinpoints(splits)
    print(f"Created {len(splits)} text chunks.")

    print("\n[3/3] Building and saving persistent Vector Database...")
    try:
        vectorstore = _embed_with_isolation(splits, embeddings, persist_dir)
        print("Vector database built and saved to disk successfully.")
        return vectorstore
    except Exception as e:
        # Deliberately re-raised rather than returned as None: None is
        # also what this function returns when there are simply no
        # supported documents to index (see the early return above), and
        # those are two very different situations for a caller to report
        # to the user - "add some documents" vs. "your embedding backend
        # errored out on every chunk". Swallowing this into the same None
        # made every embedding failure print a misleading "No PDF files
        # found" in main.py even when documents were found and chunked
        # successfully.
        print(f"Error generating embeddings: {e}")
        raise


def sync_new_files(vectorstore, doc_map):
    """
    Embed any documents dropped into pfolder (including subfolders) since
    the last run. Returns True if anything new was indexed - callers should
    refresh the BM25 side of hybrid retrieval (HybridIndex.refresh_bm25)
    whenever this happens, since BM25Retriever has no add_documents and
    would otherwise silently miss the new content.
    """
    on_disk = {_relative_source(p) for p in _discover_documents()}

    new_files = sorted(on_disk - set(doc_map.keys()))
    if not new_files:
        return False

    print(f"\nFound {len(new_files)} new document(s) not yet indexed: {', '.join(new_files)}")
    full_paths = [os.path.join(DOC_FOLDER, f) for f in new_files]
    docs = split_and_load(full_paths)
    if not docs:
        return False

    splitter = RecursiveCharacterTextSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP)
    splits = splitter.split_documents(docs)
    # Continue chunk_index from the highest one already in the store rather
    # than restarting at 0 - sort_docs orders by (source, page, chunk_index),
    # and duplicate indexes across sync batches make that ordering
    # unstable between rebuilds.
    try:
        existing = vectorstore.get(include=["metadatas"]).get("metadatas") or []
        next_index = max((m.get("chunk_index", -1) for m in existing if m), default=-1) + 1
    except Exception:
        next_index = 0
    for i, chunk in enumerate(splits):
        chunk.metadata["chunk_index"] = next_index + i
    tag_chunks_with_pinpoints(splits)

    skipped = []
    indexed = 0
    broken_sources = set()
    source_failures = {}
    for i in range(0, len(splits), _EMBED_BATCH_SIZE):
        batch = splits[i:i + _EMBED_BATCH_SIZE]
        try:
            vectorstore.add_documents(batch)
            indexed += len(batch)
        except Exception:
            for doc in batch:
                src = doc.metadata.get("source", "?")
                if src in broken_sources:
                    continue
                try:
                    vectorstore.add_documents([doc])
                    indexed += 1
                    source_failures[src] = 0
                except Exception as e:
                    source_failures[src] = source_failures.get(src, 0) + 1
                    page = _safe_page_label(doc.metadata)
                    skipped.append((os.path.basename(src) if isinstance(src, str) else "?", page, str(e)))
                    if source_failures[src] >= EMBED_FAILURE_BREAKER:
                        broken_sources.add(src)
                        skipped.append((
                            os.path.basename(src) if isinstance(src, str) else "?", "-",
                            f"circuit breaker tripped after {source_failures[src]} failed chunks - "
                            "skipping the rest of this document",
                        ))

    if skipped:
        print(f"[warning] {len(skipped)} chunk(s) were rejected by the embedding backend and skipped:")
        for src, page, err in skipped[:10]:
            print(f"  - {src}, page {page}: {err}")
        if len(skipped) > 10:
            print(f"  ...and {len(skipped) - 10} more.")

    print(f"Indexed {indexed} new chunk(s).")
    return True